import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VoiceLiveHandlers } from '@/lib/voice-live'

import { LiveVoiceCall } from './live-voice-call'

const transport = vi.hoisted(() => ({
  closed: 0,
  owners: [] as unknown[],
  started: 0
}))

vi.mock('@/lib/voice-live', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  VoiceLiveSession: class {
    instruct = vi.fn()
    setMuted = vi.fn()
    speak = vi.fn()
    think = vi.fn()

    constructor(_handlers: VoiceLiveHandlers, owner: unknown) {
      transport.owners.push(owner)
    }

    close() {
      transport.closed += 1
    }

    async start(): Promise<void> {
      transport.started += 1
    }
  }
}))

afterEach(() => {
  cleanup()
  transport.closed = 0
  transport.owners.length = 0
  transport.started = 0
})

const props = {
  busy: false,
  captionTarget: 'org-call:local::ayan',
  consumeReply: vi.fn(),
  onEnded: vi.fn(),
  owner: { connectionId: null, profile: 'ayan' },
  reply: () => null,
  submit: vi.fn(() => Promise.resolve())
}

describe('LiveVoiceCall', () => {
  it("mounting starts a GPT-Live session on the owner's profile; unmounting hangs up", async () => {
    const { unmount } = render(<LiveVoiceCall {...props} />)

    await waitFor(() => expect(transport.started).toBe(1))
    expect(transport.owners).toEqual([{ connectionId: null, profile: 'ayan' }])

    unmount()
    expect(transport.closed).toBe(1)
  })
})
