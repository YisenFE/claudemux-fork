/**
 * Inbound message-body normalization — the daemon's own renderer.
 *
 * The channel forwards a Feishu message to the session as the text inside the
 * `<channel>` block. This module turns one raw inbound message into clean,
 * conventional Markdown so a reading model can tell three kinds of content
 * apart at a glance: text the user actually wrote (bare Markdown), an
 * attachment whose bytes the model cannot see (a `[bracketed]` placeholder, or
 * a downloaded-file path), and a machine identifier (`inline code`).
 *
 * It re-parses `message.content` itself instead of calling the shared transport
 * package's `parseInbound`, because the normalized form needs information the
 * package's text flattening discards — a post link's `href`, for a real
 * `[text](href)` link — and it downloads top-level image/file attachments,
 * which needs the message_id and async I/O the pure parser does not carry. The
 * content walk here therefore deliberately mirrors, rather than imports, the
 * package's, so the shared package stays untouched.
 */

import { isRecord, mentionName } from '@excitedjs/feishu-transport'
import type { Mention } from '@excitedjs/feishu-transport'
import type { InboundResourceRequest } from './feishu'
import { safeIdentifier, safeInlineText } from './markdown-safe'

/** Downloads a top-level resource and yields its local path, or null on failure. */
export type InboundResourceDownloader = (req: InboundResourceRequest) => Promise<string | null>

/** The fields of an inbound message this renderer reads. */
export interface InboundContentInput {
  /** message_id (`om_...`) — the download key and the token-ref identifier. */
  messageId: string
  /** Feishu message_type — `text`, `post`, `image`, `file`, ... */
  messageType: string
  /** JSON-encoded content string, exactly as Feishu delivered it. */
  content: string
  /** @-mentions carried by the message. */
  mentions: Mention[]
}

/**
 * Render one inbound message into normalized Markdown. Never throws — content
 * that does not parse, or any unexpected failure in the renderer, degrades to a
 * placeholder so a malformed or hostile message still reaches the session
 * rather than being dropped by the server's handler-error path. `download` is
 * invoked only for a top-level image or a Read-consumable file; every other
 * type renders without I/O.
 */
export async function formatInboundContent(
  input: InboundContentInput,
  download: InboundResourceDownloader,
): Promise<string> {
  let content: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(input.content)
    content = isRecord(parsed) ? parsed : {}
  } catch {
    return '[unreadable message]'
  }

  try {
    return await renderByType(input, content, download)
  } catch {
    // Last-resort net: the renderer must never throw, so a delivered message is
    // never dropped. Unexpected failures (a hostile payload, a download path
    // that escaped its guards) degrade to a readable placeholder.
    return '[unreadable message]'
  }
}

/** Dispatch on message_type. May throw; `formatInboundContent` is the net. */
function renderByType(
  input: InboundContentInput,
  content: Record<string, unknown>,
  download: InboundResourceDownloader,
): Promise<string> | string {
  switch (input.messageType) {
    case 'text':
      return renderText(content, input.mentions)
    case 'post':
      return renderPost(content, input.mentions)
    case 'interactive':
      return renderCard(content)
    case 'image':
      return renderImage(content, input, download)
    case 'file':
      return renderFile(content, input, download)
    case 'audio':
      return '[voice message]'
    case 'media':
      return '[video]'
    case 'sticker':
      return '[sticker]'
    case 'video_chat':
      return '[video call]'
    case 'location':
      return renderLocation(content)
    case 'merge_forward':
      return '[forwarded messages]'
    default:
      return `[unsupported message: ${input.messageType}]`
  }
}

// ── text ────────────────────────────────────────────────────────────────────

/**
 * Render a text message, resolving @-mentions to readable handles. An empty
 * body becomes `[empty message]`.
 */
function renderText(content: Record<string, unknown>, mentions: Mention[]): string {
  const raw = typeof content.text === 'string' ? content.text : ''
  const text = applyMentions(raw, mentions)
  return text.trim() === '' ? '[empty message]' : text
}

/**
 * Replace Feishu's `@_user_N` / `@_all` placeholders with readable mentions: a
 * named mention to `@Name`, the all-members token to `@everyone`, and any
 * remaining bare placeholder (a mention with no name, or one absent from the
 * list) to `@someone`, so a raw `@_user_N` never leaks to the model. Mentions
 * are applied longest-key-first so `@_user_1` cannot partially match inside
 * `@_user_10`.
 */
function applyMentions(text: string, mentions: Mention[]): string {
  let out = text
  const ordered = [...mentions].sort((a, b) => (b.key?.length ?? 0) - (a.key?.length ?? 0))
  for (const m of ordered) {
    if (!m.key) continue
    const handle = m.key === '@_all' ? '@everyone' : m.name ? `@${m.name}` : '@someone'
    out = out.split(m.key).join(handle)
  }
  out = out.split('@_all').join('@everyone')
  out = out.replace(/@_user_\d+/g, '@someone')
  return out
}

// ── post (rich text) ──────────────────────────────────────────────────────────

