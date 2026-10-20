// Quick repro test for the screenshot fragmentation
import { describe, it, expect, beforeEach } from 'vitest'

import {
  $voiceCaptions,
  appendVoiceCaption,
  promoteVoiceCaptionsToTurn
} from './voice-captions'

const captions = (target = 'main') =>
  ($voiceCaptions.get()[target]?.captions ?? []).map(({ afterMessageId, speaker, text }) => ({
    afterMessageId,
    speaker,
    text
  }))

describe('voice caption fragmentation repro', () => {
  beforeEach(() => $voiceCaptions.set({}))

  it('reproduces "let me locate it." fragmentation', () => {
    // User: "let me locate it."
    appendVoiceCaption('main', 'user', 'let', 'm1')
    appendVoiceCaption('main', 'user', ' me locate', 'm1')
    appendVoiceCaption('main', 'user', ' it.', 'm1')

    const result = captions()
    console.log('let me locate:', JSON.stringify(result, null, 2))
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('let me locate it.')
  })

  it('reproduces "Mm-hmm." fragmentation', () => {
    appendVoiceCaption('main', 'user', 'Mm-h', 'm1')
    appendVoiceCaption('main', 'user', 'mm.', 'm1')

    const result = captions()
    console.log('Mm-hmm:', JSON.stringify(result, null, 2))
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Mm-hmm.') // Document the actual result
  })

  it('reproduces "Hello With Cloud Code, right" fragmentation on assistant', () => {
    appendVoiceCaption('main', 'assistant', 'Hello', 'm1')
    appendVoiceCaption('main', 'assistant', ' With', 'm1')
    appendVoiceCaption('main', 'assistant', ' Cloud Code, right', 'm1')

    const result = captions()
    console.log('Hello With:', JSON.stringify(result, null, 2))
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Hello With Cloud Code, right')
  })

  it('reproduces "Uh okay, and one eng, more thing..." fragmentation', () => {
    appendVoiceCaption('main', 'assistant', 'Uh okay, and one', 'm1')
    appendVoiceCaption('main', 'assistant', ' eng, more', 'm1')
    appendVoiceCaption('main', 'assistant', ' thing, can you help me uh Tell me where is> exactly', 'm1')

    const result = captions()
    console.log('Uh okay:', JSON.stringify(result, null, 2))
    expect(result).toHaveLength(1)
  })

  it('reproduces ". The Kanban board" fragmentation', () => {
    appendVoiceCaption('main', 'assistant', '. The', 'm1')
    appendVoiceCaption('main', 'assistant', ' Kanban', 'm1')
    appendVoiceCaption('main', 'assistant', ' board', 'm1')

    const result = captions()
    console.log('. The Kanban:', JSON.stringify(result, null, 2))
    expect(result).toHaveLength(1)
  })

  it('reproduces realistic sequence: assistant fills then user speaks then delegation', () => {
    // Voice model says filler (single fragment) before user turns
    appendVoiceCaption('main', 'assistant', 'Mm-hmm.', 'm1')
    // User starts: "let me locate it."
    appendVoiceCaption('main', 'user', 'let', 'm1')
    appendVoiceCaption('main', 'user', ' me locate', 'm1')
    appendVoiceCaption('main', 'user', ' it.', 'm1')
    // Delegation happens - drops user captions and mutes assistant
    promoteVoiceCaptionsToTurn('main')
    // Voice says response (should be muted)
    appendVoiceCaption('main', 'assistant', 'The', 'm2')
    appendVoiceCaption('main', 'assistant', ' Kanban', 'm2')
    appendVoiceCaption('main', 'assistant', ' board', 'm2')

    const result = captions()
    console.log('realistic:', JSON.stringify(result, null, 2))
  })

  it('checks rapid-fire same speaker deltas', () => {
    // Simulate the vendor emitting 3 quick deltas
    appendVoiceCaption('main', 'user', 'l', 'm1')
    appendVoiceCaption('main', 'user', 'e', 'm1')
    appendVoiceCaption('main', 'user', 't', 'm1')

    const result = captions()
    console.log('l,e,t rapid:', JSON.stringify(result, null, 2))
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('let')
  })
})