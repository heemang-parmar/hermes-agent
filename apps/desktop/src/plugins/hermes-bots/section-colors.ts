/**
 * SECTION COLOURS — one colour per top-level section, shared by its whole
 * subtree, so a company and everything filed under it read as one block in
 * the roster and the org chart alike.
 *
 * A section takes its colour from `BotSection.color` (a palette key the user
 * picked) or, with none set, from its top-level position, so the first few
 * companies get clearly different colours with no setup. Nested sections
 * inherit their root's colour; picking a colour on a subsection is not
 * offered, which keeps a company visually one thing.
 *
 * The palette values are mid-tone hues that hold up on both the light and the
 * dark theme; tints are mixed against the theme's own surface tokens at the
 * use site (`sectionTint`), never hard-coded per theme.
 */

import type { BotSection } from './user-sections'

export const SECTION_PALETTE = {
  blue: '#3b72d9',
  green: '#23a26d',
  amber: '#d08a16',
  rose: '#d4497c',
  violet: '#7c5ce0',
  coral: '#e0643f',
  teal: '#1f9fb3',
  slate: '#6b7a90'
} as const

export type SectionColorKey = keyof typeof SECTION_PALETTE

export const SECTION_COLOR_KEYS = Object.keys(SECTION_PALETTE) as SectionColorKey[]

export function isSectionColorKey(value: unknown): value is SectionColorKey {
  return typeof value === 'string' && value in SECTION_PALETTE
}

/** The top-level section `id` sits under (itself when it is top level). */
export function rootSectionOf(id: string, sections: BotSection[]): BotSection | undefined {
  const byId = new Map(sections.map(section => [section.id, section]))
  const seen = new Set<string>()
  let current = byId.get(id)

  while (current?.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
    seen.add(current.id)
    current = byId.get(current.parentId)
  }

  return current
}

/** The palette key a section is drawn in. */
export function sectionColorKey(id: string, sections: BotSection[]): SectionColorKey {
  const root = rootSectionOf(id, sections)

  if (!root) {
    return 'slate'
  }

  if (isSectionColorKey(root.color)) {
    return root.color
  }

  const index = sections.filter(section => !section.parentId).findIndex(section => section.id === root.id)

  return SECTION_COLOR_KEYS[Math.max(0, index) % SECTION_COLOR_KEYS.length]!
}

export function sectionColor(id: string, sections: BotSection[]): string {
  return SECTION_PALETTE[sectionColorKey(id, sections)]
}

/** `color` mixed into a theme token — `pct` percent of the colour. Used for
 *  tinted card backgrounds, borders and readable accent text on either theme. */
export function sectionTint(color: string, pct: number, token = '--ui-bg-elevated'): string {
  return `color-mix(in srgb, ${color} ${pct}%, var(${token}))`
}
