/**
 * Verify the upgrade-edit path.
 *
 * The new `editText` first tries `im.message.patch` (cards) and on any error
 * falls back to `im.message.update` with `msg_type: 'text'`. This script
 * exercises that fallback by:
 *
 *   1. sending a legacy `msg_type: 'text'` message via the raw SDK — the
 *      shape this channel produced before the upgrade,
 *   2. asking the new transport to edit it. Patch should fail (the target is
 *      not a card), the fallback should run, and the message should end up
 *      with the new text content.
 *
 * Usage:
 *   tsx scripts/verify-legacy-edit.ts <chat_id>
 */

import * as lark from '@larksuiteoapi/node-sdk'

import { createFeishuTransport } from '../src/feishu'
import { envFile, stateDir } from '../src/paths'
import { loadCredentials } from '../src/server'

const chatId: string | undefined = process.argv[2]
if (!chatId) {
  console.error('usage: tsx scripts/verify-legacy-edit.ts <chat_id>')
  process.exit(2)
}
const targetChatId: string = chatId

const credentials = loadCredentials(envFile(stateDir()))
const rawClient = new lark.Client({ appId: credentials.appId, appSecret: credentials.appSecret })

interface MessageView {
  msg_type?: string
  updated?: boolean
  body?: { content?: string }
}

async function readBack(messageId: string): Promise<MessageView | null> {
  const res = await rawClient.request<{ data?: { items?: MessageView[] } }>({
    method: 'GET',
    url: `/open-apis/im/v1/messages/${messageId}`,
  })
  return res.data?.items?.[0] ?? null
}

async function main(): Promise<void> {
  // Step 1: legacy-style send, exactly what `sendText` produced before the
  // markdown-card upgrade.
  const legacyContent = JSON.stringify({ text: 'legacy text body (pre-upgrade reply)' })
  const sent = await rawClient.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: targetChatId, msg_type: 'text', content: legacyContent },
  })
  const messageId = sent.data?.message_id
  if (!messageId) {
    console.error('legacy send did not return a message_id')
    process.exit(1)
  }
  console.log(`legacy text msg sent: ${messageId}`)

  // Step 2: call the new editText. The transport will first try `patch`
  // (which fails because the target is not a card) and then fall back to
  // `update` with `msg_type: 'text'`.
  const transport = createFeishuTransport(credentials, '/tmp/feishu-channel-verify.lock')
  await transport.editText(messageId, 'edited via the new fallback path')
  await transport.close()

  const view = await readBack(messageId)
  console.log('readback after edit →', JSON.stringify(view))

  const body = view?.body?.content ?? ''
  if (!view?.updated) {
    console.error('expected updated=true after editText')
    process.exit(1)
  }
  if (!body.includes('edited via the new fallback path')) {
    console.error('expected the new text to appear in the body content')
    process.exit(1)
  }
  console.log(`verify-legacy-edit OK — message_id=${messageId}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
