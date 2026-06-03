---
"claude-channel-feishu": minor
---

Normalize inbound Feishu message bodies to clean Markdown in the daemon. Attachments and unsupported types render as bracketed placeholders, posts and cards become real Markdown (links, bold titles, blockquoted bot-discovery and document-comment context), and @-mentions and open_ids read as `@Name` / inline code instead of leaking raw placeholders. Top-level image and file attachments are downloaded on demand to a local path the `Read` tool can open, with a lark-cli token-ref fallback whenever a download is unsupported or fails — a failed download never drops the message.
