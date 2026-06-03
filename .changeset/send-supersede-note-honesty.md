---
"@excitedjs/tm": patch
---

Make the `tm send` supersede note honest about merge timing. The note no longer promises that a superseded send's result "merges into the later send's turn" unconditionally; instead it says the prompt was delivered and queued, and points at `tm wait` / `tm last` to collect the result. A live repro showed the merge only happens when the steering send lands at a mid-task pause (e.g. the teammate is running a tool); on a pure-generation turn the queued prompt runs as a separate turn and the surviving send can even return empty. Wording and docs only — the supersede logic is unchanged.
