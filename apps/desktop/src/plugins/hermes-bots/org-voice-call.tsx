/**
 * Talk to a bot from the org chart without opening its chat: a GPT-Live call
 * (the SDK's LiveVoiceCall) on the bot's own profile, whose delegated requests
 * run as turns in the bot's existing Bot Chat. Opening the chat later shows
 * every delegated turn; small talk lives only in the call's captions.
 *
 * One call at a time. The call is mounted in a title bar slot (a permanent
 * mount point), so it keeps going while the user moves between tabs.
 */

import {
  $voiceCaptions,
  atom,
  Button,
  clearVoiceCaptions,
  cn,
  Codicon,
  host,
  LiveVoiceCall,
  type LiveVoiceCallReply,
  Tip,
  useValue
} from '@hermes/plugin-sdk'
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { findBotChatId } from './canonical-chat'
import { $botMeta, botRosterKey } from './data'
import { useBots } from './i18n'
import { displayName } from './labels'
import { openRosterBot } from './roster-actions'
import { botConnectionRoute, botRosterMeta, requestForBot } from './routing'
import type { RosterRow } from './types'

type CallStatus = 'connecting' | 'listening' | 'speaking' | 'thinking'

interface ActiveCall {
  bot: RosterRow
  key: string
}

export const $orgVoiceCall = atom<ActiveCall | null>(null)
export const $orgVoiceStatus = atom<CallStatus>('connecting')

const captionTarget = (key: string) => `org-call:${key}`

/** Mic toggle: start a call with this bot, or end it if it's the one on the line. */
export function toggleOrgVoiceCall(bot: RosterRow): void {
  const key = botRosterKey(bot)
  const current = $orgVoiceCall.get()

  if (current) {
    clearVoiceCaptions(captionTarget(current.key))
  }

  $orgVoiceStatus.set('connecting')
  $orgVoiceCall.set(current?.key === key ? null : { bot, key })
}

export function endOrgVoiceCall(): void {
  const current = $orgVoiceCall.get()

  if (current) {
    clearVoiceCaptions(captionTarget(current.key))
  }

  $orgVoiceCall.set(null)
}

function isSessionGone(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error)

  return message.includes('not in memory') || /session not found/i.test(message)
}

interface ResumeResult {
  session_id?: string
}

/** Mounts the active call (if any). Keyed by bot so switching bots hangs up first. */
export function OrgVoiceCallHost() {
  const call = useValue($orgVoiceCall)

  return call ? <BotCall bot={call.bot} key={call.key} /> : null
}

