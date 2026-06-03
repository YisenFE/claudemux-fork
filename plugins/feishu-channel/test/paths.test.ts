import { describe, expect, test } from 'vitest'
import { join, resolve, sep } from 'node:path'
import {
  accessFile,
  botIdentityFile,
  chatBotsFile,
  daemonInboundQueueFile,
  daemonLockFile,
  daemonSocketFile,
  envFile,
  inboundResourceDir,
  inboundResourcePath,
  lockFile,
  stateDir,
} from '../src/paths'

describe('paths', () => {
  const base = '/tmp/feishu-test-state'

  test('stateDir ends at the channel directory', () => {
    expect(stateDir('/home/u')).toBe('/home/u/.claude/channels/feishu')
  })

  test('builders compose onto an explicit base', () => {
    expect(accessFile(base)).toBe(join(base, 'access.json'))
    expect(envFile(base)).toBe(join(base, '.env'))
    expect(lockFile(base)).toBe(join(base, 'connection.lock'))
    expect(daemonSocketFile(base)).toBe(join(base, 'daemon.sock'))
    expect(daemonLockFile(base)).toBe(join(base, 'daemon.lock'))
    expect(daemonInboundQueueFile(base)).toBe(join(base, 'daemon-inbound-queue.jsonl'))
  })

  test('every state file sits inside the state directory', () => {
    expect(accessFile(base).startsWith(base + '/')).toBe(true)
    expect(envFile(base).startsWith(base + '/')).toBe(true)
    expect(lockFile(base).startsWith(base + '/')).toBe(true)
    expect(daemonSocketFile(base).startsWith(base + '/')).toBe(true)
    expect(daemonLockFile(base).startsWith(base + '/')).toBe(true)
    expect(daemonInboundQueueFile(base).startsWith(base + '/')).toBe(true)
  })

  test('stateDir can be overridden for a spawned daemon process', () => {
    const previous = process.env.FEISHU_CHANNEL_STATE_DIR
    process.env.FEISHU_CHANNEL_STATE_DIR = base
    try {
      expect(stateDir()).toBe(base)
      expect(stateDir('/home/u')).toBe('/home/u/.claude/channels/feishu')
    } finally {
      if (previous === undefined) {
        delete process.env.FEISHU_CHANNEL_STATE_DIR
      } else {
        process.env.FEISHU_CHANNEL_STATE_DIR = previous
      }
    }
  })

  describe('botIdentityFile', () => {
    test('embeds appId in the file name and is keyed per app only', () => {
      expect(botIdentityFile(base, 'cli_app')).toBe(join(base, 'feishu-bot-identity-cli_app.json'))
    })

    test('sits inside the base directory', () => {
      expect(botIdentityFile(base, 'a').startsWith(base + '/')).toBe(true)
    })
  })

  describe('chatBotsFile', () => {
    test('embeds appId and chatId in the file name', () => {
      const p = chatBotsFile(base, 'cli_app', 'oc_chat')
      expect(p).toBe(join(base, 'feishu-chat-bots-cli_app-oc_chat.json'))
    })

    test('sits inside the base directory', () => {
      expect(chatBotsFile(base, 'a', 'b').startsWith(base + '/')).toBe(true)
    })
  })

  describe('inboundResourcePath — path traversal is neutralized', () => {
    const root = resolve(inboundResourceDir())

    /** The path's component after the cache root — must be a single flat name. */
    function leaf(path: string): string {
      expect(path.startsWith(root + sep)).toBe(true)
      return path.slice(root.length + 1)
    }

    test('a normal id/key/ext builds the expected flat path', () => {
      expect(inboundResourcePath('om_x', 'img_v2_abc', '.png')).toBe(
        `${root}${sep}om_x-img_v2_abc.png`,
      )
    })

    test('separators in the file key cannot escape the cache dir', () => {
      const p = inboundResourcePath('om_x', 'a/../../../etc/passwd', '.png')
      // The leaf is a single filename — no separators survived, so the resolved
      // path is a direct child of the cache dir and cannot traverse out of it.
      expect(leaf(p).includes(sep)).toBe(false)
      expect(p).not.toContain(`${sep}etc${sep}`)
    })

    test('a malicious extension cannot inject a separator', () => {
      const p = inboundResourcePath('om_x', 'k', '.pn/g')
      expect(leaf(p)).toBe('om_x-k.pn_g')
    })

    test('a message id with separators is sanitized to a flat leaf', () => {
      const p = inboundResourcePath('../../om', 'k', '')
      expect(leaf(p).includes(sep)).toBe(false)
    })
  })
})
