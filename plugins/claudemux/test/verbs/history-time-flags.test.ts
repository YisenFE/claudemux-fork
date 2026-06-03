/**
 * Coverage for `--since` / `--until` time parsing in `parseHistoryArgs`.
 *
 * Two accepted shapes share one entry point (`parseTimeFlag`):
 *   - relative durations ("3d", "12h", "1w", "30m") resolve to "<N> ago",
 *     i.e. now minus the duration — what the SessionStart recall hook passes
 *     so it never has to do cross-platform date arithmetic in bash;
 *   - absolute dates (ISO, "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS") keep working
 *     for existing callers.
 *
 * `Date.now()` is pinned with fake timers so the relative cases assert exact
 * millisecond values rather than a tolerance window.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { parseHistoryArgs } from '../../src/verbs/history'

const FIXED_NOW = Date.parse('2026-06-03T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

/** Parse and require success, returning the resolved query. */
function ok(args: readonly string[]) {
  const parsed = parseHistoryArgs(args)
  if ('error' in parsed) {
    throw new Error(`expected success, got error: ${parsed.error.stderr.trim()}`)
  }
  return parsed
}

/** Parse and require the error variant, returning its stderr. */
function err(args: readonly string[]): string {
  const parsed = parseHistoryArgs(args)
  if (!('error' in parsed)) {
    throw new Error(`expected error, got success`)
  }
  return parsed.error.stderr
}

describe('--since / --until relative durations', () => {
  test.each([
    ['30m', 30 * MINUTE],
    ['12h', 12 * HOUR],
    ['3d', 3 * DAY],
    ['1w', WEEK],
    ['2w', 2 * WEEK],
    ['1m', MINUTE],
    ['1h', HOUR],
    ['1d', DAY],
  ])('--since %s resolves to now minus the duration', (token, deltaMs) => {
    expect(ok(['--since', token]).sinceMs).toBe(FIXED_NOW - deltaMs)
  })

  test('relative durations apply to --until as well', () => {
    expect(ok(['--until', '1d']).untilMs).toBe(FIXED_NOW - DAY)
  })

  test('the --since=VALUE form accepts relative durations', () => {
    expect(ok(['--since=3d']).sinceMs).toBe(FIXED_NOW - 3 * DAY)
  })

  test('zero duration resolves to now', () => {
    expect(ok(['--since', '0d']).sinceMs).toBe(FIXED_NOW)
  })
})

describe('--since / --until absolute dates still work', () => {
  test('YYYY-MM-DD parses as midnight UTC', () => {
    expect(ok(['--since', '2026-05-31']).sinceMs).toBe(Date.parse('2026-05-31'))
  })

  test('YYYY-MM-DD HH:MM:SS is normalized to UTC', () => {
    expect(ok(['--since', '2026-05-31 08:30:00']).sinceMs).toBe(
      Date.parse('2026-05-31T08:30:00Z'),
    )
  })

  test('full ISO timestamps pass through', () => {
    expect(ok(['--until', '2026-05-31T08:30:00Z']).untilMs).toBe(
      Date.parse('2026-05-31T08:30:00Z'),
    )
  })
})

describe('--since / --until invalid input', () => {
  // A bare number with no unit ("3") is not relative; it falls through to the
  // existing absolute parser, whose leniency is out of scope here. The cases
  // below are unambiguous non-dates: bad units, multi-letter units, and the
  // uppercase units the lowercase grammar deliberately rejects.
  test.each(['3x', '3days', 'banana', '-3d', '3D', '3 d'])(
    '%s is rejected as not a parseable date/time',
    (bad) => {
      expect(err(['--since', bad])).toContain('is not a parseable date/time')
    },
  )

  // A relative token whose millisecond span overflows the safe-integer range
  // must be rejected, not resolved to a ±Infinity bound.
  test.each(['99999999999999999w', '9999999999999999999d'])(
    'overflowing relative duration %s is rejected, not resolved to ±Infinity',
    (bad) => {
      expect(err(['--since', bad])).toContain('is not a parseable date/time')
    },
  )
})
