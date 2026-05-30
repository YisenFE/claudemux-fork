# sid rotation and spawn readiness (diagnostic reference)

Mechanism behind two pieces of `claudemux` plumbing that are normally invisible:

1. How `tm spawn` blocks until the new teammate REPL is actually usable.
2. How `on-session-start.sh` keeps `/tmp/teammate-<name>.sid` in sync when `/clear` (or interactive `/resume`) rotates the underlying claude `session_id`.

Read this only when debugging `.sid` drift, a stuck `tm spawn`, or surprising `tm states` output. Normal dispatcher work does not need to consult it.

## Spawn readiness

`tm spawn` pre-removes `/tmp/teammate-<name>.ready`, launches `tmux`+`claude`, then polls that file (60 × 0.3 s = 18 s cap) before returning. The SessionStart hook touches the file the moment the new claude session signals start — typically 2–4 s on a warm Mac — and the poll returns the moment it lands. On timeout, spawn prints a `WARN` and returns anyway so the caller can probe with `tm send` and get a real error if claude failed to boot. The file is per-teammate-name (not per-sid) and lives outside the `/tmp/claude-idle/` namespace.

## `/clear` and sid rotation

`/clear` retires the current `session_id` and starts a fresh one. Without help, `/tmp/teammate-<name>.sid` would still point at the dead sid and every subsequent `tm states / last / wait / send` would consult orphan files. The `on-session-start.sh` hook handles this with two gates on every `SessionStart` event:

1. **Env identity.** `tm spawn` launches its tmux session with `tmux new-session -e CLAUDEMUX_TEAMMATE_NAME=<name>`. claude inherits that env, and so does the hook. If the env var is unset, this is some other claude session (the dispatcher itself, an ad-hoc `cd <path> && claude`, or a teammate started via raw `tmux new-session` without the `-e`) — the hook no-ops. The env survives `/clear` and `/resume` because they don't restart the claude process.

2. **Recorded-cwd byte match.** Even with the env set, the firing claude's cwd must byte-equal the content of `/tmp/teammate-<env-name>.cwd` (written by `tm spawn`). For worktree teammates that recorded cwd is the worktree path under `<repo>/.claude/worktrees/<name>/`; for `--no-worktree` teammates it is the repo itself. A stray `cd packages/foo` inside the teammate before `/clear` won't match — the `.sid` pointer stays pinned to the teammate's real workspace.

On a both-gates pass, the hook overwrites `/tmp/teammate-<name>.sid` with the new sid (handles `/clear` and interactive `/resume`) and touches `/tmp/teammate-<name>.ready` (the spawn-readiness signal). `source=startup|compact|resume` with unchanged sid is a quiet no-op for the rotation step; readiness is touched regardless. All sid rotations are logged to `/tmp/claudemux-sid-changes.log` for audit.

The `/hooks` slash-command UI surfaces tool-related hooks, not Stop hooks. Do not conclude that Stop wiring is missing from that UI alone; check `~/.claude/settings.json` and watch `/tmp/claude-idle/<sid>` instead.

## Debugging checklist

When `.sid` looks wrong or `tm states` shows stale data:

| What to inspect | Command | What it tells you |
|---|---|---|
| Current sid pointer | `cat /tmp/teammate-<name>.sid` | Which session id the helpers consult |
| Recorded teammate cwd | `cat /tmp/teammate-<name>.cwd` | Must byte-equal the teammate's own `pwd -P` |
| Rotation history | `tail /tmp/claudemux-sid-changes.log` | Every rotation, with timestamps and source |
| Env identity (run inside teammate) | `printenv CLAUDEMUX_TEAMMATE_NAME` | Empty → env gate fails → hook no-ops |
| Spawn readiness signal | `ls -l /tmp/teammate-<name>.ready` | Touched by SessionStart on boot |

If env identity is empty, the teammate was launched outside `tm spawn` (raw `tmux new-session`, or `cd <path> && claude`). Kill it and re-launch via `tm spawn <path>`; raw launches deliberately bypass the rotation machinery.
