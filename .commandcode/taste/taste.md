# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# ui-ux

- Make auto-suggestions context-aware based on web search toggle state. When web grounding is enabled, show search query type suggestions; when disabled, show general question/brainstorm type suggestions. Confidence: 0.75
- Respect disabled AI engines and search providers across the entire UI. When an AI engine (DeepSeek, Gemini) or search provider is disabled, all related UI components (AiDialog, AI Playground, model selectors, etc.) must reflect this state and show options as disabled. Confidence: 0.85
- Sort providers in the AI Engine dashboard in this order: Google Vertex > Brave > Tavily. Confidence: 0.70

# code-style

- Fix root causes rather than applying caps/band-aids to suppress symptoms. When data quality issues arise (e.g., phantom 5.00 odds), trace back to the source (e.g., Pinnacle raw data staleness indicators) instead of adding upper limits on EV or odds ratios. Confidence: 0.85
- Verify diagnoses with real data before implementing fixes. Do not assume — test against actual raw data (e.g., randomly sample real API responses or DB records) to confirm root cause analysis before writing code. Confidence: 0.65

# debugging

- Write inline diagnostic scripts (npx tsx scripts/verify-\*.ts) that query live APIs and DBs to validate assumptions. Compare multiple scenarios (e.g., LIVE vs pre-match, goals vs corners vs bookings) and present evidence in tabular form before proposing fixes. Debug and iterate when scripts fail — do not abandon the approach on first error. Confidence: 0.70
- Create vitest tests for reusable accuracy validation of AI systems. Build tests that can be run repeatedly to validate AI performance over time. Confidence: 0.75
- Use random sampling (n=20) from production data for accuracy testing. Select real data samples from the database to validate AI results against known correct outcomes. Confidence: 0.70
- Run iterative processes autonomously until maximum accuracy is achieved. Continue refining and testing rather than stopping at the first working solution. Confidence: 0.70

# odds-pipeline

- Prefer false positives (phantom bets) over missing genuine value opportunities. Do not add data quality filters or caps on soft provider odds at ingestion (e.g., rejecting 5.00 as a sentinel value) because large odds jumps can be natural and legitimate. Instead, fix root causes on the sharp provider side (e.g., Pinnacle market presence tracking). Confidence: 0.80
- When a provider removes a market from its feed entirely (not just suspends it temporarily), remove the market from the odds store rather than marking it suspended. The suspended flag is semantically reserved for markets that are temporarily unavailable at the bookmaker level (e.g., in-play price freeze). Confidence: 0.70

# architecture

- For ML dashboard: use panels/ and tabs/ architecture. Preserve AnalysisModal and related analysis components when refactoring; do not delete entire dashboard/ directory blindly. Confidence: 0.80
