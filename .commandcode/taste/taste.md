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

# timezone

- Remove all manual timezone conversions from the entire application. Data already arrives in the user's timezone, and the browser automatically converts UTC timestamps to local time via new Date(). Do not add UTC offset calculations or timezone libraries for display purposes. Confidence: 0.90
- Use date-fns for any date manipulation instead of writing custom date calculation code. Confidence: 0.85

# ml-pipeline

- DeepSeek has 1M total context tokens — never limit it. Pass full search grounding results to DeepSeek without truncation. Confidence: 0.85
- Vertex AI should always be the first-priority provider. Fallback to other providers only when Vertex result confidence is low. Confidence: 0.80

# workflow

- npm run dev:all must start both the Next.js dev server and the engine background process together. Confidence: 0.80
- Prefer aggressive refactoring: when stale code or files are found during cleanup, delete them entirely rather than preserving them. Confidence: 0.75
- No database backups needed before destructive operations — clean everything directly. Solo developer workflow on main branch only. Confidence: 0.80
- Execute tasks autonomously without asking for confirmation on every step. When given authority to "do yourself" or "go implement", proceed with full implementation including restarts, migrations, and testing. Confidence: 0.70

# communication

- Provide visual explanations (mermaid diagrams, text-based flowcharts) for complex system flows. When user asks to "visualize" or understand flow, create clear step-by-step diagrams. Confidence: 0.80
- Use skills $design-taste-frontend and $redesign-existing-projects for all UI/UX design and redesign tasks. Do not design UI without invoking these skills first. Confidence: 0.85

# ui-ux

See [ui-ux/taste.md](ui-ux/taste.md)

# event-matcher

- Use DeepSeek with search grounding as the primary AI approach for fixture matching decisions. Pass full search results to DeepSeek without truncation for residual review. Confidence: 0.80
- Require exact kickoff time matching (not windows) for fixture matching candidates. Kickoff times must match precisely to be considered for review. Confidence: 0.85
- Apply strict matching criteria: exact kickoff time PLUS at least 2 of 3 similarities (league name, team A, team B) required for candidate consideration. Confidence: 0.75

# architecture

- For ML dashboard: use panels/ and tabs/ architecture. Preserve AnalysisModal and related analysis components when refactoring; do not delete entire dashboard/ directory blindly. Confidence: 0.80
- Eliminate Python service dependencies — build services in Node.js and use cloud-managed inference (Vertex AI, DeepSeek API) instead of self-hosted Python. Confidence: 0.75
- Use a central single source of truth for provider configuration so that adding a new provider auto-reflects everywhere (appshell, value bets, dashboards, etc.) without manual updates in each consumer. Confidence: 0.80

# mcp-management

- Remove MCP servers globally from all configurations when they're no longer needed (puppeteer, magic, memory, postgres). Clean up all references in global config files, not just local project. Confidence: 0.85

# testing

- Never open a browser for testing. Use direct API calls from client-side for debugging data issues. Avoid Playwright/Puppeteer for testing purposes. Confidence: 0.80
