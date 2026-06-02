/**
 * Send auto-supersede — when a later `tm send` to the same teammate arrives
 * while an earlier `tm send` is still waiting for its turn to settle, the
 * earlier send returns early (exit 0) with a note instead of burning its
 * full timeout to a 124.
 *
 * The "merged result" the dispatcher eventually reads is emergent from
 * Claude Code's own queue behavior (queued prompts fold into the ongoing
 * turn and the model answers them together at the final Stop). `tm` does
 * not merge anything — it only (a) lets every superseded send return early
 * with a note, and (b) lets the single surviving (latest, never-superseded)
 * send keep waiting for that final Stop. These tests pin both halves plus
 * the cross-process token protocol that decides who is superseded.
 *
 * Coordination across concurrent `tm send` processes is file-only (same
 * discipline as the idle/busy markers): each send claims a millisecond
 * stamp in `/tmp/teammate-<name>.send-token` (max-wins, so an older send
 * cannot regress the file), and an in-flight send is superseded the moment
 * the file holds a stamp newer than its own.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { claudeSend } from '../../../src/engines/claude/send'
import {
  claimSendStamp,
  isSuperseded,
  readSendStamp,
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

function fakeEnv(claudeName: string): ClaudeVerbEnv {
  return {
    runTmux: fakeTmuxAlive(claudeName),
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

/** Drop a raw stamp into the token file (simulates another send having claimed it). */
function seedSendToken(name: string, stamp: number): void {
  writeFileSync(sendTokenFile(name), `${stamp}\n`)
}

let savedConfirmMs: string | undefined

beforeEach(() => {
  createdNames.length = 0
  createdSids.length = 0
  // Disable submit-confirmation so these synthetic scenarios are not held
  // up by its budget — supersede is a wait-loop property, not a submit one.
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

describe('isSuperseded predicate', () => {
  test('no token file → never superseded', () => {
    const name = uniqueName('pred-absent')
    expect(isSuperseded(name, 1000)).toBe(false)
  })

  test('file stamp equals mine → not superseded (I am the one who claimed it)', () => {
    const name = uniqueName('pred-equal')
    seedSendToken(name, 1000)
    expect(isSuperseded(name, 1000)).toBe(false)
  })

  test('file stamp older than mine → not superseded (I am newer)', () => {
    const name = uniqueName('pred-older')
    seedSendToken(name, 1000)
    expect(isSuperseded(name, 1001)).toBe(false)
  })

  test('file stamp newer than mine → superseded (a later send claimed it)', () => {
    const name = uniqueName('pred-newer')
    seedSendToken(name, 1001)
    expect(isSuperseded(name, 1000)).toBe(true)
  })
})

describe('claimSendStamp is max-wins', () => {
  test('claims when the file is absent', () => {
    const name = uniqueName('claim-absent')
    claimSendStamp(name, 500)
    expect(readSendStamp(name)).toBe(500)
  })

  test('a newer stamp overwrites an older one', () => {
    const name = uniqueName('claim-newer')
    claimSendStamp(name, 500)
    claimSendStamp(name, 1000)
    expect(readSendStamp(name)).toBe(1000)
  })

  test('an older stamp does NOT regress the file', () => {
    const name = uniqueName('claim-regress')
    claimSendStamp(name, 1000)
    claimSendStamp(name, 700)
    expect(readSendStamp(name)).toBe(1000)
  })
})

describe('claudeSend returns early when superseded', () => {
  test('a newer send token present → exit 0 with a supersede note, not 124', async () => {
    const name = uniqueName('send-superseded')
    seedTeammateSid(name)
    // A later send has already claimed a stamp far in the future, so this
    // send's own (real-now) claim is a max-wins no-op and the wait loop sees
    // itself superseded on the first iteration — before any sleep, so the
    // large --timeout is never actually waited out.
    seedSendToken(name, Date.now() + 3_600_000)

    const result = await claudeSend([name, '--prompt', 'guidance', '--timeout', '60'], fakeEnv(name))

    expect(result.code).toBe(0)
    expect(result.code).not.toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('superseded')
    expect(result.stderr).toContain(name)
    // The note must point the agent at where the merged reply lands.
    expect(result.stderr).toMatch(/later send|merged|tm wait/)
  })
})

describe('a normal single send is unaffected (sync contract intact)', () => {
  test('no later send → still takes the normal expiry path (124), never the supersede note', async () => {
    const name = uniqueName('send-normal')
    seedTeammateSid(name)
    // No future token: this send claims its own real-now stamp, is never
    // superseded, and with --timeout 0 falls straight through to the
    // existing sync-wait-expiry contract.
    const result = await claudeSend([name, '--prompt', 'hi', '--timeout', '0'], fakeEnv(name))

    expect(result.code).toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stderr).toContain('sync wait expired')
    expect(result.stderr).not.toContain('superseded')
  })
})
