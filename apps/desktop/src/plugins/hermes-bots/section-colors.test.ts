/**
 * Section colours: each top-level section gets a distinct colour with no
 * setup, a whole subtree wears its root's colour (so a company reads as one
 * block), a picked colour wins and persists, and moving a section to the top
 * level keeps the colour it was given.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { storage } = vi.hoisted(() => ({ storage: new Map<string, unknown>() }))

vi.mock('./data', async () => {
  const { atom } = await import('nanostores')

  return { $botMeta: atom({}), saveBotMeta: vi.fn(async () => ({ serverPersisted: true })) }
})

vi.mock('./routing', () => ({ botRosterMeta: () => undefined }))

vi.mock('./shared', () => ({
  getPluginCtx: () => ({
    storage: {
      get: (key: string, fallback: unknown) => (storage.has(key) ? storage.get(key) : fallback),
      set: (key: string, value: unknown) => storage.set(key, value)
    }
  })
}))

import { SECTION_COLOR_KEYS, SECTION_PALETTE, sectionColor, sectionColorKey } from './section-colors'
import {
  $botSections,
  createBotSection,
  loadBotSections,
  setBotSectionColor,
  setBotSectionParent
} from './user-sections'

beforeEach(() => {
  storage.clear()
  $botSections.set([])
})

describe('section colours', () => {
  it('top-level sections get distinct colours by position; a subtree wears its root colour', () => {
    const founders = createBotSection('Founder’s Office')!
    const oil = createBotSection('One Infinity Labs')!
    const product = createBotSection('ProductOS', [], oil.id)!
    const deep = createBotSection('Platform', [], product.id)!
    const sections = $botSections.get()

    expect(sectionColorKey(founders.id, sections)).toBe(SECTION_COLOR_KEYS[0])
    expect(sectionColorKey(oil.id, sections)).toBe(SECTION_COLOR_KEYS[1])
    expect(sectionColor(product.id, sections)).toBe(sectionColor(oil.id, sections))
    expect(sectionColor(deep.id, sections)).toBe(sectionColor(oil.id, sections))
  })

  it('a picked colour wins for the whole subtree, survives a reload, and resets to automatic', () => {
    const oil = createBotSection('One Infinity Labs')!
    const product = createBotSection('ProductOS', [], oil.id)!

    setBotSectionColor(oil.id, 'rose')
    $botSections.set([])
    loadBotSections()

    expect(sectionColor(product.id, $botSections.get())).toBe(SECTION_PALETTE.rose)

    setBotSectionColor(oil.id, null)
    expect($botSections.get().find(s => s.id === oil.id)).toEqual({ id: oil.id, name: 'One Infinity Labs' })
  })

  it('moving a coloured section to the top level keeps its colour', () => {
    const oil = createBotSection('One Infinity Labs')!
    const product = createBotSection('ProductOS', [], oil.id)!

    setBotSectionColor(product.id, 'teal')
    setBotSectionParent(product.id, null)

    expect($botSections.get().find(s => s.id === product.id)).toEqual({
      color: 'teal',
      id: product.id,
      name: 'ProductOS'
    })
    expect(sectionColor(product.id, $botSections.get())).toBe(SECTION_PALETTE.teal)
  })
})
