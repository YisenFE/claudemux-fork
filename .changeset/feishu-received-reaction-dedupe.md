---
"claude-channel-feishu": patch
---

Stop a duplicate inbound delivery from stranding a "received" reaction on Feishu. When Feishu redelivers an event it has not seen acked, the same message ran through `markReceived` twice: a second reaction was added and the in-memory `message_id → reaction_id` map (keyed on `message_id`) kept only the latest id, so the earlier reaction was never taken off when Claude replied. `markReceived` now adds at most one received indicator per message, with an in-flight guard that also covers two deliveries of the same message racing through the pipeline at once. `clearReceived` is unchanged.
