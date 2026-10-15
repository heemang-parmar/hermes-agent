import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { I18nProvider, TRANSLATIONS, useI18n } from '@/i18n'
import type { I18nContextValue } from '@/i18n'
import { $interfaceMode } from '@/store/interface-mode'
import {
  $sidebarListGroupIds,
  $sidebarOrdering,
  $sidebarProfileFilter,
  $sidebarStatusFilter,
  resetSidebarView,
  setSidebarGrouping,
  setSidebarOrdering
} from '@/store/layout'
import { $profiles, $showAllProfiles } from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

import { SidebarFilterMenu } from './filter-menu'

let i18n: I18nContextValue

function Menu() {
  i18n = useI18n()

  return <SidebarFilterMenu />
}

afterEach(() => {
  cleanup()
  resetSidebarView()
  $profiles.set([])
  $showAllProfiles.set(false)
})

it('translates the live filter menu while preserving selected values and the current grouping order', async () => {
  $interfaceMode.set('advanced')
  setSidebarGrouping('date')
  setSidebarOrdering('manual')
  $sidebarListGroupIds.set(['today'])
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <Menu />
    </I18nProvider>
  )
  const zh = TRANSLATIONS.zh.sidebar.filter
  fireEvent.keyDown(screen.getByRole('button', { name: zh.filters }), { key: 'Enter' })
  const group = screen.getByRole('menuitem', { name: new RegExp(zh.grouping) })
  fireEvent.keyDown(group, { key: 'ArrowRight' })
  expect(screen.getByRole('menuitemradio', { name: zh.updated }).getAttribute('aria-checked')).toBe('true')
  fireEvent.keyDown(screen.getByRole('menuitemradio', { name: zh.updated }), { key: 'Escape' })
  fireEvent.keyDown(screen.getByRole('button', { name: zh.filters }), { key: 'Enter' })
  fireEvent.keyDown(screen.getByRole('menuitem', { name: zh.status }), { key: 'ArrowRight' })
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: zh.needsInput }))
  expect($sidebarStatusFilter.get()).toContain('needs-input')
  await act(() => i18n.setLocale('ja'))
  const ja = TRANSLATIONS.ja.sidebar.filter
  expect(screen.getByText(TRANSLATIONS.ja.sidebar.profileRail)).toBeTruthy()
  expect(screen.getByText(TRANSLATIONS.ja.sidebar.markAllRead)).toBeTruthy()
  expect(screen.queryByText(TRANSLATIONS.en.sidebar.profileRail)).toBeNull()
  expect(screen.queryByText(TRANSLATIONS.en.sidebar.markAllRead)).toBeNull()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: ja.status }), { key: 'ArrowRight' })
  expect(screen.getByRole('menuitemcheckbox', { name: ja.needsInput }).getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByRole('menuitemcheckbox', { name: zh.needsInput })).toBeNull()
  expect($sidebarOrdering.get()).toBe('manual')
})

it('labels the Profile filter with display names but filters by the stable profile id', () => {
  $interfaceMode.set('advanced')
  $showAllProfiles.set(true)
  $profiles.set([
    { display_name: 'Chief of Staff', name: 'default' },
    { display_name: '  ', name: 'research' },
    { name: 'ops' },
    { display_name: 'Growth Lead', name: 'g-1' }
  ] as ProfileInfo[])
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <Menu />
    </I18nProvider>
  )
  const en = TRANSLATIONS.en.sidebar.filter
  fireEvent.keyDown(screen.getByRole('button', { name: en.filters }), { key: 'Enter' })
  fireEvent.keyDown(screen.getByRole('menuitem', { name: en.profile }), { key: 'ArrowRight' })

  expect(screen.getByRole('menuitemcheckbox', { name: 'Chief of Staff' })).toBeTruthy()
  expect(screen.getByRole('menuitemcheckbox', { name: 'research' })).toBeTruthy()
  expect(screen.getByRole('menuitemcheckbox', { name: 'ops' })).toBeTruthy()
  expect(screen.queryByRole('menuitemcheckbox', { name: 'default' })).toBeNull()

  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Chief of Staff' }))
  expect($sidebarProfileFilter.get()).toEqual(['default'])
})

it('selecting a renamed non-default profile stores its technical id', () => {
  $interfaceMode.set('advanced')
  $showAllProfiles.set(true)
  $profiles.set([
    { name: 'default' },
    { display_name: 'Growth Lead', name: 'g-1' }
  ] as ProfileInfo[])
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <Menu />
    </I18nProvider>
  )
  const en = TRANSLATIONS.en.sidebar.filter
  fireEvent.keyDown(screen.getByRole('button', { name: en.filters }), { key: 'Enter' })
  fireEvent.keyDown(screen.getByRole('menuitem', { name: en.profile }), { key: 'ArrowRight' })
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Growth Lead' }))

  expect($sidebarProfileFilter.get()).toEqual(['g-1'])
})
