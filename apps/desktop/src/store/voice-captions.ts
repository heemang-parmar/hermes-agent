import { map } from 'nanostores'

/**
 * Live captions of a GPT-Live conversation, per composer surface ('main' |
 * 'tile:<id>'). The voice model answers small talk itself, so those exchanges
 * never become session messages; captions show them in the thread while the
 * chat is open. Display-only: never persisted, never part of $messages (the
 * spoken-reply collector reads $messages and must not hear its own captions).
 */
export interface VoiceCaption {
  /** The thread message that was last when this caption began; the caption
   *  renders right after it. null = the chat had no messages yet. */
  afterMessageId: null | string
  id: string
  speaker: 'assistant' | 'user'
  text: string
}

interface SurfaceCaptions {
  captions: VoiceCaption[]
  /** Set by a delegation: the voice's "checking" filler and its paraphrase of
   *  the delegated reply duplicate the real reply bubble, so assistant captions
   *  are dropped until the user speaks again. */
  muteAssistant: boolean
  sessionId: string
}

export const $voiceCaptions = map<Record<string, SurfaceCaptions>>({})

let nextId = 0

const surfaceOf = (target: string): SurfaceCaptions =>
  $voiceCaptions.get()[target] ?? { captions: [], muteAssistant: false, sessionId: '' }

export function appendVoiceCaption(
  target: string,
  speaker: VoiceCaption['speaker'],
  delta: string,
  afterMessageId: null | string
): void {
  const surface = surfaceOf(target)

  if (speaker === 'assistant' && surface.muteAssistant) {
    return
  }

  const last = surface.captions.at(-1)

  const captions =
    last?.speaker === speaker
      ? [...surface.captions.slice(0, -1), { ...last, text: last.text + delta }]
      : delta.trim()
        ? [...surface.captions, { afterMessageId, id: `voice-caption-${++nextId}`, speaker, text: delta.trimStart() }]
        : surface.captions

  $voiceCaptions.setKey(target, {
    ...surface,
    captions,
    muteAssistant: speaker === 'user' ? false : surface.muteAssistant
  })
}

/** A delegation turns the user's latest words into a real message bubble:
 *  drop their caption so it isn't shown twice, and mute the voice's reply. */
export function promoteVoiceCaptionsToTurn(target: string): void {
  const surface = surfaceOf(target)
  const captions = [...surface.captions]

  while (captions.at(-1)?.speaker === 'user') {
    captions.pop()
  }

  $voiceCaptions.setKey(target, { ...surface, captions, muteAssistant: true })
}

export function clearVoiceCaptions(target: string): void {
  const surface = $voiceCaptions.get()[target]

  if (surface) {
    $voiceCaptions.setKey(target, { ...surface, captions: [], muteAssistant: false })
  }
}

/** Captions belong to the chat they were spoken in: a fresh chat getting its
 *  first id keeps them, switching to another chat clears them. */
export function retargetVoiceCaptions(target: string, sessionId: null | string | undefined): void {
  const surface = surfaceOf(target)
  const next = sessionId ?? ''

  if (surface.sessionId === next) {
    return
  }

  const adopt = surface.sessionId === '' && next !== ''

  $voiceCaptions.setKey(target, {
    captions: adopt ? surface.captions : [],
    muteAssistant: adopt && surface.muteAssistant,
    sessionId: next
  })
}
