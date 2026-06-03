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
# DISPATCHER-ONLY, via three gates that must ALL hold:
#   1) TM_DISPATCHER_DIR is set. `/claudemux:setup` writes it into the
#      dispatcher root's .claude/settings.json, so Claude Code injects it on
#      dispatcher launch. A session with no claudemux config has it unset.
#   2) CLAUDEMUX_TEAMMATE_NAME is NOT set. A `tm spawn` teammate inherits the
#      dispatcher's TM_DISPATCHER_DIR through the tmux server environment, so
#      the env alone does not distinguish a teammate; the teammate-identity
#      env's absence does.
#   3) The SessionStart cwd resolves to TM_DISPATCHER_DIR. This is the
#      authoritative check: TM_DISPATCHER_DIR can leak into any session
#      launched from a shell that exported it, but only the dispatcher session
#      actually runs *in* that directory. Gates 1–2 are the cheap fast-path
#      and defense-in-depth; gate 3 is what makes "dispatcher-only" true.
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

# Gate 1 (dispatcher-configured) and gate 2 (not a teammate) are cheap env
# checks that fast-path out of the common non-dispatcher session.
[[ -n "${TM_DISPATCHER_DIR:-}" ]] || exit 0
[[ -z "${CLAUDEMUX_TEAMMATE_NAME:-}" ]] || exit 0

# Gate 3 — the authoritative dispatcher check: the firing session's cwd must
# resolve to TM_DISPATCHER_DIR. The cwd arrives in the SessionStart hook's
# JSON stdin (the same shape on-session-start.sh reads). Resolve both sides
# with `cd … && pwd -P` so a symlinked dispatcher path or a logical-vs-physical
# difference still matches; a missing/empty dir resolves to empty and fails.
input="$(cat 2>/dev/null || true)"
hook_cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
resolve_dir() { (cd "$1" 2>/dev/null && pwd -P) || true; }
dispatcher_real="$(resolve_dir "$TM_DISPATCHER_DIR")"
cwd_real="$(resolve_dir "$hook_cwd")"
[[ -n "$dispatcher_real" && "$cwd_real" == "$dispatcher_real" ]] || exit 0

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
# context window on every startup and compaction, so keep it bounded. Claude
# Code measures the additionalContext limit in characters (10,000); a 9000
# budget leaves room for the header and pointer. `${#var}` counts characters
# in a UTF-8 locale and bytes under LC_ALL=C, and bytes ≥ characters for
# multibyte text, so 9000 stays under the 10,000-character cap either way.
# History is newest-first, so truncating the TAIL keeps the most recent rows;
# trim back to a line boundary so no row is cut mid-string, then append an
# on-demand pointer to query the rest.
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
