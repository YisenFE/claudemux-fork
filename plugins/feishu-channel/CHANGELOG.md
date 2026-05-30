# feishu-channel changelog

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
