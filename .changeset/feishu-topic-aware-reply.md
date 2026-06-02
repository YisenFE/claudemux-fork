---
"claude-channel-feishu": minor
---

feishu-channel can now answer inside a Feishu topic (话题). Inbound messages that arrive in a topic expose a `thread_id` attribute on the `<channel>` tag, and the `reply` tool takes an optional `message_id` anchor — copied from that same tag — that threads the answer into the topic via `im.message.reply(reply_in_thread)`. Direct messages, non-topic groups, and replies that omit the anchor route by `chat_id` exactly as before; a chat that does not support thread replies (Feishu error `230071`) transparently falls back to the normal `chat_id` send.