function BotCall({ bot }: { bot: RosterRow }) {
  const b = useBots()
  const name = displayName(bot, botRosterMeta(bot, $botMeta.get()))
  const route = useMemo(() => botConnectionRoute(bot), [bot])
  const [busy, setBusy] = useState(false)
  const storedRef = useRef<null | string>(null)
  const runtimeRef = useRef<null | string>(null)
  const replyRef = useRef<LiveVoiceCallReply | null>(null)
  const consumedRef = useRef<null | string>(null)
  const toolRef = useRef<null | string>(null)
  const replyCounter = useRef(0)
  const readyRef = useRef<Promise<null | string> | null>(null)

  const resume = useCallback(async (stored: string): Promise<null | string> => {
    const res = await requestForBot<ResumeResult>(
      bot,
      'session.resume',
      { omit_messages: true, profile: bot.name, session_id: stored },
      { spawnPriority: 'foreground' }
    )

    runtimeRef.current = res?.session_id ?? null

    return runtimeRef.current
  }, [bot])

  // Find the bot's chat and mint a runtime id for it; hold the bot's socket for
  // the whole call so the runtime isn't reaped between requests.
  // eslint-disable-next-line no-restricted-syntax -- call-coordination refs (runtime id, reply stream), not atom mirrors
  useEffect(() => {
    let release: () => void = () => undefined
    let cancelled = false

    readyRef.current = (async () => {
      if (route && typeof host.retainProfile === 'function') {
        const releaseRoute = await host.retainProfile(route, { spawnPriority: 'foreground' }).catch(() => null)

        if (cancelled) {
          releaseRoute?.()
        } else if (releaseRoute) {
          release = releaseRoute
        }
      }

      const stored = await findBotChatId(bot)

      if (!stored) {
        host.notify({ kind: 'info', message: b.org.callNeedsChat(name) })
        endOrgVoiceCall()
        void openRosterBot(bot)

        return null
      }

      storedRef.current = stored

      return cancelled ? null : resume(stored)
    })().catch(error => {
      host.notify({ kind: 'error', message: String((error as Error)?.message ?? error) })
      endOrgVoiceCall()

      return null
    })

    return () => {
      cancelled = true
      release()
    }
  }, [b, bot, name, resume, route])

  // The delegated turn's stream, filtered to this call's runtime session.
  // eslint-disable-next-line no-restricted-syntax -- call-coordination refs (runtime id, reply stream), not atom mirrors
  useEffect(() => {
    if (typeof host.onEvent !== 'function') {
      return undefined
    }

    return host.onEvent('*', event => {
      if (!runtimeRef.current || event.session_id !== runtimeRef.current) {
        return
      }

      const payload = (event.payload ?? {}) as { name?: string; text?: unknown }

      switch (event.type) {
        case 'message.start':
          replyRef.current = { id: `reply-${++replyCounter.current}`, pending: true, text: '' }
          toolRef.current = null
          setBusy(true)

          break

        case 'message.delta':
          if (replyRef.current && typeof payload.text === 'string') {
            replyRef.current = { ...replyRef.current, text: replyRef.current.text + payload.text }
          }

          break
        case 'message.complete': {
          const reply = replyRef.current ?? { id: `reply-${++replyCounter.current}`, pending: true, text: '' }
          const finalText = typeof payload.text === 'string' ? payload.text : ''
          replyRef.current = { ...reply, pending: false, text: reply.text.trim() ? reply.text : finalText }
          toolRef.current = null
          setBusy(false)

          break
        }

        case 'tool.start':
          toolRef.current = payload.name ?? null

          break

        case 'tool.complete':
          toolRef.current = null

          break

        case 'error':
          setBusy(false)

          break
      }
    })
  }, [])

  const submit = useCallback(
    async (text: string, voiceContext: string) => {
      const runtime = await readyRef.current

      if (!runtime) {
        throw new Error(`${name} is not reachable`)
      }

      const params = { surface: 'voice-live', text, voice_context: voiceContext }

      try {
        await requestForBot(bot, 'prompt.submit', { ...params, session_id: runtime }, { spawnPriority: 'foreground' })
      } catch (error) {
        const fresh = isSessionGone(error) && storedRef.current ? await resume(storedRef.current) : null

        if (!fresh) {
          throw error
        }

        await requestForBot(bot, 'prompt.submit', { ...params, session_id: fresh }, { spawnPriority: 'foreground' })
      }
    },
    [bot, name, resume]
  )

  const reply = useCallback(() => {
    const current = replyRef.current

    return current && current.id !== consumedRef.current && current.text.trim() ? current : null
  }, [])

  const consumeReply = useCallback(() => {
    consumedRef.current = replyRef.current?.id ?? null
  }, [])

  const interrupt = useCallback(async () => {
    if (runtimeRef.current) {
      await requestForBot(bot, 'session.interrupt', { session_id: runtimeRef.current }).catch(() => undefined)
    }
  }, [bot])

  return (
    <LiveVoiceCall
      activeTool={() => toolRef.current}
      busy={busy}
      captionTarget={captionTarget(botRosterKey(bot))}
      consumeReply={consumeReply}
      interrupt={interrupt}
      onEnded={endOrgVoiceCall}
      onStatus={status =>
        $orgVoiceStatus.set(status === 'idle' ? 'connecting' : status === 'transcribing' ? 'listening' : status)
      }
      owner={{ connectionId: route?.connectionId ?? null, profile: bot.name }}
      reply={reply}
      submit={submit}
    />
  )
}

