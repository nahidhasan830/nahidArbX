"""Smoke tests for the SearchRouter and individual providers.

These tests hit real APIs (when keys are configured) to validate that
the provider implementations actually work.  Run with:

    cd services/ai-search
    pytest tests/test_search.py -v -s
"""

from __future__ import annotations

import asyncio
import os

import pytest

from app.config import load_config
from app.search.router import SearchRouter


@pytest.fixture
def config():
    return load_config()


@pytest.fixture
def router(config):
    return SearchRouter(config)


@pytest.mark.asyncio
async def test_router_returns_results(router: SearchRouter):
    """At least one provider should return results for a simple query."""
    results, provider = await router.search(
        "Manchester United football team", max_results=3
    )
    assert len(results) > 0, "No results from any provider"
    assert provider != "none", "All providers failed"
    print(f"Provider: {provider}, Results: {len(results)}")
    for r in results:
        print(f"  [{r.source}] {r.title} — {r.url}")


@pytest.mark.asyncio
async def test_router_failover(config):
    """If the primary provider is broken, router should fall through."""
    router = SearchRouter(config)

    # Mark all providers as unhealthy except the last one (DDG)
    for p in router.providers[:-1]:
        p.mark_unhealthy("test failure", cooldown_seconds=300)

    results, provider = await router.search("test query", max_results=2)
    # Should use DuckDuckGo (last resort)
    assert provider == "duckduckgo" or len(results) > 0


@pytest.mark.asyncio
async def test_router_fan_out(router: SearchRouter):
    """Fan-out should query multiple providers and merge results."""
    results, provider = await router.search(
        "Athletic Club Bilbao La Liga",
        max_results=3,
        fan_out=2,
    )
    # fan_out provider name contains "+" when multiple providers used
    print(f"Fan-out provider: {provider}, Results: {len(results)}")
    assert len(results) > 0


@pytest.mark.asyncio
async def test_stats(router: SearchRouter):
    """Stats should list all providers."""
    # Do one search first
    await router.search("test", max_results=1)
    stats = router.get_stats()
    assert len(stats["providers"]) >= 1  # at least DDG
    assert stats["total_searches"] >= 1
    print(f"Stats: {stats}")


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.getenv("BRAVE_SEARCH_API_KEY"),
    reason="No Brave API key",
)
async def test_brave_directly(config):
    """Direct Brave provider test."""
    from app.search.providers.brave import BraveSearchProvider

    provider = BraveSearchProvider(config.brave_api_key)
    results = await provider.search("Real Madrid vs Barcelona El Clasico", 3)
    assert len(results) > 0
    print(f"Brave: {len(results)} results")
    for r in results:
        print(f"  {r.title}")


@pytest.mark.asyncio
async def test_duckduckgo_directly():
    """DDG provider test (always available)."""
    from app.search.providers.duckduckgo import DuckDuckGoSearchProvider

    provider = DuckDuckGoSearchProvider()
    results = await provider.search("Liverpool FC Premier League", 3)
    assert len(results) > 0
    print(f"DDG: {len(results)} results")
    for r in results:
        print(f"  {r.title}")
