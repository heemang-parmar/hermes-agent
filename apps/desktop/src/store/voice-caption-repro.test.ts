// Pre-reconciliation original of this repro: ./__archive__/voice-caption-repro.original.ts.txt
import { beforeEach, describe, expect, it } from 'vitest'

import { $voiceCaptions, appendVoiceCaption, promoteVoiceCaptionsToTurn } from './voice-captions'

const captions = (target = 'main') =>
  ($voiceCaptions.get()[target]?.captions ?? []).map(({ afterMessageId, speaker, text }) => ({
    afterMessageId,
    speaker,
    text
  }))

describe('voice caption fragmentation repro', () => {
  beforeEach(() => $voiceCaptions.set({}))

  it('reproduces "let me locate it." fragmentation', () => {
    appendVoiceCaption('main', 'user', 'let', 'm1')
    appendVoiceCaption('main', 'user', ' me locate', 'm1')
    appendVoiceCaption('main', 'user', ' it.', 'm1')

    expect(captions()).toEqual([{ afterMessageId: 'm1', speaker: 'user', text: 'let me locate it.' }])
  })

  it('reproduces "Mm-hmm." fragmentation', () => {
    appendVoiceCaption('main', 'user', 'Mm-h', 'm1')
    appendVoiceCaption('main', 'user', 'mm.', 'm1')

    expect(captions()).toEqual([{ afterMessageId: 'm1', speaker: 'user', text: 'Mm-hmm.' }])
  })

  it('reproduces "Hello With Cloud Code, right" fragmentation on assistant', () => {
    appendVoiceCaption('main', 'assistant', 'Hello', 'm1')
    appendVoiceCaption('main', 'assistant', ' With', 'm1')
    appendVoiceCaption('main', 'assistant', ' Cloud Code, right', 'm1')

    expect(captions()).toEqual([{ afterMessageId: 'm1', speaker: 'assistant', text: 'Hello With Cloud Code, right' }])
  })

  it('reproduces "Uh okay, and one eng, more thing..." fragmentation', () => {
    appendVoiceCaption('main', 'assistant', 'Uh okay, and one', 'm1')
    appendVoiceCaption('main', 'assistant', ' eng, more', 'm1')
    appendVoiceCaption('main', 'assistant', ' thing, can you help me uh Tell me where is> exactly', 'm1')

    expect(captions()).toEqual([
      {
        afterMessageId: 'm1',
        speaker: 'assistant',
        text: 'Uh okay, and one eng, more thing, can you help me uh Tell me where is> exactly'
      }
    ])
  })

  it('reproduces ". The Kanban board" fragmentation', () => {
    appendVoiceCaption('main', 'assistant', '. The', 'm1')
    appendVoiceCaption('main', 'assistant', ' Kanban', 'm1')
    appendVoiceCaption('main', 'assistant', ' board', 'm1')

    expect(captions()).toEqual([{ afterMessageId: 'm1', speaker: 'assistant', text: '. The Kanban board' }])
  })

  it('reproduces realistic sequence: assistant fills then user speaks then delegation', () => {
    appendVoiceCaption('main', 'assistant', 'Mm-hmm.', 'm1')
    appendVoiceCaption('main', 'user', 'let', 'm1')
    appendVoiceCaption('main', 'user', ' me locate', 'm1')
    appendVoiceCaption('main', 'user', ' it.', 'm1')

    expect(captions()).toEqual([
      { afterMessageId: 'm1', speaker: 'assistant', text: 'Mm-hmm.' },
      { afterMessageId: 'm1', speaker: 'user', text: 'let me locate it.' }
    ])

    // The delegation turns the user's words into a real bubble, so their caption goes.
    promoteVoiceCaptionsToTurn('main')

    const afterDelegation = [{ afterMessageId: 'm1', speaker: 'assistant', text: 'Mm-hmm.' }]

    expect(captions()).toEqual(afterDelegation)

    // The voice's reply is muted: unmuted, it would merge into the trailing
    // assistant caption as 'Mm-hmm.The Kanban board'.
    appendVoiceCaption('main', 'assistant', 'The', 'm2')
    appendVoiceCaption('main', 'assistant', ' Kanban', 'm2')
    appendVoiceCaption('main', 'assistant', ' board', 'm2')

    expect(captions()).toEqual(afterDelegation)
  })

  it('checks rapid-fire same speaker deltas', () => {
    appendVoiceCaption('main', 'user', 'l', 'm1')
    appendVoiceCaption('main', 'user', 'e', 'm1')
    appendVoiceCaption('main', 'user', 't', 'm1')

    expect(captions()).toEqual([{ afterMessageId: 'm1', speaker: 'user', text: 'let' }])
  })

  it('keeps the anchor of the first delta when a same-speaker delta arrives after a new message', () => {
    appendVoiceCaption('main', 'user', 'let me', 'm1')
    appendVoiceCaption('main', 'user', ' locate it.', 'm2')

    expect(captions()).toEqual([{ afterMessageId: 'm1', speaker: 'user', text: 'let me locate it.' }])
  })

  it('starts a new caption, anchored at its own message, on a speaker switch', () => {
    appendVoiceCaption('main', 'user', 'let me locate it.', 'm1')
    appendVoiceCaption('main', 'assistant', 'Mm-hmm.', 'm2')
    appendVoiceCaption('main', 'user', 'The Kanban board', 'm2')

    expect(captions()).toEqual([
      { afterMessageId: 'm1', speaker: 'user', text: 'let me locate it.' },
      { afterMessageId: 'm2', speaker: 'assistant', text: 'Mm-hmm.' },
      { afterMessageId: 'm2', speaker: 'user', text: 'The Kanban board' }
    ])
  })

  it('creates nothing for a whitespace-only first delta and trims the leading space of a new caption', () => {
    appendVoiceCaption('main', 'user', '  ', 'm1')

    expect(captions()).toEqual([])

    appendVoiceCaption('main', 'user', ' let', 'm2')

    expect(captions()).toEqual([{ afterMessageId: 'm2', speaker: 'user', text: 'let' }])
  })

  it('keeps a whitespace-only delta verbatim once the caption exists', () => {
    appendVoiceCaption('main', 'user', 'let', 'm1')
    appendVoiceCaption('main', 'user', ' ', 'm1')
    appendVoiceCaption('main', 'user', 'me', 'm1')

    expect(captions()).toEqual([{ afterMessageId: 'm1', speaker: 'user', text: 'let me' }])
  })
})
