/**
 * Send auto-supersede — the cross-process protocol that lets a later
 * `tm send` to the same teammate retire an earlier `tm send` that is still
 * waiting for its turn to settle. Engine-agnostic: both the Claude engine
 * (TUI key injection) and the Codex engine (app-server `turn/steer`) drive
 * it, coordinating only through `/tmp/teammate-<name>.send-token`.
 *
 * Each `tm send` is a separate `node` process; they share no memory. A send
 * claims a **unique single-use token** and treats itself as superseded the
 * moment the file no longer holds its own token.
 *
 * Two properties make this safe under concurrency:
 *
 *  - **Atomic last-claim-wins, by identity.** A claim is a temp-write +
 *    `rename` (atomic on the same filesystem), so concurrent claims never
 *    tear and the file always holds exactly one complete token. Supersede is
 *    decided by token *identity* (`current !== mine`), never by comparing
 *    millisecond magnitudes — so two sends in the same millisecond cannot
 *    tie, and a late/replayed write cannot leave the file in a state where
 *    two sends both consider themselves the survivor. Exactly one token is
 *    ever the survivor: whoever claimed last.
 *  - **Claim only after delivery.** A send that supersedes an earlier one
 *    claims only after it has actually delivered its prompt (Claude: keys
 *    landed; Codex: `turn/steer` accepted), so a send that fails to deliver
 *    never retires an earlier waiting send with a false "your result merges
 *    into mine" promise.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

import { sendTokenFile } from '../../persistence/paths'
import type { TeammateName } from '../types'

/**
 * A unique, single-use claim token for one `tm send`. The time and pid
 * prefixes aid debugging; uniqueness comes from the random suffix, so two
 * sends minted in the same millisecond (even were they the same process)
 * still get distinct tokens — identity comparison then never ties.
 */
export function mintSendToken(): string {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(8).toString('hex')}`
}

/** Read the teammate's current send-token, or `null` when absent / unreadable / empty. */
export function readSendToken(name: TeammateName): string | null {
  let raw: string
  try {
    raw = readFileSync(sendTokenFile(name), 'utf8')
  } catch {
    return null
  }
  const token = raw.trim()
  return token.length > 0 ? token : null
}

/**
 * Record `token` as this send's claim — atomically (temp file + `rename`),
 * so a concurrent reader never sees a torn token and a concurrent claim
 * cannot interleave into a half-written file. Returns `true` when the claim
 * landed on disk; `false` on any I/O error, so the caller can decline to
 * participate in supersede rather than mistake a write failure for "a newer
 * send claimed" (which `isSuperseded` would otherwise read from a stale
 * token).
 */
export function claimSendToken(name: TeammateName, token: string): boolean {
  const target = sendTokenFile(name)
  const tmp = `${target}.${process.pid.toString(36)}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, `${token}\n`)
    renameSync(tmp, target)
    return true
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best-effort temp cleanup
    }
    return false
  }
}

/**
 * Whether a later send has claimed this teammate since `myToken` — i.e. the
 * file holds a token that is not mine. A claim that never landed (no token
 * file) is not a supersession.
 */
export function isSuperseded(name: TeammateName, myToken: string): boolean {
  const current = readSendToken(name)
  return current !== null && current !== myToken
}

/**
 * The stderr note a superseded `tm send` prints as it exits early (exit 0).
 * One wording for both engines so the dispatcher reads the same guidance
 * whether it superseded a Claude or a Codex teammate: the prompt was
 * delivered into the current run; collect the result from the later send.
 */
export function supersedeNote(name: TeammateName): string {
  return (
    `tm send: ${name}: superseded by a newer send before this turn settled — ` +
    `exiting early. This prompt was delivered and is queued into the teammate's ` +
    `current run; collect the result from the later send (or 'tm wait ${name}'). ` +
    `It may be answered together with that send, or — on a pure-generation turn ` +
    `with no mid-task pause — as a separate turn, so fall back to 'tm wait ` +
    `${name}' / 'tm last ${name}' to read it. exit 0.\n`
  )
}
