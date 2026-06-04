---
"@excitedjs/tm": minor
---

`tm send` to a busy codex teammate now supersedes the in-flight send instead of hard-failing with "busy", matching the Claude engine. A second `tm send` steers its prompt into the running turn and collects the merged result, while the earlier send exits early (exit 0) with the supersede note. Turns that cannot be steered (a `review`/`compact` turn, or a teammate whose lock is held by a `tm ask` ephemeral turn) fall back to a clear recoverable "busy".
