/**
 * Talking to a bot from the org chart: the mic starts a call without opening
 * the bot's chat, and the call's delegated requests run as turns in the bot's
 * existing Bot Chat, whose reply (and only that) is handed to the voice.
 */

import type * as HermesSdk from '@hermes/plugin-sdk'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as BotsData from './data'
import { translateBotsIn } from './i18n-test-helper'
import type * as Routing from './routing'
import type { RosterRow } from './types'

type CallProps = HermesSdk.LiveVoiceCallProps
type Listener = (event: { payload?: unknown; session_id?: string; type: string }) => void

const { calls, findBotChatId, listeners, openRosterBot, requestForBot, roster } = vi.hoisted(() => ({
  calls: [] as CallProps[],
  findBotChatId: vi.fn(),
  listeners: new Set<Listener>(),
  openRosterBot: vi.fn(),
  requestForBot: vi.fn(),
  roster: [] as RosterRow[]
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof HermesSdk>()

  return {
    ...sdk,
    host: {
      ...sdk.host,
      notify: vi.fn(),
      onEvent: (_type: string, listener: Listener) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      },
      retainProfile: undefined
    },
    LiveVoiceCall: (props: CallProps) => {
      calls.push(props)

      return null
    },
    usePluginI18n: () => translateBotsIn('en')
  }
})

vi.mock('./roster-actions', () => ({ openRosterBot }))
vi.mock('./canonical-chat', () => ({ findBotChatId }))

vi.mock('./routing', async importOriginal => ({
  ...(await importOriginal<typeof Routing>()),
  requestForBot
}))

vi.mock('./data', async importOriginal => ({
  ...(await importOriginal<typeof BotsData>()),
  useRoster: () => ({ data: { profiles: roster } })
}))

const { $botMeta } = await import('./data')
const { $botSections } = await import('./user-sections')
const { OrgChartPane } = await import('./org-chart-pane')
const { $orgVoiceCall, OrgVoiceCallHost } = await import('./org-voice-call')

const ayan: RosterRow = { connectionId: 'local', name: 'ayan' }

const emit = (event: Parameters<Listener>[0]) => act(() => listeners.forEach(listener => listener(event)))

beforeEach(() => {
  roster.splice(0, roster.length, ayan)
  $botSections.set([{ id: 'labs', name: '1Labs AI' }])
  $botMeta.set({ ayan: { designation: 'Business Head', sectionId: 'labs', title: 'Ayan' } })
  findBotChatId.mockResolvedValue('stored-1')
  requestForBot.mockImplementation((_bot: RosterRow, method: string) =>
    Promise.resolve(method === 'session.resume' ? { session_id: 'rt-1' } : {})
  )
})

afterEach(() => {
  cleanup()
  $orgVoiceCall.set(null)
  calls.length = 0
  listeners.clear()
  vi.clearAllMocks()
})

describe('org chart voice call', () => {
  it('the mic starts and ends a call with that bot without opening its chat', () => {
    render(<OrgChartPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Talk to Ayan' }))
    expect($orgVoiceCall.get()?.bot).toEqual(ayan)

    fireEvent.click(screen.getByRole('button', { name: 'End call with Ayan' }))
    expect($orgVoiceCall.get()).toBeNull()
    expect(openRosterBot).not.toHaveBeenCalled()
  })

  it("delegates into the bot's existing chat and speaks only that chat's reply", async () => {
    $orgVoiceCall.set({ bot: ayan, key: 'local::ayan' })
    render(<OrgVoiceCallHost />)

    const call = () => calls.at(-1)!
    // A local bot rides the active connection; its own profile picks voice, persona and key.
    expect(call().owner).toEqual({ connectionId: null, profile: 'ayan' })

    await act(() => call().submit('plan my week', 'User: plan my week'))

    await waitFor(() =>
      expect(requestForBot).toHaveBeenCalledWith(
        ayan,
        'prompt.submit',
        { session_id: 'rt-1', surface: 'voice-live', text: 'plan my week', voice_context: 'User: plan my week' },
        { spawnPriority: 'foreground' }
      )
    )

    emit({ session_id: 'rt-1', type: 'message.start' })
    emit({ payload: { text: 'Monday is ' }, session_id: 'rt-1', type: 'message.delta' })
    emit({ payload: { text: 'unrelated' }, session_id: 'other', type: 'message.delta' })
    expect(call().busy).toBe(true)
    expect(call().reply()).toMatchObject({ pending: true, text: 'Monday is ' })

    emit({ payload: { text: 'free.' }, session_id: 'rt-1', type: 'message.delta' })
    emit({ payload: { text: 'Monday is free.' }, session_id: 'rt-1', type: 'message.complete' })
    expect(call().busy).toBe(false)
    expect(call().reply()).toMatchObject({ pending: false, text: 'Monday is free.' })

    call().consumeReply()
    expect(call().reply()).toBeNull()
  })
})
