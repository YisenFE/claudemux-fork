# feishu-channel changelog

## 0.8.1

### Patch Changes

- 97d03f1: Fix two inbound durability defects that could silently drop Feishu events. A failed durable write is now propagated so the Feishu SDK rejects the event (HTTP 500) and Feishu redelivers it, instead of being swallowed and falsely acknowledged. Document-comment events now derive a per-comment dedup key (file token + comment id + reply id) instead of collapsing to one shared key, so distinct comments are no longer deduped out of the durable queue during offline replay. Also removes an unused Markdown-chunking module that had no production callers.

## 0.8.0

### Minor Changes

- 8e986c0: Add `feishu_channel_doctor`, a one-shot runtime diagnosis of the Feishu channel's known foot-guns — daemon/proxy version skew, a stale server holding the inbound lock, multiple daemons contending for the socket, channel ownership stolen by a teammate, and the broker handoff gap. It ships as a read-only, spawn-free MCP tool handled locally in the proxy (so it can diagnose a stale or unreachable daemon instead of forwarding to the subject) and as a `npm run doctor` CLI entry that registers no proxy and is the authoritative path for the daemon-unreachable / stale-socket cases. `feishu_channel_status` now also carries an authoritative `daemon` identity block (version, pid, generation, started_at, launch_path), and the proxy reports `metadata.transport` when the launcher injects `CLAUDEMUX_CHANNEL_TRANSPORT`.

## 0.7.0

### Minor Changes

- c0c2651: Download inline images in Feishu posts and interactive cards, not just top-level attachments. A post inline image (`image_key`) and a card inline image (`img_key`) are downloaded to a local path the `Read` tool can open, in the same two tiers as a top-level image — a downloaded `[image: /path]` or, on failure/unsupported, a `[image — not downloaded; fetch via lark-cli, …]` token-ref that never drops the message. Inline downloads are bounded: a paragraph's images download sequentially (at most one in flight), and a per-message cap limits total inline downloads, with the excess rendered as token-refs without a fetch. Implemented entirely in the daemon renderer; the shared `@excitedjs/feishu-transport` package is untouched.

## 0.6.0

### Minor Changes

- ee8107d: Normalize inbound Feishu message bodies to clean Markdown in the daemon. Attachments and unsupported types render as bracketed placeholders, posts and cards become real Markdown (links, bold titles, blockquoted bot-discovery and document-comment context), and @-mentions and open_ids read as `@Name` / inline code instead of leaking raw placeholders. Top-level image and file attachments are downloaded on demand to a local path the `Read` tool can open, with a lark-cli token-ref fallback whenever a download is unsupported or fails — a failed download never drops the message.

## 0.5.0

### Minor Changes

- bacf5d2: feishu-channel can now answer inside a Feishu topic (话题). The `reply` tool takes both `chat_id` and `message_id`: passing the `message_id` of the message being answered (from its `<channel>` tag) replies to that message via `im.message.reply`, which lands the answer wherever that message lives — back in its topic if it came from one, the main timeline otherwise — inherited automatically, with no thread flag. Replying by `message_id` routes by `message_id` alone, so a paired `chat_id` cannot misroute it, and the received indicator is cleared on the chat the reply actually reached. Passing only a `chat_id` sends a standalone message as before. A non-zero Feishu code on either path now surfaces as an error instead of a silent drop.

## 0.4.3

### Patch Changes

- ac32168: Stop a "received" reaction from being stranded on a Feishu message. Three orderings under at-least-once delivery and concurrent tool calls could leave the indicator on after Claude replied:

  - A duplicate inbound delivery ran the same message through `markReceived` twice, adding a second reaction the `message_id → reaction_id` map (keyed on `message_id`) immediately forgot. `markReceived` now adds at most one indicator per message.
  - A `reply` could land while `addReaction` was still in flight: the clear pass ran against a pending map that did not yet hold the reaction, so it was added just after the only reply and never taken off. In-flight adds are now tracked with their chat, and a clear that races one removes the reaction the moment the add resolves.
  - A late redelivery arriving after the message was already answered and cleared added a fresh reaction no further reply would remove. Cleared messages are now remembered in a bounded (most-recent-1024) tombstone so a redelivery is suppressed, capping memory in a long-lived daemon.

## 0.4.2

### Patch Changes

- cb375c2: Harden Feishu channel bot discovery names and bound running WebSocket reconnect retries.

## 0.4.1

### Patch Changes

- 158044a: Fix the feishu-channel daemon handoff across plugin reloads by advertising the real plugin version, evicting older daemons, and reconnecting proxies after daemon restarts.

## 0.4.0

### Minor Changes

- c8b690e: Channel proxies now self-report a neutral `metadata` bag at registration, surfaced in `feishu_channel_status().sessions[]`, so a coordinator can locate a session by a readable key (a claudemux teammate reports `metadata.teammate_name` and `metadata.cwd`) instead of reverse-engineering it from `pid`. `feishu_channel_acquire` and `feishu_channel_grant` accept a `match` selector that targets a proxy by its metadata, with clear errors on no match or an ambiguous match. The core schema stays orchestrator-neutral; a feishu-only install carries an empty-or-cwd-only bag. Backward compatible: older proxies omit the field and the selector simply finds nothing for them.

