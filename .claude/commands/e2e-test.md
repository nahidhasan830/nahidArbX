# E2E Test Runner

Run the Playwright end-to-end test suite and report results.

## Steps

1. Ensure the dev server is running (start it if needed via `npm run dev` in background)
2. Run the full Playwright test suite: `npx playwright test`
3. If any tests fail:
   - Read the failing test file
   - Analyze the error output
   - Determine if it's a test issue or an app bug
   - Fix the issue and re-run the failing test
4. Report a summary: total tests, passed, failed, and any fixes applied
5. If all tests pass, confirm with a green summary

## Options

- To run only a specific test file, pass the filename: `/e2e-test login`
- To run headed (visible browser): `npx playwright test --headed`
- To open the HTML report after: `npx playwright show-report`
