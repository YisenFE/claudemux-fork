#!/usr/bin/env bash
# scan-dispatcher.sh — convert recent dispatcher JSONL transcripts into
# readable MD logs that /claudemux:optimize ingests.
#
# Uses $PWD (physical path) to locate ~/.claude/projects/<encoded>/ —
# Claude Code encodes each project's cwd as its directory name, mapping
# both '/' AND '.' to '-' (verified: ~/.claude → -Users-<user>--claude,
# the double dash comes from the leading '.' on '.claude'). That single
# encoded directory contains EXACTLY the dispatcher's own conversations.
# Per-repo teammate sessions live under different encoded dirs (one per
# repo), so no cross-project post-filter is needed.
#
# Self-contained: depends only on bash and jq. No external skill or
# scanner is required.
#
# Usage:
#   scan-dispatcher.sh [days=7] [output_dir=/tmp/dispatcher-optimize-logs]
# Env:
#   MIN_TURNS  minimum string-typed user-turn count to include a session
#              (default 2) — sessions below the bar are skipped as noise

set -euo pipefail

DAYS="${1:-7}"
OUT="${2:-/tmp/dispatcher-optimize-logs}"
MIN_TURNS="${MIN_TURNS:-2}"

command -v jq >/dev/null 2>&1 || {
    echo "scan-dispatcher: jq is required but not on PATH (try 'brew install jq' on macOS, 'apt-get install jq' on Debian/Ubuntu)" >&2
    exit 1
}

DISPATCHER_DIR=$(pwd -P)
ENCODED=$(printf '%s' "$DISPATCHER_DIR" | tr './' '-')
PROJECT_DIR="$HOME/.claude/projects/$ENCODED"

mkdir -p "$OUT"
rm -f "$OUT"/*.md

if [[ ! -d "$PROJECT_DIR" ]]; then
    # No Claude Code project dir for this cwd at all — caller has never run
    # `claude` from $PWD as a recorded session. Distinct from "no signal"
    # (project dir exists but no jsonl in the look-back window): callers
    # branch on the STATUS line below.
    echo "STATUS: no-project-dir"
    echo "scan-dispatcher: no project dir at $PROJECT_DIR — this dispatcher hasn't recorded any sessions yet" >&2
    echo "$OUT"
    exit 2
fi

# find -mtime -N: files modified within the last N*24h. Both BSD (macOS)
# and GNU (Linux) find accept the same semantics here.
# Use while-read (portable to macOS bash 3.2) rather than mapfile (bash 4+).
JSONLS=()
while IFS= read -r f; do
    [[ -n "$f" ]] && JSONLS+=("$f")
done < <(find "$PROJECT_DIR" -maxdepth 1 -type f -name '*.jsonl' -mtime "-$DAYS" 2>/dev/null | sort)

echo "scan-dispatcher: dispatcher_dir=$DISPATCHER_DIR"
echo "scan-dispatcher: scanning last $DAYS day(s) from $PROJECT_DIR (${#JSONLS[@]} jsonl candidate(s))"

written=0
skipped=0
for jsonl in "${JSONLS[@]}"; do
    sid=$(basename "$jsonl" .jsonl)

    # Count real user prompts (string-typed content). tool_result entries
    # have array-typed content; they don't represent user activity and are
    # excluded from the threshold check.
    user_turns=$(jq -r '
        select(.type == "user" and (.message.content | type) == "string") | 1
    ' "$jsonl" 2>/dev/null | wc -l | tr -d ' ')

    if (( user_turns < MIN_TURNS )); then
        skipped=$((skipped+1))
        continue
    fi

    # `first(inputs|...)` lets jq short-circuit after the first match and exit
    # cleanly. We avoid `jq ... | head -1` here: on a large jsonl, head closes
    # its stdin after one line, jq is killed by SIGPIPE → rc=141, and with
    # `set -o pipefail` that kills the whole script mid-loop. (last_ts via
    # `tail -1` is safe: tail reads its entire stdin, so no SIGPIPE on jq.)
    first_ts=$(jq -rn 'first(inputs | .timestamp // empty)' "$jsonl" 2>/dev/null)
    last_ts=$(jq -r 'select(.timestamp != null) | .timestamp' "$jsonl" 2>/dev/null | tail -1)

    out_file="$OUT/${sid}.md"
    {
        printf -- '---\n'
        printf 'session: %s\n' "$sid"
        printf 'project: %s\n' "$DISPATCHER_DIR"
        printf 'started: %s\n' "${first_ts:-?}"
        printf 'ended: %s\n' "${last_ts:-?}"
        printf 'user_turns: %s\n' "$user_turns"
        printf 'source: scan-dispatcher\n'
        printf -- '---\n\n'

        # Walk entries in append (chronological) order. Emit:
        #   USER   — string-typed user prompts
        #   ASST   — assistant text blocks
        #   TOOL   — assistant tool_use blocks, summarized as "<name>: <one-liner>"
        #   ERROR  — user tool_result blocks with is_error=true, summarized
        # Successful tool_results (is_error=false), thinking blocks, and
        # is_error=false tool_result blobs are dropped — they inflate token
        # cost without adding signal. We keep is_error=true because "which
        # commands the dispatcher ran that failed" is exactly the kind of
        # foot-gun signal /claudemux:optimize looks for.
        #
        # Sidechain entries (sub-agent turns) are kept so the optimize pass
        # can see what work the dispatcher delegated; they share the same
        # session jsonl and otherwise look like normal user/assistant blocks.
        jq -r '
            def short(s):
                (s // "" | tostring | gsub("\n"; " ") |
                 if length > 200 then .[0:200] + "…" else . end);

            def tool_one_liner(input):
                if input == null then ""
                elif input.file_path then short(input.file_path)
                elif input.command then short(input.command)
                elif input.path then short(input.path)
                elif input.pattern then short(input.pattern)
                elif input.prompt then short(input.prompt)
                elif input.url then short(input.url)
                else short(input | tostring)
                end;

            # tool_result.content can be either a string or an array of
            # content blocks (Anthropic API spec). Coerce to a single string.
            def tr_text(c):
                if (c | type) == "string" then c
                elif (c | type) == "array" then
                    (c | map(select(.type == "text") | .text) | join("\n"))
                else "" end;

            (.timestamp // "") as $ts
            | if .type == "user" and (.message.content | type) == "string" then
                "## USER (\($ts))\n\(.message.content)\n"
              elif .type == "user" and (.message.content | type) == "array" then
                .message.content[]
                | select(.type == "tool_result" and (.is_error // false) == true)
                | "## ERROR (\($ts))\n\(short(tr_text(.content)))\n"
              elif .type == "assistant" and (.message.content | type) == "array" then
                .message.content[]
                | if .type == "text" then
                    "## ASST (\($ts))\n\(.text)\n"
                  elif .type == "tool_use" then
                    "## TOOL (\($ts))\n\(.name): \(tool_one_liner(.input))\n"
                  else empty end
              else empty end
        ' "$jsonl" 2>/dev/null

    } > "$out_file"

    written=$((written+1))
done

# Emit STATUS line so callers don't have to count files themselves.
# - no-signal: project dir exists but produced zero usable logs in the window
# - ok:        at least one session log was written
if (( written == 0 )); then
    echo "STATUS: no-signal"
else
    echo "STATUS: ok"
fi
echo "scan-dispatcher: wrote $written session log(s), skipped $skipped (under min_turns=$MIN_TURNS)"
echo "$OUT"
