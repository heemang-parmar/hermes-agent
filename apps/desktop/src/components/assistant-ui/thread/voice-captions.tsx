import { useStore } from '@nanostores/react'
import type { FC } from 'react'

import { useComposerScope } from '@/app/chat/composer/scope'
import { $voiceCaptions, type VoiceCaption } from '@/store/voice-captions'

const USER_CAPTION_CLASS =
  'self-end max-w-[min(86%,44rem)] whitespace-pre-wrap wrap-anywhere rounded-xl border bg-(--dt-user-bubble) px-3 py-2 text-left'

const ASSISTANT_CAPTION_CLASS = 'self-start max-w-full whitespace-pre-wrap wrap-anywhere'

function useSurfaceCaptions(): VoiceCaption[] {
  const { target } = useComposerScope()

  return useStore($voiceCaptions, { keys: [target] })[target]?.captions ?? []
}

const CaptionList: FC<{ captions: VoiceCaption[] }> = ({ captions }) =>
  captions.length === 0 ? null : (
    <div className="flex min-w-0 flex-col gap-(--conversation-turn-gap) pb-(--conversation-turn-gap)" data-slot="voice-captions">
      {captions.map(caption => (
        <div
          className={caption.speaker === 'user' ? USER_CAPTION_CLASS : ASSISTANT_CAPTION_CLASS}
          data-speaker={caption.speaker}
          key={caption.id}
        >
          {caption.text}
        </div>
      ))}
    </div>
  )

/** Captions spoken while one of this group's messages was the newest. */
export const VoiceCaptionsAfter: FC<{ anchorIds: readonly string[] }> = ({ anchorIds }) => {
  const captions = useSurfaceCaptions().filter(
    caption => caption.afterMessageId !== null && anchorIds.includes(caption.afterMessageId)
  )

  return <CaptionList captions={captions} />
}

/** Captions whose anchor isn't on screen (a chat with no messages yet, or an
 *  anchor that hydration replaced), shown at the end of the thread. */
export const VoiceCaptionsTail: FC<{ anchorIds: ReadonlySet<string> }> = ({ anchorIds }) => {
  const captions = useSurfaceCaptions().filter(
    caption => caption.afterMessageId === null || !anchorIds.has(caption.afterMessageId)
  )

  return <CaptionList captions={captions} />
}
