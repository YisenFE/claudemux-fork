# feishu-channel changelog

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
