import { describe, expect, it } from 'vitest'

import { botDesignation, botRowSubtitle } from './bot-row-subtitle'
import type { RosterRow } from './types'

const SHIVEN = 'Business Head · One Infinity Labs'
const DM = "Message from agent 'scout': secret plan details"

describe('botDesignation', () => {
  it('reads Bot Mode meta, then the row ui_meta, trimmed', () => {
    expect(botDesignation({ name: 'shiven' }, { designation: `  ${SHIVEN} ` })).toBe(SHIVEN)
    expect(botDesignation({ name: 'shiven', ui_meta: { 'hermes-bots': { designation: SHIVEN } } })).toBe(SHIVEN)
  })

  it('is empty when missing, blank or non-string, and never falls back to description', () => {
    const bot: RosterRow = { name: 'x', description: 'A very long policy…' }

    expect(botDesignation(bot, { description: 'A very long policy…' })).toBe('')
    expect(botDesignation(bot, { designation: '   ' })).toBe('')
    expect(botDesignation(bot, { designation: 42 as unknown as string })).toBe('')
  })
})

describe('botRowSubtitle', () => {
  it('shows the designation and leaks no message content', () => {
    expect(botRowSubtitle(SHIVEN, DM)).toEqual({ designation: SHIVEN, fromBot: false, preview: '' })
    expect(botRowSubtitle(SHIVEN, 'hello from the user')).toEqual({ designation: SHIVEN, fromBot: false, preview: '' })
  })

  it('keeps the preview behaviour without a designation', () => {
    expect(botRowSubtitle('', 'hello **there**')).toEqual({ designation: '', fromBot: false, preview: 'hello there' })
    expect(botRowSubtitle('', DM)).toEqual({ designation: '', fromBot: true, preview: 'secret plan details' })
    expect(botRowSubtitle('', null)).toEqual({ designation: '', fromBot: false, preview: '' })
  })
})
