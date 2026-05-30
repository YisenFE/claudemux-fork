# `tm` verb `--engine` flag audit

- **Date:** 2026-05-25
- **Scope:** Every teammate-targeted `tm` verb after the [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md) reshape.
- **Question:** Which verbs need a `--engine claude|codex` flag for the
  caller to disambiguate the target engine, and which can trust the
  identity router to make engine selection automatic?

## Summary

The reshape made identity router resolution unambiguous for **every
post-creation verb**. `/tmp/teammate-<name>.json`'s `engine` field is
the single source of truth, and `ProductionTeammateRouter.resolve(name)`
returns the engine in one read.

Only two verbs operate on a teammate that may not yet have a record:

| Verb | Current state | Reason |
|---|---|---|
| `spawn` | has `--engine` already (decision codex-engine-flag §1) | Teammate does not exist; flag is the only signal. |
| `resume` | has `--engine` already (decision multi-engine-tui-architecture, wired in PR #75) | Teammate may be killed-but-resumable; flag overrides every other selector. |

Every other teammate-targeted verb routes through `router.resolve(name)`
or the `Engine` registry default. **No new `--engine` flag is added.**

## Per-verb table

Verbs are listed in `cli/dispatch.ts` order, with the engine-selection
mechanism each one already uses.

| Verb | Engine selection today | Ambiguity possible? | Decision |
|---|---|---|---|
| `ls` | enumerates every registered engine via `Engine.list()` (verb-default in `verbs/ls.ts`) | No — fleet-wide listing, not a single-teammate verb. | No flag needed. |
| `states` | same as `ls` — `verbs/states.ts` aggregates per-engine listings. | No. | No flag needed. |
| `status` | `router.resolve(name)` → `Engine.status({ name })`. | No — JSON pins one engine. | No flag needed. |
| `kill` | `router.resolve(name)` → `Engine.kill({ name })`. | No — JSON pins one engine. | No flag needed. |
| `spawn` | `--engine` flag (parsed in `shared/verb-args.ts`); `cli/parse.ts:inferSpawnEngine` falls back to the existing teammate's engine when re-spawning a known name, else defaults to `claude`. | Yes — teammate does not exist. | **Already has flag.** |
| `send` | `verbs/send.ts` calls `resolveTargetEngine(name, ctx)` → `router.resolve(name)`. | No — JSON pins one engine. | No flag needed. |
| `wait` | same as `send` via `verbs/wait.ts`. | No. | No flag needed. |
| `compact` | `verbs/compact.ts` → router; Codex returns `not-supported` and the formatter prints a one-line message. | No. | No flag needed. |
| `resume` | layered priority: (1) `--engine` flag, (2) checkpoint reverse-lookup against Codex rollouts, (3) `router.resolve(name)`, (4) cwd-side probing (claude transcripts + codex rollouts), (5) `resolveTargetEngine` fallback. | Yes — a killed teammate has no JSON; cwd probing can hit both engines. | **Already has flag.** |
| `last` | `verbs/last.ts` → router; Claude reads `.last`, Codex reads the latest rollout. | No. | No flag needed. |
| `ctx` | `verbs/ctx.ts` → router; Claude reads transcript JSONL, Codex reads rollout snapshot. | No (per-name) — `--all` enumerates every engine via `fleetTargets`. | No flag needed. |
| `history` | `verbs/history.ts` → `resolveHistoryTarget` chooses an engine from (a) the router and (b) cwd-side codex-rollout probing, then queries that engine. Detail mode (with a sid/thread prefix) probes both engines because a killed teammate may still have rollouts; the prefix-shape short-circuit in `verbs/history.ts:detailEngineFromPrefix` collapses the probe to one engine when the UUID version digit is exposed by the prefix, with the dual probe kept as the fallback for short prefixes. | No (engine inferred from router or rollout file). | No flag needed. |
| `mem` | `verbs/mem.ts` → router; Codex returns `not-supported`. | No. | No flag needed. |
| `reload` | `verbs/reload.ts` → router; Codex returns `not-supported`. | No. | No flag needed. |

`tm ask`, `tm poll`, `tm archive`, `tm doctor` are dispatcher-only or
diagnostic verbs that do not target a single teammate; they fall outside
this audit.

## Why "JSON pins one engine" closes the ambiguity for post-creation verbs

The reshape's identity rule (decision multi-engine-tui-architecture
§"Engine identity is the JSON's `engine` field") makes
`/tmp/teammate-<name>.json` the single source of truth for which engine
owns a teammate. Once a teammate is spawned, every later verb resolves
that record exactly once:

