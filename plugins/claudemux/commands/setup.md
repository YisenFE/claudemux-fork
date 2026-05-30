---
description: First-time claudemux setup: check dependencies, seed CLAUDE.md in the current directory, and guide Remote Control setup.
argument-hint: "[--force]"
---

You are guiding a human through first-time setup, not just executing a checklist.
Run safe checks and the bundled setup script yourself; keep package-manager
installs, `tmux` session startup, new `claude` launches, and teammate creation in
the user's hands because those actions may need passwords, new terminals, or a
fresh process that reads startup settings.

Use `AskUserQuestion` when it is available for a real decision or an action you
need the user to complete. If that tool is unavailable, ask the same question in
normal chat and wait for the answer. Keep questions concrete, include the exact
command the user should run, and recheck after the user says the action is done.

At the end, give a short setup report and the exact dispatcher start command.
The setup flow ends there; the user starts the dispatcher session next.

## Preflight: confirm the dispatcher directory

`/claudemux:setup` seeds `CLAUDE.md` into the current working directory. The
runtime later derives the dispatcher directory from the working directory of the
dispatcher session, so setup should run from the directory the user intends to
use as the dispatcher. A good dispatcher directory is usually the parent of
several sibling git repos, separate from any one repo and separate from `$HOME`.

Check the current working directory:

```bash
dispatcher_dir="$(pwd -P)"
echo "dispatcher: $dispatcher_dir"
find "$dispatcher_dir" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | head -10
[[ -d "$dispatcher_dir/.git" ]] && echo "warn: dispatcher directory is itself a git working tree"
[[ "$dispatcher_dir" == "$HOME" ]] && echo "warn: dispatcher directory is the home directory"
```

If any `warn:` line printed, or the `find` output shows zero sibling
subdirectories, pause before setup and ask:

> "claudemux will seed `CLAUDE.md` into `<dispatcher-dir>` and future dispatcher
> sessions will treat that directory as the repo parent. A typical dispatcher dir
> contains sibling repos and is separate from `$HOME` or any one repo. How do you
> want to proceed?"
>
> Options:
> - **"I'll re-run from the right directory"** — end the setup flow and give the
>   instruction: exit this Claude session, `cd` to the intended dispatcher
>   directory, run `claude`, then run `/claudemux:setup` again.
> - **"Continue with this dispatcher dir"** — record the confirmation and proceed.

If the current directory looks normal, continue without prompting.

## Step 0: verify system dependencies

claudemux needs `tmux`, `jq`, and the `claude` CLI. Check all of them first,
then give the user one clear install checklist for anything missing. Finish this
step before running the setup script because later checks and the dispatcher
workflow rely on these binaries.

```bash
echo "platform: $(uname -s)"
if command -v apt-get >/dev/null 2>&1; then
  echo "package-manager: apt-get"
elif command -v dnf >/dev/null 2>&1; then
  echo "package-manager: dnf"
elif command -v brew >/dev/null 2>&1; then
  echo "package-manager: brew"
else
  echo "package-manager: unknown"
fi

for bin in tmux jq claude; do
  command -v "$bin" >/dev/null 2>&1 && echo "$bin: OK" || echo "$bin: MISSING"
done
```

Suggest install commands by platform:

| Missing binary | macOS with Homebrew | Debian/Ubuntu/WSL | Fedora/RHEL | Other |
|---|---|---|---|---|
| `tmux` | `brew install tmux` | `sudo apt-get install -y tmux` | `sudo dnf install -y tmux` | ask the user to install `tmux` with their system package manager |
| `jq` | `brew install jq` | `sudo apt-get install -y jq` | `sudo dnf install -y jq` | ask the user to install `jq` with their system package manager |
| `claude` | follow https://claude.com/claude-code | same | same | same |

When one or more binaries are missing, ask once with a short list:

> "claudemux is missing these prerequisites: `<missing-list>`. Please run the
> matching install command(s) in your regular shell, then tell me when done so I
> can recheck."

> Options (single-select):
> - **"I've installed them"** — re-run the dependency check.
> - **"I'll handle this later"** — end setup with the missing prerequisites and
>   the install commands.

Loop until every required binary prints `OK`, or until the user chooses to stop.

