/**
 * Codex `tm send` supersede — the shared steer helpers and the supersede race.
 *
 * A real `codex app-server` cannot run in CI, so the protocol-layer pieces are
 * exercised against an in-process `WebSocket.Server` that replays the steer /
 * thread-read envelopes, and the token race is driven through the on-disk
 * send-token file directly. The end-to-end behaviour (two real `tm send`
 * processes against a live daemon) is the documented merge gate, recorded in
 * the PR — these tests pin the moving protocol parts around it.
 */

import type { AddressInfo } from 'node:net'
import { rmSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { WebSocketServer } from '#ws'
import type { WebSocket as WsServerSocket } from '#ws'

import { CodexRpcError, CodexWsClient } from '../../../src/engines/codex/rpc'
import {
  activeTurnIdFromThread,
  expectedActiveTurnIdFromError,
  nonSteerableTurnKind,
  readActiveTurnId,
  steerActiveTurn,
} from '../../../src/engines/codex/steer'
import { SUPERSEDED, awaitTurnOrSupersede } from '../../../src/engines/codex/engine'
import { claimSendToken, mintSendToken } from '../../../src/engines/shared/send-token'
import { sendTokenFile } from '../../../src/persistence/paths'
import type { Thread } from '../../../src/codex-protocol/v2/Thread'
import type { CollectedTurn } from '../../../src/engines/codex/events'

// ─── steer.ts pure helpers ─────────────────────────────────────────────────

function threadWithTurns(turns: ReadonlyArray<{ id: string; status: string }>): Thread {
  return { turns } as unknown as Thread
}

describe('activeTurnIdFromThread', () => {
  test('returns the last in-progress turn id', () => {
    const thread = threadWithTurns([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'inProgress' },
    ])
    expect(activeTurnIdFromThread(thread)).toBe('t2')
  })

  test('returns null when no turn is in progress', () => {
    const thread = threadWithTurns([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'failed' },
    ])
    expect(activeTurnIdFromThread(thread)).toBeNull()
  })
})

describe('expectedActiveTurnIdFromError', () => {
  test('parses the daemon turn-id mismatch message', () => {
    const err = new Error('expected active turn id `old` but found `new`')
    expect(expectedActiveTurnIdFromError(err)).toBe('new')
  })

  test('returns null for an unrelated error', () => {
    expect(expectedActiveTurnIdFromError(new Error('boom'))).toBeNull()
  })
})

describe('nonSteerableTurnKind', () => {
  test('detects the live daemon shape (codex 0.136.0): data.codexErrorInfo + message', () => {
    // Captured from a real `turn/steer` against an in-progress compact turn.
    const err = new CodexRpcError('cannot steer a compact turn', -32600, {
      message: 'cannot steer a compact turn',
      codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } },
      additionalDetails: null,
    })
    expect(nonSteerableTurnKind(err)).toBe('compact')
  })

  test('detects the kind from the message text alone (no structured data)', () => {
    expect(nonSteerableTurnKind(new Error('cannot steer a review turn'))).toBe('review')
  })

  test('accepts activeTurnNotSteerable directly under data too', () => {
    const err = new CodexRpcError('nope', -32000, {
      activeTurnNotSteerable: { turnKind: 'review' },
    })
    expect(nonSteerableTurnKind(err)).toBe('review')
  })

  test('returns null for a steerable-turn error (e.g. turn-id mismatch)', () => {
    const err = new Error('expected active turn id `a` but found `b`')
    expect(nonSteerableTurnKind(err)).toBeNull()
  })
})

// ─── steer over a mock daemon ──────────────────────────────────────────────

interface Harness {
  server: WebSocketServer
  url: string
  serverSocket: Promise<WsServerSocket>
}

async function startHarness(): Promise<Harness> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((res) => server.once('listening', () => res()))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const serverSocket = new Promise<WsServerSocket>((resolve) => {
    server.once('connection', (sock) => resolve(sock))
  })
  return { server, url, serverSocket }
}

let harness: Harness
let client: CodexWsClient | undefined

beforeEach(async () => {
  harness = await startHarness()
  client = undefined
})

afterEach(async () => {
  if (client !== undefined) client.close()
  await new Promise<void>((res) => harness.server.close(() => res()))
})

describe('readActiveTurnId over the wire', () => {
  test('reads the in-progress turn from a thread/read response', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket
    sock.on('message', (data) => {
      const env = JSON.parse(data.toString())
      sock.send(
        JSON.stringify({
          id: env.id,
          result: { thread: { turns: [{ id: 'live-1', status: 'inProgress' }] } },
        }),
      )
    })
    expect(await readActiveTurnId(client, 'thread-x')).toBe('live-1')
  })
})

describe('steerActiveTurn retry', () => {
  test('retries once with the daemon-reported turn id on a mismatch', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket
    const steers: string[] = []
    sock.on('message', (data) => {
      const env = JSON.parse(data.toString())
      if (env.method !== 'turn/steer') return
      steers.push(env.params.expectedTurnId)
      if (steers.length === 1) {
        sock.send(
          JSON.stringify({
            id: env.id,
            error: { message: 'expected active turn id `stale` but found `fresh`' },
          }),
        )
      } else {
        sock.send(JSON.stringify({ id: env.id, result: { turnId: env.params.expectedTurnId } }))
      }
    })

    const resp = await steerActiveTurn(client, {
      threadId: 'thread-x',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
      expectedTurnId: 'stale',
    })
    expect(resp.turnId).toBe('fresh')
    expect(steers).toEqual(['stale', 'fresh'])
  })

  test('rethrows a non-mismatch steer error without retrying', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket
    let calls = 0
    sock.on('message', (data) => {
      const env = JSON.parse(data.toString())
      if (env.method !== 'turn/steer') return
      calls += 1
      sock.send(JSON.stringify({ id: env.id, error: { message: 'daemon exploded' } }))
    })
    await expect(
      steerActiveTurn(client, {
        threadId: 'thread-x',
        input: [{ type: 'text', text: 'hi', text_elements: [] }],
        expectedTurnId: 'a',
      }),
    ).rejects.toThrow('daemon exploded')
    expect(calls).toBe(1)
  })
})

// ─── supersede race ─────────────────────────────────────────────────────────

describe('awaitTurnOrSupersede', () => {
  const name = `cmx-test-supersede-${process.pid}`

  afterEach(() => {
    rmSync(sendTokenFile(name), { force: true })
  })

  function fakeTurn(): CollectedTurn {
    return { completed: { threadId: 'x', turn: {} } as unknown as CollectedTurn['completed'], tokenUsage: null }
  }

  test('resolves with the turn when it completes before any newer send', async () => {
    const myToken = mintSendToken()
    claimSendToken(name, myToken)
    const turn = fakeTurn()
    const result = await awaitTurnOrSupersede(Promise.resolve(turn), name, myToken)
    expect(result).toBe(turn)
  })

  test('resolves with SUPERSEDED once a newer send claims the token', async () => {
    const myToken = mintSendToken()
    claimSendToken(name, myToken)
    // A turn that never settles on its own — only supersession ends the wait.
    const pending = new Promise<CollectedTurn>(() => {})
    const race = awaitTurnOrSupersede(pending, name, myToken)
    // A later send claims a fresh token.
    claimSendToken(name, mintSendToken())
    expect(await race).toBe(SUPERSEDED)
  })
})
