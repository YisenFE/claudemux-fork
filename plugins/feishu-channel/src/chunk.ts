/**
 * Splitting long outbound replies into Feishu-sized messages.
 */

export type ChunkMode = 'length' | 'newline' | 'markdown'

/**
 * Split `text` into chunks no longer than `limit` characters.
 *
 * - `length` mode is lossless — `chunk(t, n, 'length').join('') === t`. It cuts
 *   on a hard character boundary.
 * - `newline` mode prefers a paragraph, line, or word boundary at or before
 *   `limit` so chunks read naturally; the boundary whitespace between chunks
 *   is consumed, so this mode is not lossless.
 * - `markdown` mode is fence-aware: it cuts only at block boundaries and, when
 *   a fenced code block is itself larger than `limit`, splits the block by
 *   closing the fence at the end of one chunk and reopening it at the start of
 *   the next. The result is that every chunk is individually well-formed
 *   Markdown, so a long ```code block``` or list does not render as half an
 *   open fence in one card and an orphan body in the next.
 *
 * Every returned chunk is non-empty and at most `limit` characters. Text that
 * already fits is returned as a single chunk, so empty input yields `['']` and
 * a caller always has something to send.
 */
export function chunk(text: string, limit: number, mode: ChunkMode = 'length'): string[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`chunk limit must be an integer >= 1, got ${limit}`)
  }
  if (text.length <= limit) return [text]

  if (mode === 'markdown') return chunkMarkdown(text, limit)

  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const cut = mode === 'newline' ? preferredCut(rest, limit) : limit
    out.push(rest.slice(0, cut))
    const next = rest.slice(cut)
    rest = mode === 'newline' ? next.replace(/^\s+/, '') : next
  }
  if (rest.length > 0) out.push(rest)
  return out
}

/**
 * Pick a cut point at or before `limit` that lands on a natural boundary —
 * a blank line, a newline, then a space, in that order of preference. Falls
 * back to a hard cut at `limit` when no boundary sits in the second half of
 * the window, since cutting too early would make uselessly small chunks.
 *
 * The returned cut is always in [1, limit], so the loop in `chunk` always
 * makes progress.
 */
function preferredCut(text: string, limit: number): number {
  const half = limit / 2
  const paragraph = text.lastIndexOf('\n\n', limit)
  if (paragraph > half) return paragraph
  const line = text.lastIndexOf('\n', limit)
  if (line > half) return line
  const space = text.lastIndexOf(' ', limit)
  if (space > half) return space
  return limit
}

/**
 * One parsed block of the Markdown source. A `text` block is everything
 * outside a fenced code block; a `fence` block is one ```...``` or ~~~...~~~
 * region with its body lines extracted, so the body can be split independently
 * when the whole block is too large to fit in one chunk.
 */
interface MarkdownBlock {
  kind: 'text' | 'fence'
  /** Block as it appears in the source — for a fence, includes open and close. */
  raw: string
  /** Fence open line, e.g. "```ts" — only set when `kind === 'fence'`. */
  open?: string
  /** Fence close marker, e.g. "```" — only set when `kind === 'fence'`. */
  close?: string
  /** Lines between open and close (joined by `\n`), only set for a fence. */
  body?: string
}

/** A line that opens or closes a fenced code block (``` or ~~~ runs of 3+). */
const FENCE_LINE = /^([`~]{3,})/

/**
 * Parse the Markdown source into an alternating sequence of text and fence
 * blocks. A fence is detected by the standard CommonMark rule: a line that
 * starts with three or more backticks or tildes opens a fence; the next line
 * starting with the same character run (or end-of-source) closes it.
 *
 * The parser is deliberately permissive: an unclosed fence at end-of-source
 * is still emitted as a fence block with an empty `close`, so the chunker
 * does not lose the body lines.
 */
function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fenceMatch = FENCE_LINE.exec(line)
    if (fenceMatch) {
      const fenceMark = fenceMatch[1] as string
      const open = line
      const bodyLines: string[] = []
      i++
      let close = ''
      while (i < lines.length) {
        const curr = lines[i] ?? ''
        if (curr.startsWith(fenceMark)) {
          close = curr
          i++
          break
        }
        bodyLines.push(curr)
        i++
      }
      const rawLines = close ? [open, ...bodyLines, close] : [open, ...bodyLines]
      blocks.push({
        kind: 'fence',
        raw: rawLines.join('\n'),
        open,
        close: close || fenceMark,
        body: bodyLines.join('\n'),
      })
    } else {
      const textLines: string[] = []
      while (i < lines.length && !FENCE_LINE.test(lines[i] ?? '')) {
        textLines.push(lines[i] ?? '')
        i++
      }
      blocks.push({ kind: 'text', raw: textLines.join('\n') })
    }
  }
  return blocks
}

/**
 * Pack parsed blocks into chunks no longer than `limit`. A block boundary is
 * always a safe place to cut; an oversized block is split inline — a text
 * block by the `newline` chunker, a fence block by repeating its open and
 * close markers around each body segment so every chunk is balanced Markdown.
 */
function chunkMarkdown(text: string, limit: number): string[] {
  const blocks = parseMarkdownBlocks(text)
  const parts: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.length > 0) {
      parts.push(current)
      current = ''
    }
  }
  for (const block of blocks) {
    if (block.raw.length === 0 && block.kind === 'text') {
      // Empty text block (consecutive fences) — preserve nothing; the join
      // between adjacent blocks already inserts a newline.
      continue
    }
    const sep = current.length === 0 ? '' : '\n'
    if ((current + sep + block.raw).length <= limit) {
      current = current + sep + block.raw
      continue
    }
    flush()
    if (block.raw.length <= limit) {
      current = block.raw
      continue
    }
    // Block is itself too large. Split inline, push every part except the
    // last so the last can still pack a following small block.
    const pieces =
      block.kind === 'fence'
        ? splitFenceBlock(block, limit)
        : chunk(block.raw, limit, 'newline')
    for (let i = 0; i < pieces.length - 1; i++) parts.push(pieces[i] as string)
    current = pieces[pieces.length - 1] ?? ''
  }
  flush()
  return parts
}

/**
 * Split one oversized fence block into pieces, each shaped `open\nbody\nclose`
 * with the open and close lines repeated on every piece. The body is split by
 * the line-prefer chunker against a budget that already reserves room for the
 * open and close lines, so each emitted piece fits within `limit`.
 *
 * When a single body line is longer than the remaining budget — a one-line
 * minified blob, say — the budget is enforced by a hard length cut as a last
 * resort, since carving an unsplittable token at every newline would loop.
 */
function splitFenceBlock(block: MarkdownBlock, limit: number): string[] {
  const open = block.open ?? '```'
  const close = block.close ?? '```'
  const body = block.body ?? ''
  // open + '\n' + body + '\n' + close
  const overhead = open.length + close.length + 2
  const innerLimit = Math.max(1, limit - overhead)
  // For a body that is itself a single very long line, fall back to a hard
  // length cut so the recursion still makes progress.
  const bodyPieces =
    body.includes('\n') ? chunk(body, innerLimit, 'newline') : chunk(body, innerLimit, 'length')
  return bodyPieces.map((piece) => [open, piece, close].join('\n'))
}
