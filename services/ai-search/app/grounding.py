"""GroundedAI — search-grounded inference orchestrator.

Combines the SearchRouter (multi-provider web search) with GroqEngine
(cloud LLM via Groq API) to produce verdicts backed by web evidence.

Two modes of operation:
1. **Pre-search** — search first, inject results as context, then LLM.
   Simpler, uses fewer LLM calls, works even without tool-calling support.
2. **Tool-use** — let the LLM decide when to search via function calling.
   More flexible, better for complex disambiguation.

Default: pre-search (reliable). Set `use_tools=True` for tool-use mode.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any

from cachetools import TTLCache

from app.config import Config
from app.llm.prompts import (
    ENTITY_MATCH_BATCH_PROMPT_TEMPLATE,
    ENTITY_MATCH_BATCH_SCHEMA,
    ENTITY_MATCH_BATCH_SYSTEM,
    ENTITY_MATCH_PROMPT_TEMPLATE,
    ENTITY_MATCH_SCHEMA,
    ENTITY_MATCH_SYSTEM,
    GENERIC_PROMPT_TEMPLATE,
    GENERIC_QUERY_SCHEMA,
    GENERIC_SYSTEM,
    SEARCH_TOOL_DEFINITION,
    SETTLEMENT_PROMPT_TEMPLATE,
    SETTLEMENT_SCHEMA,
    SETTLEMENT_SYSTEM,
)
from app.models import (
    BatchMatchVerdict,
    EventInfo,
    GroundedAnswer,
    MatchDecision,
    MatchVerdict,
    PairVerdict,
    SearchResult,
    SettlementVerdict,
    SourceCitation,
)
from app.search.router import SearchRouter

log = logging.getLogger("ai-search.grounding")


class GroundedAI:
    """Search-grounded AI inference engine.

    Usage::

        cfg = load_config()
        router = SearchRouter(cfg)
        engine = GroqEngine(api_key="gsk_...")
        ai = GroundedAI(router, engine, cfg)

        verdict = await ai.entity_match(event_a, event_b)
    """

    def __init__(
        self,
        search_router: SearchRouter,
        llm_engine: Any,
        config: Config,
    ) -> None:
        self.search = search_router
        self.llm = llm_engine
        self.config = config

        # Caches keyed by a string hash of the request
        self._match_cache: TTLCache = TTLCache(
            maxsize=config.cache_max_size,
            ttl=config.cache_ttl_entity_match,
        )
        self._settlement_cache: TTLCache = TTLCache(
            maxsize=config.cache_max_size,
            ttl=config.cache_ttl_settlement,
        )

    # ── Entity matching ──────────────────────────────────────────────

    async def entity_match(
        self,
        event_a: EventInfo,
        event_b: EventInfo,
        *,
        use_tools: bool = False,
    ) -> MatchVerdict:
        """Determine if two events are the same real-world match.

        Steps:
        1. Check cache.
        2. Build search queries from team/competition names.
        3. Search web for evidence (fan-out to 2 providers).
        4. Feed evidence to LLM → structured verdict.
        5. Cache and return.
        """
        cache_key = self._match_cache_key(event_a, event_b)
        if cache_key in self._match_cache:
            log.info("Entity match cache hit: %s", cache_key[:60])
            return self._match_cache[cache_key]

        if use_tools:
            verdict = await self._entity_match_with_tools(event_a, event_b)
        else:
            verdict = await self._entity_match_presearch(event_a, event_b)

        self._match_cache[cache_key] = verdict
        return verdict

    async def _entity_match_presearch(
        self, event_a: EventInfo, event_b: EventInfo
    ) -> MatchVerdict:
        """Pre-search mode: search first, then single LLM call."""
        # Step 1: Build targeted search queries
        queries = self._build_match_queries(event_a, event_b)
        all_evidence: list[SearchResult] = []
        queries_used: list[str] = []

        # Step 2: Search (failover — tries providers in priority order)
        for q in queries[:2]:  # max 2 queries to conserve quota
            results, _provider = await self.search.search(q, max_results=3)
            all_evidence.extend(results)
            queries_used.append(q)

        # Step 3: Format prompt with evidence
        evidence_text = self._format_evidence(all_evidence)
        prompt = ENTITY_MATCH_PROMPT_TEMPLATE.format(
            provider_a=event_a.provider or "Unknown",
            home_a=event_a.home_team,
            away_a=event_a.away_team,
            comp_a=event_a.competition,
            time_a=self._format_time(event_a.start_time),
            provider_b=event_b.provider or "Unknown",
            home_b=event_b.home_team,
            away_b=event_b.away_team,
            comp_b=event_b.competition,
            time_b=self._format_time(event_b.start_time),
        )
        if evidence_text:
            prompt += f"\n\nWEB SEARCH EVIDENCE:\n{evidence_text}"

        # Step 4: LLM verdict — json_object mode with schema instructions
        resp = await self.llm.generate(
            prompt, system=ENTITY_MATCH_SYSTEM,
            json_schema=ENTITY_MATCH_SCHEMA, max_tokens=256,
        )

        return self._parse_match_verdict(
            resp.text, resp.model, all_evidence, queries_used
        )

    # ── Batch entity matching ──────────────────────────────────────────

    async def entity_match_batch(
        self,
        pairs: list[tuple[EventInfo, EventInfo]],
    ) -> BatchMatchVerdict:
        """Match multiple event pairs in a single grounded AI call.

        Steps:
        1. Format all pairs in the natural one-line format.
        2. Extract unique disambiguation needs across ALL pairs.
        3. Deduplicate and batch-search (far fewer API calls than 1-by-1).
        4. Feed all pairs + all evidence to the LLM in one prompt.
        5. Parse N verdicts from a single JSON array response.
        """
        if not pairs:
            return BatchMatchVerdict(verdicts=[], model="")

        # Step 1: Build the natural-format pairs text
        pairs_lines: list[str] = []
        for i, (a, b) in enumerate(pairs, 1):
            time_a = self._format_time(a.start_time)
            time_b = self._format_time(b.start_time)
            pairs_lines.append(
                f'{i}. "{a.home_team} vs {a.away_team}", {time_a}, '
                f'{a.competition} ({a.provider or "Unknown"})'
                f'  \u2194  '
                f'"{b.home_team} vs {b.away_team}", {time_b}, '
                f'{b.competition} ({b.provider or "Unknown"})'
            )
        pairs_text = "\n".join(pairs_lines)

        # Step 2: Extract unique search queries (deduplicated across pairs)
        queries = self._build_batch_queries(pairs)
        all_evidence: list[SearchResult] = []
        queries_used: list[str] = []

        # Step 3: Search (max 6 queries to conserve quota, failover)
        for q in queries[:6]:
            results, _provider = await self.search.search(
                q, max_results=3
            )
            all_evidence.extend(results)
            queries_used.append(q)

        # Step 4: Build prompt with evidence (higher limit for batch)
        evidence_text = self._format_evidence(all_evidence, max_items=15)
        prompt = ENTITY_MATCH_BATCH_PROMPT_TEMPLATE.format(pairs_text=pairs_text)
        if evidence_text:
            prompt += f"\n\nWEB SEARCH EVIDENCE:\n{evidence_text}"

        # Step 5: Single LLM call for all pairs
        resp = await self.llm.generate(
            prompt, system=ENTITY_MATCH_BATCH_SYSTEM,
            json_schema=ENTITY_MATCH_BATCH_SCHEMA,
            max_tokens=min(256 * len(pairs), 4096),
        )

        return self._parse_batch_verdict(
            resp.text, resp.model, len(pairs), all_evidence, queries_used
        )


    async def _entity_match_with_tools(
        self, event_a: EventInfo, event_b: EventInfo
    ) -> MatchVerdict:
        """Tool-use mode: let the LLM decide when to search."""
        prompt = ENTITY_MATCH_PROMPT_TEMPLATE.format(
            provider_a=event_a.provider or "Unknown",
            home_a=event_a.home_team,
            away_a=event_a.away_team,
            comp_a=event_a.competition,
            time_a=self._format_time(event_a.start_time),
            provider_b=event_b.provider or "Unknown",
            home_b=event_b.home_team,
            away_b=event_b.away_team,
            comp_b=event_b.competition,
            time_b=self._format_time(event_b.start_time),
        )

        # Collect evidence from tool calls for citations
        all_evidence: list[SearchResult] = []
        queries_used: list[str] = []

        async def web_search(query: str) -> str:
            """Tool executor: search the web and return formatted results."""
            results, _provider = await self.search.search(query, max_results=3)
            all_evidence.extend(results)
            queries_used.append(query)
            return self._format_evidence(results)

        resp = await self.llm.generate_with_tools(
            prompt,
            system=ENTITY_MATCH_SYSTEM,
            tools=[SEARCH_TOOL_DEFINITION],
            tool_executor={"web_search": web_search},
            max_rounds=3,
        )

        return self._parse_match_verdict(
            resp.text, resp.model, all_evidence, queries_used
        )

    # ── Settlement verification ──────────────────────────────────────

    async def verify_settlement(
        self,
        event: EventInfo,
        question: str,
        *,
        use_tools: bool = False,
    ) -> SettlementVerdict:
        """Verify a match result or statistic for bet settlement."""
        cache_key = (
            f"settle:{event.home_team}:{event.away_team}:{event.start_time}:{question}"
        )
        if cache_key in self._settlement_cache:
            return self._settlement_cache[cache_key]

        if use_tools:
            verdict = await self._settlement_with_tools(event, question)
        else:
            verdict = await self._settlement_presearch(event, question)

        self._settlement_cache[cache_key] = verdict
        return verdict

    async def _settlement_presearch(
        self, event: EventInfo, question: str
    ) -> SettlementVerdict:
        """Pre-search settlement verification."""
        date_str = (
            event.start_time[:10] if len(event.start_time) >= 10 else event.start_time
        )
        query = f"{event.home_team} vs {event.away_team} {event.competition} {date_str} result score"
        results, _ = await self.search.search(query, max_results=5)

        evidence_text = self._format_evidence(results)
        prompt = SETTLEMENT_PROMPT_TEMPLATE.format(
            home=event.home_team,
            away=event.away_team,
            competition=event.competition,
            date=date_str,
            question=question,
        )
        if evidence_text:
            prompt += f"\n\nWEB SEARCH EVIDENCE:\n{evidence_text}"

        resp = await self.llm.generate(
            prompt, system=SETTLEMENT_SYSTEM,
            json_schema=SETTLEMENT_SCHEMA,
        )

        return self._parse_settlement_verdict(resp.text, resp.model, results)

    async def _settlement_with_tools(
        self, event: EventInfo, question: str
    ) -> SettlementVerdict:
        """Tool-use settlement verification."""
        date_str = (
            event.start_time[:10] if len(event.start_time) >= 10 else event.start_time
        )
        prompt = SETTLEMENT_PROMPT_TEMPLATE.format(
            home=event.home_team,
            away=event.away_team,
            competition=event.competition,
            date=date_str,
            question=question,
        )

        all_evidence: list[SearchResult] = []

        async def web_search(query: str) -> str:
            results, _ = await self.search.search(query, max_results=5)
            all_evidence.extend(results)
            return self._format_evidence(results)

        resp = await self.llm.generate_with_tools(
            prompt,
            system=SETTLEMENT_SYSTEM,
            tools=[SEARCH_TOOL_DEFINITION],
            tool_executor={"web_search": web_search},
        )

        return self._parse_settlement_verdict(resp.text, resp.model, all_evidence)

    # ── Generic grounded query ───────────────────────────────────────

    async def query(
        self,
        question: str,
        context: dict | None = None,
        *,
        use_tools: bool = False,
        model_override: str | None = None,
    ) -> GroundedAnswer:
        """Answer an arbitrary question with web search grounding."""
        # Temporarily override engine model if requested
        original_model: str | None = None
        if model_override:
            original_model = self.llm.model
            self.llm.model = model_override

        try:
            return await self._query_inner(question, context, use_tools=use_tools)
        finally:
            if original_model is not None:
                self.llm.model = original_model

    async def _query_inner(
        self,
        question: str,
        context: dict | None = None,
        *,
        use_tools: bool = False,
    ) -> GroundedAnswer:
        """Internal query implementation."""
        context_section = ""
        if context:
            context_section = "Additional context:\n" + json.dumps(context, indent=2)

        if use_tools:
            all_evidence: list[SearchResult] = []

            async def web_search(query: str) -> str:
                results, _ = await self.search.search(query, max_results=5)
                all_evidence.extend(results)
                return self._format_evidence(results)

            prompt = GENERIC_PROMPT_TEMPLATE.format(
                question=question, context_section=context_section
            )
            resp = await self.llm.generate_with_tools(
                prompt,
                system=GENERIC_SYSTEM,
                tools=[SEARCH_TOOL_DEFINITION],
                tool_executor={"web_search": web_search},
            )
            sources = self._results_to_citations(all_evidence)
        else:
            # Pre-search
            results, _ = await self.search.search(question, max_results=5)
            evidence_text = self._format_evidence(results)

            prompt = GENERIC_PROMPT_TEMPLATE.format(
                question=question, context_section=context_section
            )
            if evidence_text:
                prompt += f"\n\nWEB SEARCH EVIDENCE:\n{evidence_text}"

            resp = await self.llm.generate(
                prompt, system=GENERIC_SYSTEM,
                json_schema=GENERIC_QUERY_SCHEMA,
            )
            sources = self._results_to_citations(results)

        try:
            data = json.loads(resp.text)
        except json.JSONDecodeError:
            data = {"answer": resp.text, "reasoning": ""}

        return GroundedAnswer(
            answer=data.get("answer", resp.text),
            reasoning=data.get("reasoning", ""),
            sources=sources,
            model=resp.model,
        )

    # ── Helpers ──────────────────────────────────────────────────────

    def _build_match_queries(self, event_a: EventInfo, event_b: EventInfo) -> list[str]:
        """Generate search queries for entity disambiguation.

        Returns 1-3 queries targeting the most ambiguous aspects.
        """
        queries = []

        # Query 1: Primary — are these the same team?
        # Pick the shorter/more ambiguous team name
        if event_a.home_team.lower() != event_b.home_team.lower():
            queries.append(
                f'Is "{event_a.home_team}" the same football team as '
                f'"{event_b.home_team}"? {event_a.competition} vs {event_b.competition}'
            )

        # Query 2: Competition verification
        if event_a.competition.lower() != event_b.competition.lower():
            queries.append(
                f'"{event_a.competition}" vs "{event_b.competition}" — '
                f"same football league/tournament? "
                f"{event_a.home_team} vs {event_a.away_team}"
            )

        # Query 3: General match lookup
        date_str = event_a.start_time[:10] if len(event_a.start_time) >= 10 else ""
        queries.append(
            f"{event_a.home_team} vs {event_a.away_team} {date_str} "
            f"{event_a.competition} match schedule"
        )

        return queries

    @staticmethod
    def _format_evidence(results: list[SearchResult], *, max_items: int = 8) -> str:
        """Format search results as text for LLM context."""
        if not results:
            return ""
        # Deduplicate by URL before formatting
        seen: set[str] = set()
        unique: list[SearchResult] = []
        for r in results:
            url_key = r.url.rstrip("/").lower()
            if url_key not in seen:
                seen.add(url_key)
                unique.append(r)
        lines: list[str] = []
        for i, r in enumerate(unique[:max_items], 1):
            lines.append(f"[{i}] {r.title}")
            lines.append(f"    URL: {r.url}")
            lines.append(f"    {r.snippet[:300]}")
            lines.append("")
        return "\n".join(lines)

    @staticmethod
    def _results_to_citations(
        results: list[SearchResult],
    ) -> list[SourceCitation]:
        """Convert SearchResults to SourceCitations for the response."""
        seen: set[str] = set()
        citations: list[SourceCitation] = []
        for r in results:
            url_key = r.url.rstrip("/").lower()
            if url_key not in seen:
                seen.add(url_key)
                citations.append(
                    SourceCitation(
                        url=r.url,
                        title=r.title,
                        snippet=r.snippet[:200],
                    )
                )
        return citations

    @staticmethod
    def _sanitize_json(text: str) -> str:
        r"""Fix invalid backslash escapes that LLMs embed (e.g. LaTeX \text{}).

        JSON only allows: \" \\ \/ \b \f \n \r \t \uXXXX
        Any other \X sequence is illegal.  We double the backslash so
        json.loads sees a literal backslash instead of choking.
        """
        # Match a backslash NOT followed by a valid JSON escape char
        return re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", text)

    @staticmethod
    def _try_parse_json(raw_text: str) -> dict | list | None:
        """Extract JSON from LLM output, tolerating markdown fences and prose.

        Tries, in order:
          1. Direct json.loads (fast path).
          2. Strip ```json ... ``` fences and retry.
          3. Find the first { ... } or [ ... ] substring and parse that.
          4. After extraction, sanitize invalid escape sequences and retry.

        Returns the parsed dict/list or None on total failure.
        """
        text = raw_text.strip()

        # 1. Fast path — clean JSON
        try:
            return json.loads(text)
        except (json.JSONDecodeError, ValueError):
            pass

        # 2. Strip markdown code fences
        fenced = re.sub(r"^```(?:json)?\s*", "", text, flags=re.MULTILINE)
        fenced = re.sub(r"\s*```\s*$", "", fenced, flags=re.MULTILINE).strip()
        if fenced != text:
            try:
                return json.loads(fenced)
            except (json.JSONDecodeError, ValueError):
                pass

        # 3. Greedy extraction — find outermost { ... } or [ ... ]
        for open_ch, close_ch in [("{", "}"), ("[", "]")]:
            start = text.find(open_ch)
            if start == -1:
                continue
            depth = 0
            in_str = False
            escape = False
            for i in range(start, len(text)):
                ch = text[i]
                if escape:
                    escape = False
                    continue
                if ch == "\\" and in_str:
                    escape = True
                    continue
                if ch == '"' and not escape:
                    in_str = not in_str
                    continue
                if in_str:
                    continue
                if ch == open_ch:
                    depth += 1
                elif ch == close_ch:
                    depth -= 1
                    if depth == 0:
                        candidate = text[start : i + 1]
                        try:
                            return json.loads(candidate)
                        except (json.JSONDecodeError, ValueError):
                            pass
                        # 4. Sanitize invalid escapes and retry
                        try:
                            return json.loads(
                                GroundedAI._sanitize_json(candidate)
                            )
                        except (json.JSONDecodeError, ValueError):
                            break
            # If we get here, the bracket search for this char failed; try next.

        return None

    @staticmethod
    def _regex_extract_verdict(raw_text: str) -> dict | None:
        r"""Last-resort extraction of decision + confidence via regex.

        When the LLM degenerates (e.g. repeating tokens making the JSON
        unclosable), we can still salvage the key fields that appeared
        early in the output.  Returns a minimal dict or None.
        """
        dec_m = re.search(
            r'"decision"\s*:\s*"(SAME|DIFFERENT|UNCERTAIN)"',
            raw_text,
            re.IGNORECASE,
        )
        if not dec_m:
            return None

        conf_m = re.search(r'"confidence"\s*:\s*(\d+)', raw_text)
        confidence = int(conf_m.group(1)) if conf_m else 50

        # Try to grab reasoning (may be truncated, that's OK)
        reason_m = re.search(r'"reasoning"\s*:\s*"((?:[^"\\]|\\.){0,500})', raw_text)
        reasoning = reason_m.group(1) if reason_m else "(extracted from malformed LLM output)"

        return {
            "decision": dec_m.group(1).upper(),
            "confidence": confidence,
            "reasoning": reasoning,
        }

    def _parse_match_verdict(
        self,
        raw_text: str,
        model: str,
        evidence: list[SearchResult],
        queries_used: list[str],
    ) -> MatchVerdict:
        """Parse LLM JSON output into a MatchVerdict."""
        data = self._try_parse_json(raw_text)
        if data is None or not isinstance(data, dict):
            # Last resort: regex-extract decision + confidence from truncated JSON
            data = self._regex_extract_verdict(raw_text)
            if data is None:
                log.warning("Failed to parse LLM JSON: %s", raw_text[:200])
                return MatchVerdict(
                    decision=MatchDecision.UNCERTAIN,
                    confidence=30,
                    reasoning=f"Failed to parse LLM response: {raw_text[:200]}",
                    sources=self._results_to_citations(evidence),
                    search_queries_used=queries_used,
                    model=model,
                )

        decision_str = data.get("decision", "UNCERTAIN").upper()
        if decision_str not in ("SAME", "DIFFERENT", "UNCERTAIN"):
            decision_str = "UNCERTAIN"

        return MatchVerdict(
            decision=MatchDecision(decision_str),
            confidence=max(0, min(100, int(data.get("confidence", 50)))),
            reasoning=data.get("reasoning", ""),
            sources=self._results_to_citations(evidence),
            search_queries_used=queries_used,
            model=model,
        )

    def _parse_settlement_verdict(
        self,
        raw_text: str,
        model: str,
        evidence: list[SearchResult],
    ) -> SettlementVerdict:
        """Parse LLM JSON output into a SettlementVerdict."""
        try:
            data = json.loads(raw_text)
        except json.JSONDecodeError:
            return SettlementVerdict(
                answer=raw_text[:500],
                confidence=20,
                reasoning="Failed to parse LLM response as JSON",
                sources=self._results_to_citations(evidence),
                model=model,
            )

        return SettlementVerdict(
            answer=data.get("answer", ""),
            confidence=max(0, min(100, int(data.get("confidence", 50)))),
            reasoning=data.get("reasoning", ""),
            sources=self._results_to_citations(evidence),
            model=model,
        )

    @staticmethod
    def _match_cache_key(event_a: EventInfo, event_b: EventInfo) -> str:
        """Deterministic cache key for an event pair."""
        parts = sorted(
            [
                f"{event_a.home_team}|{event_a.away_team}|{event_a.competition}",
                f"{event_b.home_team}|{event_b.away_team}|{event_b.competition}",
            ]
        )
        return f"match:{parts[0]}::{parts[1]}"

    def _build_batch_queries(
        self, pairs: list[tuple[EventInfo, EventInfo]]
    ) -> list[str]:
        """Build deduplicated search queries across all pairs.

        Extracts unique disambiguation needs (team aliases, league names)
        so we don't search for the same thing multiple times.
        """
        # Collect unique name mismatches needing verification
        team_questions: set[str] = set()
        comp_questions: set[str] = set()
        match_lookups: set[str] = set()

        for a, b in pairs:
            # Team name mismatches
            if a.home_team.lower() != b.home_team.lower():
                key = tuple(sorted([a.home_team.lower(), b.home_team.lower()]))
                team_questions.add(
                    f'"{a.home_team}" "{b.home_team}" football team same club'
                )

            if a.away_team.lower() != b.away_team.lower():
                key = tuple(sorted([a.away_team.lower(), b.away_team.lower()]))
                team_questions.add(
                    f'"{a.away_team}" "{b.away_team}" football team same club'
                )

            # Competition name mismatches
            if a.competition.lower() != b.competition.lower():
                key = tuple(sorted([a.competition.lower(), b.competition.lower()]))
                comp_questions.add(
                    f'"{a.competition}" "{b.competition}" football league'
                )

            # General match schedule lookup (one per pair, deduped)
            date_str = a.start_time[:10] if len(a.start_time) >= 10 else ""
            if date_str:
                match_lookups.add(
                    f"{a.home_team} vs {a.away_team} {date_str} {a.competition}"
                )

        # Priority order: team disambiguation > comp > match lookup
        queries: list[str] = []
        queries.extend(sorted(team_questions))
        queries.extend(sorted(comp_questions))
        queries.extend(sorted(match_lookups))

        return queries

    def _parse_batch_verdict(
        self,
        raw_text: str,
        model: str,
        expected_count: int,
        evidence: list[SearchResult],
        queries_used: list[str],
    ) -> BatchMatchVerdict:
        """Parse LLM JSON array output into a BatchMatchVerdict."""
        sources = self._results_to_citations(evidence)

        data = self._try_parse_json(raw_text)
        if data is None:
            log.warning("Batch: failed to parse LLM JSON: %s", raw_text[:300])
            # Return UNCERTAIN for all pairs
            return BatchMatchVerdict(
                verdicts=[
                    PairVerdict(
                        pair_index=i,
                        decision=MatchDecision.UNCERTAIN,
                        confidence=30,
                        reasoning="Failed to parse LLM batch response",
                    )
                    for i in range(expected_count)
                ],
                sources=sources,
                search_queries_used=queries_used,
                model=model,
            )

        # Handle both array and object-with-array responses
        items: list[dict] = []
        if isinstance(data, list):
            items = data
        elif isinstance(data, dict):
            # LLM might wrap in {"results": [...]} or {"verdicts": [...]}
            for key in ("results", "verdicts", "pairs"):
                if key in data and isinstance(data[key], list):
                    items = data[key]
                    break
            if not items:
                items = [data]  # single object, treat as 1-item batch

        verdicts: list[PairVerdict] = []
        for i in range(expected_count):
            if i < len(items):
                item = items[i]
                decision_str = str(item.get("decision", "UNCERTAIN")).upper()
                if decision_str not in ("SAME", "DIFFERENT", "UNCERTAIN"):
                    decision_str = "UNCERTAIN"
                verdicts.append(
                    PairVerdict(
                        pair_index=i,
                        decision=MatchDecision(decision_str),
                        confidence=max(0, min(100, int(item.get("confidence", 50)))),
                        reasoning=item.get("reasoning", ""),
                    )
                )
            else:
                # LLM returned fewer items than pairs — fill with UNCERTAIN
                verdicts.append(
                    PairVerdict(
                        pair_index=i,
                        decision=MatchDecision.UNCERTAIN,
                        confidence=30,
                        reasoning="LLM did not return a verdict for this pair",
                    )
                )

        return BatchMatchVerdict(
            verdicts=verdicts,
            sources=sources,
            search_queries_used=queries_used,
            model=model,
        )

    @staticmethod
    def _format_time(iso_time: str) -> str:
        """Extract a human-readable time from an ISO timestamp.

        '2025-05-02T14:30:00Z' → '14:30'
        '2025-05-02T14:30:00+06:00' → '14:30'
        Short/malformed strings pass through unchanged.
        """
        if len(iso_time) >= 16 and "T" in iso_time:
            return iso_time[11:16]
        return iso_time
