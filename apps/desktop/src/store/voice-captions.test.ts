import { beforeEach, describe, expect, it } from 'vitest'

import {
  $voiceCaptions,
  appendVoiceCaption,
  promoteVoiceCaptionsToTurn,
  retargetVoiceCaptions
} from './voice-captions'

const captions = (target = 'main') =>
  ($voiceCaptions.get()[target]?.captions ?? []).map(({ afterMessageId, speaker, text }) => ({
    afterMessageId,
    speaker,
    text
  }))

describe('voice captions', () => {
  beforeEach(() => $voiceCaptions.set({}))

  it('merges consecutive deltas per speaker and anchors each caption where it began', () => {
    appendVoiceCaption('main', 'user', 'Hey ', 'm1')
    appendVoiceCaption('main', 'user', 'Kyrah', 'm1')
    appendVoiceCaption('main', 'assistant', 'Hi there!', 'm2')

    expect(captions()).toEqual([
      { afterMessageId: 'm1', speaker: 'user', text: 'Hey Kyrah' },
      { afterMessageId: 'm2', speaker: 'assistant', text: 'Hi there!' }
    ])
  })

  it('drops the delegated utterance and the voice paraphrase until the user speaks again', () => {
    appendVoiceCaption('main', 'assistant', 'Hello!', 'm1')
    appendVoiceCaption('main', 'user', 'Plan my week', 'm1')

    promoteVoiceCaptionsToTurn('main')
    appendVoiceCaption('main', 'assistant', 'Let me check.', 'm1')
    appendVoiceCaption('main', 'user', 'Thanks', 'm3')
    appendVoiceCaption('main', 'assistant', 'Anytime.', 'm3')

    expect(captions().map(caption => caption.text)).toEqual(['Hello!', 'Thanks', 'Anytime.'])
  })

  it('keeps captions when a fresh chat gets its id and clears them on a chat switch', () => {
    retargetVoiceCaptions('main', null)
    appendVoiceCaption('main', 'user', 'Hi', null)

    retargetVoiceCaptions('main', 'session-a')
    expect(captions().map(caption => caption.text)).toEqual(['Hi'])

    retargetVoiceCaptions('main', 'session-b')
    expect(captions()).toEqual([])
  })

  it('keeps each surface separate', () => {
    appendVoiceCaption('tile:1', 'user', 'Tile words', null)

    expect(captions('main')).toEqual([])
    expect(captions('tile:1').map(caption => caption.text)).toEqual(['Tile words'])
  })
})
