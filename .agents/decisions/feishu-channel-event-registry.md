# Feishu channel: event registry and core design choices

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** `plugins/feishu-channel/`

> **Update 2026-05-29:** The plugin shipped and is merged on `next`. The event
> registry, `chat_id` routing, and the `ShutdownCoordinator` below are the live
> design. Two details below are original-snapshot only: the suite runs on
> **`vitest`** (not `bun test`), and `configure` ships as a slash command while
> `access` is the skill. Current shape:
> [components/feishu-channel.md](/.agents/components/feishu-channel.md).

## Context

[Decision feishu-channel-plugin](/.agents/decisions/feishu-channel-plugin.md) settled
that the Feishu channel ships as a separate TypeScript+Bun plugin. It left
open how the channel is shaped *inside*. Four questions had to be answered
before the plugin could be more than a single-event prototype:

- The channel must react to more than one Feishu event type — chat messages
  first, document comments next, more later (reactions, recalls). How is an
  event type added without rewriting the server each time?
- A reply must reach the right Feishu conversation, and only that one.
- A long-lived WebSocket plus an MCP stdio server is two resources that leak
  if shutdown is an afterthought.
- One required event — the document-comment event — could not be verified
  against Feishu's own documentation.

## Decision

### Event handling is an extensible registry, not a switch

Each Feishu event type is a self-contained `EventHandler` (`src/events.ts`):
it declares the `event_type` it subscribes to and maps one raw payload to a
`ChannelDelivery` — content plus `<channel>` meta. An `EventRegistry` holds
the handlers; `createChannelCore` resolves one per inbound event. The
transport (`src/feishu.ts`) is event-type agnostic — `start` takes a route
table built from the registry.

Adding a Feishu event type is therefore one new handler module under
`src/handlers/` plus one `register(...)` line in `createChannelCore`. The
core pipeline and the transport do not change. A delivered event carries a
`kind` meta attribute (`message` / `doc_comment`) so a multi-event channel
stays unambiguous to Claude.

### A reply has two destinations: the answered message, or a chat

The outbound `reply` tool takes both `chat_id` and `message_id` as first-class,
and they are distinct destinations:

- With a `message_id` (the message being answered, copied from its `<channel>`
  tag), the reply goes through `im.message.reply(message_id)`. Feishu lands it
  wherever that message lives — back in its topic if it came from one, the main
  timeline otherwise — with no thread flag and no `thread_id`: replying by
  `message_id` inherits the original's location automatically. Routing is by
  `message_id` alone, so the `chat_id` paired with it never steers delivery.
- With only a `chat_id` (no message to answer), the reply is an
  `im.message.create` to that chat — a first-class on-your-own-initiative post,
  not a fallback.

The `<channel>` tag deliberately does NOT expose `thread_id`; the model never
reasons about topics directly. It only chooses "answer this message" (pass its
`message_id`) or "post to this chat" (pass the `chat_id`) — the same kind of
choice it already makes between a p2p and a group reply. Topic placement is
Feishu's job, derived from the answered message.

Routing by `message_id` alone is what makes a cross-chat misroute structurally
impossible: no `chat_id` from one conversation can redirect a reply addressed to
another conversation's `message_id`. The transport reports the chat the reply
actually landed in (the reply target's chat from the Feishu response), and
`clearReceived` takes the "received" indicator off that chat — so the indicator
is always cleared on the chat the reply reached, even if the caller paired a
stale `chat_id`. A chat that does not support thread replies (Feishu error
`230071`) transparently falls back to the `chat_id` send; any other non-zero
Feishu code fails loudly rather than reporting a phantom success.

### Graceful shutdown is wired from the first commit

A `ShutdownCoordinator` (`src/shutdown.ts`) handles SIGTERM/SIGINT and the
stdio `onclose`, then closes the WebSocket and the MCP server. It was built
and tested up front, not retrofitted — a persistent networked process that
leaks its connection on exit is a bug that only structure prevents.

### The document-comment event is treated as unverified

`drive.notice.comment_add_v1` and its payload field names are corroborated
by independent third-party integrations but could not be confirmed against
Feishu's own event list, which is a JavaScript-rendered page. The handler
(`src/handlers/doc-comment.ts`) decodes defensively: it tries several key
paths per field, never throws, and logs an unrecognized-payload note instead
of crashing. The README and the `configure` skill tell operators to confirm
the event in their app console before relying on it.

## Consequences

- New event types are cheap, and the spec's "do not hardcode two events into
  the server" requirement is satisfied structurally, not by convention.
- The doc-comment handler may need a payload-shape correction once a live
  event is observed. The tolerant decode contains that risk — a shape
  mismatch is a logged drop, not a crash, and chat messages are unaffected.
- The plugin ships two skills — `configure` and `access` — and its `bun
  test` suite runs in CI under the `feishu-channel` job (see
  [components/repo-tooling.md](/.agents/components/repo-tooling.md)).
- This plugin is still mid-build on branch `feishu-channel-plugin`. Until it
  merges, [components/feishu-channel.md](/.agents/components/feishu-channel.md)
  describes intent that must be re-verified against the merged code.

## References

- Branch `feishu-channel-plugin`: the event registry (`src/events.ts`), the
  `im.message.receive_v1` and `drive.notice.comment_add_v1` handlers under
  `src/handlers/`, and the `configure` / `access` skills.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md),
  [decisions/feishu-channel-plugin.md](/.agents/decisions/feishu-channel-plugin.md).
