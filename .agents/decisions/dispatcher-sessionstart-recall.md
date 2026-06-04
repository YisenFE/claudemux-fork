# Dispatcher SessionStart recall

- **Status:** Accepted
- **Date:** 2026-06-03
- **Affects:** the hook bundle, `tm history`, the dispatcher seed (`templates/CLAUDE.md.template`)

## Context

The retired hand-written dispatcher Markdown ledger had one property the
`tm history` / `tm states` replacement lost: it was auto-loaded into every
dispatcher session through a `CLAUDE.md` `@import`. `tm history` is queryable
but not automatic — a `CLAUDE.md` `@path` import only inlines a static file, it
does not run a command — so recent teammate work no longer enters context on
its own. The dispatcher makes this worse: it is a long-lived single session
that rarely restarts and compacts repeatedly, and a compaction drops the
recent-work context it had built up.

## Decision

A SessionStart hook (`on-session-start-recall.sh`) injects
`tm history --since 3d --oneline` as `additionalContext`, bound to the
`startup|resume|compact` sources. `compact` is the main path: every compaction
re-fires SessionStart, so the recall refreshes instead of only seeding a cold
start.

Two supporting choices make it robust:

- **Wired in the plugin's `hooks.json`, gated dispatcher-only — not written
  into the dispatcher's `settings.json`.** Plugin install paths are
  version-pinned (`~/.claude/plugins/cache/claudemux/claudemux/<version>/…`),
  so an absolute hook path baked into `settings.json` would 404 after the next
  plugin update — and a SessionStart hook failure shows its stderr to the user
  on *every* session start, so a stale path spams an error each launch. The
  plugin's `hooks.json` instead uses `${CLAUDE_PLUGIN_ROOT}`, re-resolved to
  the current version every launch. The script resolves `tm` the same way —
  `${CLAUDE_PLUGIN_ROOT}/bin/tm` first, falling back to `tm` on PATH — so it
  stays version-coherent and keeps resolving even when a mid-session plugin
  reload drops the plugin's `bin/` off PATH (a PATH-only lookup would silently
  inject nothing there). The hook
  gates three ways: `TM_DISPATCHER_DIR` set, `CLAUDEMUX_TEAMMATE_NAME` unset,
  and — the authoritative check — the SessionStart `cwd` realpath-equal to
  `TM_DISPATCHER_DIR`. The cwd check is what actually pins it to the
  dispatcher: `TM_DISPATCHER_DIR` can leak into any session launched from a
  shell that exported it (and a `tm spawn` teammate inherits it through the
  tmux server environment), but only the dispatcher runs *in* that directory.
  Both sides are resolved with `cd … && pwd -P` (pure bash, no `realpath`
  binary), so a symlinked path — e.g. `TM_DISPATCHER_DIR=/home/u/dev` against a
  physical cwd `/data00/home/u/dev` — still matches, with no BSD-vs-coreutils
  `realpath` portability gap.

- **Relative durations were added to `tm history --since/--until`** (`3d`,
  `12h`, `1w`, `30m` → "<N> ago"), so the hook passes `--since 3d` directly
  with no cross-platform `date` arithmetic in shell. Absolute dates still
  parse; the relative grammar cannot collide with any absolute date shape.

## Consequences

- Recall refreshes on every compaction, not just on cold start — the property
  the dispatcher actually needed.
- The hook fires for every Claude Code session on the machine (like the other
  four) but no-ops in ~1 ms unless the session is the dispatcher.
- Every failure mode degrades to `exit 0` with no stdout and no stderr — gates
  unmet, `tm`/`jq` missing, `tm history` non-zero, empty history — because a
  SessionStart hook's stderr reaches the user. The injected string is capped
  (9000-character budget — Claude Code measures the `additionalContext` limit
  in characters — with newest-first truncation and a `tm history --since
  <window>` pointer) so it does not crowd the context window every compaction.
- **Enforcement against silent regression:**
  [`test/cli/on_session_start_recall.bats`](/plugins/claudemux/test/cli/on_session_start_recall.bats)
  covers all three gates (including a cwd that differs from `TM_DISPATCHER_DIR`
  by a symlink but resolves equal — which must still inject — and the reverse),
  the size-cap truncation, the `additionalContext` JSON shape, the
  `tm`-resolution order (`${CLAUDE_PLUGIN_ROOT}/bin/tm` preferred over PATH,
  PATH fallback, and injection surviving a stale PATH), and the
  `tm history`-failure degradation;
  [`test/verbs/history-time-flags.test.ts`](/plugins/claudemux/test/verbs/history-time-flags.test.ts)
  covers the relative/absolute/invalid `--since` grammar.
- **Foot-guns:** do not move the wiring into a `settings.json` hook with an
  absolute plugin path (version-pinned → stale → per-launch error); do not drop
  the `CLAUDEMUX_TEAMMATE_NAME` gate (teammates inherit `TM_DISPATCHER_DIR`);
  and do not weaken the cwd gate to a literal string compare — a real
  dispatcher whose path crosses a symlink would then be rejected forever.

## References

- [`hooks/on-session-start-recall.sh`](/plugins/claudemux/hooks/on-session-start-recall.sh),
  [`hooks/hooks.json`](/plugins/claudemux/hooks/hooks.json),
  [`src/verbs/history.ts`](/plugins/claudemux/src/verbs/history.ts) (relative-duration parsing),
  [`templates/CLAUDE.md.template`](/plugins/claudemux/templates/CLAUDE.md.template).
- [components/hooks.md](/.agents/components/hooks.md),
  [decisions/hook-driven-busy-idle-signal.md](/.agents/decisions/hook-driven-busy-idle-signal.md).
