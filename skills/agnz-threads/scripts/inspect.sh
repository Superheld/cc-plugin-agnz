#!/usr/bin/env bash
# agnz-inspect — inspect thread state and transcript
#
# Usage (run from project root):
#   inspect.sh                  list all threads in .claude/agnz/threads/
#   inspect.sh <id-prefix>      show meta + last N transcript messages
#
# Env:
#   AGNZ_DIR     workspace dir  (default: .claude/agnz)
#   N_MESSAGES   how many lines to tail from transcript  (default: 30)

set -euo pipefail

AGNZ_DIR="${AGNZ_DIR:-.claude/agnz}"
THREADS_DIR="$AGNZ_DIR/threads"
N_MESSAGES="${N_MESSAGES:-30}"

# trace-stats.mjs lives at the plugin root; resolve it relative to this script
# (skills/agnz-threads/scripts/ → ../../../lib/). Used for the stats views.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACE_STATS="$SCRIPT_DIR/../../../lib/trace-stats.mjs"

# ── stats mode: `inspect.sh stats` → workspace-wide trace aggregation ─────────
if [ "${1:-}" = "stats" ]; then
  if command -v node &>/dev/null && [ -f "$TRACE_STATS" ]; then
    exec node "$TRACE_STATS"
  fi
  echo "ERROR: node and $TRACE_STATS are required for stats" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required" >&2
  exit 1
fi

if [ ! -d "$THREADS_DIR" ]; then
  echo "No agnz workspace at $AGNZ_DIR (run from project root)" >&2
  exit 1
fi

# ── portable timestamp formatter ────────────────────────────────────────────
fmt_ts() {
  local ms="${1:-0}"
  local secs=$(( ms / 1000 ))
  date -r "$secs" '+%Y-%m-%d %H:%M' 2>/dev/null ||
  date -d "@$secs" '+%Y-%m-%d %H:%M' 2>/dev/null ||
  echo "$ms"
}

# ── list mode (no args) ──────────────────────────────────────────────────────
if [ $# -eq 0 ]; then
  shopt -s nullglob
  metas=("$THREADS_DIR"/*.meta.json)
  if [ ${#metas[@]} -eq 0 ]; then
    echo "(no threads)"
    exit 0
  fi

  printf "%-10s  %-18s  %-20s  %-14s  %-10s  %s\n" \
    "ID" "STATUS" "NAME" "AGENT" "UPDATED" "NOTE"
  printf '%s\n' "$(printf '%0.s-' {1..85})"

  for meta in "${metas[@]}"; do
    id=$(basename "$meta" .meta.json)
    name=$(jq -r '.name // "(unnamed)"' "$meta")
    status=$(jq -r '.status' "$meta")
    agent=$(jq -r '.agentDef.name // "-"' "$meta")
    ms=$(jq -r '.updatedAt // 0' "$meta")
    ts=$(fmt_ts "$ms")
    note=""
    # pending hint
    pkind=$(jq -r '.pending.kind // ""' "$meta")
    [ -n "$pkind" ] && note="awaiting $pkind"
    # error hint
    errmsg=$(jq -r '.error.message // ""' "$meta")
    [ -n "$errmsg" ] && note="err: ${errmsg:0:30}"

    printf "%-10s  %-18s  %-20s  %-14s  %-10s  %s\n" \
      "${id:0:8}" "$status" "${name:0:20}" "${agent:0:14}" "$ts" "$note"
  done
  exit 0
fi

# ── inspect mode (id prefix) ─────────────────────────────────────────────────
QUERY="$1"
META_FILE=""
MATCH_ID=""

shopt -s nullglob
for meta in "$THREADS_DIR"/*.meta.json; do
  id=$(basename "$meta" .meta.json)
  if [[ "$id" == "$QUERY"* ]]; then
    META_FILE="$meta"
    MATCH_ID="$id"
    break
  fi
done

if [ -z "$META_FILE" ]; then
  echo "No thread matching '$QUERY'" >&2
  exit 1
fi

JSONL_FILE="$THREADS_DIR/$MATCH_ID.jsonl"

# ── meta summary ────────────────────────────────────────────────────────────
echo "=== Thread: $MATCH_ID ==="
echo

jq -r '
  "name:        " + (.name // "(unnamed)"),
  "description: " + (.description // "-"),
  "agent:       " + (.agentDef.name // "-"),
  "status:      " + .status
' "$META_FILE"

ms_c=$(jq -r '.createdAt // 0' "$META_FILE")
ms_u=$(jq -r '.updatedAt // 0' "$META_FILE")
echo "created:     $(fmt_ts "$ms_c")"
echo "updated:     $(fmt_ts "$ms_u")"

# pending
pkind=$(jq -r '.pending.kind // ""' "$META_FILE")
if [ -n "$pkind" ]; then
  echo
  echo "--- PENDING: $pkind ---"
  if [ "$pkind" = "approval" ]; then
    jq -r '"tool:   " + (.pending.name // "-")' "$META_FILE"
    jq -r '.pending.args // {} | to_entries[] |
      "  " + .key + " = " + (.value | tostring | .[0:80])' "$META_FILE"
  elif [ "$pkind" = "question" ]; then
    jq -r '"Q: " + (.pending.question // "")' "$META_FILE"
  fi
fi

# error
errmsg=$(jq -r '.error.message // ""' "$META_FILE")
if [ -n "$errmsg" ]; then
  echo
  echo "--- ERROR ---"
  echo "$errmsg"
fi

# trace stats (turns, tokens, tool outcomes) — best-effort, needs node
if command -v node &>/dev/null && [ -f "$TRACE_STATS" ]; then
  echo
  node "$TRACE_STATS" "$MATCH_ID" 2>/dev/null || true
fi

# ── transcript ───────────────────────────────────────────────────────────────
if [ ! -f "$JSONL_FILE" ]; then
  echo
  echo "(no transcript)"
  exit 0
fi

total=$(wc -l < "$JSONL_FILE" | tr -d ' ')
echo
echo "=== Transcript (last $N_MESSAGES of $total) ==="
echo

tail -n "$N_MESSAGES" "$JSONL_FILE" | while IFS= read -r line; do
  role=$(printf '%s' "$line" | jq -r '.role // "?"')

  case "$role" in
    user)
      text=$(printf '%s' "$line" | jq -r '.content // ""')
      printf 'USER   %s\n' "${text:0:200}"
      ;;

    assistant)
      text=$(printf '%s' "$line" | jq -r '.content // ""')
      [ -n "$text" ] && printf 'ASST   %s\n' "${text:0:200}"
      # tool calls on separate lines
      printf '%s' "$line" | jq -r '
        .tool_calls[]? |
        "CALL   " + .function.name + "(" +
          (.function.arguments | fromjson? // {} | to_entries |
            map(.key + "=" + (.value | tostring | .[0:50])) | join(", ")) +
          ")"
      ' 2>/dev/null || true
      ;;

    tool)
      tcid=$(printf '%s' "$line" | jq -r '.tool_call_id // ""')
      content=$(printf '%s' "$line" | jq -r '.content // ""')
      printf 'TOOL   [%s] %s\n' "${tcid: -6}" "${content:0:160}"
      ;;

    *)
      printf '%-6s %s\n' "$role" "$(printf '%s' "$line" | jq -r 'tostring | .[0:160]')"
      ;;
  esac
done
