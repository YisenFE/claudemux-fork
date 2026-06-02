---
"@excitedjs/tm": minor
---

`tm send` now auto-supersedes: when a newer `tm send` to the same teammate arrives while an earlier one is still waiting, the earlier send returns early (exit 0) with a note instead of hanging to its timeout, and only the latest send waits for the merged reply. This makes "guide the model with a second send" a supported pattern. A plain single send is unchanged, and there is no opt-out flag. Claude teammates only; `--pane-quiet` sends and Codex teammates do not participate.
