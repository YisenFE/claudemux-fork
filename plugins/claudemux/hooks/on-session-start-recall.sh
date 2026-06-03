#!/usr/bin/env bash
# claudemux SessionStart "recent-work recall" hook.
#
# Injects the dispatcher's recent `tm history` into the session as
# additionalContext, so a dispatcher that almost never restarts and compacts
# repeatedly keeps a fresh view of what its teammates have been doing —
# replacing the auto-loading the retired hand-written Markdown ledger used to
# get via CLAUDE.md @import. Wired on the startup|resume|compact sources
# (compact is the main path: every compaction re-fires SessionStart and
# refreshes the recall, not just a cold start).
#
# DISPATCHER-ONLY, via two env gates that must BOTH hold:
#   1) TM_DISPATCHER_DIR is set. `/claudemux:setup` writes it into the
#      dispatcher root's .claude/settings.json, so Claude Code injects it on
#      dispatcher launch. An ad-hoc `claude` with no claudemux config has it
#      unset → no-op.
#   2) CLAUDEMUX_TEAMMATE_NAME is NOT set. A `tm spawn` teammate inherits the
#      dispatcher's TM_DISPATCHER_DIR through the tmux server environment, so
#      gate 1 alone would also fire inside teammates and pollute their
#      context. The teammate identity env is the positive signal that this is
#      a teammate; its absence is what makes the hook dispatcher-only.
#
# This hook ships in the plugin's hooks.json (like the other four), so the
# `${CLAUDE_PLUGIN_ROOT}` path is re-resolved to the current plugin version on
# every launch. It calls `tm` by PATH (Claude Code prepends each plugin's
# bin/ to PATH) — never an absolute, version-pinned plugin path.
#
# SessionStart hook failures show their stderr to the user on every session
# start, so every failure mode here degrades to a silent `exit 0` with no
# stderr and no output (which Claude Code treats as "no context to add").

set -u

# Gate 1: dispatcher-configured session. Gate 2: not a teammate.
[[ -n "${TM_DISPATCHER_DIR:-}" ]] || exit 0
[[ -z "${CLAUDEMUX_TEAMMATE_NAME:-}" ]] || exit 0

# Required tools, both guarded: `tm` provides the history, `jq` builds the
# JSON with correct string escaping (history intent/name fields are arbitrary
# user text — quotes, backslashes, newlines, unicode). Missing either → no-op.
command -v tm >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Recent window. --oneline is the compact one-row-per-session shape
# (`id engine state repo name intent`), sorted newest-first; --limit bounds
# the row count before the character budget below trims further.
RECALL_SINCE="3d"
RECALL_LIMIT=50

history_text="$(tm history --since "$RECALL_SINCE" --oneline --limit "$RECALL_LIMIT" 2>/dev/null)" || exit 0

# Nothing recent (or `tm history` printed nothing) → no context worth adding.
[[ -n "$history_text" ]] || exit 0

# Character budget for the injected history. additionalContext rides in the
# context window every session start and every compact, so keep it bounded
# (~10k cap for the whole string; 9000 here leaves room for the header and
# pointer). History is newest-first, so truncating the TAIL keeps the most
# recent rows; trim back to a line boundary so no row is cut mid-string, and
# append an on-demand pointer to query the rest.
HISTORY_BUDGET=9000
pointer=""
if [[ ${#history_text} -gt $HISTORY_BUDGET ]]; then
    history_text="${history_text:0:$HISTORY_BUDGET}"
    history_text="${history_text%$'\n'*}"
    pointer=$'\n'"… truncated to the most recent; run \`tm history --since 1w\` (or a longer window) for the rest."
fi

additional_context="Recent teammate sessions — \`tm history --since ${RECALL_SINCE} --oneline\`, newest first.
Columns: id engine state repo name intent. Look further back with \`tm history --since <window>\` (e.g. 1w, 2w).

${history_text}${pointer}"

jq -nc --arg ctx "$additional_context" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}' \
    2>/dev/null || exit 0

exit 0