```ts
// identity/router.ts — ProductionTeammateRouter.resolve
const record = readIdentity(name)
if (record === null) return null
const engine = this.engines.get(record.engine)
return engine === undefined ? null : { name, engine }
```

There is no "is this a `codex-*` name?" branch, no "does this Codex
registry directory exist?" check, and no per-verb engine inference. A
verb that has a name in hand and the teammate exists has exactly one
engine to talk to, and a `--engine` flag would be a no-op (matching) or
a contradiction (mismatching) — neither earns its cost on the CLI
surface.

The two verbs that **do** carry the flag are the ones where the
teammate is either not yet created (`spawn`) or potentially gone
(`resume` after a `kill`). Both are documented in their own decision
records.

## Cross-engine name reuse remains forbidden

Decision codex-engine-flag §4 (carried forward by
multi-engine-tui-architecture §"Engine identity") forbids `spawn` from
creating a name that already exists in another engine's registry. This
is what lets "name → engine" stay one-to-one for the entire post-spawn
lifetime; without it, the absence of a `--engine` flag on `send` /
`wait` / `kill` would have been ambiguous.

## Verified against the current code

- `cli/dispatch.ts:ENGINE_VERBS` — the canonical list of teammate verbs.
- `identity/router.ts:ProductionTeammateRouter` — the single read used
  by every verb-default that resolves by name.
- `shared/verb-args.ts:parseSpawnArgs`, `parseResumeArgs` — the only
  parsers that surface `--engine`.
- `verbs/resume.ts:resumeVerb` — the layered priority that demonstrates
  why `resume` keeps `--engine` even though the router would usually
  resolve.

## Follow-ups

None. If a third engine lands later and the reshape's identity rule
holds (one record, one `engine` field), this audit does not need to be
re-run — the rule mechanically guarantees zero ambiguity for every
post-creation verb. A future engine that violates the rule (e.g. an
engine whose registry can hold the same name simultaneously with
another engine) would re-open this question and warrant a fresh
decision record.

## Hazard dispositions

Recorded on 2026-05-25 alongside the audit.

| Hazard | Disposition |
|---|---|
| A third engine lands that does not respect the "one JSON, one engine" identity rule and reopens cross-engine name ambiguity. | Conditional, future. Re-audit when the third engine's identity model is being designed; the rule is enforced by `ProductionTeammateRouter.resolve` and `EngineRegistry`, and a new engine that wanted to share a name space would have to bypass one of them — a change that warrants its own decision record. |
| `tm history` detail mode currently probes both engines for short sid/thread prefixes (no UUID version digit visible) and forwards whichever returns a single match. | Accepted as-is. The companion change in this PR adds a UUID-version short-circuit (`detailEngineFromPrefix`) that eliminates the dual probe for any prefix whose 13th hex char is `4` or `7`; short prefixes (no version digit reached) keep the dual probe so an unprefixed thread or sid still resolves cleanly. The trade-off is documented in the helper's comment in `verbs/history.ts`. |
| A future verb that the audit missed adds a flag-needing path. | The audit's working list comes from `cli/dispatch.ts:ENGINE_VERBS`. Any new teammate-targeted verb is added there and is in scope for a fresh audit at that time. |
