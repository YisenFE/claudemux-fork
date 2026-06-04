/**
 * Shared turn-control helpers for the codex app-server protocol.
 *
 * Steering an in-progress turn (`turn/steer`) and reading the active turn id
 * (`thread/read` → last `inProgress` turn) are needed by two callers:
 *   - the Codex-UI follower path (`ipc-bridge.ts`), where Codex-UI is the
 *     leader and claudemux forwards steer/interrupt requests, and
 *   - the `tm send` supersede path (`engine.ts`), where a later send joins the
 *     turn an earlier send started.
 * They live here so both reach the same logic instead of one re-deriving it.
 */

import type { Thread } from '../../codex-protocol/v2/Thread.js'
import type { NonSteerableTurnKind } from '../../codex-protocol/v2/NonSteerableTurnKind.js'
import type { ThreadReadResponse } from '../../codex-protocol/v2/ThreadReadResponse.js'
import type { TurnSteerParams } from '../../codex-protocol/v2/TurnSteerParams.js'
import type { TurnSteerResponse } from '../../codex-protocol/v2/TurnSteerResponse.js'
import type { CodexWsClient } from './rpc.js'

/** The last `inProgress` turn on a thread, or `null` when none is running. */
export function activeTurnIdFromThread(thread: Thread): string | null {
  for (let i = thread.turns.length - 1; i >= 0; i -= 1) {
    const turn = thread.turns[i]
    if (turn?.status === 'inProgress') return turn.id
  }
  return null
}

/**
 * Read the thread snapshot and return its active (in-progress) turn id, if any.
 * A thread that has never received a first user message is "not materialized":
 * the daemon rejects `thread/read` with `includeTurns` rather than returning an
 * empty turn list. Such a thread has no active turn by definition, so treat
 * that rejection as `null` instead of letting it abort the caller.
 */
export async function readActiveTurnId(
  client: CodexWsClient,
  threadId: string,
): Promise<string | null> {
  let read: ThreadReadResponse
  try {
    read = await client.request<'thread/read', ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: true,
    })
  } catch (e) {
    if (/not\s+materialized/i.test(errorMessage(e))) return null
    throw e
  }
  return activeTurnIdFromThread(read.thread)
}

/**
 * The codex daemon checks `expectedTurnId` optimistically: if the turn rolled
 * over between our `thread/read` and the `turn/steer`, it rejects with
 * "expected active turn id `X` but found `Y`". Recover the actual id so the
 * caller can retry against it once.
 */
export function expectedActiveTurnIdFromError(error: unknown): string | null {
  const match = errorMessage(error).match(/expected active turn id `[^`]+` but found `([^`]+)`/)
  return match?.[1] ?? null
}

/**
 * Whether a `turn/steer` rejection means the active turn cannot be steered
 * because it is a `review` or `compact` turn — the daemon's
 * `activeTurnNotSteerable` error. Observed live shape (codex 0.136.0):
 *
 *   message: "cannot steer a compact turn"
 *   data:    { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } }, ... }
 *
 * The structured `data` is authoritative; fall back to the message text for
 * forward-compatibility if a future daemon stops carrying `data`.
 */
export function nonSteerableTurnKind(error: unknown): NonSteerableTurnKind | null {
  const fromData = nonSteerableKindFromData((error as { data?: unknown })?.data)
  if (fromData !== null) return fromData
  const message = errorMessage(error)
  const match = message.match(/steer(?:ing)?\s+a\s+(review|compact)\s+turn/i)
  const kind = match?.[1]?.toLowerCase()
  return kind === 'review' || kind === 'compact' ? kind : null
}

function nonSteerableKindFromData(data: unknown): NonSteerableTurnKind | null {
  const record = asRecord(data)
  if (record === null) return null
  // The daemon nests it as `data.codexErrorInfo.activeTurnNotSteerable.turnKind`;
  // accept it directly under `data` too in case the wrapping ever changes.
  const info = asRecord(record['codexErrorInfo']) ?? record
  const wrapper = asRecord(info['activeTurnNotSteerable'])
  if (wrapper === null) return null
  const kind = wrapper['turnKind']
  return kind === 'review' || kind === 'compact' ? kind : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * `turn/steer` with the already-built params, retrying once if the turn id
 * rolled over between read and steer (`expectedActiveTurnIdFromError`). The
 * retry self-corrects `expectedTurnId` against the id the daemon reports.
 * Callers build params their own way (the follower munges metadata; `tm send`
 * passes a plain text input) and share the retry here.
 */
export async function steerActiveTurn(
  client: CodexWsClient,
  steerParams: TurnSteerParams,
): Promise<TurnSteerResponse> {
  try {
    return await client.request<'turn/steer', TurnSteerResponse>('turn/steer', steerParams)
  } catch (e) {
    const actualTurnId = expectedActiveTurnIdFromError(e)
    if (actualTurnId === null) throw e
    return client.request<'turn/steer', TurnSteerResponse>('turn/steer', {
      ...steerParams,
      expectedTurnId: actualTurnId,
    })
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