/** The mic toggle on an org chart card. Sits beside the card button, never in it. */
export function OrgCallButton({ bot, className }: { bot: RosterRow; className?: string }) {
  const b = useBots()
  const call = useValue($orgVoiceCall)
  const active = call?.key === botRosterKey(bot)
  const name = displayName(bot, botRosterMeta(bot, useValue($botMeta)))
  const label = active ? b.org.endTalk(name) : b.org.talkTo(name)

  const onClick = (event: MouseEvent) => {
    event.stopPropagation()
    toggleOrgVoiceCall(bot)
  }

  return (
    <Tip label={label}>
      <button
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'grid size-7 place-items-center rounded-full border transition-[opacity,background-color,color] duration-150',
          active
            ? 'border-transparent bg-(--ui-accent) text-white opacity-100 shadow-sm'
            : 'border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) text-(--ui-text-secondary) opacity-70 hover:text-(--ui-text-primary) hover:opacity-100 group-hover/org-card:opacity-100',
          className
        )}
        data-slot="org-chart-call"
        onClick={onClick}
        onPointerDown={event => event.stopPropagation()}
        type="button"
      >
        <Codicon className={active ? 'animate-pulse' : undefined} name="mic" size="0.875rem" />
      </button>
    </Tip>
  )
}

/** Floating bar while a call is on: who, status, the latest caption, open chat, end. */
export function OrgCallBar() {
  const b = useBots()
  const call = useValue($orgVoiceCall)
  const status = useValue($orgVoiceStatus)
  const captions = useValue($voiceCaptions)

  if (!call) {
    return null
  }

  const name = displayName(call.bot, botRosterMeta(call.bot, $botMeta.get()))
  const last = captions[captionTarget(call.key)]?.captions.at(-1)

  return (
    <div
      className="absolute bottom-4 left-1/2 z-20 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-3 py-2 shadow-lg"
      data-slot="org-chart-call-bar"
      onPointerDown={event => event.stopPropagation()}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-(--ui-accent) text-white">
        <Codicon className="animate-pulse" name="mic" size="0.875rem" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-medium">
          {b.org.callWith(name)} · <span className="text-(--ui-text-secondary)">{b.org.callStatus[status]}</span>
        </span>
        {last ? (
          <span className="block truncate text-[0.75rem] text-(--ui-text-tertiary)">
            {last.speaker === 'user' ? '› ' : ''}
            {last.text}
          </span>
        ) : null}
      </span>
      <Button onClick={() => void openRosterBot(call.bot)} size="sm" variant="ghost">
        {b.org.openChat}
      </Button>
      <Button onClick={endOrgVoiceCall} size="sm" variant="destructive">
        {b.org.endCall}
      </Button>
    </div>
  )
}

/** Title bar slot (a permanent mount point): hosts the call so it survives tab
 *  switches, and shows a compact "on a call" pill from anywhere in the app. */
export function OrgCallTitlebar() {
  const b = useBots()
  const call = useValue($orgVoiceCall)
  const status = useValue($orgVoiceStatus)

  if (!call) {
    return null
  }

  const name = displayName(call.bot, botRosterMeta(call.bot, $botMeta.get()))

  return (
    <>
      <OrgVoiceCallHost />
      <span
        className="flex items-center gap-1.5 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) py-0.5 pr-0.5 pl-2 text-[0.75rem] [-webkit-app-region:no-drag]"
        data-slot="org-chart-call-pill"
      >
        <Codicon className="animate-pulse text-(--ui-accent)" name="mic" size="0.75rem" />
        <button className="max-w-40 truncate hover:underline" onClick={() => void openRosterBot(call.bot)} type="button">
          {name} · {b.org.callStatus[status]}
        </button>
        <Tip label={b.org.endTalk(name)}>
          <button
            aria-label={b.org.endTalk(name)}
            className="grid size-5 place-items-center rounded-full text-(--ui-text-secondary) hover:bg-(--ui-control-active-background) hover:text-(--ui-text-primary)"
            onClick={endOrgVoiceCall}
            type="button"
          >
            <Codicon name="close" size="0.75rem" />
          </button>
        </Tip>
      </span>
    </>
  )
}
