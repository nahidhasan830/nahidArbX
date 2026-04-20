#!/bin/bash
# Smart test router: maps changed files to relevant Playwright tests
# Called by Claude Code PostToolUse hook after Edit/Write operations

set -e

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null)

if [ -z "$FILE" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")/../.."

# Map file path to test files
TESTS=""

case "$FILE" in
  */app/login/* | */components/auth/*)
    TESTS="e2e/login.spec.ts"
    ;;
  */app/admin/* | */components/spreadsheet/* | */components/hooks/*)
    TESTS="e2e/admin.spec.ts"
    ;;
  */app/about/*)
    TESTS="e2e/about.spec.ts"
    ;;
  */app/api/health/*)
    TESTS="e2e/api-health.spec.ts"
    ;;
  */app/page.tsx | */middleware.ts)
    TESTS="e2e/navigation.spec.ts"
    ;;
  */app/api/*)
    TESTS="e2e/api-health.spec.ts"
    ;;
  *)
    # No matching test for this file
    exit 0
    ;;
esac

if [ -n "$TESTS" ] && [ -f "$TESTS" ]; then
  echo "Running related tests: $TESTS"
  npx playwright test "$TESTS" --reporter=list 2>&1 | tail -20
  EXIT_CODE=${PIPESTATUS[0]}
  if [ "$EXIT_CODE" -ne 0 ]; then
    echo "TESTS FAILED for: $TESTS (triggered by change to $FILE)"
    exit 2  # Exit code 2 = block, shows stderr to Claude
  fi
  echo "Tests passed for: $TESTS"
fi

exit 0
