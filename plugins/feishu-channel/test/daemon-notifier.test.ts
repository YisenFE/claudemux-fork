import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import { createDurableNotifier } from '../src/daemon'
import { openInboundQueue, type InboundQueue, type InboundQueueRow } from '../src/daemon-queue'

let n = 0
const tmp = () => join(tmpdir(), `feishu-daemon-notifier-${process.pid}-${n++}.jsonl`)

/** A queue whose enqueue fails — stands in for a full disk / unwritable state dir. */
function failingQueue(): InboundQueue {
  return {
    enqueue() {
      throw new Error('disk full')
    },
    markDelivered() {},
    pending: () => [],
    all: () => [],
  }
}

/** A doc-comment routing meta, exactly as the doc-comment handler builds it. */
function docCommentMeta(over: Record<string, string> = {}): Record<string, string> {
  return {
    kind: 'doc_comment',
    notice_type: 'add_comment',
    file_token: 'docABC',
    file_type: 'docx',
    comment_id: 'cmt_1',
    commenter_id: 'ou_x',
    mentioned_bot: 'false',
    ...over,
  }
}

describe('createDurableNotifier — the durability boundary', () => {
  // The durable write is the boundary the Feishu ACK is allowed past. If it
  // fails, the failure MUST propagate so the caller can let the Feishu SDK
  // reject — the event is then redelivered rather than lost.
  test('a persistence (enqueue) failure propagates to the caller', () => {
    const notify = createDurableNotifier({
      queue: failingQueue(),
      generation: 1,
      now: () => 100,
      route: () => true,
    })

    expect(() => notify('hi', { event_id: 'evt_1' })).toThrow('disk full')
  })

  // The row is already durable before delivery is attempted, so a proxy
  // delivery failure must NOT look like a persistence failure: it is logged
  // and the row is left for replay. Propagating it would make Feishu redeliver
  // an event that is already safely persisted.
  test('a delivery (route) failure does not propagate — the row stays persisted', () => {
    const path = tmp()
    const queue = openInboundQueue(path)
    const notify = createDurableNotifier({
      queue,
      generation: 1,
      now: () => 100,
      route: () => {
        throw new Error('socket write failed')
      },
    })

    expect(() => notify('hi', { event_id: 'evt_1' })).not.toThrow()
    // Persisted and still pending — a later proxy registration replays it.
    expect(queue.pending().map((r) => r.eventId)).toEqual(['evt_1'])
  })

  // P1-3 end to end: two distinct doc-comments share none of the
  // event_id/uuid/message_id keys, so before the fix both keyed on the literal
  // `evt_` and the second was deduped out of the queue — a silently lost
  // comment. With per-comment keys, both persist and both replay.
  test('two distinct doc-comments both persist and both replay (no false dedup)', () => {
    const path = tmp()
    const queue = openInboundQueue(path)
    const routed: string[] = []
    const notify = createDurableNotifier({
      queue,
      generation: 1,
      now: () => 100,
      route: (content) => {
        routed.push(content)
        return true
      },
    })

    notify('comment on doc A', docCommentMeta({ file_token: 'docA', comment_id: 'cmt_1' }))
    notify('comment on doc B', docCommentMeta({ file_token: 'docB', comment_id: 'cmt_1' }))
    notify('a reply in doc A', docCommentMeta({ file_token: 'docA', comment_id: 'cmt_1', reply_id: 'rpl_9' }))

    const persisted: InboundQueueRow[] = queue.all()
    expect(persisted.map((r) => r.eventId).sort()).toEqual([
      'doc_comment:docA:cmt_1:root',
      'doc_comment:docA:cmt_1:rpl_9',
      'doc_comment:docB:cmt_1:root',
    ])
    expect(routed).toHaveLength(3)

    // Offline-replay simulation: a fresh reader of the same on-disk queue (e.g.
    // a restarted daemon) still sees all three as pending, unconfused by the
    // old shared `evt_` key.
    const replayed = openInboundQueue(path).pending()
    expect(replayed).toHaveLength(3)
  })

  // The same comment-add delivered twice (a Feishu retry, or handoff's two WS
  // clients) keys identically, so the duplicate is deduped out.
  test('a re-delivered doc-comment is deduped, not duplicated', () => {
    const path = tmp()
    const queue = openInboundQueue(path)
    const route = vi.fn(() => true)
    const notify = createDurableNotifier({ queue, generation: 1, now: () => 100, route })

    notify('same comment', docCommentMeta())
    notify('same comment', docCommentMeta())

    expect(queue.all()).toHaveLength(1)
  })
})
