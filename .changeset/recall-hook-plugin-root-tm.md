---
"@excitedjs/tm": patch
---

Harden the dispatcher SessionStart recall hook against PATH drift. The hook now resolves `tm` via `${CLAUDE_PLUGIN_ROOT}/bin/tm` first (the version-coherent path Claude Code re-resolves at every launch) and falls back to `tm` on PATH only when that is missing. Previously a PATH-only lookup let the hook silently inject nothing whenever a session started while the plugin's `bin/` had dropped off PATH — a drift seen after a plugin version change reloads plugins mid-session.
