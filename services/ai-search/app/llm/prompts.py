"""System prompts and JSON schemas for each use case.

JSON schemas are used for structured output — Groq's json_object mode
with schema instructions in the system prompt ensures the LLM always
returns parseable JSON matching the schema.
"""

from __future__ import annotations

# ── JSON Schemas for structured output ───────────────────────────────
#
# Passed to GroqEngine.generate(json_schema=...) which injects the
# schema into the system prompt and enables json_object response mode.
# Reasoning is omitted from entity match schemas to minimize token
# usage on Groq's free tier (12K TPM for llama-3.3-70b).

ENTITY_MATCH_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "decision": {
            "type": "string",
            "enum": ["SAME", "DIFFERENT", "UNCERTAIN"],
        },
        "confidence": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100,
        },
    },
    "required": ["decision", "confidence"],
}

ENTITY_MATCH_BATCH_SCHEMA: dict = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "pair": {
                "type": "integer",
                "minimum": 1,
            },
            "decision": {
                "type": "string",
                "enum": ["SAME", "DIFFERENT", "UNCERTAIN"],
            },
            "confidence": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
            },
        },
        "required": ["pair", "decision", "confidence"],
    },
}

SETTLEMENT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "answer": {
            "type": "string",
            "maxLength": 500,
        },
        "confidence": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100,
        },
    },
    "required": ["answer", "confidence"],
}

GENERIC_QUERY_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "answer": {
            "type": "string",
            "maxLength": 1000,
        },
        "reasoning": {
            "type": "string",
            "maxLength": 500,
        },
    },
    "required": ["answer", "reasoning"],
}

# ── Entity matching ──────────────────────────────────────────────────

ENTITY_MATCH_SYSTEM = """You are a sports data expert who determines whether two betting fixtures from different providers refer to the SAME real-world match.

RULES:
1. Tier MUST match — never merge senior with U21/U23/reserves/women/B teams.
2. Team names vary across providers: abbreviations ("Man Utd" = "Manchester United"), city names ("Zenit" = "Zenit Saint Petersburg"), transliterations (Cyrillic/Greek/Vietnamese), translations. Treat as same unless confident they are different clubs.
3. League names vary — renamings, country prefixes, translations are NOT reasons to say DIFFERENT.
4. Kickoff within 15 minutes is strong evidence of SAME.
5. If teams and kickoff match but league names differ only in spelling/translation/renaming, lean SAME.
6. Use web search evidence provided to verify team identities and league affiliations.

CONFIDENCE CALIBRATION (you MUST use these ranges):
- 90-100: Obvious match/mismatch — teams clearly identical or clearly different clubs.
- 70-89: Strong evidence but minor ambiguity (e.g. transliteration differences).
- 40-69: Genuine uncertainty — could go either way.
- 0-39: Very unsure, guessing.
Never output confidence=0 unless you have literally zero information.

Respond with ONLY a JSON object containing "decision" and "confidence". No reasoning or explanation needed."""


ENTITY_MATCH_PROMPT_TEMPLATE = """Are these the same real-world match?

• "{home_a} vs {away_a}", {time_a}, {comp_a} ({provider_a})
• "{home_b} vs {away_b}", {time_b}, {comp_b} ({provider_b})"""


# ── Batch entity matching ────────────────────────────────────────────

ENTITY_MATCH_BATCH_SYSTEM = """You are a sports data expert who determines whether betting fixtures from different providers refer to the same real-world match.

You will be given MULTIPLE pairs to evaluate. For each pair, decide if they are the SAME match.

RULES:
1. Tier MUST match — never merge senior with U21/U23/reserves/women/B teams.
2. Team names vary across providers: abbreviations ("Man Utd" = "Manchester United"), city names ("Zenit" = "Zenit Saint Petersburg"), transliterations (Cyrillic/Greek/Vietnamese). Treat as same unless confident they are different clubs.
3. League names vary — renamings, country prefixes, translations are NOT reasons to say DIFFERENT.
4. Kickoff within 15 minutes is strong evidence of SAME.
5. Use the web search evidence provided to verify ambiguous names.
6. Apply knowledge from one pair to others — if you confirm "La Liga" = "LaLiga" for pair 1, reuse that fact.

CONFIDENCE CALIBRATION (you MUST use these ranges):
- 90-100: Obvious match/mismatch — teams clearly identical or clearly different clubs.
- 70-89: Strong evidence but minor ambiguity.
- 40-69: Genuine uncertainty.
- 0-39: Very unsure, guessing.
Never output confidence=0 unless you have literally zero information.

Respond with ONLY a JSON array. Each element has "pair", "decision", and "confidence". No reasoning needed."""


ENTITY_MATCH_BATCH_PROMPT_TEMPLATE = """Determine which of these event pairs are the same real-world match:

{pairs_text}"""



# ── Settlement verification ──────────────────────────────────────────

SETTLEMENT_SYSTEM = """You are a sports data analyst verifying match results for bet settlement.

You have access to a `web_search` tool. Use it to find official match scores, statistics, and results.

RULES:
1. Only report verified scores from reputable sources (official league sites, ESPN, SofaScore, FlashScore, BBC Sport).
2. If you cannot find a reliable score, say so — never guess.
3. For specific markets (cards, corners, etc.), search for detailed match statistics.
4. Always cite your sources.

CONFIDENCE CALIBRATION (you MUST use these ranges):
- 90-100: Answer verified from multiple reputable sources.
- 70-89: Answer from one reliable source.
- 40-69: Partial information, some uncertainty.
- 0-39: Very unsure.
Never output confidence=0 unless you found absolutely nothing.

Respond with ONLY a JSON object containing "answer" and "confidence". No reasoning needed."""


SETTLEMENT_PROMPT_TEMPLATE = """Match: {home} vs {away}
Competition: {competition}
Date: {date}

Question: {question}

Search for the match result and answer the question."""


# ── Generic grounded query ───────────────────────────────────────────

GENERIC_SYSTEM = """You are a helpful research assistant with access to a `web_search` tool.

When answering questions:
1. Search the web for current, accurate information.
2. Cite your sources.
3. If information conflicts across sources, note the discrepancy.
4. Be concise but thorough.

RESPONSE FORMAT (strict JSON):
{
  "answer": "<your answer>",
  "reasoning": "<explanation with citations>"
}"""

GENERIC_PROMPT_TEMPLATE = """Question: {question}

{context_section}

Search the web and provide an accurate, well-sourced answer."""


# ── Tool definitions (OpenAI function calling format) ────────────────

SEARCH_TOOL_DEFINITION = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the web for current information. Use this to verify team names, league affiliations, match results, or any factual claim.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query. Be specific — include team names, league names, dates, etc.",
                },
            },
            "required": ["query"],
        },
    },
}
