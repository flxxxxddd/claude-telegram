import { describe, expect, test } from 'bun:test'
import { isBlocked, isMissingTopic } from './errors.ts'

describe('isBlocked', () => {
  test('recognises the states that never recover on their own', () => {
    // Observed verbatim from the Bot API: every send to that chat fails
    // identically until the user messages the bot again.
    expect(isBlocked(new Error('[sendRichMessage] 403: Forbidden: bot was blocked by the user'))).toBe(true)
    expect(isBlocked(new Error('403: Forbidden: user is deactivated'))).toBe(true)
    expect(isBlocked(new Error('400: Bad Request: chat not found'))).toBe(true)
  })

  test('leaves retryable failures alone', () => {
    // Pausing delivery on a rate limit or a network blip would turn a hiccup
    // into an outage lasting until the user happens to send something.
    expect(isBlocked(new Error('429: Too Many Requests: retry after 3'))).toBe(false)
    expect(isBlocked(new Error('ETIMEDOUT'))).toBe(false)
    expect(isBlocked(new Error('400: Bad Request: message is not modified'))).toBe(false)
  })
})

describe('isMissingTopic', () => {
  test('recognises a thread the user deleted', () => {
    expect(isMissingTopic(new Error('400: Bad Request: TOPIC_DELETED'))).toBe(true)
    expect(isMissingTopic(new Error('400: Bad Request: message thread not found'))).toBe(true)
  })

  test('does not confuse it with a blocked chat', () => {
    expect(isMissingTopic(new Error('403: Forbidden: bot was blocked by the user'))).toBe(false)
  })
})
