---
"@excitedjs/tm": minor
---

Dispatcher sessions now auto-recall recent teammate work. A new SessionStart hook injects `tm history --since 3d --oneline` into the dispatcher's context on the startup, resume, and compact sources — so the recall refreshes after every compaction, not just on a cold start — restoring the "recent work loads itself into context" behavior the retired hand-written Markdown ledger used to provide via a `CLAUDE.md` `@import`. The hook is dispatcher-only (gated on `TM_DISPATCHER_DIR` set and `CLAUDEMUX_TEAMMATE_NAME` unset, so it never injects into a teammate session), ships in the plugin's `hooks.json` with no change to the dispatcher's `settings.json`, and degrades to a silent no-op on any failure.

Supporting this, `tm history --since`/`--until` now accept relative durations (`30m`, `12h`, `3d`, `1w` — minutes/hours/days/weeks ago) in addition to absolute dates, so the hook passes `--since 3d` directly without any cross-platform date arithmetic.
