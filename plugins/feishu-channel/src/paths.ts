/**
 * Path builders for the channel's on-disk state.
 *
 * Every path under the state directory is constructed by a named builder
 * here, never by string concatenation at the use site — the layout is the
 * coupling layer between the channel server and the access skill, so a schema
 * change stays a single-file edit.
 *
 * Each builder accepts an explicit base directory so tests can point the
 * whole tree at a temporary directory.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root of all channel state: ~/.claude/channels/feishu */
export function stateDir(home?: string): string {
  if (home === undefined && process.env.FEISHU_CHANNEL_STATE_DIR) {
    return process.env.FEISHU_CHANNEL_STATE_DIR
  }
  return join(home ?? homedir(), '.claude', 'channels', 'feishu')
}

/** access.json — the access-control policy, managed by the access skill. */
export function accessFile(base: string = stateDir()): string {
  return join(base, 'access.json')
}

/** .env — Feishu app credentials (FEISHU_APP_ID / FEISHU_APP_SECRET). */
export function envFile(base: string = stateDir()): string {
  return join(base, '.env')
}

/** connection.lock — the single-instance lock for the inbound WebSocket. */
export function lockFile(base: string = stateDir()): string {
  return join(base, 'connection.lock')
}

/** daemon.sock — local IPC socket for the standing Feishu daemon. */
export function daemonSocketFile(base: string = stateDir()): string {
  return join(base, 'daemon.sock')
}

/** daemon.lock — single-instance lock for the standing Feishu daemon. */
export function daemonLockFile(base: string = stateDir()): string {
  return join(base, 'daemon.lock')
}

export function daemonInboundQueueFile(base: string = stateDir()): string {
  return join(base, 'daemon-inbound-queue.jsonl')
}

/**
 * feishu-bot-identity-{appId}.json — the app-wide `open_id → name` map for
 * peer bots. Keyed by the observing app only: a Feishu open_id is stable for a
 * given bot across every chat this app shares with it, so identity is reused
 * channel-wide rather than duplicated per chat.
 */
export function botIdentityFile(base: string, appId: string): string {
  return join(base, `feishu-bot-identity-${appId}.json`)
}

/**
 * feishu-chat-bots-{appId}-{chatId}.json — which bots are in one chat and how
 * far the one-shot discovery injection has progressed for it. Per (appId,
 * chatId) so membership cannot leak between chats or apps.
 */
export function chatBotsFile(base: string, appId: string, chatId: string): string {
  return join(base, `feishu-chat-bots-${appId}-${chatId}.json`)
}

/**
 * /tmp/feishu-inbound — the local cache for downloaded inbound message
 * resources (top-level images and files). Fixed under /tmp, deliberately
 * outside the channel state directory, so the OS reclaims it on its own (macOS
 * clears untouched /tmp entries after a few days; Linux per its tmpfiles
 * policy) and the channel writes no cleanup: a notification is asynchronous, so
 * a downloaded file must outlive the gap between delivery and the model's Read.
 * The absolute path is embedded verbatim in the delivered body for Read to open.
 */
export function inboundResourceDir(): string {
  return join('/tmp', 'feishu-inbound')
}

/**
 * Absolute on-disk path for one downloaded resource:
 * `<inboundResourceDir>/<messageId>-<fileKey><ext>`. `messageId` (`om_...`) is
 * unique per message and `fileKey` (`img_v2_...` / `file_v2_...`) per resource,
 * and both contain only filename-safe characters, so the pair never collides.
 * `ext` carries its own leading dot (or is empty when no extension is known).
 */
export function inboundResourcePath(messageId: string, fileKey: string, ext: string): string {
  return join(inboundResourceDir(), `${messageId}-${fileKey}${ext}`)
}
