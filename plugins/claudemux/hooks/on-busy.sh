#!/usr/bin/env bash
# claudemux on-busy hook.
#
# Fires on UserPromptSubmit, UserPromptExpansion, PreToolUse, PreCompact —
# every event that transitions the session from "ready for input" to
# "actively working on something". Writes /tmp/claude-idle/<sid>.busy as a
# zero-byte marker. `tm states` / `pane_busy()` read this file to decide
# whether the teammate is busy without scraping the pane.
#
# The OFF transition (rm .busy + touch idle marker) is handled by
# on-stop.sh, which is bound to Stop, StopFailure, PostCompact, SessionEnd.
#
# This hook fires for EVERY Claude Code session on the machine (including
# the dispatcher itself). The .busy file is keyed by session_id, so there
# is no cross-session collision — but it does mean we cannot do anything
# expensive here. No jq, no transcript parsing — just extract session_id
# with sed and touch one file.

set -u

input=$(cat || true)
[[ -n "$input" ]] || exit 0

# Fast session_id extract. jq spawn (~8ms cold) is too expensive for a hook
# that fires on every PreToolUse. The payload is a single-line JSON object
# in practice; this sed pattern grabs the first "session_id":"..." value.
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[[ -n "$sid" ]] || exit 0

idle_dir="/tmp/claude-idle"
mkdir -p "$idle_dir" 2>/dev/null || exit 0

# Path builders for the per-sid protocol files under $idle_dir. Mirror
# bin/tm's idle_marker_for / busy_marker_for / last_file_for so the
# scheme has a named accessor at every site — hooks can't source tm,
# so the discipline is enforced by repeating the builders here.
busy_marker_for() { echo "$idle_dir/$1.busy"; }

touch "$(busy_marker_for "$sid")"
exit 0
