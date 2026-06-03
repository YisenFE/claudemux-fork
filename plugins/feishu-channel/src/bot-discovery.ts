/**
 * The bot-discovery logic that sits between the message handler and the two
 * stores (`./identity-store`, `./chat-bots-store`).
 *
 * Two responsibilities:
 *  - `observeBotSender` — passive auto-observe. Any bot message (even one not
 *    addressed to us) teaches us that bot's open_id, so the model can later
 *    @-mention it. Recording is discovery only: it never authorizes the gate.
 *  - `buildDiscoveryContext` — assemble the one-shot context to prepend to a
 *    delivered message (sender line + first-join baseline + incremental delta),
 *    plus a `commit` callback that persists "already injected" state. The
 *    handler calls `commit` only after the session notification succeeds, so a
 *    failed delivery never silently consumes a one-shot injection.
 */

import { isBotSenderType } from './access'
import { getBotIdentity, recordBotIdentity } from './identity-store'
import {
  clearPendingNewBots,
  commitBaselineInjected,
  enqueuePendingNewBot,
  readChatBots,
  recordChatMember,
} from './chat-bots-store'

/** Inputs describing the sender of the current inbound event. */
export interface DiscoveryInput {
  /** open_id of the bot itself, so it is never listed as its own peer. */
  botOpenId?: string
  /** Feishu sender_type — `user` for a human, `bot`/`app` for a bot. */
  senderType?: string
  /** open_id of the sender. */
  senderOpenId: string
  /** Display name of the sender, when known from the event. */
  senderName?: string
  /** Injected clock (epoch millis). */
  now: number
}

/**
 * Passively record a bot sender. No-op for a human sender, a missing open_id,
 * or the bot itself. The first time an open_id is seen in this chat it is
 * queued as a pending new bot for the next incremental injection; a repeat
 * sighting only refreshes its identity `lastSeenAt`.
 */
export function observeBotSender(
  baseDir: string,
  appId: string,
  chatId: string,
  input: DiscoveryInput,
): void {
  if (!isBotSenderType(input.senderType)) return
  if (!input.senderOpenId) return
  if (input.botOpenId !== undefined && input.senderOpenId === input.botOpenId) return

  recordBotIdentity(
    baseDir,
    appId,
    chatId,
    [{ openId: input.senderOpenId, name: input.senderName || input.senderOpenId }],
    'observed',
    input.now,
  )
  const { wasNew } = recordChatMember(baseDir, appId, chatId, input.senderOpenId)
  if (wasNew) enqueuePendingNewBot(baseDir, appId, chatId, input.senderOpenId)
}

/** The prepended context and the callback that commits its one-shot state. */
export interface DiscoveryContext {
  /** Text to prepend to the delivered message; `''` when there is nothing to add. */
  prefix: string
  /** Persist injected state. Call ONLY after the delivery notification succeeds. */
  commit: () => void
}

/** Render one bot as ``**Name** (`open_id`)``, or just `` `open_id` `` when unnamed. */
function botRef(baseDir: string, appId: string, openId: string): string {
  const name = getBotIdentity(baseDir, appId, openId)?.name
  return name && name !== openId ? `**${name}** (\`${openId}\`)` : `\`${openId}\``
}

/**
 * Assemble the discovery context for a message about to be delivered. Combines,
 * in order: a sender line (when the sender is a peer bot), then either the
 * first-join baseline (when one is pending and not yet injected) or an
 * incremental delta of pending new bots. The returned `commit` persists exactly
 * what was shown — stamping the baseline and/or clearing the shown pending —
 * and must run only after the delivery succeeds.
 */
export function buildDiscoveryContext(
  baseDir: string,
  appId: string,
  chatId: string,
  input: DiscoveryInput,
): DiscoveryContext {
  const blocks: string[] = []
  const commits: Array<() => void> = []

  // Sender line — names the peer bot that sent this message.
  if (
    isBotSenderType(input.senderType) &&
    input.senderOpenId &&
    input.senderOpenId !== input.botOpenId
  ) {
    const name = getBotIdentity(baseDir, appId, input.senderOpenId)?.name ?? input.senderName
    const ref =
      name && name !== input.senderOpenId
        ? `**${name}** (\`${input.senderOpenId}\`)`
        : `\`${input.senderOpenId}\``
    blocks.push(`> From bot ${ref}.`)
  }

  const state = readChatBots(baseDir, appId, chatId)
  const isPeer = (id: string): boolean => id !== input.botOpenId
  const showBaseline = state.needsBaselineOnNextMention && state.baselineInjectedAt === null

  if (showBaseline) {
    const peers = state.openIds.filter(isPeer)
    if (peers.length > 0) {
      blocks.push(
        `> Bots in this group (${peers.length}): ` +
          peers.map((id) => botRef(baseDir, appId, id)).join(', ') +
          '.\n> To @-mention one, pass its open_id to `reply`; run ' +
          '`feishu_list_chat_bots` to re-list after compaction.',
      )
    } else {
      blocks.push(
        "> No other bots known in this group yet; they'll be added once they post or are introduced.",
      )
    }
    const pendingSnapshot = [...state.pendingNewBots]
    commits.push(() => {
      commitBaselineInjected(baseDir, appId, chatId, input.now)
      // The baseline already lists every known peer, so anything queued is
      // covered — clear it rather than re-announce it as a delta next time.
      if (pendingSnapshot.length > 0) clearPendingNewBots(baseDir, appId, chatId, pendingSnapshot)
    })
  } else {
    const pending = state.pendingNewBots.filter(isPeer)
    if (pending.length > 0) {
      blocks.push(
        `> New bot${pending.length > 1 ? 's' : ''} in this group: ` +
          pending.map((id) => botRef(baseDir, appId, id)).join(', ') +
          '.',
      )
      commits.push(() => clearPendingNewBots(baseDir, appId, chatId, pending))
    }
  }

  // Join the blocks with single newlines so the sender line and the baseline /
  // delta form one contiguous blockquote, then a blank line before the user's
  // own text — physically separating the system context from what they said.
  return {
    prefix: blocks.length > 0 ? blocks.join('\n') + '\n\n' : '',
    commit: () => {
      for (const fn of commits) fn()
    },
  }
}
