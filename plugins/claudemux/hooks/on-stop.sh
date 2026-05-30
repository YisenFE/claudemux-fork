#!/usr/bin/env bash
# claudemux "session-idle" hook.
#
# Bound to ALL of: Stop, StopFailure, PostCompact, SessionEnd. These are
# every event that transitions the session from "actively working" back
# to "ready for input" (or "gone"). On every fire:
#   1) rm /tmp/claude-idle/<sid>.busy           (clear the BUSY marker)
#   2) (Stop only) extract the assistant's last-turn text into <sid>.last
#   3) touch /tmp/claude-idle/<sid>             (the wait-idle signal)
#
# The .last file lets the dispatcher recover a full reply without scraping
# tmux scrollback (which truncates) and without parsing jsonl itself. It
# is meaningful only for Stop — the other three events don't have an
# assistant turn to extract:
#   - StopFailure: API error; whatever the model emitted before the error
#                  may not constitute a settled turn
#   - PostCompact: the jsonl has just been REWRITTEN; "last assistant"
#                  doesn't correspond to anything the user said
#   - SessionEnd:  session is going away; nothing to extract
# For those we still want the BUSY clear and the idle marker (so anything
# that was 'tm wait'-ing wakes up promptly), but we skip the .last work.
#
# Hook stdin is the harness JSON: { session_id, transcript_path,
# hook_event_name, ... }. We always exit 0 — the harness does not want a
# hook to fail the turn.

set -u

# Cross-platform stat helper. macOS ships BSD stat (`stat -f`), Linux
# ships GNU stat (`stat -c`); the two flag sets are mutually exclusive.
# Detect once and dispatch so the rest of the hook is platform-agnostic.
# Returns '0' on failure so the diag-log string composition stays safe.
if stat -f %z /dev/null >/dev/null 2>&1; then
    _STAT_FLAVOR=bsd
else
    _STAT_FLAVOR=gnu
fi
stat_size() {
    case "$_STAT_FLAVOR" in
        bsd) stat -f %z "$1" 2>/dev/null || echo 0 ;;
        *)   stat -c %s "$1" 2>/dev/null || echo 0 ;;
    esac
}

# Diagnostic log — appended on every Stop fire, one line per phase. Lives
# under the idle dir so the existing TTL sweep cleans it up after 7 days.
# Always-on (cheap); when investigating a misbehaving turn, `cat` this file
# to see what the hook saw and which branch it took.
DIAG_LOG="/tmp/claude-idle/_on-stop.log"
diag_log() {
    local ts; ts=$(date +%Y-%m-%dT%H:%M:%S)
    printf '%s sid=%s %s\n' "$ts" "${sid:-unknown}" "$*" >> "$DIAG_LOG" 2>/dev/null
}

input=$(cat || true)
[[ -n "${input:-}" ]] || exit 0

# Pull three fields in one jq invocation — jq is the dominant per-fire
# cost (~8ms cold start each), and this hook runs on EVERY Claude Code
# session on the machine across four hook events.
sid=""; transcript=""; event=""
IFS=$'\t' read -r sid transcript event < <(
    printf '%s' "$input" | jq -r '[.session_id // "", .transcript_path // "", .hook_event_name // ""] | @tsv' 2>/dev/null || true
)
[[ -n "${sid:-}" ]] || exit 0

idle_dir="/tmp/claude-idle"
mkdir -p "$idle_dir" 2>/dev/null || exit 0

# Path builders for the per-sid protocol files under $idle_dir. Mirror
# bin/tm's idle_marker_for / busy_marker_for / last_file_for so the
# scheme has a named accessor at every site — hooks can't source tm,
# so the discipline is enforced by repeating the builders here.
idle_marker_for() { echo "$idle_dir/$1"; }
busy_marker_for() { echo "$idle_dir/$1.busy"; }
last_file_for()   { echo "$idle_dir/$1.last"; }

diag_log "phase=enter event=${event:-?} transcript=${transcript:-<empty>}"

# BUSY marker is cleared on ALL four events. Cheap, no branching needed.
rm -f "$(busy_marker_for "$sid")" 2>/dev/null

