# Dashboard Audit & Improvement Plan

Analyze the NahidArbX codebase and create a plan for dashboard improvements.

## Steps

### 1. Architecture Review

Read and understand the current architecture:

- `CLAUDE.md` - Project overview and design philosophy (especially "Dashboard Design Philosophy" section)
- `ARCHITECTURE.md` - Detailed implementation notes
- `lib/types.ts` - All data structures

### 2. Data Flow Analysis

Trace data from source to display:

- `lib/adapters/pslive.ts` - What data PSLive provides
- `lib/adapters/ninewickets.ts` - What data NineWickets provides
- `lib/store.ts` - What data is stored in memory
- `app/api/admin/route.ts` - What data the API exposes
- `app/admin/page.tsx` - What data is currently displayed

### 3. Gap Analysis

Identify data that exists but isn't displayed:

- Markets data (fetched but not stored/displayed)
- Per-event provider details (eventId, fetchedAt per provider)
- Matching scores (how well events matched)
- Arbitrage opportunities (pending implementation)
- Odds comparison across providers

### 4. Dashboard Improvement Recommendations

Based on the "Universe Table" philosophy from CLAUDE.md, recommend:

- Expandable rows to show markets per event
- Side-by-side odds comparison columns
- Real-time arbitrage highlighting
- Market depth indicators
- Provider-specific odds columns
- Filter enhancements

### 5. Create Implementation Plan

Write a detailed plan including:

- API changes needed to expose more data
- Store changes to persist markets
- Frontend table enhancements (expandable rows, nested data)
- New components required
- Priority order for implementation

## Output

After analysis, present findings in this format:

1. **Current State Summary** - What's working, what data flows where
2. **Available but Unused Data** - Data that exists at API/store level but not shown in UI
3. **Recommended Improvements** (prioritized):
   - P0: Critical for core functionality
   - P1: High value, moderate effort
   - P2: Nice to have
4. **Implementation Plan** - Specific file changes with code snippets where helpful

Remember: The table should be "a small box that holds the universe" - all data in one unified, expandable table view.
