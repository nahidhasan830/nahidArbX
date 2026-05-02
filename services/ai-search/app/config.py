"""Configuration — all settings from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load the root .env so BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, SERPER_API_KEY
# (and other vars) are visible to this Python process.
_repo_root = Path(__file__).resolve().parents[3]  # app/ -> ai-search/ -> services/ -> repo root
_dotenv_path = _repo_root / ".env"
load_dotenv(_dotenv_path)


@dataclass(frozen=True)
class Config:
    """Immutable configuration snapshot read from env vars at startup."""

    # ── Search provider API keys ─────────────────────────────────────
    brave_api_key: str = ""
    tavily_api_key: str = ""
    serper_api_key: str = ""
    # DDG needs no key

    # ── Groq (cloud LLM, free tier) ──────────────────────────────────
    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"

    # ── HuggingFace Router (primary while Pro credits last) ──────────
    hf_api_key: str = ""
    hf_model: str = "meta-llama/Llama-3.3-70B-Instruct"
    hf_routing: str = "fastest"

    # ── Service ──────────────────────────────────────────────────────
    port: int = 8090

    # ── Quota tracking (monthly resets) ──────────────────────────────
    brave_monthly_limit: int = 1000
    tavily_monthly_limit: int = 1000
    serper_total_limit: int = 2500  # one-time, not monthly

    # ── Cache ────────────────────────────────────────────────────────
    cache_ttl_entity_match: int = 86400  # 24 hours
    cache_ttl_settlement: int = 3600  # 1 hour
    cache_ttl_search: int = 1800  # 30 minutes
    cache_max_size: int = 2000


def load_config() -> Config:
    """Build Config from environment variables."""
    return Config(
        brave_api_key=os.getenv("BRAVE_SEARCH_API_KEY", ""),
        tavily_api_key=os.getenv("TAVILY_API_KEY", ""),
        serper_api_key=os.getenv("SERPER_API_KEY", ""),
        groq_api_key=os.getenv("GROQ_API_KEY", ""),
        groq_model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
        hf_api_key=os.getenv("HF_API_KEY", ""),
        hf_model=os.getenv("HF_MODEL", "meta-llama/Llama-3.3-70B-Instruct"),
        hf_routing=os.getenv("HF_ROUTING", "fastest"),
        port=int(os.getenv("AI_SEARCH_PORT", "8090")),
        brave_monthly_limit=int(os.getenv("BRAVE_MONTHLY_LIMIT", "1000")),
        tavily_monthly_limit=int(os.getenv("TAVILY_MONTHLY_LIMIT", "1000")),
        serper_total_limit=int(os.getenv("SERPER_TOTAL_LIMIT", "2500")),
    )