# Occasionally sweep stale idle/last files older than 7 days. The hook is the
# only writer to $idle_dir, but `tm kill` only cleans entries for sessions it
# spawned — ad-hoc `claude` sessions (and orphans from crashes) accumulate
# forever otherwise. Run in the background and ignore failures so the sweep
# never delays turn-end. ~1/16 probability keeps it amortized over many turns.
if (( RANDOM % 16 == 0 )); then
    find "$idle_dir" -maxdepth 1 -mtime +7 -type f -delete 2>/dev/null &
    disown 2>/dev/null || true
fi

last_file=$(last_file_for "$sid")

# Reverse input by line. GNU `tac` if available (Linux), else BSD `tail -r`
# (macOS). Both seek from end on a regular file (true backward streaming),
# and both also work on stdin (slurped), which is fine for the second
# reversal where input is already O(turn-size).
rev_lines() {
    if command -v tac >/dev/null 2>&1; then tac "$@"; else tail -r "$@"; fi
}

# Extract the assistant's last-turn text from a jsonl transcript.
#
# Walk the file BACKWARDS line by line. For each entry:
#   - assistant entry: emit its joined text-block content (empty entries dropped)
#   - real user entry (string content): `halt` — that's the previous turn's
#     boundary. tool_result user entries have array content, so they fail the
#     type check and we keep walking back.
#   - synthetic local-command user entries (`<bash-input>`, `<bash-stdout>`,
#     `<bash-stderr>`, `<local-command-stdout>`, `<local-command-caveat>`,
#     `<command-name|message|args>`, `<task-notification|summary|output>`):
#     Claude Code writes these as
#     string-content user entries AFTER an assistant turn ends (the `!cmd`
#     and `/slash` machinery, plus background task notifications). They are
#     not turn boundaries — skip them and keep walking back.
#   - anything else: skip.
# `halt` makes jq exit cleanly, the upstream reverser gets SIGPIPE and stops,
# so the file read is bounded by ONE turn's worth of lines (~10s-100s), not
# the transcript length. The small reversed output is then reversed back to
# chronological order and joined with blank lines.
extract_last_turn() {
    rev_lines "$1" 2>/dev/null | jq -c '
        if .type == "user" and (.message.content | type) == "string" then
          if (.message.content | test("^<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-caveat|command-name|command-message|command-args|task-notification|task-summary|task-output)\\b")) then empty
          else halt
          end
        elif .type == "assistant" then
          (.message.content // [] | map(select(.type == "text") | .text) | join(""))
          | select(length > 0)
        else empty end
    ' 2>/dev/null | rev_lines | jq -rs 'join("\n\n")'
}

# Return "<stop_reason>|<content_types>" for the most recent assistant
# entry in the jsonl (content_types comma-separated, e.g. "text" or
# "thinking,tool_use"), or empty on error / no assistant entry yet.
# Tail-walks with rev_lines + head -1: SIGPIPE bounds the scan to one
# entry's worth of lines.
latest_assistant_summary() {
    rev_lines "$1" 2>/dev/null \
        | jq -r 'select(.type == "assistant")
            | "\(.message.stop_reason // "")|\((.message.content // []) | map(.type) | join(","))"' 2>/dev/null \
        | head -1
}

# Does this stop_reason mean the Anthropic API call ended without expecting
# the agent loop to continue? Source: Anthropic API docs.
#   end_turn       Model finished its natural text response.
#   stop_sequence  A configured stop sequence was emitted.
#   max_tokens     Token budget hit.
#   refusal        Model refused (newer models).
# Non-terminal — the agent loop is still mid-flight and will write more:
#   tool_use       Paused waiting for caller to run a tool.
#   pause_turn     Extended-thinking pause; more content coming.
is_terminal_stop_reason() {
    case "$1" in
        end_turn|stop_sequence|max_tokens|refusal) return 0 ;;
        *) return 1 ;;
    esac
}

# Is the latest assistant entry SETTLED — i.e. safe to treat the turn as
# truly over? Two conditions:
#   1. stop_reason is terminal (see above).
#   2. content contains at least one `text` or `tool_use` block.
#
# Why (2): Claude Code can split an extended-thinking turn into separate
# API responses — a thinking-only response with stop_reason=end_turn
# followed by a text response with stop_reason=end_turn. Without (2), the
# hook fast-pathed on the thinking-only entry, extracted no text, and
# rm'd .last seconds before the real deliverable landed. Requiring a non-
# thinking block forces the wait to continue until the visible/actionable
# part of the turn has been flushed.
is_assistant_settled() {
    local summary="$1" reason types
    [[ -n "$summary" ]] || return 1
    reason="${summary%%|*}"
    types="${summary#*|}"
    is_terminal_stop_reason "$reason" || return 1
    case ",$types," in
        *,text,*|*,tool_use,*) return 0 ;;
        *) return 1 ;;
    esac
}

