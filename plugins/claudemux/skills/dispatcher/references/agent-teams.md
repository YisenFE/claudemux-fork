# Agent Teams teammates (diagnostic reference)

Reach for Agent Teams only when you genuinely need a shared task list or peer SendMessage across multiple teammates. Otherwise prefer `tm` teammates or `tm ask`; Agent Teams teammates have the caveats below.

## Spawn-prompt checklist

Use the `Agent` tool with `team_name=<existing-team>` and `name=<teammate-name>`. The spawn prompt **must** include all three of these, or the teammate will silently misbehave:

1. **Explicit working directory.** Unlike a `tm spawn` (which uses `tmux new-session -c` to set cwd), an Agent Teams teammate inherits the dispatcher's cwd and cannot be reassigned at spawn time. Write the absolute path of the target repo into the prompt verbatim, e.g. `` Your working directory is `/Users/foo/dev/my-repo`; cd there before doing anything else. `` The teammate runs without this skill in context, so any placeholder you write goes through to it unexpanded. The repo's own `CLAUDE.md` will *not* auto-load — instruct the teammate to `Read` it if needed.

2. **Hard SendMessage requirement.** Teammates default to silent idle and will not message back even when the prompt politely asks. Use this exact framing in the prompt:

   > Required: SendMessage to="team-lead" with the result. Not allowed to only idle. Not sending = not done.

3. **No nested teams.** Teammates cannot spawn their own teammates. If a sub-team is needed, you (the lead) must spawn it.

Agent Teams teammates cannot be resumed after dispatcher restart; there is no equivalent of `tm resume`. Treat teammates as ephemeral; pin persistent state into files inside the target repo if you need continuity.

## Filtering idle-notification noise

Agent Teams teammates emit `{"type":"idle_notification","from":"...","idleReason":"available"}` after every turn. These arrive as conversation turns even when there is no new information.

Default response: a single line confirming the noise, no extra action. Don't `tm status` or `capture-pane` reflexively on every idle ping — that floods your own context. Only investigate state proactively when:

- the user explicitly asks for it,
- you sent a teammate work and a long enough time has passed that something should have come back,
- or an idle notification follows an explicit message you sent and you need to confirm the message was acted on.

A teammate going idle immediately after a SendMessage does **not** mean it failed; it means the teammate finished its turn and is waiting. The Agent Teams framework also separates `shutdown_approved` (the teammate agreed to shut down) from `teammate_terminated` (the process actually exited) — wait for the latter before `TeamDelete`.
