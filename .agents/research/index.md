# Research archive

This directory archives the **research artifacts** produced while building the
`feishu-channel` plugin and while auditing claudemux's `tm` core. They are
kept here so the investigation behind a decision is recoverable — a decision
record states *what was chosen*; these documents are *the legwork that backed
the choice*.

## These are frozen snapshots — read them as history

Every file here is a **point-in-time snapshot**. It records what was known,
measured, or reviewed on its stated date and is **not maintained afterwards**.
This is the opposite of [decisions/](/.agents/decisions/README.md), which are
living records kept consistent with the code, and of `components/` /
`domains/`, which are updated whenever the thing they describe moves.

Practical consequences when you open one of these:

- **Do not treat a fact here as current.** A version number, a commit hash, a
  test count, an API field, a "not yet done" — all were true on the date in
  the header and may have moved since. Verify against the code before acting.
- **Do not edit them to "fix" drift.** Correcting a snapshot destroys the
  snapshot. If the world moved, the right home for the new truth is a
  `component`/`domain` doc or a new decision record — not an edit here.
- **One exception — the `## Hazard dispositions` appendix.** A research doc
  carries a closing section reconciling the hazards it raised to a
  disposition. For docs frozen before that discipline existed, the section is
  a dated, append-only appendix. This is not "fixing drift": the snapshot body
  stays verbatim, and the appendix is append-only, the same model the decision
  records follow. See [decision research-hazard-dispositions](/.agents/decisions/research-hazard-dispositions.md).
- **The decision record is the authority.** Where a snapshot and a decision
  record disagree, the decision record (kept fresh) wins; the snapshot just
  shows the reasoning at the time.

Archived documents are kept **verbatim** in their original language.

## claudemux quality & architecture research

Background for [`tm` quality hardening](/.agents/decisions/tm-quality-hardening.md)
and [cross-process / cross-platform invariants](/.agents/decisions/cross-process-cross-platform-invariants.md).

| Document | Snapshot of | Date | Feeds |
|---|---|---|---|
| [architecture-review.md](/.agents/research/architecture-review.md) | Seven-dimension read-only audit of `bin/tm` and its co-process partners — layering, protocol evolvability, cross-platform safety, and the idle-dir / jsonl path-builder gaps. | 2026-05-20 | [tm-quality-hardening](/.agents/decisions/tm-quality-hardening.md), [cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md) |
| [research-report.md](/.agents/research/research-report.md) | Desk research comparing claudemux against industry practice for plugin authoring, CI, and Bash CLI testing, with the gaps called out. | 2026-05-20 | [tm-quality-hardening](/.agents/decisions/tm-quality-hardening.md), [cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md) |
| [investigation-context-window.md](/.agents/research/investigation-context-window.md) | Probe of whether a teammate's real model and context-window size can be discovered without a model turn (conclusion: largely not — every layer checked lacks the signal). | 2026-05-20 | No decision record — a negative-result probe; explains why `tm`'s `ctx` line falls back to `assumed 200k`. |
| [tm-states-last-column.md](/.agents/research/tm-states-last-column.md) | Audit and implementation notes for aligning the `tm states` LAST column across Claude `.last` files and Codex rollout JSONL assistant timestamps. | 2026-05-25 | [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md) |
| [tm-verb-engine-flag-audit.md](/.agents/research/tm-verb-engine-flag-audit.md) | Per-verb audit of which teammate-targeted `tm` verbs need a `--engine` flag — conclusion: only `spawn` and `resume`, since the identity router makes every post-creation verb's engine selection unambiguous. | 2026-05-25 | [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md) |
