"""Web search abstraction for teaching validation.

Uses DuckDuckGo by default (no API key needed).
Can be swapped to SerpAPI or Tavily via OASIS_WEB_SEARCH_PROVIDER env var.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

PROVIDER = os.getenv("OASIS_WEB_SEARCH_PROVIDER", "duckduckgo")


async def search(query: str, num_results: int = 5) -> list[dict[str, Any]]:
    """Search the web and return a list of {title, url, snippet} dicts."""
    logger.info("Web search (%s): %s", PROVIDER, query[:80])

    if PROVIDER == "duckduckgo":
        return await _search_ddg(query, num_results)
    elif PROVIDER == "tavily":
        return await _search_tavily(query, num_results)
    else:
        logger.warning("Unknown search provider '%s', using duckduckgo", PROVIDER)
        return await _search_ddg(query, num_results)


async def _search_ddg(query: str, num_results: int) -> list[dict[str, Any]]:
    """Search using DuckDuckGo (no API key required). Uses ddgs package."""
    try:
        from ddgs import DDGS

        results = []
        for r in DDGS().text(query, max_results=num_results):
            results.append({
                "title": r.get("title", ""),
                "url": r.get("href", r.get("url", r.get("link", ""))),
                "snippet": r.get("body", r.get("snippet", "")),
            })
        logger.info("DuckDuckGo returned %d results", len(results))
        return results
    except ImportError:
        logger.error("ddgs package not installed (pip install ddgs)")
        return []
    except Exception as e:
        logger.error("DuckDuckGo search failed: %s", e)
        return []


async def _search_tavily(query: str, num_results: int) -> list[dict[str, Any]]:
    """Search using Tavily API."""
    try:
        import httpx
        api_key = os.getenv("OASIS_TAVILY_API_KEY", "")
        if not api_key:
            logger.error("OASIS_TAVILY_API_KEY not set")
            return []
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={"api_key": api_key, "query": query, "max_results": num_results},
            )
            resp.raise_for_status()
            data = resp.json()
            return [
                {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("content", "")}
                for r in data.get("results", [])
            ]
    except Exception as e:
        logger.error("Tavily search failed: %s", e)
        return []
