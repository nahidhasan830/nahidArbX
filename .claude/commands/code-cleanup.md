# Code Cleanup

Perform a comprehensive code cleanup across both backend and frontend. Focus on eliminating duplication, using shared utilities, leveraging UI libraries, and removing redundant code.

## Cleanup Checklist

### Phase 1: Backend Code Duplication

**1.1 URLSearchParams Helpers (ninewickets-sportsbook.ts)**

- [ ] Extract `buildCatalogParams(providerEventId: string)` helper
- [ ] Extract `buildOddsParams(providerEventId: string, marketIds: string[])` helper
- [ ] Replace 3 duplicate blocks at lines ~89, ~184, ~207

**1.2 Event Params Constant (ninewickets-exchange.ts)**

- [ ] Create `DEFAULT_EVENT_PARAMS` constant
- [ ] Extract `buildEventParams(type: number)` helper
- [ ] Replace duplicate blocks at lines ~115, ~245

**1.3 Deduplication Utility**

- [ ] Create `lib/shared/deduplication.ts` with:
  ```typescript
  export function deduplicateById<T extends { id: string }>(items: T[]): T[];
  ```
- [ ] Replace Map-based deduplication in `ninewickets-exchange.ts` and `ninewickets-sportsbook.ts`

**1.4 API Response Helpers (app/api/dashboard/route.ts)**

- [ ] Extract `serializeSyncStatus(syncStatus)` helper
- [ ] Replace duplicate serialization at lines ~246, ~282

**1.5 Constants Extraction**

- [ ] Create `lib/shared/constants.ts` with:
  - `MATCH_THRESHOLD = 0.85`
  - `SYNC_INTERVAL_MS = 60000`
  - `PINNACLE_TIMEOUT_MS = 30000`
  - `MIN_EV_PCT = 2.0`
  - `VALUE_TOTAL_STAKE = 1000`
- [ ] Update imports in matcher.ts, fetcher.ts, config.ts

---

### Phase 2: Frontend UI Improvements

**2.1 Provider Badge Variants (components/ui/badge.tsx)**

- [ ] Add CVA variants for providers:
  ```typescript
  pinnacle: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
  "ninewickets-exchange": "bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 border border-violet-200 dark:border-violet-800"
  "ninewickets-sportsbook": "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
  ```
- [ ] Replace `getProviderBadgeClasses()` in SpreadsheetToolbar.tsx with `<Badge variant={providerId}>`

**2.2 OddsCell Component (components/ui/odds-cell.tsx)**

- [ ] Create CVA-based component with variants: `arb`, `suspended`, `best`, `default`
- [ ] Replace conditional className logic in ValueBetSpreadsheet.tsx lines ~98-106

**2.3 Status Badge Variants**

- [ ] Add `success`, `warning`, `info` variants to Badge
- [ ] Use for sync status, match status indicators

---

### Phase 3: Redundant Code Removal

**3.1 Unused Imports**

- [ ] Remove `import axios from "axios"` from `lib/adapters/pinnacle.ts:8`
- [ ] Remove `BrowserContext` from `lib/auth/token-manager.ts:14`
- [ ] Run `npm run lint` to find other unused imports

**3.2 Console Statements**
Replace with structured logger OR remove entirely:

- [ ] `lib/background/fetcher.ts` - 10+ console.log statements
- [ ] `lib/matching/matcher.ts:72-74` - matcher logging
- [ ] `lib/atoms/value-detector.ts` - warning logs
- [ ] `lib/shared/validation.ts:25` - error log
- [ ] `lib/adapters/ninewickets-exchange.ts:137,223` - debug logs
- [ ] `lib/atoms/registry.ts:61-68` - init logs

**3.3 Commented Code**

- [ ] Remove `lib/atoms/mappings/pinnacle.ts:470` - commented console.log

**3.4 Unnecessary Logic**

- [ ] Simplify ternary at `lib/matching/matcher.ts:140-143`
- [ ] Clean up type assertions in `lib/store.ts:46-47`

**3.5 Registry Flattening**

- [ ] Evaluate if `lib/adapters/index.ts` can export directly instead of re-exporting from unified-registry

---

### Phase 4: Type Safety

**4.1 Remove Unnecessary Assertions**

- [ ] `lib/store.ts:46` - Use proper type annotation instead of `as Record<>`
- [ ] `lib/atoms/registry.ts:12` - Type the JSON import properly

**4.2 Consistent Type Naming**

- [ ] Decide on `Provider` vs `ProviderKey` - use one consistently
- [ ] Update `lib/types.ts:5-8` to remove confusion

---

### Phase 5: Optional Enhancements

**5.1 Logger Service (if removing console.logs)**

```typescript
// lib/shared/logger.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const logger = {
  debug: (context: string, message: string, data?: unknown) => { ... },
  info: (context: string, message: string, data?: unknown) => { ... },
  warn: (context: string, message: string, data?: unknown) => { ... },
  error: (context: string, message: string, data?: unknown) => { ... },
};
```

**5.2 Provider UI Directory**

- [ ] Create `components/providers/` for provider-specific UI
- [ ] Move provider badge logic to `components/providers/ProviderBadge.tsx`

---

## Verification Steps

After cleanup:

1. `npm run build` - No TypeScript errors
2. `npm run lint` - No new lint issues
3. `npm run dev` - Dashboard loads correctly
4. Test manual sync - All providers fetch
5. Check value-bet detection - EV/Kelly calculations unchanged
6. Verify dark mode - All UI changes support dark theme

---

## Files Reference

**Create:**

- `lib/shared/deduplication.ts`
- `lib/shared/constants.ts`
- `components/ui/odds-cell.tsx`
- `lib/shared/logger.ts` (optional)

**Modify:**

- `lib/atoms/adapters/ninewickets-sportsbook.ts`
- `lib/adapters/ninewickets-exchange.ts`
- `components/ui/badge.tsx`
- `components/spreadsheet/SpreadsheetToolbar.tsx`
- `components/spreadsheet/ValueBetSpreadsheet.tsx`
- `app/api/dashboard/route.ts`
- `lib/background/fetcher.ts`
- `lib/matching/matcher.ts`
- `lib/store.ts`
- `lib/types.ts`
