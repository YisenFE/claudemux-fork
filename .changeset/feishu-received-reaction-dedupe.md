---
"claude-channel-feishu": patch
---

Stop a "received" reaction from being stranded on a Feishu message. Three orderings under at-least-once delivery and concurrent tool calls could leave the indicator on after Claude replied:

- A duplicate inbound delivery ran the same message through `markReceived` twice, adding a second reaction the `message_id → reaction_id` map (keyed on `message_id`) immediately forgot. `markReceived` now adds at most one indicator per message.
- A `reply` could land while `addReaction` was still in flight: the clear pass ran against a pending map that did not yet hold the reaction, so it was added just after the only reply and never taken off. In-flight adds are now tracked with their chat, and a clear that races one removes the reaction the moment the add resolves.
- A late redelivery arriving after the message was already answered and cleared added a fresh reaction no further reply would remove. Cleared messages are now remembered in a bounded (most-recent-1024) tombstone so a redelivery is suppressed, capping memory in a long-lived daemon.
