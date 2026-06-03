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

- Each send claims a **unique single-use token** in
  `/tmp/teammate-<name>.send-token`
  ([`sendTokenFile`](/plugins/claudemux/src/persistence/paths.ts),
  [`supersede.ts`](/plugins/claudemux/src/engines/claude/supersede.ts)).
- The claim is an **atomic temp-write + `rename`** (last-claim-wins), and
  supersede is decided by token **identity** (`current !== mine`), never by
  comparing millisecond magnitudes. So two sends in the same millisecond
  cannot tie, and a late/replayed write cannot leave the file in a state
  where two sends both consider themselves the survivor — exactly one token
  is ever the survivor, whoever claimed last.
- The claim happens **only after `sendKeys` lands the prompt**, so a send
  that fails to deliver never retires an earlier waiting send with a false
  promise. A claim that fails to write yields a null token, so that send
  simply waits as usual rather than mistaking the failure for a supersession.
- The wait loop
  ([`waitForTurnEnd`](/plugins/claudemux/src/engines/claude/wait-signals.ts))
  treats itself as superseded the moment the file holds a token other than
  its own, and returns `{ superseded: true }`.
- The superseded send exits 0 with a stderr note: the prompt was delivered
  and is queued into the teammate's current run; collect the result from the
  later send or `tm wait` / `tm last`. The note does **not** promise a single
  merged reply — whether the queued prompt merges depends on the run (see
  [Runtime behavior](#runtime-behavior-live-repro)).

What the dispatcher reads is **emergent from Claude Code**, not computed by
`tm`: a queued prompt is folded into the current run and answered together
with the later send only when that send lands at a mid-task pause; otherwise
it runs as a separate turn. `tm` only (a) lets every superseded send return
early, and (b) lets the single survivor wait for the next Stop.

Why exit 0: the prompt *was* delivered, so this is neither a failure (1) nor
a stuck-but-alive expiry (124). The note carries the semantics; the exit
code stays the success code so a backgrounded send is not misread as an
anomaly.

Scope: Claude only — `claudeSend` is the sole participant. `--pane-quiet`
sends (hook-less TUI commands, not steering prompts) neither claim nor
check. `tm wait` stays a pure recovery seam and does not participate. The
Codex engine drives its own transport and is unchanged.

## Runtime behavior (live repro)

A live end-to-end run — a real `claude` teammate driven by two concurrent
sends — confirmed the early return and characterized the merge, which is
**not** unconditional:

- **Early return works.** In every case the earlier send returned exit 0 with
  the supersede note within one poll instead of hanging to its timeout.
- **The earlier turn fires no Stop.** With a message queued, Claude Code does
  not fire the Stop hook between the busy turn and the queued prompt — which
  is exactly why the earlier send used to hang, and why the early return is
  needed.
- **Merge depends on the injection point:**
  - *Tool-using / mid-task-pause turn* (the typical "steer a working
    teammate" case): the queued prompt is injected at the post-tool pause and
    folded into **one** continued assistant turn — a true merge. The surviving
    send returns the combined reply (both prompts answered).
  - *Pure-generation turn with no mid-task pause*: the queued prompt runs as a
    **separate** next turn — no merge. Worse, the survivor can return an
    **empty** reply: the queued send's `clearIdle` wiped the `.last` baseline,
    and the Stops that fire while the queue drains extract an empty `.last`
    (on-stop's `rm-empty`). The content is still in the transcript — recover
    it with `tm wait` / `tm last`.

The note wording reflects this: it points at `tm wait` / `tm last` and does
not promise a single merged reply.

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
  mirror; a leftover token from a finished send is harmless (the next send's
  claim atomically replaces it before that send begins its wait).
- This refines [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md)'s
  "round-trips are atomic by default": a send is still atomic, but a later
  send to the same teammate now retires an earlier one's wait. It does **not**
  re-introduce the removed `--no-wait` flag — there is no opt-out switch.

## Known follow-ups (not done)

- **Make the survivor's readback reliable in the no-merge case.** A
  steering/queued send rides the current turn rather than starting a fresh
  one, so it could skip `clearIdle` (which today wipes the in-flight `.last`
  baseline) and relax `confirmSubmit` (a queued prompt produces no fresh
  turn-start signal, so today it spuriously warns and re-sends Enter). Doing
  both would let the surviving send capture the reply directly instead of
  relying on a `tm wait` / `tm last` fallback. Deferred: the accepted scope of
  this record is the honest note plus the [Runtime behavior](#runtime-behavior-live-repro)
  finding; the supersede logic is unchanged.

## References

- [`src/engines/claude/supersede.ts`](/plugins/claudemux/src/engines/claude/supersede.ts),
  [`src/engines/claude/send.ts`](/plugins/claudemux/src/engines/claude/send.ts),
  [`src/engines/claude/wait-signals.ts`](/plugins/claudemux/src/engines/claude/wait-signals.ts).
- Tests: [`test/engines/claude/send-supersede.test.ts`](/plugins/claudemux/test/engines/claude/send-supersede.test.ts).
- [components/tm.md](/.agents/components/tm.md), [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md).
