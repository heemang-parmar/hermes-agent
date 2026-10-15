/**
 * The org chart tab's one job beyond drawing the tree: a bot card opens THAT
 * bot's chat through the same exact-row open path a roster row uses, and the
 * card reads the bot's designation, not its latest message.
 */

import type * as HermesSdk from '@hermes/plugin-sdk'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as BotsData from './data'
import { translateBotsIn } from './i18n-test-helper'
import type { RosterRow } from './types'

const { openRosterBot, roster } = vi.hoisted(() => ({
  openRosterBot: vi.fn(),
  roster: [] as RosterRow[]
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof HermesSdk>()

  return { ...sdk, usePluginI18n: () => translateBotsIn('en') }
})

vi.mock('./roster-actions', () => ({ openRosterBot }))

vi.mock('./data', async importOriginal => ({
  ...(await importOriginal<typeof BotsData>()),
  useRoster: () => ({ data: { profiles: roster } })
}))

const { $botMeta } = await import('./data')
const { $botSections } = await import('./user-sections')
const { OrgChartPane } = await import('./org-chart-pane')

const ayan: RosterRow = { connectionId: 'local', name: 'ayan' }
const shiven: RosterRow = { connectionId: 'local', name: 'lead-oil' }

beforeEach(() => {
  openRosterBot.mockResolvedValue(true)
  roster.splice(0, roster.length, shiven, ayan)
  $botSections.set([
    { id: 'oil', name: 'One Infinity Labs' },
    { id: 'labs', name: '1Labs AI', parentId: 'oil' }
  ])
  $botMeta.set({
    ayan: { designation: 'Business Head · 1Labs AI', sectionId: 'labs', title: 'Ayan' },
    'lead-oil': { designation: 'Business Head · One Infinity Labs', sectionId: 'oil', title: 'Shiven' }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('OrgChartPane', () => {
  it('draws each section with its bots and their designations', () => {
    render(<OrgChartPane />)

    expect(screen.getByText('One Infinity Labs')).toBeTruthy()
    expect(screen.getByText('1Labs AI')).toBeTruthy()
    expect(screen.getByText('Business Head · 1Labs AI')).toBeTruthy()
  })

  it('clicking a bot card opens that exact bot through the roster open path', () => {
    render(<OrgChartPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Chat with Ayan' }))

    expect(openRosterBot).toHaveBeenCalledTimes(1)
    expect(openRosterBot).toHaveBeenCalledWith(ayan)
  })
})
