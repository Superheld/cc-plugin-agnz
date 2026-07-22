#!/bin/sh
# Run the test suite the way the flake watch demands (docs/next.md → Watch):
# full output tee'd to a log BEFORE any filtering, failing test names echoed
# on red, and the runner's own exit code propagated so release chains gate
# correctly (`sh scripts/test.sh && git merge ...`).
#
# Usage: sh scripts/test.sh [test files...]   (default: tests/*.test.mjs)
set -u
cd "$(dirname "$0")/.." || exit 1

LOG="${TMPDIR:-/tmp}/agnz-suite-$(date +%Y%m%d-%H%M%S).log"
if [ "$#" -gt 0 ]; then
  node --test "$@" 2>&1 | tee "$LOG"
else
  node --test tests/*.test.mjs 2>&1 | tee "$LOG"
fi
# POSIX sh has no PIPESTATUS; re-derive the verdict from the runner's own
# "ℹ fail N" summary line (grep -c '^✖' would miss tests nested in describe()).
fails=$(grep -E '^ℹ fail ' "$LOG" | tail -1 | awk '{print $3}')
fails="${fails:-1}" # no summary line at all = the runner died; treat as red

echo ""
echo "log: $LOG"
if [ "$fails" -gt 0 ]; then
  echo "FAILING TESTS (capture these names in docs/next.md if this is the flake):"
  grep '✖' "$LOG"
  exit 1
fi
exit 0
