# UI Test After Changes

Automatically determine which E2E tests to run based on recently changed files.

## Steps

1. Run `git diff --name-only HEAD` to see what files changed
2. Map changed files to test files:
   - `app/login/**` or `components/auth/**` → run `e2e/login.spec.ts`
   - `app/admin/**` or `components/spreadsheet/**` or `components/hooks/**` → run `e2e/admin.spec.ts`
   - `app/about/**` → run `e2e/about.spec.ts`
   - `app/api/health/**` → run `e2e/api-health.spec.ts`
   - `app/page.tsx` or `middleware.ts` → run `e2e/navigation.spec.ts`
   - If no specific mapping, run ALL tests
3. Run the determined tests with `npx playwright test <files>`
4. Report results and fix any failures caused by the changes
5. If tests were updated or added, show what changed
