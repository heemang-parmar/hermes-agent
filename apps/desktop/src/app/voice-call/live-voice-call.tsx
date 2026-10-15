import { atom } from 'nanostores'
import { type FC, useEffect, useMemo, useRef } from 'react'

import { type ComposerScope, ComposerScopeProvider, MAIN_COMPOSER_SCOPE } from '@/app/chat/composer/scope'
import type { ChatMessage } from '@/lib/chat-messages'

import type { ConversationStatus } from '../chat/composer/hooks/use-voice-conversation'
import { useVoiceLiveConversation } from '../chat/composer/hooks/use-voice-live-conversation'

export interface LiveVoiceCallReply {
  id: string
  pending: boolean
  text: string
}

export interface LiveVoiceCallProps {
  /** Whose GPT-Live voice, persona and key run the call (a Bot's own profile). */
  owner: { connectionId?: null | string; profile: string }
  /** Caption surface key in `$voiceCaptions` (both sides' transcript). */
  captionTarget: string
  /** The delegated turn is running on the backend. */
  busy: boolean
  /** Send a delegated request: the user's words and the recent spoken exchange. */
  submit: (text: string, voiceContext: string) => Promise<void>
  /** The delegated turn's reply so far, or null when there is nothing to speak. */
  reply: () => LiveVoiceCallReply | null
  consumeReply: () => void
  activeTool?: () => null | string
  interrupt?: () => Promise<void> | void
  /** The call ended on its own (stop word, vendor close, start failure). */
  onEnded: () => void
  onStatus?: (status: ConversationStatus, level: number) => void
}

/**
 * A GPT-Live conversation with no chat view: the same engine the composer runs
 * (`useVoiceLiveConversation`), with the delegation and reply wiring supplied by
 * the caller. Mount it to start the call; unmount it to hang up.
 */
export const LiveVoiceCall: FC<LiveVoiceCallProps> = props => {
  const { captionTarget, owner } = props

  const scope = useMemo<ComposerScope>(
    () => ({
      ...MAIN_COMPOSER_SCOPE,
      $awaitingInput: atom(false),
      $messages: atom<ChatMessage[]>([]),
      connectionId: owner.connectionId ?? null,
      profile: owner.profile,
      target: captionTarget
    }),
    [captionTarget, owner.connectionId, owner.profile]
  )

  return (
    <ComposerScopeProvider value={scope}>
      <LiveVoiceCallEngine {...props} />
    </ComposerScopeProvider>
  )
}

const LiveVoiceCallEngine: FC<LiveVoiceCallProps> = ({
  activeTool,
  busy,
  consumeReply,
  interrupt,
  onEnded,
  onStatus,
  reply,
  submit
}) => {
  const conversation = useVoiceLiveConversation({
    activeToolLabel: activeTool,
    busy,
    consumePendingResponse: consumeReply,
    enabled: true,
    onFatalError: onEnded,
    onInterrupt: interrupt,
    onStopWord: onEnded,
    onSubmit: submit,
    pendingResponse: reply,
    seedHistory: () => []
  })

  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  useEffect(() => {
    onStatusRef.current?.(conversation.status, conversation.level)
  }, [conversation.level, conversation.status])

  return null
}
