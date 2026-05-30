# Decision: worktree-default spawn + name/repo decoupling (schema 2)

> **Status:** landed in `feat/worktree-default`. Supersedes none; carries
> forward the engine model from
> [decision multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md)
> and the cross-process invariants of
> [decision cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md).

## Decision

Two cuts that landed together in one PR because together they unlock the
next year of dispatcher use cases (multiple teammates per repo, optional
isolation, future multi-dispatcher fan-out) and apart cost more than the
combined cut.

### Cut 1 — name / repo decoupling (schema 2)

A teammate's identity has two independent dimensions:

- `name` — a flat opaque identifier (`^[A-Za-z0-9][A-Za-z0-9_-]*$`),
  globally unique across the dispatcher. The CLI's only argument shape
  for non-spawn verbs (`tm send <name>` / `tm wait <name>` / …).
- `repo` — the physical source repository, recorded at spawn time and
  exposed through `tm ls` / `tm states` columns.

The legacy contract collapsed both dimensions into `<repo>`, which
prevented multiple teammates per repo (`/tmp/teammate-<name>.json`'s
`O_EXCL` reservation rejected a second spawn) and forced the name to
match a dispatcher subdirectory.

The schema 2 on-disk record adds `repo` and `worktreeSlug` next to the
existing `cwd`; the legacy schema 1 record is rejected — users
`tm kill` and respawn rather than read the old shape silently with
fabricated fields. The `/` → `__` nested-name encoding in
`tmuxSessionName` is removed because names are now flat by validator.

The SessionStart env identity gate is renamed
`CLAUDEMUX_TEAMMATE_REPO` → `CLAUDEMUX_TEAMMATE_NAME` so the hook
binding matches the new layer's vocabulary.

### Cut 2 — worktree by default

Every new teammate runs inside a git worktree by default — Claude
through `claude --worktree <name>` and Codex through
claudemux-managed `git worktree add`. Layout:
`<repo>/.claude/worktrees/<name>/`, branch `worktree-<name>`, base ref
`HEAD`. `--no-worktree` opts out for repo-wide tasks.

The Claude path injects `worktree.baseRef: "head"` into the
`--settings` JSON the teammate already inherits (alongside
`claudeMdExcludes`); no global Claude Code settings are touched.

`tm kill` is graceful: `/exit` → wait 5s for SessionEnd (Claude
auto-removes a clean worktree + branch on its own) → on a dirty
worktree Claude's TUI shows a Keep/Remove prompt, the verb presses
`Enter` to confirm the default Keep → wait 3s more → `tmux
kill-session` fallback. Codex's `tm kill` reaps the daemon, then
`git worktree remove --force` for clean state, with a stderr
preserve-and-hand-clean note for dirty state.

## Why

The decoupling is a load-bearing precondition for two adjacent
roadmap items the user has on hand:

- **Multiple teammates per repo.** Today every dispatcher session can
  hold exactly one teammate per sibling directory because name and
  cwd are identical. Worktrees give us the file-isolation half;
  decoupled names give us the identity half.
- **Multi-dispatcher fan-out.** Two dispatchers reaching at the same
  sibling directory need separate worktrees and separate
  `/tmp/teammate-<name>.json` reservations — name uniqueness is the
  natural primary key.

The graceful kill path is the only one that fires the SessionEnd hook
on the teammate side, which is what writes the `.last` sentinel for
the dispatcher to read on the next turn boundary. Falling back to
SIGHUP on timeout keeps `tm kill` bounded even when the dirty
prompt path goes wrong.

Hybrid worktree creation (Claude does its own,
claudemux does Codex's) accepts a small amount of
asymmetry — Claude's `.worktreeinclude`, `symlinkDirectories`,
`sparsePaths`, and 30-day orphan cleanup are inherited for free,
while Codex's path stays trivially under our control. The
alternative — claudemux owning every worktree creation — would
either re-implement the `.worktreeinclude` behaviour or drop it,
both worse than the asymmetry.

## What the empirical tests confirmed

The Claude `--worktree` design space was probed live (Claude Code
v2.1.153):

| Probe | Result |
|---|---|
| `claude --worktree slug --session-id <uuid>` | works; transcript lands at `~/.claude/projects/<encoded-worktree-path>/<uuid>.jsonl` |
| SessionStart payload `cwd` field | the worktree physical path, not the parent repo — so `/tmp/teammate-<name>.cwd` must be pre-populated with the worktree path for the byte-match identity gate to succeed |
| Nested `claude --worktree x` inside an existing worktree | does not error; Claude walks up to the parent repo and creates a sibling worktree there (benign) |
| AutoMemory | created at the parent-repo encoded path, not the worktree's — `tm mem` therefore uses `identity.repo` for the project-dir lookup, sharing memory across all worktrees of one repo |
| `/exit` in a teammate with no dirty state | auto-removes worktree dir AND `worktree-<slug>` branch, fires SessionEnd cleanly |
| `/exit` in a teammate with dirty state | shows a TUI Keep/Remove prompt; `AskUserQuestion` is disabled but this is a built-in TUI control and not affected. Pressing `Enter` (default Keep) exits cleanly and fires SessionEnd; the worktree + branch remain on disk |

## Decisions deliberately not taken

- **`.worktreeinclude` on the Codex path.** Claude inherits its
  native support; the Codex `git worktree add` path skips it for
  v1. Users with a Codex teammate that needs gitignored files
  (`.env`, etc.) copy them manually. Folded into followup work.
- **Forced removal of dirty worktrees.** `tm kill` never removes a
  dirty worktree — neither by sending `Down + Enter` on the Claude
  prompt nor by `git worktree remove --force` on the Codex path.
  Users run `git worktree remove --force` themselves once they
  decide the changes are disposable.
- **Backwards-compatible reads of schema 1.** One-step cut. Pre-cut
  teammates get a clear "kill and respawn" migration message.
- **`tm wt-prune` standalone cleanup verb.** Deferred — Claude's
  built-in 30-day orphan cleanup covers the common case, and Codex
  worktrees are dispatcher-managed via `tm kill` already.

## See also

- The Feishu research that mapped `claude --worktree` against
  teammate semantics (internal design doc).
- [decision multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md)
  — the layered Engine / verb / identity model this cut extends.
- [components/claudemux-core.md](/.agents/components/claudemux-core.md)
  — module-level overview of the orchestrator the cut lives in.
