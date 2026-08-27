/**
 * Classifying Bot API failures by what they mean for the next attempt.
 *
 * Most send errors are worth retrying. Two are not, and telling them apart is
 * the difference between a bridge that recovers and one that hammers Telegram
 * for hours writing the same line to a log nobody is reading.
 */

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The user blocked the bot, deleted the chat, or was deactivated. Every send to
 * that chat will fail identically until they message it again, so the only
 * useful response is to stop.
 */
export function isBlocked(err: unknown): boolean {
  return /\b403\b|bot was blocked by the user|user is deactivated|bot can't initiate conversation|chat not found/i
    .test(text(err))
}

/**
 * The topic is gone — the user deleted the thread. The record has to be dropped
 * so the next message opens a fresh one instead of failing on a dead id forever.
 */
export function isMissingTopic(err: unknown): boolean {
  return /TOPIC_(DELETED|ID_INVALID)|message thread not found|TOPIC_CLOSED/i.test(text(err))
}
