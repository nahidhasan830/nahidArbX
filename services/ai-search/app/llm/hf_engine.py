"""HFEngine — HuggingFace Inference Router (OpenAI-compatible).

Uses the ``openai`` AsyncOpenAI SDK pointed at
``https://router.huggingface.co/v1``.

Pro credits give high rate limits.  When credits run out the API returns
HTTP 402 — we flag ``is_exhausted`` so the FallbackEngine can skip us.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import openai
from openai import AsyncOpenAI

from app.llm.groq_engine import LLMResponse
from app.quota_store import get_store

log = logging.getLogger("ai-search.hf")

HF_BASE_URL = "https://router.huggingface.co/v1"
DEFAULT_HF_MODEL = "meta-llama/Llama-3.3-70B-Instruct"
DEFAULT_ROUTING = "fastest"


class CreditsExhaustedError(Exception):
    """Raised when HuggingFace returns HTTP 402 (monthly credits used up)."""


class HFEngine:
    """HuggingFace Inference Router — OpenAI-compatible, Pro credits.

    Usage::

        engine = HFEngine(api_key="hf_...", model="meta-llama/Llama-3.3-70B-Instruct")
        resp = await engine.generate("What is 2+2?")
        print(resp.text)
    """

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_HF_MODEL,
        routing: str = DEFAULT_ROUTING,
    ) -> None:
        self.model: str = model
        self._routing: str = routing
        self._client: AsyncOpenAI = AsyncOpenAI(
            base_url=HF_BASE_URL,
            api_key=api_key,
        )
        self._credits_exhausted: bool = False
        self._total_requests: int = get_store().get_llm_usage("huggingface")
        self._last_updated: float = 0.0
        if self._total_requests > 0:
            log.info("Restored HF usage: %d requests", self._total_requests)

    @property
    def is_exhausted(self) -> bool:
        """True when HF returned 402 — credits used up."""
        return self._credits_exhausted

    @property
    def _routed_model(self) -> str:
        """Model name with routing suffix for the HF Router."""
        return f"{self.model}:{self._routing}"

    # ── generate ─────────────────────────────────────────────────────

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
        """Generate a completion via HuggingFace Router.

        When ``json_schema`` is provided, injects the schema into the
        system prompt and uses ``json_object`` response format (HF Router
        does not support strict constrained decoding across all providers).
        """
        import json as _json

        messages: list[dict[str, Any]] = []
        effective_system = system or ""

        # Inject schema into system prompt + use json_object mode
        use_json_object = json_schema is not None

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
            "model": self._routed_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        if use_json_object or json_mode:
            call_kwargs["response_format"] = {"type": "json_object"}

        resp = await self._call(call_kwargs)
        choice = resp.choices[0]
        text = choice.message.content or ""

        self._total_requests += 1
        self._last_updated = time.time()
        get_store().set_llm_usage("huggingface", self._total_requests)

        log.debug(
            "HF: %d chars, model=%s, finish=%s",
            len(text),
            self.model,
            choice.finish_reason,
        )

        return LLMResponse(
            text=text,
            model=self.model,
            finish_reason=choice.finish_reason,
        )

    # ── generate_with_tools ──────────────────────────────────────────

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
        """Multi-turn tool-use loop — same interface as GroqEngine."""
        import inspect
        import json

        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        last_text = ""

        for _round in range(max_rounds):
            resp = await self._call({
                "model": self._routed_model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "tools": tools,
            })
            choice = resp.choices[0]
            last_text = choice.message.content or ""

            self._total_requests += 1
            self._last_updated = time.time()
            get_store().set_llm_usage("huggingface", self._total_requests)

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

    # ── health / stats ───────────────────────────────────────────────

    async def is_healthy(self) -> bool:
        """Check if HF Router is reachable. False if credits exhausted."""
        if self._credits_exhausted:
            return False
        try:
            await self._client.models.list()
            return True
        except Exception:
            return False

    def get_usage_stats(self) -> dict[str, Any]:
        """Return current usage stats."""
        return {
            "provider": "huggingface",
            "model": self.model,
            "routing": self._routing,
            "total_requests": self._total_requests,
            "credits_exhausted": self._credits_exhausted,
            "last_updated": self._last_updated if self._last_updated else None,
        }

    # ── internal ─────────────────────────────────────────────────────

    async def _call(self, kwargs: dict[str, Any]) -> Any:
        """Wrap the OpenAI SDK call, detecting HTTP 402 credits exhaustion."""
        try:
            return await self._client.chat.completions.create(**kwargs)
        except openai.APIStatusError as exc:
            if exc.status_code == 402:
                self._credits_exhausted = True
                log.warning("HF Router returned 402 — credits exhausted, flagging engine")
                raise CreditsExhaustedError("HuggingFace monthly credits exhausted") from exc
            raise