## 0.3.4

### Patch Changes

- 79bd41f: Handle proper-lockfile stale-reclaim races without crashing the daemon starter.

## 0.3.3

### Patch Changes

- 886f059: Use Claude Code's injected session id for Feishu proxy identities so multiple teammate sessions no longer collapse to the same channel session id.

## 0.3.2

### Patch Changes

- 7afb38e: Single-instance daemon lock now rests on proper-lockfile (atomic mkdir steal +
  background mtime refresh) instead of a hand-rolled writeFileSync/pid-death/unlink
  reclaim, closing the stale-reclaim race where two concurrent starters could both
  pass the judge-dead → unlink → recreate window. Adds a re-probe-after-acquire
  guard so a lapsed-but-still-serving holder is detected and the new starter stands
  down, with the unix-socket bind kept as a backstop arbiter.

  The plugin entrypoint now starts as a thin MCP stdio proxy and lazily spawns the
  standing daemon when the daemon socket is absent. The daemon owns the sole Feishu
  WebSocket and opens the transport without the legacy per-session instance lock,
  so ordinary Claude sessions no longer contend for the channel connection.

  Adds the handoff skill documenting how Dispatcher and teammate sessions inspect,
  grant, acquire, return, and reclaim explicit Feishu channel delivery ownership.

## 0.3.1

### Patch Changes

- fc41074: Consume `@excitedjs/feishu-transport@0.0.2` for all engine-agnostic Feishu platform I/O (the 长链/分发/解析/编码 boundary), deleting the in-tree duplicates (`content`/`render`/`pairing`/`json`/`types`). Also migrates the #17 bot-discovery parse onto the shared core: `bot-member` now consumes core's `normalizeBotMemberAddedEvent` + `BOT_MEMBER_ADDED_EVENT_TYPE`, and `im-message` uses core's `mentionName` instead of an inline lookup. Host policy/stores/UX (observe/baseline/delta, identity-store, chat-bots-store, gate) stay in claudemux. No behavior change; resolves the #13↔#17 conflict on current main.

## 0.3.0

### Minor Changes

- 1fb119a: feishu-channel: auto-discover peer bots' Open IDs in a group and surface them to the model. Any bot message (passive auto-observe) and the `/introduce` handshake now record peers into a per-app identity map (`open_id → name`, reused across chats) and a per-chat membership store; the `im.chat.member.bot.added_v1` event arms a one-shot baseline that is injected — together with incremental "new bot" deltas and a sender line for peer-bot messages — onto the next delivered mention, committed only after the session notification succeeds. A new `feishu_list_chat_bots` MCP tool lets the model re-query a chat's known bots after compaction. Auto-observe is discovery only: it never widens the access gate, whose trust set remains the `/introduce`-authorized bots.

## 0.2.0

### Minor Changes

- 4a4eb64: The received-reaction indicator now picks a random emoji per inbound message from a "seen, on it" pool (👀 `GLANCE` 看, `LGTM` 了解, `Typing` 敲键盘, `GoGoGo` 冲, `OnIt` 在做了) instead of always reacting with 👀. Removal is unchanged — it keys off the reaction_id Feishu returns, so clearing works regardless of which emoji was placed.

### Patch Changes

- 4a4eb64: Relocate the channel's manual live-verification tooling off the shipped `scripts/` surface: delete `verify-legacy-edit.ts` (its `editText` patch→update fallback is already fully covered by the mocked unit suite) and move `dogfood-markdown.ts` to `test/` beside `feishu-live.ts`, documented in the README as a manual card-render QA tool. No runtime behavior change.

## 0.1.1

### Patch Changes

- 76bc756: remove `<available_bots>` injection from group message deliveries

  The peer-bot open_ids are already surfaced in the `sender_id` attribute of
  every `<channel>` event; the separate XML block was redundant. Removing it
  simplifies the delivery path and shrinks every group message that Claude sees.

## 0.1.1-beta.0

### Patch Changes

- 76bc756: remove `<available_bots>` injection from group message deliveries

  The peer-bot open_ids are already surfaced in the `sender_id` attribute of
  every `<channel>` event; the separate XML block was redundant. Removing it
  simplifies the delivery path and shrinks every group message that Claude sees.

## 0.11.0 — 2026-05-28

- (minor) add `<@open_id>` @-mention syntax to `reply` and `edit_message` — the render pipeline converts it to a lark_md `<at>` tag that Feishu renders as an inline notification mention

## 0.10.0 — 2026-05-25

- (patch) Detect an exited parent by stdin EOF instead of polling process.ppid, so an orphaned channel server reliably self-terminates
- (patch) doc-comment: fetch comment text with batchQuery so local-selection comments resolve
- (minor) feishu-channel: migrate the runtime from Bun to Node
- (minor) send Feishu replies as interactive cards rendered from Markdown
- (patch) comments: rewrite decision NNNN references to topic slugs
- (minor) harden reply markdown rendering: fence-aware chunking, legacy-text edit fallback, card size guard
- (minor) render headings and GFM tables as dedicated v2 card components
- (minor) enforce byte / element / cell limits in renderer to prevent oversized or partial card sends
