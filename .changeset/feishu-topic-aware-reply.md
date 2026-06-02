---
"claude-channel-feishu": minor
---

feishu-channel can now answer inside a Feishu topic (话题). The `reply` tool takes both `chat_id` and `message_id`: passing the `message_id` of the message being answered (from its `<channel>` tag) replies to that message via `im.message.reply`, which lands the answer wherever that message lives — back in its topic if it came from one, the main timeline otherwise — inherited automatically, with no thread flag. Replying by `message_id` routes by `message_id` alone, so a paired `chat_id` cannot misroute it, and the received indicator is cleared on the chat the reply actually reached. Passing only a `chat_id` sends a standalone message as before. A chat that does not support thread replies (Feishu error `230071`) falls back to the `chat_id` send; any other non-zero Feishu code now surfaces as an error instead of a silent drop.
