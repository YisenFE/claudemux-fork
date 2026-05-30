#!/usr/bin/env bash
# claudemux SessionStart hook. Three responsibilities, gated by two
# independent safety checks (no DEV_DIR, no config file):
#
#   1) Sid rotation. /clear (and interactive /resume) generate a fresh
#      session_id; we update /tmp/teammate-<repo>.sid in place so the
#      dispatcher's `tm states / last / wait / send` keep working.
#
#   2) Spawn readiness. Touch /tmp/teammate-<repo>.ready so `tm spawn`'s
#      poll loop knows the REPL is up.
#
#   3) Audit. Each rotation is appended to /tmp/claudemux-sid-changes.log
#      so drift events are post-hoc inspectable.
#
# Safety check 1 — env identity gate:
#   `tm spawn` launches its tmux session with
#   `tmux new-session -e CLAUDEMUX_TEAMMATE_NAME=<name>`. claude inherits
#   that env, hooks inherit it from claude. The env survives /clear and
#   /resume because they don't restart the claude process. If the env is
#   not set, this is some other claude session (the dispatcher itself,
#   an ad-hoc `cd <repo> && claude`, a teammate launched via raw
#   `tmux new-session` without the -e) and we no-op. This single check
#   is what prevents a dispatcher whose cwd happens to byte-equal a
#   recorded teammate.cwd from hijacking the teammate's .sid file via
#   the cwd-match loop below.
#
# Safety check 2 — recorded-cwd byte match:
#   Even with the env set, we still verify the firing claude's cwd
#   byte-equals the content of /tmp/teammate-<env-name>.cwd. `tm spawn`
#   writes that file at spawn time with the PHYSICAL path of the
#   teammate's working directory (the worktree path under
#   <repo>/.claude/worktrees/<slug> when a worktree is in use, the
#   repo itself otherwise), and Claude Code emits cwd in the hook
#   payload as the same physical path. The match also acts as a
#   safety against a stray `cd packages/foo && /clear` inside a
#   teammate — different cwd → no sid rotation, the .sid pointer stays
#   pinned to the teammate's real workspace.

set -u

input=$(cat || true)
[[ -n "$input" ]] || exit 0

# Fast field extraction — sed is enough for the JSON shapes Claude Code
# emits; jq's ~8 ms cold start is wasted budget on every SessionStart.
extract_field() {
    printf '%s' "$input" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

sid=$(extract_field session_id)
cwd=$(extract_field cwd)
src=$(extract_field source)
[[ -n "$sid" && -n "$cwd" ]] || exit 0

# Env identity gate (see file header). Without CLAUDEMUX_TEAMMATE_NAME,
# this claude was not launched by `tm spawn` — exit before doing any
# .sid / .ready work, even if the cwd happens to match a recorded
# teammate.cwd. This is what protects against the dispatcher (running in
# a cwd that coincides with a teammate workspace) hijacking the sid
# pointer.
env_name="${CLAUDEMUX_TEAMMATE_NAME:-}"
[[ -n "$env_name" ]] || exit 0

# Recorded-cwd byte match. The env tells us WHICH teammate this is;
# the .cwd file tells us where that teammate's working directory lives
# on disk. If the firing cwd doesn't match the recorded cwd for
# env_name, something is off (e.g. someone `cd`'d into a subdir before
# /clear) — refuse to rotate, leaving the .sid pointer pinned to the
# teammate's workspace.
cf="/tmp/teammate-${env_name}.cwd"
[[ -f "$cf" ]] || exit 0
[[ "$(cat "$cf" 2>/dev/null)" == "$cwd" ]] || exit 0
name="$env_name"

sf="/tmp/teammate-${name}.sid"

# Sid rotation. Write only when the sid actually changes — that keeps
# the steady-state startup case quiet (dispatcher's `tm spawn` already
# wrote the same sid before claude booted) and limits the audit log to
# real rotations (/clear, interactive /resume).
old=""
[[ -s "$sf" ]] && old=$(cat "$sf" 2>/dev/null || true)
if [[ "$old" != "$sid" ]]; then
    echo "$sid" > "$sf"
    ts=$(date +%Y-%m-%dT%H:%M:%S)
    printf '%s name=%s source=%s old=%s new=%s\n' "$ts" "$name" "${src:-?}" "${old:-<none>}" "$sid" \
        >> /tmp/claudemux-sid-changes.log 2>/dev/null
fi

# Readiness signal — always touched once the teammate is identified.
# `tm spawn` rm's this file BEFORE launching claude and polls for it to
# reappear; subsequent SessionStarts (clear / compact / resume) also
# touch but no one polls at that time, so they're harmless mtime bumps.
touch "/tmp/teammate-${name}.ready" 2>/dev/null

exit 0
