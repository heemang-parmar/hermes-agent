/**
 * Two roster shortcuts over user sections: the PINNED block lifts pinned bots
 * above every folder (while they stay in their folders), and shared-department
 * sections draw below a divider after the companies. Rendered through the
 * real section renderers with stub rows, so only the composition is under
 * test.
 */

import type * as HermesSdk from '@hermes/plugin-sdk'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { translateBots, translateBotsIn } from './i18n-test-helper'
import type { RosterRow } from './types'

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof HermesSdk>()

  return { ...sdk, usePluginI18n: () => translateBotsIn('en') }
})

const { rosterSectionRenderers } = await import('./roster-pane-sections')
const { bind } = await import('./i18n-bind')
const { BOTS_LOCALES } = await import('./i18n')

afterEach(() => cleanup())

const bot = (name: string) => ({ connectionId: 'local', name }) as RosterRow
const row = (name: string) => ({ bot: bot(name), kind: 'bot' as const })

function renderRoster(meta: Record<string, Record<string, unknown>>, collapsed = (_id: string) => false) {
  const b = bind(translateBots, BOTS_LOCALES.en as object) as never

  const { renderUserSections } = rosterSectionRenderers({
    allMeta: meta,
    b,
    dragging: null,
    groupRooms: {},
    renderBotRow: (r: RosterRow, prefix = '') => (
      <div data-testid={`row:${prefix}${r.name}`} key={`${prefix}${r.name}`}>
        {r.name}
      </div>
    ),
    renderGroupRow: r => <div key={r.name}>{r.name}</div>,
    roster: Object.keys(meta).map(bot),
    rosterSectionCollapsed: collapsed,
    setSectionDialog: () => undefined,
    sortedGroupRows: [],
    toggleRosterSection: () => undefined,
    userSections: [
      { id: 'leaders', name: 'Founder’s Office' },
      { id: 'team', name: 'Shared Departments', shared: true },
      { id: 'oil', name: 'One Infinity Labs' }
    ]
  })

  return render(<div>{renderUserSections(Object.keys(meta).map(row))}</div>).container
}

describe('roster shortcuts over user sections', () => {
  it('pinned bots appear above every folder and still in their own folder', () => {
    const container = renderRoster({
      ariv: { pinned: true, sectionId: 'leaders' },
      astra: { pinned: true, sectionId: 'team' },
      shiven: { sectionId: 'oil' }
    })

    const pinned = container.querySelector('[data-slot="bots-pinned"]') as HTMLElement

    expect(within(pinned).getByText('Pinned')).toBeTruthy()
    expect(within(pinned).getByTestId('row:pinned:ariv')).toBeTruthy()
    expect(within(pinned).getByTestId('row:pinned:astra')).toBeTruthy()
    expect(within(pinned).queryByText('shiven')).toBeNull()
    // Still filed where they live.
    expect(screen.getAllByText('ariv')).toHaveLength(2)
    // And the block comes before the first folder.
    const first = container.querySelector('[data-slot="bots-section"]')!

    expect(pinned.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a shared-department section draws after the companies, past a divider', () => {
    const container = renderRoster({
      ariv: { sectionId: 'leaders' },
      astra: { sectionId: 'team' },
      shiven: { sectionId: 'oil' }
    })

    const headings = [...container.querySelectorAll('[data-slot="bots-section-heading"]')].map(el =>
      el.getAttribute('data-section-id')
    )

    const divider = container.querySelector('[data-slot="bots-shared-divider"]')!
    const shared = container.querySelector('[data-section-id="team"]')!

    expect(headings).toEqual(['leaders', 'oil', 'team'])
    expect(divider.compareDocumentPosition(shared) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
