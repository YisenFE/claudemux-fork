# `tm send` auto-supersedes an earlier in-flight send

- **Status:** Accepted
- **Date:** 2026-06-02
- **Affects:** `tm` (the Claude `send` path), the dispatcher skill

## Context

`tm send <name> --prompt p` is a sync round-trip: it delivers the prompt and
blocks on the Stop-hook idle signal until the turn settles (decision
[atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md),
[multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md)
— `--no-wait` was removed and wait became the only path).

That contract breaks down when the dispatcher steers a teammate with two
sends in quick succession — a common "guide the model" pattern. Claude Code
queues a prompt submitted while the REPL is busy and folds it into the
ongoing run, so the queued prompt produces **no dedicated Stop**. The
earlier send is waiting for a turn boundary that never arrives for it, so it
burned its full `--timeout` (default 1800s) to a spurious 124. The
dispatcher skill documented this as a foot-gun ("don't send extra input
during a sync wait") rather than supporting it.

The two sends also raced on the shared per-sid markers: the later send's
`clearIdle` wiped the idle/`.last` baseline the earlier send's wait depended
on, so even when a Stop did eventually fire the earlier send could miss it.

## Decision

When a newer `tm send` to the same teammate arrives while an earlier send is
still waiting, the **earlier send returns early** (exit 0) with a note, and
only the **latest** (never-superseded) send keeps waiting and collects the
result. The behavior is **automatic** — no flag. A plain single send is
unchanged.

Mechanism — a file-only protocol between the otherwise-independent `tm send`
processes (same discipline as the idle/busy markers; they share no memory):

- Each send claims a millisecond stamp — its invocation order — in
  `/tmp/teammate-<name>.send-token` at start
  ([`sendTokenFile`](/plugins/claudemux/src/persistence/paths.ts),
  [`supersede.ts`](/plugins/claudemux/src/engines/claude/supersede.ts)).
- The claim is **max-wins** (write only a stamp ≥ what is on disk), so a
  slow write from an older send cannot regress the file and resurrect
  itself. The latest send always holds the greatest stamp.
- The wait loop
  ([`waitForTurnEnd`](/plugins/claudemux/src/engines/claude/wait-signals.ts))
  treats itself as superseded the moment the file holds a stamp strictly
  greater than its own, and returns `{ superseded: true }`.
- The superseded send exits 0 with a stderr note: the prompt was delivered
  and is queued into the teammate's current run; its result merges into the
  later send's turn, so collect the combined reply from that send (or
  `tm wait`).

The "merged result" is **emergent from Claude Code**, not computed by `tm`:
queued prompts fold into the run and the model answers them together at the
final Stop. `tm` only (a) lets every superseded send return early, and
(b) lets the single survivor wait for that final Stop.

Why exit 0: the prompt *was* delivered, so this is neither a failure (1) nor
a stuck-but-alive expiry (124). The note carries the semantics; the exit
code stays the success code so a backgrounded send is not misread as an
anomaly.

Scope: Claude only — `claudeSend` is the sole participant. `--pane-quiet`
sends (hook-less TUI commands, not steering prompts) neither claim nor
check. `tm wait` stays a pure recovery seam and does not participate. The
Codex engine drives its own transport and is unchanged.

## Consequences

- The earlier "don't send extra input during a sync wait" foot-gun becomes a
  supported pattern: the dispatcher can fire a follow-up steering send and
  the earlier one returns promptly (within one ~3s poll) with a note instead
  of hanging to a 124.
- The clearIdle race is defused for the superseded send: it returns via the
  token, not the marker, so the later send's baseline reset can no longer
  strand it. The survivor's own `clearIdle` + fresh-Stop wait is unchanged.
- A new per-teammate protocol file (`.send-token`) joins the `/tmp` seam. No
  hook reads it (it coordinates `tm send` processes only), so it has no Bash
  mirror; a stale stamp is always in the past and harmless (the next send's
  larger stamp overwrites it).
- This refines [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md)'s
  "round-trips are atomic by default": a send is still atomic, but a later
  send to the same teammate now retires an earlier one's wait. It does **not**
  re-introduce the removed `--no-wait` flag — there is no opt-out switch.

## References

- [`src/engines/claude/supersede.ts`](/plugins/claudemux/src/engines/claude/supersede.ts),
  [`src/engines/claude/send.ts`](/plugins/claudemux/src/engines/claude/send.ts),
  [`src/engines/claude/wait-signals.ts`](/plugins/claudemux/src/engines/claude/wait-signals.ts).
- Tests: [`test/engines/claude/send-supersede.test.ts`](/plugins/claudemux/test/engines/claude/send-supersede.test.ts).
- [components/tm.md](/.agents/components/tm.md), [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md).
