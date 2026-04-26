# Code Cleanup

Perform a comprehensive code cleanup across the codebase. This is a **reusable checklist** — run it anytime to catch accumulated debt. Each phase includes scan commands and fix guidance.

Work through phases in order. Skip phases that come back clean.

---

## Phase 1: Lint & Build Gate

Run these first. Fix everything before proceeding — later phases assume a clean baseline.

```bash
npm run lint    # Fix all lint errors
npm run build   # Fix all TypeScript errors
```

If either fails, fix all errors before moving to Phase 2.

---

## Phase 2: Dead Code Scan

### 2.1 Unused imports

```bash
npm run lint   # ESLint catches unused imports
```

Fix all `no-unused-vars` and `@typescript-eslint/no-unused-vars` warnings.

### 2.2 Imports to deleted/missing files

```bash
# Find imports that reference non-existent paths
grep -rn "from ['\"]\./" lib/ components/ app/ --include='*.ts' --include='*.tsx' | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  imp=$(echo "$line" | sed "s/.*from ['\"]//;s/['\"].*//" )
  dir=$(dirname "$file")
  resolved="$dir/$imp"
  # Check .ts, .tsx, /index.ts variants
  [ -f "${resolved}.ts" ] || [ -f "${resolved}.tsx" ] || [ -f "${resolved}/index.ts" ] || [ -f "${resolved}/index.tsx" ] || [ -f "$resolved" ] || echo "MISSING: $file → $imp"
done
```

Delete or update any broken imports found.

### 2.3 Unused exports

Look for exports that nothing imports. Focus on `lib/` — component exports are harder to trace.

```bash
# For each exported function/const in lib/, check if it's imported elsewhere
grep -roh "export \(function\|const\|class\|type\|interface\) \w\+" lib/ --include='*.ts' | sed 's/export \(function\|const\|class\|type\|interface\) //' | sort -u | while read name; do
  count=$(grep -r "$name" lib/ components/ app/ --include='*.ts' --include='*.tsx' -l | wc -l)
  [ "$count" -le 1 ] && echo "POSSIBLY UNUSED: $name"
done
```

Review each hit — some are entry points (API routes, schedulers). Remove genuinely dead exports.

### 2.4 Unused npm dependencies

```bash
# List all dependencies, check if they're imported anywhere
cat package.json | jq -r '.dependencies // {} | keys[]' | while read dep; do
  count=$(grep -r "from ['\"]$dep" lib/ components/ app/ middleware.ts --include='*.ts' --include='*.tsx' -l 2>/dev/null | wc -l)
  [ "$count" -eq 0 ] && echo "UNUSED DEP: $dep"
done
```

Cross-reference with indirect usage (peer deps, Next.js plugins, PostCSS). Remove genuinely unused packages.

---

## Phase 3: Console Statement Audit

`lib/shared/logger.ts` is the structured logger. All runtime logging should use it.

```bash
# Find all console.* calls outside of scripts/ and tests/
grep -rn 'console\.\(log\|warn\|error\|debug\|info\)(' lib/ components/ app/ --include='*.ts' --include='*.tsx'
```

**Rules:**

- `console.log` for debug output → remove or replace with `logger.debug(context, message)`
- `console.warn` for runtime warnings → replace with `logger.warn(context, message)`
- `console.error` for caught errors → replace with `logger.error(context, message, error)`
- In `scripts/` → leave alone (CLI scripts legitimately use console)
- In auth code → skip if auth is parked

---

## Phase 4: Type Safety Sweep

### 4.1 Explicit `any` usage

```bash
grep -rn ': any\b\|as any\b' lib/ components/ app/ --include='*.ts' --include='*.tsx'
```

Replace with proper types. Common patterns:

- `Record<string, any>` → define the value type or use `unknown`
- `as any` cast → fix the type mismatch at the source
- Function params typed `any` → add proper parameter types
- Exception: generic library wrappers (cache, circuit-breaker) may legitimately use `any`

