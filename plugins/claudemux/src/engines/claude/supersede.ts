/**
 * Claude-side surface for the send auto-supersede protocol. The mechanism is
 * engine-agnostic and lives in `../shared/send-token`; this module re-exports
 * it so the Claude engine and its tests keep a stable `./supersede` import
 * while the Codex engine shares the same single source of truth.
 */

export {
  claimSendToken,
  isSuperseded,
  mintSendToken,
  readSendToken,
  supersedeNote,
} from '../shared/send-token'
