# Component: the hook bundle

Four hook scripts under [`/plugins/claudemux/hooks/`](/plugins/claudemux/hooks),
wired in [`hooks.json`](/plugins/claudemux/hooks/hooks.json). Three maintain the
file-based BUSY/idle signal that `tm`'s waiting verbs block on; the fourth,
[`on-session-start-recall.sh`](/plugins/claudemux/hooks/on-session-start-recall.sh),
is dispatcher-only and injects recent `tm history` as SessionStart context (see
[decision dispatcher-sessionstart-recall](/.agents/decisions/dispatcher-sessionstart-recall.md)).

The hooks fire for **every Claude Code session on the machine** — every
teammate *and* the dispatcher itself. For the three signal hooks that is by
design: markers are keyed by `session_id`, so there is no cross-session
collision, and nothing waits on the dispatcher's own markers, so its extra
writes are harmless. The recall hook also fires on every session but **no-ops
unless the session is the dispatcher** (env-gated, below) and writes no marker.

## The four scripts

| Script | Bound events | Job |
|---|---|---|
| [`on-busy.sh`](/plugins/claudemux/hooks/on-busy.sh) | `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PreCompact` | Touch `/tmp/claude-idle/<sid>.busy` — the idle→working transition |
| [`on-stop.sh`](/plugins/claudemux/hooks/on-stop.sh) | `Stop`, `StopFailure`, `PostCompact`, `SessionEnd` | Remove `.busy`, touch the idle marker, and (Stop only) write `<sid>.last` — the working→idle transition |
| [`on-session-start.sh`](/plugins/claudemux/hooks/on-session-start.sh) | `SessionStart` | Keep `/tmp/teammate-<repo>.sid` in sync when `/clear` or `/resume` rotates the session_id; touch `<repo>.ready` for `tm spawn`'s poll |
| [`on-session-start-recall.sh`](/plugins/claudemux/hooks/on-session-start-recall.sh) | `SessionStart` (matcher `startup\|resume\|compact`) | Dispatcher-only: inject recent `tm history` as `additionalContext` so recent-work recall refreshes on every compaction |

The event sets for `on-busy.sh` and `on-stop.sh` are chosen to cover *every*
transition in each direction. Why this matters: if `tm wait` only woke on
`Stop`, a `/compact` turn (which ends on `PostCompact`) or an API-error turn
(`StopFailure`) would hang the wait forever. See
[decision hook-driven-busy-idle-signal](/.agents/decisions/hook-driven-busy-idle-signal.md).

## Design constraints when editing a hook

- **A hook must be fast.** `on-busy.sh` runs on every `PreToolUse` — it uses
  `sed`, not `jq`, to pull `session_id` (a `jq` cold start is ~8 ms of
  wasted budget per fire). `on-stop.sh` may use `jq` because it runs once
  per turn, not per tool call.
- **A hook always exits 0.** The harness must not see a hook fail the turn.
  Every failure path degrades silently.
- **Hooks cannot source `tm`.** They re-declare the path builders
  (`idle_marker_for`, `busy_marker_for`, `last_file_for`) inline. The
  invariant is "every protocol path comes from a named builder" — *not*
  "one shared definition". When the protocol shape changes, both `tm` and
  the hooks must change together.
- **Cross-platform.** `on-stop.sh` carries its own `stat_size` BSD/GNU
  helper and a `rev_lines` helper (`tac` on Linux, `tail -r` on macOS).

## `on-stop.sh` — the `.last` extraction subtlety

`.last` (the teammate's last-turn text) is written **only on `Stop`** —
`StopFailure`/`PostCompact`/`SessionEnd` have no settled assistant turn to
extract. Even on `Stop`, the hook can fire before the final assistant API
response is flushed to the transcript jsonl. So `on-stop.sh` polls the jsonl
(budget 75 × 0.2 s = 15 s) for an assistant entry that is **settled**: a
terminal `stop_reason` *and* at least one `text` or `tool_use` content block.
Requiring the non-thinking block prevents a thinking-only intermediate
response from being mistaken for the finished turn. On poll timeout it
leaves the existing `.last` untouched rather than blanking it.
When walking backward to find the last assistant turn, synthetic string-content
user entries emitted after the assistant response are skipped instead of
treated as user turn boundaries; this includes local-command tags and the
background-task tag family (`<task-notification>`, `<task-summary>`,
`<task-output>`).

A diagnostic log at `/tmp/claude-idle/_on-stop.log` records one line per
phase per fire — `cat` it when investigating a misbehaving turn.

## `on-session-start.sh` — the two safety gates

Sid rotation only happens when **both** gates pass:

1. **Env identity gate** — `CLAUDEMUX_TEAMMATE_NAME` must be set. Only
   `tm spawn` launches a tmux session with that env (`tmux new-session -e`),
   and it survives `/clear` / `/resume`. This is what stops the dispatcher
   (whose cwd may byte-equal a sibling repo) from hijacking a teammate's
   `.sid`.
2. **Recorded-cwd byte match** — the firing session's cwd must byte-equal
   `/tmp/teammate-<repo>.cwd`, written by `tm spawn` with the physical path.

Each real rotation is appended to `/tmp/claudemux-sid-changes.log`.

## `on-session-start-recall.sh` — dispatcher-only recall

Injects the dispatcher's recent `tm history` as SessionStart
`additionalContext`, so a dispatcher that rarely restarts and compacts often
keeps a fresh view of recent teammate work — the `compact` source is the main
path (every compaction re-fires SessionStart and refreshes the recall).

- **Two env gates, both required.** It runs only when `TM_DISPATCHER_DIR` is
  set **and** `CLAUDEMUX_TEAMMATE_NAME` is unset. The first marks a
  claudemux-configured session; the second excludes teammates — a `tm spawn`
  teammate inherits `TM_DISPATCHER_DIR` through the tmux server environment,
  so the absence of the teammate-identity env is what makes the hook
  dispatcher-only. Any other session no-ops.
- **`tm` by PATH, never an absolute plugin path.** The script calls bare `tm`
  (Claude Code prepends each plugin's `bin/` to PATH) and ships in the
  plugin's `hooks.json`, so the `${CLAUDE_PLUGIN_ROOT}` wiring re-resolves to
  the current plugin version every launch. Writing a version-pinned plugin
  path into a settings.json hook would 404 after the next plugin update — and
  a SessionStart hook failure surfaces its stderr to the user on every session
  start (below). See
  [decision dispatcher-sessionstart-recall](/.agents/decisions/dispatcher-sessionstart-recall.md).
- **Bounded, newest-first.** `tm history --since 3d --oneline --limit 50`,
  then a ~9 KB character budget trims the tail (history is newest-first, so
  the most recent rows survive) and appends a `tm history --since <window>`
  pointer for the rest. `jq` builds the JSON so arbitrary intent text is
  escaped correctly.
- **Silent on every failure.** SessionStart cannot block, but its hook's
  stderr is shown to the user on every session start, so each failure mode
  (gates not met, `tm`/`jq` missing, `tm history` non-zero, empty history)
  degrades to `exit 0` with no stdout and no stderr.

## See also

- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — every protocol file the hooks read and write.
- [components/tm.md](/.agents/components/tm.md) — the consumer side of the signal.
- [decisions/hook-driven-busy-idle-signal.md](/.agents/decisions/hook-driven-busy-idle-signal.md) — why the signal is hook-driven.
- [decisions/dispatcher-sessionstart-recall.md](/.agents/decisions/dispatcher-sessionstart-recall.md) — why recall is a plugin SessionStart hook, dispatcher-gated.