# Poll the jsonl until the latest assistant entry is "settled" (terminal
# stop_reason AND has text/tool_use content). Returns 0 on hit, 1 on
# timeout. Budget 75 × 0.2s = 15s, well within the default 60s hook
# timeout. The loop early-exits the instant the entry settles, so the
# budget is a ceiling for the slow-flush case, not a fixed cost: a fast
# turn returns in one iteration. 15s covers a long reply with deep
# thinking flushing to the transcript; past that, suspect a real stall.
wait_for_jsonl_terminal() {
    local jsonl="$1" summary i
    for ((i = 0; i < 75; i++)); do
        summary=$(latest_assistant_summary "$jsonl")
        if is_assistant_settled "$summary"; then
            return 0
        fi
        sleep 0.2
    done
    return 1
}

# .last extraction is meaningful only for Stop. StopFailure, PostCompact,
# and SessionEnd reach the touch-idle below without touching .last.
if [[ "$event" == "Stop" && -n "${transcript:-}" && -f "$transcript" ]]; then
    # Snapshot tail-5 entries at fire time — type|stop_reason|content_types
    # — so we can later tell whether the jsonl already had a text-bearing
    # final entry, or only an earlier thinking-only one.
    tail_summary=$(tail -5 "$transcript" 2>/dev/null | jq -r '
        [(.type // "?"),
         (.message.stop_reason // "-"),
         (if .type == "assistant" then ((.message.content // []) | map(.type) | join(",")) else "-" end)
        ] | join("|")
    ' 2>/dev/null | tr '\n' ';')
    diag_log "phase=tail-summary jsonl_size=$(stat_size "$transcript") tail5=[${tail_summary%;}]"

    # The Stop hook can fire before the turn's final assistant API response
    # has been flushed to the jsonl on disk — so a naive extract can produce
    # a .last that is silently missing the user-visible deliverable text
    # block. We poll for a TERMINAL stop_reason on the most recent assistant
    # entry to decide it's safe to extract.
    #
    # Known weakness being investigated: a turn that splits into multiple
    # API calls (e.g. one thinking-only call followed by a text call) has
    # MULTIPLE terminal entries. If the earlier one is in the jsonl but the
    # final text one isn't yet, fast-path passes prematurely and we extract
    # nothing — historically rm'd .last, which destroyed prior content too.
    # Diagnostic logging here lets us see the timing on a real repro before
    # tightening the predicate.
    if wait_for_jsonl_terminal "$transcript"; then
        diag_log "phase=wait-end result=terminal"
        text=$(extract_last_turn "$transcript")
        if [[ -n "$text" ]]; then
            printf '%s\n' "$text" > "$last_file"
            # ${#text} is character count, not bytes — under UTF-8 that's
            # half-ish to a third of the on-disk size for CJK text. Read
            # the actual file size with stat for the "what shipped" number,
            # and keep the char count as a secondary signal.
            file_bytes=$(stat_size "$last_file")
            diag_log "phase=write file_bytes=$file_bytes text_chars=${#text}"
        else
            diag_log "phase=rm-empty (terminal stop_reason but extract empty — tool-only or thinking-only final entry?)"
            rm -f "$last_file"
        fi
    else
        # On timeout, leave .last untouched. A 15s poll miss does not
        # prove the file is stale — it just means the jsonl has not
        # reached a terminal stop_reason within our budget; the prior
        # turn's settled content in .last may still be the correct
        # thing for `tm wait` / `tm last` to surface.
        diag_log "phase=timeout (jsonl never reached terminal stop_reason within 15s — leaving .last as-is)"
    fi
fi

# Touch the idle signal LAST. Any waiter that races on the touch and
# immediately reads .last will find the .last in place. We always touch
# regardless of event so 'tm wait' (and the wait phase of 'tm send' /
# 'tm compact' / 'tm spawn --prompt') wakes up on StopFailure /
# PostCompact / SessionEnd too — without those, /compact and API-error
# turns would hang the wait forever.
touch "$(idle_marker_for "$sid")"
diag_log "phase=touch-idle event=${event:-?}"
exit 0
