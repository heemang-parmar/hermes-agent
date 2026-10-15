/**
 * Nested user sections — the invariants nesting adds on top of flat sections:
 * the tree survives a reload and repairs itself (no lost or looping sections),
 * a section can never be moved into its own subtree, deleting a section moves
 * its bots and children up one level, members carry their ancestry so another
 * desktop rebuilds the same tree, and a flat (unnested) section writes exactly
 * what it wrote before nesting existed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { saveBotMeta, storage } = vi.hoisted(() => ({
  saveBotMeta: vi.fn<(bot: { name: string }, patch: Record<string, unknown>) => Promise<unknown>>(),
  storage: new Map<string, unknown>()
}))

vi.mock('./data', async () => {
  const { atom } = await import('nanostores')
  const $botMeta = atom<Record<string, Record<string, unknown>>>({})

  saveBotMeta.mockImplementation(async (bot: { name: string }, patch: Record<string, unknown>) => {
    $botMeta.set({ ...$botMeta.get(), [bot.name]: { ...$botMeta.get()[bot.name], ...patch } })

    return { serverOutcome: 'persisted', serverPersisted: true }
  })

  return { $botMeta, saveBotMeta }
})

vi.mock('./routing', () => ({
  botRosterMeta: (bot: { name: string }, meta: Record<string, unknown>) => meta[bot.name]
}))

vi.mock('./shared', () => ({
  getPluginCtx: () => ({
    storage: {
      get: (key: string, fallback: unknown) => (storage.has(key) ? storage.get(key) : fallback),
      set: (key: string, value: unknown) => storage.set(key, value)
    }
  })
}))

import { $botMeta } from './data'
import type { RosterRow } from './types'
import {
  $botSections,
  adoptBotSectionsFromMeta,
  createBotSection,
  deleteBotSection,
  flattenSectionTree,
  groupRowsBySection,
  isUserSectionKey,
  loadBotSections,
  moveBotSection,
  moveBotsToSection,
  nestSectionBlocks,
  normalizeBotSections,
  renameBotSection,
  resetBotSectionDeletes,
  setBotSectionColor,
  setBotSectionParent,
  setBotSectionShared
} from './user-sections'

const bot = (name: string) => ({ name }) as RosterRow
const row = (name: string) => ({ bot: bot(name), kind: 'bot' as const })

beforeEach(() => {
  storage.clear()
  $botMeta.set({})
  $botSections.set([])
  resetBotSectionDeletes()
  saveBotMeta.mockClear()
})

describe('nested user sections', () => {
  it('a subsection persists under its parent and reloads as the same tree', () => {
    const org = createBotSection('One Infinity Labs')!
    const product = createBotSection('ProductOS', [], org.id)!
    createBotSection('Shared Departments')

    $botSections.set([])
    loadBotSections()

    expect(flattenSectionTree($botSections.get()).map(({ depth, section }) => [depth, section.name])).toEqual([
      [0, 'One Infinity Labs'],
      [1, 'ProductOS'],
      [0, 'Shared Departments']
    ])
    expect($botSections.get().find(s => s.id === product.id)?.parentId).toBe(org.id)
  })

  it('a missing parent or a loop lifts sections to the top level instead of hiding them', () => {
    const repaired = normalizeBotSections([
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
      { id: 'c', name: 'C', parentId: 'gone' }
    ])

    // Every section is still reachable from the top of the tree.
    expect(flattenSectionTree(repaired)).toHaveLength(3)
    expect(repaired.find(s => s.id === 'c')).toEqual({ id: 'c', name: 'C' })
  })

  it('refuses to move a section into itself or its own subtree', () => {
    const org = createBotSection('Blue Barrows')!
    const brand = createBotSection('Kindly Objects', [], org.id)!
    const prod = createBotSection('Production', [], brand.id)!

    expect(setBotSectionParent(org.id, prod.id)).toBe(false)
    expect(setBotSectionParent(org.id, org.id)).toBe(false)
    expect($botSections.get().find(s => s.id === org.id)?.parentId).toBeUndefined()

    // Lifting a nested section to the top level is allowed and brings its subtree.
    expect(setBotSectionParent(brand.id, null)).toBe(true)
    expect(flattenSectionTree($botSections.get()).map(({ depth, section }) => [depth, section.name])).toEqual([
      [0, 'Blue Barrows'],
      [0, 'Kindly Objects'],
      [1, 'Production']
    ])
  })

  it('members of a nested section carry their ancestry; flat sections write what they always did', async () => {
    const flat = createBotSection('Founder’s Office', [bot('ariv')])!
    const org = createBotSection('One Infinity Labs')!
    const product = createBotSection('ProductOS', [bot('elio')], org.id)!

    await vi.waitFor(() => expect(saveBotMeta).toHaveBeenCalledTimes(2))
    expect(saveBotMeta).toHaveBeenCalledWith(bot('ariv'), { sectionId: flat.id, sectionName: 'Founder’s Office' })
    expect(saveBotMeta).toHaveBeenCalledWith(bot('elio'), {
      sectionId: product.id,
      sectionName: 'ProductOS',
      sectionParents: [{ id: org.id, name: 'One Infinity Labs' }]
    })

    // Renaming the parent re-stamps the child's members, so the new name
    // reaches other desktops through their ancestry.
    renameBotSection(org.id, '1 Infinity Labs', [bot('ariv'), bot('elio')])
    await vi.waitFor(() =>
      expect($botMeta.get().elio?.sectionParents).toEqual([{ id: org.id, name: '1 Infinity Labs' }])
    )

    // Moving the bot to a top-level section clears its ancestry.
    await moveBotsToSection([bot('elio')], flat.id)
    expect($botMeta.get().elio).toMatchObject({ sectionId: flat.id, sectionParents: null })
  })

  it('another desktop rebuilds the nested tree from what members carry', () => {
    adoptBotSectionsFromMeta([bot('elio'), bot('nirmaan')], {
      elio: {
        sectionId: 'sec-product',
        sectionName: 'ProductOS',
        sectionParents: [{ id: 'sec-oil', name: 'One Infinity Labs' }]
      },
      nirmaan: {
        sectionId: 'sec-print',
        sectionName: 'Production',
        sectionParents: [
          { id: 'sec-bb', name: 'Blue Barrows' },
          { id: 'sec-ko', name: 'Kindly Objects' }
        ]
      }
    })

    expect(flattenSectionTree($botSections.get()).map(({ depth, section }) => [depth, section.name])).toEqual([
      [0, 'One Infinity Labs'],
      [1, 'ProductOS'],
      [0, 'Blue Barrows'],
      [1, 'Kindly Objects'],
      [2, 'Production']
    ])
  })

  it('deleting a section moves its bots and child sections up one level, and undo restores both', async () => {
    const org = createBotSection('Blue Barrows')!
    const brand = createBotSection('Kindly Objects', [bot('rachit')], org.id)!
    const prod = createBotSection('Production', [bot('nirmaan')], brand.id)!
    const roster = [bot('rachit'), bot('nirmaan')]

    await vi.waitFor(() => expect($botMeta.get().nirmaan?.sectionId).toBe(prod.id))

    const { undo } = deleteBotSection(brand.id, roster)

    await vi.waitFor(() => expect($botMeta.get().rachit?.sectionId).toBe(org.id))
    expect($botSections.get().find(s => s.id === prod.id)?.parentId).toBe(org.id)
    await vi.waitFor(() =>
      expect($botMeta.get().nirmaan?.sectionParents).toEqual([{ id: org.id, name: 'Blue Barrows' }])
    )

    undo()

    await vi.waitFor(() => expect($botMeta.get().rachit?.sectionId).toBe(brand.id))
    expect($botSections.get().find(s => s.id === prod.id)?.parentId).toBe(brand.id)
  })

  it('a top-level colour and shared mark ride on the subtree members and rebuild on another desktop', async () => {
    const oil = createBotSection('One Infinity Labs', [bot('shiven')])!
    const product = createBotSection('ProductOS', [bot('elio')], oil.id)!
    const shared = createBotSection('Shared Departments', [bot('astra')])!
    const roster = [bot('shiven'), bot('elio'), bot('astra')]

    await vi.waitFor(() => expect(saveBotMeta).toHaveBeenCalledTimes(3))
    // No look picked yet: nothing extra is written.
    expect(saveBotMeta.mock.calls.every(([, patch]) => !('sectionRootStyle' in patch))).toBe(true)

    setBotSectionColor(oil.id, 'navy', roster)
    setBotSectionShared(shared.id, true, roster)

    await vi.waitFor(() => expect($botMeta.get().elio?.sectionRootStyle).toEqual({ color: 'navy' }))
    await vi.waitFor(() => expect($botMeta.get().astra?.sectionRootStyle).toEqual({ shared: true }))
    expect($botMeta.get().shiven?.sectionRootStyle).toEqual({ color: 'navy' })

    // Another desktop, which has none of these records, draws the same look.
    const meta = $botMeta.get()

    $botSections.set([])
    adoptBotSectionsFromMeta(roster, meta)

    const rebuilt = $botSections.get()

    expect(rebuilt.find(s => s.id === oil.id)).toMatchObject({ color: 'navy' })
    expect(rebuilt.find(s => s.id === product.id)?.color).toBeUndefined()
    expect(rebuilt.find(s => s.id === shared.id)).toMatchObject({ shared: true })
  })

  it('collapse all reaches every folder, at any depth and under any gateway, and nothing else', () => {
    for (const key of ['user-section:oil', 'local:user-section:labs', 'local:section:unassigned']) {
      expect(isUserSectionKey(key)).toBe(true)
    }

    // Pinned stays open; gateway and group-chat buckets keep their own toggle.
    for (const key of ['pinned', 'local:pinned', 'gateway:local', 'group-chats']) {
      expect(isUserSectionKey(key)).toBe(false)
    }
  })

  it('move up / down reorders among siblings only', () => {
    const a = createBotSection('A')!
    const a1 = createBotSection('A1', [], a.id)!
    createBotSection('A2', [], a.id)
    createBotSection('B')

    moveBotSection(a1.id, 1)
    moveBotSection(a1.id, 1) // already last among A's children: no-op

    expect(flattenSectionTree($botSections.get()).map(({ section }) => section.name)).toEqual(['A', 'A2', 'A1', 'B'])
  })

  it('a parent heading counts every bot in its subtree', () => {
    const sections = [
      { id: 'oil', name: 'One Infinity Labs' },
      { id: 'labs', name: '1Labs AI', parentId: 'oil' },
      { id: 'pos', name: 'ProductOS', parentId: 'oil' }
    ]

    const meta = { shiven: { sectionId: 'oil' }, ayan: { sectionId: 'labs' }, elio: { sectionId: 'pos' } }
    const rows = [row('shiven'), row('ayan'), row('elio'), row('loose')]
    const tree = nestSectionBlocks(groupRowsBySection(rows, sections, meta), sections)

    expect(tree.map(node => [node.block.name, node.total, node.children.map(c => c.block.name)])).toEqual([
      ['One Infinity Labs', 3, ['1Labs AI', 'ProductOS']],
      ['', 1, []]
    ])
  })
})
