"""Pydantic models shared across the module."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

# ── Search ───────────────────────────────────────────────────────────


class SearchResult(BaseModel):
    """A single search result from any provider."""

    title: str
    url: str
    snippet: str
    source: str  # provider name that returned this result
    score: float | None = None  # relevance score if available


class SearchResponse(BaseModel):
    """Response from the /search endpoint."""

    query: str
    results: list[SearchResult]
    provider_used: str
    cached: bool = False


# ── Events ───────────────────────────────────────────────────────────


class EventInfo(BaseModel):
    """Minimal event info for entity matching / settlement."""

    home_team: str
    away_team: str
    competition: str
    start_time: str  # ISO 8601
    provider: str | None = None


# ── Verdicts ─────────────────────────────────────────────────────────


class MatchDecision(str, Enum):
    SAME = "SAME"
    DIFFERENT = "DIFFERENT"
    UNCERTAIN = "UNCERTAIN"


class MatchVerdict(BaseModel):
    """Structured verdict from grounded entity matching."""

    decision: MatchDecision
    confidence: int = Field(ge=0, le=100)
    reasoning: str
    sources: list[SourceCitation] = []
    search_queries_used: list[str] = []
    model: str = ""


class SourceCitation(BaseModel):
    """A cited source from search results."""

    url: str
    title: str
    snippet: str = ""


class SettlementVerdict(BaseModel):
    """Verdict for settlement verification queries."""

    answer: str
    confidence: int = Field(ge=0, le=100)
    reasoning: str
    sources: list[SourceCitation] = []
    model: str = ""


class GroundedAnswer(BaseModel):
    """Generic grounded answer for ad-hoc queries."""

    answer: str
    reasoning: str
    sources: list[SourceCitation] = []
    model: str = ""


# ── Provider Stats ───────────────────────────────────────────────────


class ProviderStats(BaseModel):
    """Usage statistics for a single search provider."""

    name: str
    healthy: bool
    requests_used: int
    quota_limit: int | None
    quota_remaining: int | None
    quota_source: str = "local"  # "live" | "local" | "none"
    last_error: str | None = None
    last_used_at: str | None = None


class StatsResponse(BaseModel):
    """Response from the /stats endpoint."""

    providers: list[ProviderStats]
    total_searches: int
    llm_healthy: bool
    llm_model: str


# ── Request bodies ───────────────────────────────────────────────────


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    max_results: int = Field(default=5, ge=1, le=20)
    providers: list[str] | None = None  # force specific providers


class GroundedQueryRequest(BaseModel):
    question: str = Field(..., min_length=1)
    context: dict[str, Any] | None = None
    model: str | None = None  # override LLM model for this request


class EntityMatchRequest(BaseModel):
    event_a: EventInfo
    event_b: EventInfo
    llm_provider: str | None = None  # force a specific LLM engine ("huggingface", "groq")


class BatchEntityMatchRequest(BaseModel):
    """Batch of event pairs to match in a single grounded AI call."""

    pairs: list[EntityMatchRequest] = Field(..., min_length=1, max_length=20)


class PairVerdict(BaseModel):
    """Verdict for a single pair within a batch response."""

    pair_index: int
    decision: MatchDecision
    confidence: int = Field(ge=0, le=100)
    reasoning: str


class BatchMatchVerdict(BaseModel):
    """Response from batch entity matching — one verdict per pair."""

    verdicts: list[PairVerdict]
    sources: list[SourceCitation] = []
    search_queries_used: list[str] = []
    model: str = ""


class SettlementRequest(BaseModel):
    event: EventInfo
    question: str = Field(..., min_length=1)
