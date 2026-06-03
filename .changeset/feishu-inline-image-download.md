---
"claude-channel-feishu": minor
---

Download inline images in Feishu posts and interactive cards, not just top-level attachments. A post inline image (`image_key`) and a card inline image (`img_key`) are downloaded to a local path the `Read` tool can open, in the same two tiers as a top-level image — a downloaded `[image: /path]` or, on failure/unsupported, a `[image — not downloaded; fetch via lark-cli, …]` token-ref that never drops the message. Inline downloads are bounded: a paragraph's images download sequentially (at most one in flight), and a per-message cap limits total inline downloads, with the excess rendered as token-refs without a fetch. Implemented entirely in the daemon renderer; the shared `@excitedjs/feishu-transport` package is untouched.
