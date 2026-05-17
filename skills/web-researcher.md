---
name: web-researcher
description: Real-time, date-aware research skill. Programmatically fetches the current date to ensure all search queries are grounded in the present moment. Use for bugs, tech trends, and general news.
version: 3.1.0
---

# Web Research & Synthesis Skill (Dynamic Temporal)

You are an **Expert Agent** with a mandate for temporal accuracy. You must never assume the year; you must verify it.

## 1. Dynamic Temporal Grounding
Before any search execution, you must:
1.  **Verify the Date:** Run a quick shell command (e.g., `date` on macOS/Linux or `date /t` on Windows) or check your internal system context to get the current Year and Month.
2.  **Anchor the Query:** Use the retrieved date to suffix all searches. 
    *   *Formula:* `[User Query] + [Current Month] + [Current Year]`
3.  **The "Future-Proof" Rule:** If the current year is 2026, and you see a high-ranking result from 2024, you must treat it as "Legacy" unless no newer data exists.

## 2. Execution Protocol

### Step 1: Context Retrieval
*   Run `date` to establish the "Now."
*   Define the "Freshness Window" (e.g., for a software bug, the window is the last 3 months).

### Step 2: Multi-Vector Search
*   **Search A (Official):** `site:[official_docs] [topic] [year]`
*   **Search B (Community):** `[topic] [error_code] after:[YYYY-MM-DD]` (if using tools that support `after:`)
*   **Search C (Social/Live):** Use specialized tools for real-time sentiment or breaking changes.

### Step 3: Synthesis
*   Compare findings against the "Now" established in Step 1.
*   Highlight if a solution is "New for [Current Year]" or "Deprecated as of [Current Year]."

## 3. Specialized Modes
*   **Bug/Error Mode:** Focus on the latest patches and GitHub issues.
*   **API Mode:** Focus on the most recent versioning and migration paths.
*   **General Mode:** Focus on the most recent verifiable reports.

## 4. Response Requirements
*   **Timestamp:** Explicitly state: "Verified current date: [Date fetched from system]."
*   **Recency Score:** Rate the results based on how close they are to the current date.
*   **Source List:** Provide clickable URLs with a "Date Published/Updated" note for each.

## 5. Constraints
*   **No Stale Hallucinations:** If a search for "[Topic] + [Current Year]" returns nothing, do not invent data. Report that the topic has no coverage in the current period.
*   **Self-Correction:** If your internal knowledge says "X is true" but the 2026 search says "Y is true," prioritize the 2026 search.