### 4.2 ESLint directive suppressions

```bash
grep -rn '// eslint-disable\|@ts-ignore\|@ts-expect-error\|@ts-nocheck' lib/ components/ app/ --include='*.ts' --include='*.tsx'
```

Review each suppression:

- **`no-var` for globalThis singletons** → legitimate, leave alone
- **`react-hooks/exhaustive-deps`** → fix the hook dependencies or restructure with `useCallback`/`useRef`
- **`@typescript-eslint/no-explicit-any`** → fix the type (see 4.1)
- **`@typescript-eslint/no-unused-vars`** → remove the unused variable
- **`no-console`** → migrate to logger (see Phase 3)

Goal: reduce suppressions to only genuinely necessary ones (globalThis singletons, rare framework edge cases).

---

## Phase 5: Typography Tier Audit

Per CLAUDE.md typography tiers:

- **Chrome** (buttons, badges, table cells, toolbar pills, stat numbers) → `text-[11px]` / `text-xs` is CORRECT
- **Prose** (tooltip bodies, descriptions, help text, form labels, error messages, empty states) → `text-sm` (14px) minimum

```bash
# Find all text-[11px] and text-xs usage in components
grep -rn 'text-\[11px\]\|text-xs' components/ --include='*.tsx'
```

For each hit, check context:

- Inside `<Button>`, `<Badge>`, `<td>`, toolbar wrapper, filter pill → correct, leave alone
- Inside `<p>`, `<label>`, tooltip body, `CardDescription`, help text, error message → bump to `text-sm`

---

## Phase 6: CSS Compliance

Per CLAUDE.md, only these are allowed in `app/globals.css`:

- `@import` statements and `@theme inline { }` block
- `:root` / `.dark` CSS variable definitions
- `@layer base { }` reset
- Sonner toast overrides (third-party data attributes)
- Scrollbar pseudo-elements

```bash
# Check for any custom component class blocks
grep -n '^\.\|^  \.' app/globals.css | grep -v '^[0-9]*:\.dark'
```

If custom classes are found, migrate them to Tailwind utilities on the JSX elements, then delete the CSS rules. See CLAUDE.md "Styling" section for the migration steps.

---

## Phase 7: Component Size Check

```bash
# Find files over 500 lines
find lib components app -name '*.ts' -o -name '*.tsx' | xargs wc -l 2>/dev/null | sort -rn | awk '$1 > 500 {print}'
```

Files over 1,000 lines are strong decomposition candidates. For each:

1. Identify logical sub-sections (filter bar, detail panel, config section, etc.)
2. Extract into separate files in the same directory
3. Keep the original file as the composition root that imports sub-components
4. Don't change the public API — only split internal concerns

Files over 500 lines: review but don't force-split if the code is cohesive.

---

## Phase 8: Stale References

### 8.1 References to renamed/deprecated concepts

```bash
# Check for references to old names that were renamed
# (Update the list below as renames happen)
grep -rn 'TODO\|FIXME\|HACK\|XXX' lib/ components/ app/ --include='*.ts' --include='*.tsx'
```

Address or remove each TODO/FIXME. If the fix is non-trivial, file it as a separate task.

### 8.2 Duplicate logic

Look for similar code blocks that could share a utility:

- Repeated URL/query-param construction
- Repeated error handling patterns in API routes
- Repeated date formatting or number formatting
- Repeated Zod schema patterns

Extract shared utilities into `lib/shared/` or `lib/formatting/`.

---

## Phase 9: Verification

After all cleanup:

```bash
npm run lint    # Zero errors
npm run build   # Clean build
```

Then visually verify in browser:

- `/dashboard` loads, accounts panel renders
- `/value-bets` spreadsheet loads, sync works
- `/bets` history table loads, filters work
- `/lab/optimisation` runs table loads

Report: number of files changed, lines added/removed, categories of fixes applied.
