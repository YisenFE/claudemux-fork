/**
 * Send auto-supersede — the cross-process protocol that lets a later
 * `tm send` to the same teammate retire an earlier `tm send` that is still
 * waiting for its turn to settle.
 *
 * Each `tm send` is a separate `node` process; they share no memory and
 * coordinate only through files (same discipline as the idle/busy markers).
 * A send claims a millisecond stamp — its invocation order — in
 * `/tmp/teammate-<name>.send-token` at start, and treats itself as
 * superseded the moment the file holds a stamp newer than its own. The
 * latest send always carries the greatest stamp, so it never sees a newer
 * one and is the single survivor that keeps waiting for the merged reply.
 *
 * The claim is **max-wins**: a send writes its stamp only when it is newer
 * than (or as new as) what is already on disk. That makes the file robust
 * to write-ordering races — an older send whose write lands late cannot
 * regress the file to its (smaller) stamp and resurrect itself, and it
 * makes the predicate cleanly testable (seed a future stamp; a real-now
 * claim is a no-op and the send observes itself superseded).
 *
 * Claude-only for now: `claudeSend` is the sole writer/reader. The Codex
 * engine drives its own transport and does not participate.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { sendTokenFile } from '../../persistence/paths'
import type { TeammateName } from '../types'

/** This send's claim stamp — its invocation order, in epoch milliseconds. */
export function mintSendStamp(): number {
  return Date.now()
}

/** Read the teammate's current send-token stamp, or `null` when absent / unparseable. */
export function readSendStamp(name: TeammateName): number | null {
  let raw: string
  try {
    raw = readFileSync(sendTokenFile(name), 'utf8')
  } catch {
    return null
  }
  const stamp = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(stamp) ? stamp : null
}

/**
 * Record `stamp` as the latest send's claim — max-wins, so an older send
 * never overwrites a newer claim. Best-effort: a failed write degrades to
 * "no supersede detection" (the send falls back to waiting for its Stop),
 * never to a crash.
 */
export function claimSendStamp(name: TeammateName, stamp: number): void {
  const current = readSendStamp(name)
  if (current !== null && current > stamp) return
  try {
    writeFileSync(sendTokenFile(name), `${stamp}\n`)
  } catch {
    // Best-effort — supersede detection is an optimization over the
    // existing wait, not a correctness requirement.
  }
}

/**
 * Whether a strictly-newer send has claimed this teammate since `myStamp`
 * was minted. Equal stamps are not superseded (that is this very send
 * re-reading its own claim, or — in the practically-impossible same-
 * millisecond tie — a fall-back to the ordinary wait for both).
 */
export function isSuperseded(name: TeammateName, myStamp: number): boolean {
  const current = readSendStamp(name)
  return current !== null && current > myStamp
}
