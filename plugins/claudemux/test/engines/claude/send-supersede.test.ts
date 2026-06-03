/**
 * Send auto-supersede — when a later `tm send` to the same teammate arrives
 * while an earlier `tm send` is still waiting for its turn to settle, the
 * earlier send returns early (exit 0) with a note instead of burning its
 * full timeout to a 124.
 *
 * Two properties make this safe under concurrency (these tests pin both):
 *
 *  - **Exactly one survivor.** Each send claims a unique single-use token in
 *    `/tmp/teammate-<name>.send-token` with an atomic temp-write + rename,
 *    and supersede is decided by token *identity* (the file no longer holds
 *    my token), never by comparing millisecond magnitudes. So two sends in
 *    the same millisecond cannot tie, and a late/replayed claim cannot
 *    "regress" the file into a state where two sends both think they
 *    survived (which would resurrect the original 124/marker race).
 *
 *  - **Claim only after delivery.** A send claims the token only after its
 *    `sendKeys` actually lands the prompt. A send that fails to deliver must
 *    not retire an earlier waiting send with a false "your result merges
 *    into mine" promise.
 *
 * The "merged result" the dispatcher eventually reads is emergent from
 * Claude Code's own queue behavior; `tm` only lets superseded sends return
 * early and lets the single survivor keep waiting for the final Stop.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { claudeSend } from '../../../src/engines/claude/send'
import { waitForTurnEnd } from '../../../src/engines/claude/wait-signals'
import {
  claimSendToken,
  isSuperseded,
  mintSendToken,
  readSendToken,
} from '../../../src/engines/claude/supersede'
import {
  idleDir,
  idleMarkerFor,
  lastFileFor,
  sendTokenFile,
  sidFile,
} from '../../../src/persistence/paths'
import { EXIT_SYNC_WAIT_EXPIRED } from '../../../src/tm'
import type { ClaudeVerbEnv } from '../../../src/engines/claude/env'
import type { TmuxRunner } from '../../../src/tmux'

/** A tmux runner that reports every teammate alive and every key-send a success. */
function fakeTmuxAlive(claudeName: string): TmuxRunner {
  const sessionName = `teammate-${claudeName}`
  return async (args) => {
    const verb = args[0]
    if (verb === 'list-sessions') return { code: 0, stdout: `$0 ${sessionName}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

/**
 * A tmux runner that, on every `has-session` probe, writes `laterToken` into
 * the teammate's send-token file — simulating a *newer* `tm send` that
 * claimed the teammate. `waitForTurnEnd` calls `requireSession` (→
 * `has-session`) at entry, AFTER the send under test has already claimed its
 * own token, so the loop's first supersede check sees the later token.
 */
function fakeTmuxInjectingLater(claudeName: string, laterToken: string): TmuxRunner {
  const sessionName = `teammate-${claudeName}`
  return async (args) => {
    const verb = args[0]
    if (verb === 'has-session') {
      writeFileSync(sendTokenFile(claudeName), `${laterToken}\n`)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (verb === 'list-sessions') return { code: 0, stdout: `$0 ${sessionName}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

/** A tmux runner whose session is alive but every `send-keys` fails — delivery never lands. */
function fakeTmuxFailDelivery(claudeName: string): TmuxRunner {
  const sessionName = `teammate-${claudeName}`
  return async (args) => {
    const verb = args[0]
    if (verb === 'list-sessions') return { code: 0, stdout: `$0 ${sessionName}\n`, stderr: '' }
    if (verb === 'send-keys') return { code: 1, stdout: '', stderr: 'send-keys: no server' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function envWith(runTmux: TmuxRunner): ClaudeVerbEnv {
  return {
    runTmux,
    runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
    dispatcherDir: tmpdir(),
    projectsDir: tmpdir(),
  }
}

const createdNames: string[] = []
const createdSids: string[] = []

function uniqueName(label: string): string {
  const name = `cmxtest-${label}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  createdNames.push(name)
  return name
}

function seedTeammateSid(name: string): string {
  const sid = `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12)
    .toString(16)
    .padStart(12, '0')
    .slice(-12)}`
  mkdirSync(idleDir(), { recursive: true })
  writeFileSync(sidFile(name), `${sid}\n`)
  createdSids.push(sid)
  return sid
}

let savedConfirmMs: string | undefined

beforeEach(() => {
  createdNames.length = 0
  createdSids.length = 0
  savedConfirmMs = process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS']
  process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS'] = '0'
})

afterEach(() => {
  if (savedConfirmMs === undefined) delete process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS']
  else process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS'] = savedConfirmMs
  for (const name of createdNames) {
    rmSync(sidFile(name), { force: true })
    rmSync(sendTokenFile(name), { force: true })
  }
  for (const sid of createdSids) {
    rmSync(idleMarkerFor(sid), { force: true })
    rmSync(lastFileFor(sid), { force: true })
  }
})

describe('mintSendToken', () => {
  test('produces a unique token on every call (no same-millisecond collision)', () => {
    const tokens = new Set([
      mintSendToken(),
      mintSendToken(),
      mintSendToken(),
      mintSendToken(),
    ])
    expect(tokens.size).toBe(4)
  })
})

describe('isSuperseded is identity-based', () => {
  test('no token file → never superseded', () => {
    const name = uniqueName('id-absent')
    expect(isSuperseded(name, 'tok')).toBe(false)
  })

  test('file holds my token → not superseded', () => {
    const name = uniqueName('id-mine')
    claimSendToken(name, 'tok-mine')
    expect(isSuperseded(name, 'tok-mine')).toBe(false)
    expect(readSendToken(name)).toBe('tok-mine')
  })

  test('file holds a different token → superseded', () => {
    const name = uniqueName('id-other')
    claimSendToken(name, 'tok-other')
    expect(isSuperseded(name, 'tok-mine')).toBe(true)
  })
})

describe('exactly one survivor under concurrent / replayed claims', () => {
  test('two distinct claims → only the latest survives (no same-instant tie)', () => {
    const name = uniqueName('one-survivor')
    claimSendToken(name, 'tok-A')
    claimSendToken(name, 'tok-B')
    expect(isSuperseded(name, 'tok-A')).toBe(true)
    expect(isSuperseded(name, 'tok-B')).toBe(false)
  })

  test('a replayed earlier claim cannot leave two survivors', () => {
    const name = uniqueName('no-two-survivors')
    claimSendToken(name, 'tok-A')
    claimSendToken(name, 'tok-B')
    claimSendToken(name, 'tok-A') // an older send's write landing late / replayed
    const survivors = ['tok-A', 'tok-B'].filter((t) => !isSuperseded(name, t))
    // Exactly one token is ever the non-superseded survivor — whoever claimed
    // last — never both. (A magnitude/max-wins scheme could leave two here.)
    expect(survivors).toEqual(['tok-A'])
  })
})

describe('waitForTurnEnd supersede wiring', () => {
  test('returns {superseded} when the token file holds a different token', async () => {
    const name = uniqueName('wait-superseded')
    seedTeammateSid(name)
    claimSendToken(name, 'newer-token')

    const verdict = await waitForTurnEnd(
      name,
      60,
      false,
      fakeTmuxAlive(name),
      { jsonl: null, sinceBytes: 0 },
      'my-token',
    )

    expect(verdict).toEqual({ superseded: true })
  })

  test('a null token (non-participating send) never reports superseded', async () => {
    const name = uniqueName('wait-null-token')
    seedTeammateSid(name)
    claimSendToken(name, 'whatever')

    const verdict = await waitForTurnEnd(
      name,
      0,
      false,
      fakeTmuxAlive(name),
      { jsonl: null, sinceBytes: 0 },
      null,
    )

    // --timeout 0 falls straight through to the ordinary expiry, never the
    // supersede branch, because this send claimed no token.
    expect(verdict).toEqual({ ok: false })
  })
})

describe('claudeSend returns early when superseded', () => {
  test('a newer send claims during the wait → exit 0 with a supersede note, not 124', async () => {
    const name = uniqueName('send-superseded')
    seedTeammateSid(name)

    const result = await claudeSend(
      [name, '--prompt', 'guidance', '--timeout', '60'],
      envWith(fakeTmuxInjectingLater(name, 'a-newer-send-token')),
    )

    expect(result.code).toBe(0)
    expect(result.code).not.toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('superseded')
    expect(result.stderr).toContain(name)
    expect(result.stderr).toMatch(/later send|merged|tm wait/)
  })
})

describe('claim happens only after delivery succeeds', () => {
  test('a send whose delivery fails does NOT claim the token (no false supersede)', async () => {
    const name = uniqueName('send-fail-deliver')
    seedTeammateSid(name)
    // An earlier send is already waiting on this teammate (it owns the token).
    claimSendToken(name, 'earlier-send')

    const result = await claudeSend(
      [name, '--prompt', 'g2', '--timeout', '0'],
      envWith(fakeTmuxFailDelivery(name)),
    )

    // The delivery failed, so this send is a hard failure (exit 1) and must
    // NOT have overwritten the earlier send's token.
    expect(result.code).toBe(1)
    expect(result.code).not.toBe(0)
    expect(readSendToken(name)).toBe('earlier-send')
    // …so the earlier waiting send is NOT superseded by this failed delivery.
    expect(isSuperseded(name, 'earlier-send')).toBe(false)
  })
})

describe('a normal single send is unaffected (sync contract intact)', () => {
  test('no later send → still takes the normal expiry path (124), never the supersede note', async () => {
    const name = uniqueName('send-normal')
    seedTeammateSid(name)

    const result = await claudeSend(
      [name, '--prompt', 'hi', '--timeout', '0'],
      envWith(fakeTmuxAlive(name)),
    )

    expect(result.code).toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stderr).toContain('sync wait expired')
    expect(result.stderr).not.toContain('superseded')
  })
})
