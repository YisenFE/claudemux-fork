---
"claude-channel-feishu": patch
---

Fix two inbound durability defects that could silently drop Feishu events. A failed durable write is now propagated so the Feishu SDK rejects the event (HTTP 500) and Feishu redelivers it, instead of being swallowed and falsely acknowledged. Document-comment events now derive a per-comment dedup key (file token + comment id + reply id) instead of collapsing to one shared key, so distinct comments are no longer deduped out of the durable queue during offline replay. Also removes an unused Markdown-chunking module that had no production callers.