## Step 1: run the bundled setup script

Once all deps are present:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" $ARGUMENTS
```

That copies `CLAUDE.md.template` into the dispatcher dir, ensures
`/tmp/claude-idle/` exists, merges `TM_DISPATCHER_DIR=<dispatcher-dir>` into
the dispatcher root's `.claude/settings.json` (so Claude Code injects it as
env at every dispatcher launch — `tm` then resolves the dispatcher dir from
env instead of `$PWD`, immune to Bash-tool cwd drift), and removes any
leftover `~/.config/claudemux/config` from older versions.

Read stdout/stderr as evidence. Extract the dispatcher directory and status for
the final report. Treat any teammate verification lines printed by the script as
background; the setup report should hand off only the dispatcher start command.

| Output line | What it means | What to do |
|---|---|---|
| `[setup] wrote <path>/CLAUDE.md from template` | fresh install | continue |
| `[setup] CLAUDE.md already matches template — skipping` | already set up | continue |
| `[setup] CLAUDE.md exists and differs from template — leaving in place` | customized `CLAUDE.md` without the workspace marker block | ask whether to inject the `@.workspace/imports.md` marker block at the top (body stays untouched). If yes, re-run with `--force` |
| `[setup] injected @.workspace/imports.md marker block at the top of <path>` | `--force` added the workspace import line into a legacy CLAUDE.md | continue |
| `[setup] <path> already has the workspace imports marker — skipping inject` | `--force` re-run on a CLAUDE.md that already has the block (idempotent) | continue |
| `[setup] wrote <path>/.claude/settings.json with TM_DISPATCHER_DIR=...` | fresh write of settings.json | continue |
| `[setup] merged TM_DISPATCHER_DIR=... into <path>/.claude/settings.json (other keys preserved)` | merged into a settings.json the user already had | continue |
| `[setup] <path>/.claude/settings.json already has TM_DISPATCHER_DIR=... — skipping` | re-running setup; nothing to change | continue |
| `[setup] updated TM_DISPATCHER_DIR in <path>/.claude/settings.json (<old> -> <new>)` | user moved the dispatcher dir; old value replaced | continue |
| `setup.sh: failed to update <path>/.claude/settings.json (is it valid JSON?...)` | existing settings.json is corrupt | hand the user the suggested `jq .` command and stop |
| `[setup] workspace imports: active (CLAUDE.md contains the marker block)` | dispatcher's CLAUDE.md does `@.workspace/imports.md`, so editing profile stubs takes effect immediately | **gate Step 1.5** — proceed with the personalization walk-through |
| `[setup] workspace imports: inactive (CLAUDE.md is missing the marker block — run with --force to inject)` | legacy CLAUDE.md exists, marker not injected; profile stubs are inert | **gate Step 1.5** — skip the walk-through and tell the user they need `--force` first (see Step 1.5 below) |
| `[setup] wrote <path>/.workspace/...` | new workspace stub written | continue |
| `[setup] ensured <path>/.workspace/ exists with profile / notes / artifacts subdirs` | workspace tree present and verified | continue |
| `[setup] <path>/.workspace is a symlink (-> <target>) — refusing to seed scaffold or git init` | user has a symlinked `.workspace/`; setup did not touch it | **gate Step 1.5** — skip personalization and tell the user to resolve the symlink and re-run |
| `[setup] skipped .workspace/ git init (symlink)` | companion line to the above | continue |
| `[setup] initialized <path>/.workspace/ as a git repo and committed the scaffold` | first-time `.workspace/` git init succeeded | continue |
| `[setup] <path>/.workspace/ is already a git repo — skipping git init` | re-run; nothing to do | continue |
| `[setup] git init OK in <path>/.workspace/, but the initial commit failed` | likely missing `user.email` / `user.name` or GPG prompt with no TTY (actual git stderr printed on the following `  git: …` lines) | surface the printed `git:` diagnostic and recovery hint verbatim; setup itself still succeeded |
| `[setup] git init failed in <path>/.workspace/ — skipping` | rare filesystem / permission issue | note in the final report; non-fatal |
| `[setup] git is not installed — skipping .workspace/ git init` | `git` missing on PATH | suggest installing git later; non-fatal |

## Step 1.5: personalize the dispatcher (optional)

**Before asking anything, gate this entire step on the workspace state setup.sh just printed.** Three branches, exactly one applies:

1. `[setup] workspace imports: active (CLAUDE.md contains the marker block)` — proceed with the personalization walk-through below.
2. `[setup] workspace imports: inactive (CLAUDE.md is missing the marker block — run with --force to inject)` — **skip the walk-through entirely**. Tell the user: ".workspace/ was seeded with stubs at .workspace/profile/{persona,user-profile,principles}.md, but the imports are inactive — your existing CLAUDE.md does not yet have the @.workspace/imports.md marker. Filling profiles now would have no effect on dispatcher sessions. Re-run /claudemux:setup with `--force` to inject the marker (your CLAUDE.md body is preserved), then come back here for personalization." Note this in Step 3 as `workspace personalization: pending — imports inactive, --force needed`.
3. `[setup] <path>/.workspace is a symlink (-> <target>) — refusing to seed scaffold or git init` — **skip the walk-through entirely**. Tell the user: ".workspace/ is a symlink to <target>; setup did not touch it because the design contract is that .workspace/.git/ lives inside the dispatcher dir. Either remove the symlink (rm <path>/.workspace) and re-run setup, or manage the link-target directory by hand." Note this in Step 3 as `workspace: skipped (symlink)`.

If branch 1 applies, continue with the walk-through. The dispatcher dir has HTML-comment-only stubs at `.workspace/profile/persona.md`, `.workspace/profile/user-profile.md`, and `.workspace/profile/principles.md`. Edited content gets imported into every dispatcher session via `.workspace/imports.md`; unedited stubs contribute nothing (HTML block comments are stripped from Claude Code context).

**Ask in plain chat by default, not via `AskUserQuestion`.** `AskUserQuestion`'s modal does not render reliably on Claude Code Remote Control (web), the mobile app, or other non-TUI clients — the user may see only your follow-up text and never the modal options. Drop down to the modal only when you know the current client surfaces it (e.g., the user invoked `/claudemux:setup` directly in a TUI session you can observe). Phrase the prompt in the user's own language at runtime — the dispatcher knows it from prior context. Skeleton in English:

> "Your dispatcher's `.workspace/profile/` has three empty stubs:
>   - `persona.md` — how the dispatcher should talk to you (language, verbosity, tone).
>   - `user-profile.md` — who you are, your role, your preferences.
>   - `principles.md` — house rules, do's, don'ts.
>  These get `@import`'d into `CLAUDE.md` via `.workspace/imports.md` every dispatcher session. Want to fill them in now? Reply with one of:
>    1. **Walk me through it** — I'll ask three quick questions.
>    2. **I'll fill them in later** — leave the stubs as-is; I'll print the paths.
>    3. **Skip** — same as above; no difference.
>  You can also edit the files directly any time. Write in whatever language you prefer — this is your local workspace, the 'CLAUDE.md must be English' rule does not apply here."

If the user picks option 1, ask three questions in order:

1. "How should the dispatcher talk to you? (language, verbosity, tone, formatting preferences)"
2. "What should the dispatcher know about you? (role, expertise, preferred workflows)"
3. "Any house rules you want the dispatcher to follow? (do's, don'ts, hard prohibitions)"

After **each** answer, Write that answer into the matching profile file (overwriting the HTML-comment stub). Writing per-answer instead of batching means a mid-flow ctrl-C still keeps earlier answers durable on disk.

**Idempotency for re-runs.** Before asking any question, inspect each `.workspace/profile/*.md`. If a file contains any non-blank line that is not inside `<!-- ... -->` HTML comments, treat that file as already filled and skip the matching question, reporting "<file>: already filled, leaving as-is" in the final report. Heuristic check (any line outside HTML comments that has non-whitespace content):

```bash
awk '
  /<!--/ { in_comment = 1 }
  /-->/  { in_comment = 0; next }
  !in_comment && NF { print "non-comment content"; exit }
' "$file"
```

If that prints anything, the file is filled.

For the final report, surface workspace personalization state as one of:

- "workspace personalization: seeded (persona / user-profile / principles)" — if all three were filled this run.
- "workspace personalization: partial (filled: <list>, stubs: <list>)" — if only some.
- "workspace personalization: stubs only at .workspace/profile/" — if the user skipped everything but imports are active.
- "workspace personalization: pending — imports inactive, --force needed" — if branch 2 above applied.
- "workspace: skipped (symlink)" — if branch 3 above applied.

## Step 2: offer to enable Remote Control

Claude Code Remote Control lets the user drive each dispatcher / teammate session from claude.ai/code or the mobile app. It's controlled by the user-level setting `remoteControlAtStartup` in `~/.claude/settings.json`. claudemux assumes it's on — every teammate gets its own remote URL automatically.

Check the current state:

```bash
jq -r '.remoteControlAtStartup // false' ~/.claude/settings.json 2>/dev/null || echo "false"
```

If it prints `true`, record "Remote Control already enabled" for the final
report.

If it prints anything else, ask:

> "claudemux works best with Claude Code Remote Control enabled at startup, so
> every dispatcher and teammate session gets its own remote URL. Enable it for
> future Claude Code sessions?"

Options:
- **"Show me the `/config` path"** — tell the user to run `/config` in a Claude
  Code session and toggle "Remote Control at startup". Mark the final report as
  `manual step pending`.
- **"Leave it off for now"** — skip and mark the final report as
  `skipped by user`.

If the user explicitly asks you to edit the file for them, explain that editing
`~/.claude/settings.json` may trigger a Self-Modification permission prompt, then
attempt one guarded edit with a backup:

```bash
settings="$HOME/.claude/settings.json"
mkdir -p "$(dirname "$settings")"
if [[ -f "$settings" ]]; then
  cp "$settings" "$settings.bak-$(date +%Y%m%d-%H%M%S)"
else
  printf '{}\n' > "$settings"
fi
jq '.remoteControlAtStartup = true' "$settings" > /tmp/cmx-rc.tmp \
  && mv /tmp/cmx-rc.tmp "$settings"
```

After an automated edit, re-run the `jq -r` check. If the edit fails, report the
exact failure and give the `/config` path as the recovery step.

## Step 3: report

Print a short, human-facing summary:

- Dispatcher directory that was seeded.
- Whether `CLAUDE.md` was written / skipped / already matched.
- Whether `.claude/settings.json` was written / merged / already correct /
  updated from a previous value. Remind that `TM_DISPATCHER_DIR` is read at
  the next `claude` launch — the existing dispatcher session (if any) keeps
  its old env until restart. Once restarted, the dispatcher can run
  `tm doctor` to confirm the env is taking effect.
- Workspace state: `.workspace/` seeded fresh / already existed (per-file lines from setup.sh). Always include the `.workspace/profile/` paths the user can edit later, even if all three were filled this run.
- Workspace git: initialized + committed / already a git repo / git missing / commit pending (recovery hint).
- Workspace personalization: seeded / partial / stubs only (as decided in Step 1.5).
- Dependency state: all required binaries present.
- Remote Control state: already on / enabled / manual step pending /
  skipped by user / failed with manual recovery.
- Reminder: Remote Control is read at Claude Code startup, so changes apply to
  the next `claude` launch.
- The exact command for the user to start their dispatcher. Use the absolute
  dispatcher path from the preflight or setup script output:

  ```
  tmux new-session -s dispatcher -c "<dispatcher-dir>"
  # inside the new pane:
  claude
  ```

End after this report. The next `claude` process is the dispatcher session.

## Re-running

`/claudemux:setup` is fully idempotent: `setup.sh` skips writing `CLAUDE.md` when the existing copy already matches the template, never overwrites an existing `.workspace/` file, skips `git init` when `.workspace/.git/` already exists, `mkdir -p /tmp/claude-idle` is harmless on an existing dir, and the legacy-config cleanup is a no-op when nothing is left to remove. If the user later says "再跑一次 setup" / "再帮我配一下" / "verify the install", just re-run the command — no special handling needed. Step 1.5 re-asks only for profile files that are still stubs.

The branch that needs user input is `setup.sh` reporting `CLAUDE.md exists and
differs from template — leaving in place`: ask whether to inject the
`@.workspace/imports.md` marker block at the top with `--force` (body
preserved) or leave the file untouched.