/**
 * Render a Feishu rich-text "post" as Markdown: the title as bold on its own
 * line, paragraphs separated by blank lines, links as `[text](href)`, inline
 * images as `[image]`, and @-mentions resolved. A post is locale-wrapped
 * (`{ zh_cn: { title, content } }`); the body is an array of paragraphs, each an
 * array of tagged inline elements.
 */
function renderPost(content: Record<string, unknown>, mentions: Mention[]): string {
  const post = pickPostLocale(content)
  const blocks: string[] = []
  if (typeof post.title === 'string' && post.title.trim() !== '') {
    blocks.push(`**${post.title}**`)
  }
  const body = post.content
  if (Array.isArray(body)) {
    for (const paragraph of body) {
      if (!Array.isArray(paragraph)) continue
      const line = paragraph.map((el) => renderPostElement(el, mentions)).join('')
      if (line !== '') blocks.push(line)
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : '[empty message]'
}

/** Pick the first present locale block of a post, falling back to the raw object. */
function pickPostLocale(content: Record<string, unknown>): Record<string, unknown> {
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    const block = content[locale]
    if (isRecord(block)) return block
  }
  return content
}

/** Render one inline post element to Markdown. */
function renderPostElement(el: unknown, mentions: Mention[]): string {
  if (!isRecord(el)) return ''
  switch (el.tag) {
    case 'text':
      return typeof el.text === 'string' ? el.text : ''
    case 'a': {
      const text = typeof el.text === 'string' ? el.text : ''
      const href = typeof el.href === 'string' ? el.href : ''
      if (text && href) return `[${text}](${href})`
      if (href) return `<${href}>`
      return text
    }
    case 'at':
      return renderPostAt(el, mentions)
    case 'img':
      return '[image]'
    default:
      return ''
  }
}

/** Render a post @-mention element, resolving to a readable handle. */
function renderPostAt(el: Record<string, unknown>, mentions: Mention[]): string {
  const userId = typeof el.user_id === 'string' ? el.user_id : ''
  if (userId === 'all') return '@everyone'
  const name = (typeof el.user_name === 'string' && el.user_name) || mentionName(mentions, userId)
  return name ? `@${name}` : '@someone'
}

// ── interactive card ─────────────────────────────────────────────────────────

/**
 * Bounds on the card walk. A hostile card can nest containers arbitrarily deep
 * or wide; the depth cap stops the recursion from overflowing the stack and the
 * node budget caps total work. Past either bound the walk simply stops — the
 * card still renders from whatever was collected, or `[card]` if nothing was.
 */
const MAX_CARD_DEPTH = 32
const MAX_CARD_NODES = 4000

/**
 * Render a v2 interactive card to Markdown: the header title as bold, then each
 * text block. Card `markdown` / `lark_md` content is already Markdown, so it is
 * passed through unchanged; a card with no extractable text becomes `[card]`.
 */
function renderCard(content: Record<string, unknown>): string {
  const card = unwrapUserDsl(content)
  const parts: string[] = []
  const header = card.header
  if (isRecord(header) && isRecord(header.title)) {
    const title = header.title.content
    if (typeof title === 'string' && title.trim() !== '') parts.push(`**${title}**`)
  }
  const body = isRecord(card.body) ? card.body.elements : card.elements
  if (Array.isArray(body)) {
    const budget = { nodes: MAX_CARD_NODES }
    for (const el of body) collectCardText(el, parts, 0, budget)
  }
  return parts.length > 0 ? parts.join('\n\n') : '[card]'
}

/** Unwrap the `user_dsl` JSON-string envelope Feishu WebSocket events wrap cards in. */
function unwrapUserDsl(card: Record<string, unknown>): Record<string, unknown> {
  if (typeof card.user_dsl !== 'string') return card
  try {
    const inner: unknown = JSON.parse(card.user_dsl)
    return isRecord(inner) ? inner : card
  } catch {
    return card
  }
}

/**
 * Recursively collect readable text from a v2 card element into `parts`. Bounded
 * by `depth` (stack safety) and the shared `budget` (total work); past either it
 * stops descending rather than risk a stack overflow on a hostile card.
 */
function collectCardText(
  el: unknown,
  parts: string[],
  depth: number,
  budget: { nodes: number },
): void {
  if (depth > MAX_CARD_DEPTH || budget.nodes <= 0) return
  budget.nodes--
  if (!isRecord(el)) return
  const tag = el.tag
  if (tag === 'markdown' || tag === 'plain_text' || tag === 'div') {
    // `content` is a direct string in feishu-channel cards; `text.content` is
    // the nested-object form other bots use.
    const text = isRecord(el.text) ? el.text.content : el.content
    if (typeof text === 'string' && text.trim() !== '') parts.push(text)
    // div.fields[] — lark_md cells in field-layout cards from other bots. Each
    // field consumes the shared budget too, so a div carrying thousands of
    // fields cannot emit thousands of segments.
    if (Array.isArray(el.fields)) {
      for (const f of el.fields) {
        if (budget.nodes <= 0) break
        budget.nodes--
        if (!isRecord(f)) continue
        const ft = isRecord(f.text) ? f.text.content : f.content
        if (typeof ft === 'string' && ft.trim() !== '') parts.push(ft)
      }
    }
  }
  // column_set → columns[].elements[]
  if (Array.isArray(el.columns)) {
    for (const col of el.columns) {
      if (isRecord(col) && Array.isArray(col.elements)) {
        for (const child of col.elements) collectCardText(child, parts, depth + 1, budget)
      }
    }
  }
  // Generic child elements (action blocks, nested containers).
  if (Array.isArray(el.elements)) {
    for (const child of el.elements) collectCardText(child, parts, depth + 1, budget)
  }
}

// ── attachments ──────────────────────────────────────────────────────────────

/**
 * Render a top-level image: download it and link the local path, or fall back
 * to a token-ref placeholder the model can resolve with lark-cli.
 */
async function renderImage(
  content: Record<string, unknown>,
  input: InboundContentInput,
  download: InboundResourceDownloader,
): Promise<string> {
  const imageKey = typeof content.image_key === 'string' ? content.image_key : ''
  // No key means neither a download nor a token-ref is possible — only a bare
  // placeholder.
  if (!imageKey) return '[image]'
  const path = await safeDownload(download, { messageId: input.messageId, fileKey: imageKey, type: 'image' })
  if (path) return `[image: ${path}]`
  return tokenRef('image', undefined, input.messageId, imageKey, 'image')
}

/**
 * Render a top-level file. A file whose extension Read can consume (a PDF or a
 * text/code format) is downloaded and linked `[name → path]`; any other type,
 * or a failed download, falls back to a token-ref placeholder. The file's
 * resource key is `file_key`, downloaded with resource type `file`. The display
 * name is wrapped in inline code and stripped of control/delimiter characters,
 * so a crafted file name cannot break out of the placeholder or forge a second
 * one.
 */
async function renderFile(
  content: Record<string, unknown>,
  input: InboundContentInput,
  download: InboundResourceDownloader,
): Promise<string> {
  const fileKey = typeof content.file_key === 'string' ? content.file_key : ''
  const fileName = typeof content.file_name === 'string' ? content.file_name : ''
  const display = safeInlineText(fileName)
  // No key means no download and no token-ref — only a bare placeholder.
  if (!fileKey) return display ? `[file: \`${display}\`]` : '[file]'
  if (fileName && isReadableFile(fileName)) {
    const path = await safeDownload(download, {
      messageId: input.messageId,
      fileKey,
      type: 'file',
      fileName,
    })
    if (path) return `[file: \`${display}\` → ${path}]`
  }
  return tokenRef('file', fileName, input.messageId, fileKey, 'file')
}

/** Run the injected downloader, treating a thrown error as a failed download. */
async function safeDownload(
  download: InboundResourceDownloader,
  req: InboundResourceRequest,
): Promise<string | null> {
  try {
    return await download(req)
  } catch {
    return null
  }
}

/**
 * Build the not-downloaded token-ref placeholder: a prose negation plus the
 * lark-cli identifiers a model needs to fetch the resource itself (the default
 * target session has lark-cli installed and authenticated). The display name is
 * inline-code-wrapped and sanitized, and the identifiers are reduced to the
 * Feishu key charset, so a crafted name or key cannot inject a forged token-ref.
 */
function tokenRef(
  kind: 'image' | 'file',
  name: string | undefined,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
): string {
  const display = safeInlineText(name ?? '')
  const label = display ? `${kind}: \`${display}\` — not downloaded` : `${kind} — not downloaded`
  return (
    `[${label}; fetch via lark-cli, ` +
    `message_id=${safeIdentifier(messageId)}, file_key=${safeIdentifier(fileKey)}, type=${type}]`
  )
}

/**
 * Extensions Claude Code's `Read` tool can consume directly — PDF plus text and
 * code formats. Only these files are worth downloading; any other type (an
 * archive, a binary office document, a media container) renders as a token-ref,
 * so the model fetches it on demand instead of paying download cost for bytes it
 * cannot read.
 */
const READABLE_FILE_EXTS = new Set([
  'pdf',
  'txt', 'text', 'log', 'md', 'markdown', 'rst', 'tex',
  'csv', 'tsv',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'html', 'htm', 'css', 'svg',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cpp', 'cxx', 'cc', 'hpp', 'cs', 'php', 'swift', 'scala', 'sh', 'bash', 'zsh',
  'sql', 'lua', 'pl', 'r', 'dart', 'vue', 'svelte',
  'ipynb',
])

/** True when a file's extension is one `Read` can consume. */
function isReadableFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0 || dot === fileName.length - 1) return false
  return READABLE_FILE_EXTS.has(fileName.slice(dot + 1).toLowerCase())
}

// ── location ──────────────────────────────────────────────────────────────────

/** Render a location share: name it when present, else the bare placeholder. */
function renderLocation(content: Record<string, unknown>): string {
  const name = typeof content.name === 'string' ? content.name.trim() : ''
  return name ? `[location: ${name}]` : '[location]'
}
