# Dispatcher workspace

This directory belongs to a single claudemux dispatcher. It holds personalization, dispatcher-generated artifacts, and long-term notes — anything tied to *this dispatcher* that doesn't belong in AutoMemory or any sibling repo.

## Layout

- `profile/persona.md` — how this dispatcher should talk to you.
- `profile/user-profile.md` — who you are, your role, preferences.
- `profile/principles.md` — house rules, do's, don'ts.
- `imports.md` — the file `CLAUDE.md` imports; itself imports the three `profile/*.md`.
- `notes/` — long-term local notes you curate by hand.
- `artifacts/` — dispatcher-generated intermediate output (triage tables, research dumps, design drafts). Filenames `<YYYYMMDD>-<slug>.md` for time-based cleanup.

The three `profile/*.md` files are imported into the dispatcher's `CLAUDE.md` at every session start. `notes/` and `artifacts/` are **not** auto-imported — the dispatcher reads files in them on demand.

## Editing profile files

After `/claudemux:setup`, the three `profile/*.md` files are HTML-comment-only stubs. Edit them in place; the comment inside each file explains what to put. Stub comments are stripped from context, so unedited stubs contribute nothing.

You can write the profile content in any language; the "use English in CLAUDE.md" rule applies to repo-shipped files, not your personal workspace.

## Artifacts vs notes vs `/tmp/`

| Use this for | Goes to |
|---|---|
| Dispatcher-generated intermediate output worth keeping across reboots | `artifacts/<YYYYMMDD>-<slug>.md` |
| Hand-curated long-term local notes | `notes/<free-name>.md` |
| Truly one-shot output, IPC, anything you don't need tomorrow | `/tmp/...` |
| Durable learnings about you / the project that the auto-memory system should track | `~/.claude/projects/<encoded>/memory/` (AutoMemory, unchanged) |

## Git tracking

`/claudemux:setup` initializes this directory as **its own** git repo (separate from any git tracking the dispatcher-dir-level might have). To inspect history, `cd .workspace && git log`.

If you want to back this up to a remote (a dotfiles repo, a personal gist), set a remote inside `.workspace/` and push as you would any other repo. Setup never adds a remote on your behalf.

## Privacy

`profile/user-profile.md` and `profile/principles.md` may contain personal information or company-specific rules. No git remote is configured by setup, so nothing is pushed unless you do it deliberately.
