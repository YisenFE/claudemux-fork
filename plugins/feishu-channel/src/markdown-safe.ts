/**
 * Helpers for embedding externally-supplied text in the Markdown the channel
 * delivers to the session. A Feishu display name, file name, or open_id reaches
 * us from attacker-influenced payloads, so it must not be able to break out of
 * its placeholder, escape a blockquote, or inject Markdown structure.
 */

/**
 * Reduce untrusted text to a safe one-line inline string: drop control
 * characters and newlines (which would split a one-line placeholder or escape a
 * `>` blockquote), and the Markdown delimiters that could break out of bold,
 * inline code, or a `[...]` span (`*`, backtick, `[`, `]`). Collapses runs of
 * whitespace and trims. Returns `''` when nothing printable remains.
 */
export function safeInlineText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[`*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Reduce an identifier to the Feishu key charset for safe inline-code display. A
 * real open_id / message_id / file_key is already `[A-Za-z0-9_-]`, so this is
 * lossless for legitimate values and neutralizes a crafted one that tried to
 * inject `key=value` structure or break out of inline code.
 */
export function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_')
}
