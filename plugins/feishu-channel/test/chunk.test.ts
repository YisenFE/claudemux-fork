import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { chunk, type ChunkMode } from '../src/chunk'

const modeArb = fc.constantFrom<ChunkMode>('length', 'newline', 'markdown')

describe('chunk', () => {
  test('text within the limit is a single chunk', () => {
    expect(chunk('hello', 10)).toEqual(['hello'])
    expect(chunk('hello', 5)).toEqual(['hello'])
  })

  test('empty text yields a single empty chunk', () => {
    expect(chunk('', 10)).toEqual([''])
  })

  test('rejects a non-positive or non-integer limit', () => {
    expect(() => chunk('abc', 0)).toThrow(RangeError)
    expect(() => chunk('abc', -1)).toThrow(RangeError)
    expect(() => chunk('abc', 1.5)).toThrow(RangeError)
  })

  test('length mode cuts on a hard boundary', () => {
    expect(chunk('abcdef', 2, 'length')).toEqual(['ab', 'cd', 'ef'])
    expect(chunk('abcdefg', 3, 'length')).toEqual(['abc', 'def', 'g'])
  })

  test('newline mode prefers a blank-line boundary', () => {
    const out = chunk('aaaa\n\nbbbb', 6, 'newline')
    expect(out[0]).toBe('aaaa')
    expect(out[1]).toBe('bbbb')
  })

  test('newline mode prefers a word boundary over a mid-word cut', () => {
    const out = chunk('alpha bravo charlie', 13, 'newline')
    expect(out[0]).toBe('alpha bravo')
  })

  test('newline mode falls back to a hard cut when no boundary is near', () => {
    const out = chunk('aaaaaaaaaa', 4, 'newline')
    for (const c of out) expect(c.length).toBeLessThanOrEqual(4)
    expect(out.join('')).toBe('aaaaaaaaaa')
  })

  test('property: every chunk is within the limit', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 60 }), modeArb, (text, limit, mode) => {
        for (const c of chunk(text, limit, mode)) {
          expect(c.length).toBeLessThanOrEqual(limit)
        }
      }),
    )
  })

  test('property: every chunk is non-empty for non-empty input', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 1, max: 60 }),
        modeArb,
        (text, limit, mode) => {
          for (const c of chunk(text, limit, mode)) {
            expect(c.length).toBeGreaterThan(0)
          }
        },
      ),
    )
  })

  test('property: length mode is lossless', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 60 }), (text, limit) => {
        expect(chunk(text, limit, 'length').join('')).toBe(text)
      }),
    )
  })

  test('property: length mode chunk count is ceil(len / limit)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 1, max: 60 }), (text, limit) => {
        expect(chunk(text, limit, 'length').length).toBe(Math.ceil(text.length / limit))
      }),
    )
  })
})

describe('chunk in markdown mode', () => {
  test('text without fences cuts on a paragraph or line boundary', () => {
    const out = chunk('para one\n\npara two', 12, 'markdown')
    expect(out).toEqual(['para one', 'para two'])
  })

  test('a fenced code block that fits stays in one chunk', () => {
    const text = ['intro', '```ts', 'const a = 1', '```'].join('\n')
    expect(chunk(text, 100, 'markdown')).toEqual([text])
  })

  test('a fenced code block longer than the limit splits with repeated fences', () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const text = ['```ts', body, '```'].join('\n')
    const out = chunk(text, 40, 'markdown')

    expect(out.length).toBeGreaterThan(1)
    for (const part of out) {
      expect(part.length).toBeLessThanOrEqual(40)
      // Every emitted part is itself well-formed Markdown — the opening fence
      // and its language tag at the top, the closing fence at the bottom, and
      // therefore an even number of ``` markers overall.
      expect(part.startsWith('```ts')).toBe(true)
      expect(part.endsWith('```')).toBe(true)
      expect(part.split(/^```/gm).length - 1).toBe(2)
    }
    // The concatenation of every body line is preserved across parts.
    const restored = out
      .map((p) => p.replace(/^```ts\n/, '').replace(/\n```$/, ''))
      .join('\n')
    expect(restored).toBe(body)
  })

  test('a fence-only body alternates around a long surrounding text', () => {
    const text = [
      'intro text first paragraph',
      '',
      '```sh',
      'echo "step one"',
      'echo "step two"',
      '```',
      '',
      'closing paragraph after the code',
    ].join('\n')
    const out = chunk(text, 40, 'markdown')
    // Every emitted part is balanced — even number of fence markers.
    for (const part of out) {
      const fenceCount = (part.match(/^```/gm) ?? []).length
      expect(fenceCount % 2).toBe(0)
    }
  })

  test('a tilde-fenced block uses the same fence character on the repeated open', () => {
    const text = ['~~~md', 'one', 'two', 'three', 'four', 'five', '~~~'].join('\n')
    const out = chunk(text, 16, 'markdown')
    expect(out.length).toBeGreaterThan(1)
    for (const part of out) {
      expect(part.startsWith('~~~md')).toBe(true)
      expect(part.endsWith('~~~')).toBe(true)
    }
  })

  test('every markdown chunk is within the limit', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 8, max: 80 }), (text, limit) => {
        for (const c of chunk(text, limit, 'markdown')) {
          expect(c.length).toBeLessThanOrEqual(limit)
        }
      }),
    )
  })
})
