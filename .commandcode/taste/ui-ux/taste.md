# ui-ux

- Make auto-suggestions context-aware based on web search toggle state. When web grounding is enabled, show search query type suggestions; when disabled, show general question/brainstorm type suggestions. Confidence: 0.75
- Respect disabled AI engines and search providers across the entire UI. When an AI engine (DeepSeek, Gemini) or search provider is disabled, all related UI components (AiDialog, AI Playground, model selectors, etc.) must reflect this state and show options as disabled. Confidence: 0.85
- Sort providers in the AI Engine dashboard in this order: Google Vertex > Brave > Tavily. Confidence: 0.70
- Match table designs consistently with components/bets-history/BetsHistoryTable.tsx or components/bets-history/BetsHistorySpreadsheet.tsx styling. Use these as the reference implementation for all data tables. Confidence: 0.80
- Remove unnecessary UI elements completely rather than hiding them — don't store or display data that isn't relevant to users (tooltips, info cards, tabs, filters, technical metadata). Confidence: 0.85
- Use professional, concise UI copy. Avoid technical jargon in user-facing labels (e.g., "save database changes" → "Apply Changes"). Confidence: 0.70
- Show real-time progress monitoring for long-running processes (matcher runs, batch operations). Provide visual feedback of what's happening during execution. Confidence: 0.70
