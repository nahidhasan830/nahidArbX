"""GroqEngine — cloud LLM via Groq API (OpenAI-compatible).

Free tier: 30 RPM, 1000 RPD for Llama 3.3 70B.
~400 tokens/sec — entity match in ~200ms.
Zero local memory.

Uses the ``openai`` SDK (already a dependency) with
``base_url`` pointed at Groq.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from openai import AsyncOpenAI

from app.quota_store import get_store

log = logging.getLogger("ai-search.groq")


@dataclass
class LLMResponse:
    """Raw response from the LLM."""

    text: str
    model: str
    finish_reason: str | None = None
    tool_calls: list[dict[str, Any]] | None = None

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "llama-3.3-70b-versatile"

# Known free-tier limits per model (May 2026)
GROQ_MODEL_LIMITS: dict[str, dict[str, int]] = {
    "llama-3.3-70b-versatile":                    {"rpm": 30,  "rpd": 1_000,  "tpm": 12_000,  "tpd": 100_000},
    "meta-llama/llama-4-scout-17b-16e-instruct":   {"rpm": 30,  "rpd": 1_000,  "tpm": 30_000,  "tpd": 500_000},
    "qwen/qwen3-32b":                              {"rpm": 60,  "rpd": 1_000,  "tpm": 6_000,   "tpd": 500_000},
    "llama-3.1-8b-instant":                        {"rpm": 30,  "rpd": 14_400, "tpm": 6_000,   "tpd": 500_000},
    "allam-2-7b":                                  {"rpm": 30,  "rpd": 7_000,  "tpm": 6_000,   "tpd": 500_000},
    "openai/gpt-oss-120b":                         {"rpm": 30,  "rpd": 1_000,  "tpm": 8_000,   "tpd": 200_000},
    "openai/gpt-oss-20b":                          {"rpm": 30,  "rpd": 1_000,  "tpm": 8_000,   "tpd": 200_000},
}


class GroqEngine:
    """Groq cloud LLM — OpenAI-compatible, free tier.

    Usage::

        engine = GroqEngine(api_key="gsk_...")
        resp = await engine.generate("What is 2+2?")
        print(resp.text)
    """

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
    ) -> None:
        self.model: str = model
        self._client: AsyncOpenAI = AsyncOpenAI(
            base_url=GROQ_BASE_URL,
            api_key=api_key,
        )
        # Rate limit tracking — updated from response headers
        self._last_rate_limits: dict[str, int | None] = {
            "limit_requests": None,     # RPD limit
            "remaining_requests": None,  # RPD remaining
            "limit_tokens": None,        # TPM limit
            "remaining_tokens": None,    # TPM remaining
        }
        self._total_requests: int = get_store().get_llm_usage("groq")
        self._last_updated: float = 0.0
        if self._total_requests > 0:
            log.info("Restored Groq usage: %d requests", self._total_requests)

    # Models that support Groq's strict json_schema response_format
    _STRICT_SCHEMA_MODELS = frozenset({"openai/gpt-oss-20b", "openai/gpt-oss-120b"})

    async def generate(
        self,
        prompt: str,
        *,
        system: str | None = None,
        json_mode: bool = False,
        json_schema: dict[str, Any] | None = None,
        temperature: float = 0.0,
        max_tokens: int = 512,
        # Accept and ignore legacy params for interface compat
        tools: list[dict[str, Any]] | None = None,
        num_ctx: int = 2048,
    ) -> LLMResponse:
        """Generate a completion from Groq.

        When ``json_schema`` is provided:
        - For models that support strict mode (gpt-oss), uses constrained
          decoding via ``response_format: json_schema``.
        - For other models (e.g. llama-3.3-70b), falls back to
          ``json_object`` mode with the schema injected into the system
          prompt as instructions.  Llama 3.3 70B reliably follows JSON
          schemas when instructed, achieving ~99% parse rate.
        """
        import json as _json

        messages: list[dict[str, Any]] = []
        effective_system = system or ""

        # If json_schema is requested but model doesn't support strict mode,
        # inject schema into system prompt and use json_object mode instead.
        use_strict = (
            json_schema is not None and self.model in self._STRICT_SCHEMA_MODELS
        )
        use_json_object = json_schema is not None and not use_strict

        if use_json_object and json_schema:
            schema_instruction = (
                "\n\nYou MUST respond with valid JSON matching this exact schema:\n"
                f"```json\n{_json.dumps(json_schema, indent=2)}\n```\n"
                "Do NOT include any text outside the JSON object."
            )
            effective_system += schema_instruction

        if effective_system:
            messages.append({"role": "system", "content": effective_system})
        messages.append({"role": "user", "content": prompt})

        call_kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        if use_strict and json_schema:
            call_kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "response_schema",
                    "strict": True,
                    "schema": self._make_strict_schema(json_schema),
                },
            }
        elif use_json_object or json_mode:
            call_kwargs["response_format"] = {"type": "json_object"}

        resp = await self._client.chat.completions.create(**call_kwargs)
        self._track_rate_limits(resp)
        choice = resp.choices[0]
        text = choice.message.content or ""

        log.debug(
            "Groq: %d chars, model=%s, finish=%s, schema=%s",
            len(text),
            self.model,
            choice.finish_reason,
            "strict" if use_strict else ("json_object" if use_json_object or json_mode else "none"),
        )

        return LLMResponse(
            text=text,
            model=self.model,
            finish_reason=choice.finish_reason,
        )

    async def generate_with_tools(
        self,
        prompt: str,
        *,
        system: str | None = None,
        tools: list[dict[str, Any]],
        tool_executor: dict[str, Any],
        temperature: float = 0.1,
        max_rounds: int = 3,
        max_tokens: int = 4096,
    ) -> LLMResponse:
        """Multi-turn tool-use loop with OpenAI-style tool calling."""
        import inspect
        import json

        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        last_text = ""

        for _round in range(max_rounds):
            resp = await self._client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=tools,
            )
            choice = resp.choices[0]
            last_text = choice.message.content or ""

            # No tool calls — model is done
            if not choice.message.tool_calls:
                return LLMResponse(
                    text=last_text,
                    model=self.model,
                    finish_reason=choice.finish_reason,
                )

            # Process tool calls
            messages.append(choice.message.model_dump())

            for tc in choice.message.tool_calls:
                fn_name = tc.function.name
                fn_args = json.loads(tc.function.arguments)

                log.info("Tool call: %s(%s)", fn_name, json.dumps(fn_args)[:200])

                executor = tool_executor.get(fn_name)
                if executor and callable(executor):
                    try:
                        if inspect.iscoroutinefunction(executor):
                            result = await executor(**fn_args)
                        else:
                            result = executor(**fn_args)
                    except Exception as exc:
                        result = f"Error executing {fn_name}: {exc}"
                else:
                    result = f"Unknown tool: {fn_name}"

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": (
                            json.dumps(result)
                            if not isinstance(result, str)
                            else result
                        ),
                    }
                )

        return LLMResponse(
            text=last_text,
            model=self.model,
            finish_reason="max_rounds",
        )

    async def is_healthy(self) -> bool:
        """Check if Groq API is reachable."""
        try:
            await self._client.models.list()
            return True
        except Exception:
            return False

    def _track_rate_limits(self, resp: Any) -> None:
        """Extract rate limit info from Groq response headers when available."""
        self._total_requests += 1
        self._last_updated = time.time()
        get_store().set_llm_usage("groq", self._total_requests)
        try:
            # The openai SDK exposes response headers via _response
            headers = getattr(resp, '_response', None)
            if headers is not None:
                raw = getattr(headers, 'headers', {})
                for key, attr in [
                    ('x-ratelimit-limit-requests', 'limit_requests'),
                    ('x-ratelimit-remaining-requests', 'remaining_requests'),
                    ('x-ratelimit-limit-tokens', 'limit_tokens'),
                    ('x-ratelimit-remaining-tokens', 'remaining_tokens'),
                ]:
                    val = raw.get(key)
                    if val is not None:
                        try:
                            self._last_rate_limits[attr] = int(val)
                        except (ValueError, TypeError):
                            pass
        except Exception:
            pass  # Non-fatal — header tracking is best-effort

    def get_usage_stats(self) -> dict[str, Any]:
        """Return current usage stats and known rate limits."""
        limits = GROQ_MODEL_LIMITS.get(self.model, {})
        return {
            "model": self.model,
            "total_requests": self._total_requests,
            "known_limits": limits,
            "live_headers": {
                k: v for k, v in self._last_rate_limits.items() if v is not None
            },
            "last_updated": self._last_updated if self._last_updated else None,
        }

    @staticmethod
    def _make_strict_schema(schema: dict) -> dict:
        """Normalize JSON schema for Groq strict constrained decoding.

        Groq strict mode requires:
        - All properties listed in ``required``
        - ``additionalProperties: false`` on all objects
        - No ``minimum``/``maximum``/``maxLength`` (unsupported)
        """

        def convert(s: dict) -> dict:
            out = dict(s)
            if out.get("type") == "object" and "properties" in out:
                # Strict mode: all properties must be required
                out["required"] = list(out["properties"].keys())
                out["additionalProperties"] = False
                out["properties"] = {
                    k: convert(v) for k, v in out["properties"].items()
                }
            if "items" in out:
                out["items"] = convert(out["items"])
            # Remove keywords not supported by Groq strict mode
            out.pop("minimum", None)
            out.pop("maximum", None)
            out.pop("maxLength", None)
            return out

        return convert(schema)
