/**
 * USER SECTIONS — folders the user makes, not folders the topology makes.
 *
 * The roster already had sections (`roster-sections.tsx`), but only AUTOMATIC
 * ones: one per gateway connection, plus the group-chat bucket. Those answer
 * "where does this bot run", which is not the question you are asking when you
 * want two client bots filed together under "Clients".
 *
 * So this is a SECOND axis, and it composes with the first rather than
 * replacing it. Two deliberate choices:
 *
 *   * The membership lives on the BOT (`sectionId` in its ui_meta), not as a
 *     member list on the section. A bot can only be in one place, deleting a
 *     section cannot orphan anybody, and the assignment rides the same
 *     profile.yaml sync every other bot setting already uses — so sections
 *     follow the profile to another machine.
 *   * "Unassigned" is not a section. It is whatever is left, always drawn
 *     last, and it is where members of a deleted section land. With no
 *     sections at all the roster renders exactly as it did before.
 *
 * Pure model + session atoms. No JSX — the pane composes it.
 */

import { atom } from 'nanostores'

import { $botMeta, saveBotMeta } from './data'
import { $groupChats, updateGroupChat } from './group-chat'
import { botRosterMeta } from './routing'
import { getPluginCtx } from './shared'
import type { BotMeta, GroupChat, RosterRow } from './types'

/** The one section-name dialog's state: New section (optionally filing the
 *  bot or group whose menu opened it, or nested under `parentId`) or Rename. */
export type SectionDialogState =
  | null
  | { bot?: RosterRow; group?: string; mode: 'create'; parentId?: string }
  | { id: string; mode: 'rename'; name: string }

export const UNASSIGNED_SECTION_KEY = 'section:unassigned'
export const BOT_SECTIONS_KEY = 'bot-sections-v1'

export interface BotSection {
  id: string
  name: string
  /** The section this one is nested under. Absent at the top level, so a flat
   *  list persists exactly as it did before nesting existed. */
  parentId?: string
}

/** One link of a member's ancestry (`BotMeta.sectionParents`), root first. */
export interface SectionAncestor {
  id: string
  name: string
}

/** `[{ id, name }]`, in display order. */
export const $botSections = atom<BotSection[]>([])

/** Sections whose delete is still clearing its members. A delete clears them
 *  one profile write at a time, and a slow write (a remote gateway, a pooled
 *  backend still starting) leaves the rest carrying the id AND the name for
 *  seconds — long enough for adoptBotSectionsFromMeta to rebuild the section
 *  the user just deleted, under whatever name a not-yet-cleared member still
 *  carries. The entry expires when that clear finishes (after it, a member
 *  carrying the id was filed there again — by another desktop — and adopting
 *  it is right); Undo takes it out early. The token keeps an earlier delete's
 *  clear from expiring a later delete of the same id. */
const pendingSectionDeletes = new Map<string, symbol>()

/** Sections whose members this desktop is re-stamping after a rename or a
 *  re-parent. Until every write lands, the members still carry the OLD name
 *  and ancestry, and adoptBotSectionsFromMeta must not read those back as an
 *  edit made on another desktop and undo the user's change. Counted, because
 *  two quick edits of one section overlap. */
const pendingRestamps = new Map<string, number>()

/** Test seam. */
export function resetBotSectionDeletes(): void {
  pendingSectionDeletes.clear()
  pendingRestamps.clear()
}

/** Roster key of the bot in flight during a drag. Session-only, and cleared
 *  on dragend even when the drop lands outside any target — a stuck
 *  "dragging" state outlives the gesture and reads as a broken pane. */
export const $draggingBot = atom<null | string>(null)

/** The ONE section block lit as the drop target. Sections nest, so the block
 *  under the pointer sits inside its parent's block too; the innermost one
 *  claims the drag (and stops it bubbling), and this keeps the parent from
 *  staying lit after the pointer moved into the child. Session-only. */
export const $sectionDropTarget = atom<null | string>(null)

export function normalizeBotSections(value: unknown): BotSection[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const out: BotSection[] = []

  for (const entry of value) {
    const id = String((entry as BotSection)?.id || '').trim()
    const name = String((entry as BotSection)?.name || '').trim()

    if (!id || !name || seen.has(id)) {
      continue
    }

    seen.add(id)
    const parentId = String((entry as BotSection)?.parentId || '').trim()

    out.push(parentId ? { id, name, parentId } : { id, name })
  }

  // A parent that no longer exists, or a loop (two desktops each nesting one
  // section under the other), would hide those sections from the tree
  // entirely; lift them to the top level instead.
  const parentOf = new Map(out.map(s => [s.id, s.parentId && seen.has(s.parentId) ? s.parentId : null]))

  for (const section of out) {
    const visited = new Set([section.id])

    for (let up = parentOf.get(section.id); up; up = parentOf.get(up)) {
      if (visited.has(up)) {
        parentOf.set(section.id, null)

        break
      }

      visited.add(up)
    }
  }

  return out.map(({ id, name }) => {
    const parentId = parentOf.get(id)

    return parentId ? { id, name, parentId } : { id, name }
  })
}

/** The sections above `id`, root first — empty at the top level. */
export function sectionAncestors(id: string, sections: BotSection[]): SectionAncestor[] {
  const byId = new Map(sections.map(s => [s.id, s]))
  const chain: SectionAncestor[] = []
  const visited = new Set([id])

  for (let up = byId.get(id)?.parentId; up && !visited.has(up); up = byId.get(up)?.parentId) {
    const parent = byId.get(up)

    if (!parent) {
      break
    }

    visited.add(up)
    chain.unshift({ id: parent.id, name: parent.name })
  }

  return chain
}

/** Every section nested anywhere under `id` (not `id` itself). */
export function sectionDescendantIds(id: string, sections: BotSection[]): Set<string> {
  const out = new Set<string>()
  const queue = [id]

  while (queue.length) {
    const current = queue.shift()!

    for (const section of sections) {
      if (section.parentId === current && !out.has(section.id) && section.id !== id) {
        out.add(section.id)
        queue.push(section.id)
      }
    }
  }

  return out
}

/** The tree as a depth-first list in display order, for menus that list every
 *  section with indentation. */
export function flattenSectionTree(sections: BotSection[]): { depth: number; section: BotSection }[] {
  const list = normalizeBotSections(sections)
  const out: { depth: number; section: BotSection }[] = []

  const walk = (parentId: null | string, depth: number) => {
    for (const section of list) {
      if ((section.parentId || null) === parentId) {
        out.push({ depth, section })
        walk(section.id, depth + 1)
      }
    }
  }

  walk(null, 0)

  return out
}

/** Position among siblings (same parent), which is what Move up / Move down
 *  reorder. */
export function sectionSiblingPosition(id: string, sections: BotSection[]): { count: number; index: number } {
  const parentId = sections.find(s => s.id === id)?.parentId || null
  const siblings = sections.filter(s => (s.parentId || null) === parentId)

  return { count: siblings.length, index: siblings.findIndex(s => s.id === id) }
}

function persistBotSections(next: BotSection[]): void {
  $botSections.set(next)

  try {
    getPluginCtx()?.storage?.set?.(BOT_SECTIONS_KEY, next)
  } catch {
    // No storage — sections live for this window only, which is strictly
    // better than the pane throwing while the user drags a bot into a folder.
  }
}

/** Read the persisted list back at plugin start. */
export function loadBotSections(): void {
  try {
    $botSections.set(normalizeBotSections(getPluginCtx()?.storage?.get?.(BOT_SECTIONS_KEY, [])))
  } catch {
    $botSections.set([])
  }
}

function newSectionId(): string {
  return `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Create a section — nested under `parentId` when given — and file `bots`
 *  into it. Returns the new section, or null when the name is blank. */
export function createBotSection(name: string, bots: RosterRow[] = [], parentId?: null | string): BotSection | null {
  const clean = String(name || '').trim()

  if (!clean) {
    return null
  }

  const list = $botSections.get()

  const section: BotSection =
    parentId && list.some(s => s.id === parentId)
      ? { id: newSectionId(), name: clean, parentId }
      : { id: newSectionId(), name: clean }

  persistBotSections([...list, section])
  void moveBotsToSection(bots, section.id)

  return section
}

/** Re-stamp the members of `ids` (in that order), whose carried name or
 *  ancestry just changed, so other desktops rebuild the same tree. */
async function restampSections(ids: Iterable<string>, roster: RosterRow[]): Promise<void> {
  const list = [...ids]

  for (const id of list) {
    pendingRestamps.set(id, (pendingRestamps.get(id) || 0) + 1)
  }

  try {
    for (const id of list) {
      await moveBotsToSection(
        (roster || []).filter(bot => botSectionId(bot, $botMeta.get()) === id),
        id
      )
    }
  } finally {
    for (const id of list) {
      const left = (pendingRestamps.get(id) || 1) - 1

      if (left) {
        pendingRestamps.set(id, left)
      } else {
        pendingRestamps.delete(id)
      }
    }
  }
}

export function renameBotSection(id: string, name: string, roster: RosterRow[] = []): void {
  const clean = String(name || '').trim()

  if (!clean) {
    return
  }

  const list = $botSections.get().map(s => (s.id === id ? { ...s, name: clean } : s))

  persistBotSections(list)
  // Members carry the name with their membership (see moveBotsToSection), so
  // a rename re-stamps them — that is how the new name reaches other desktops.
  // Members of nested sections carry it in their ancestry, so they re-stamp too.
  void restampSections([id, ...sectionDescendantIds(id, list)], roster)
}

/**
 * Nest section `id` under `parentId` (`null` lifts it to the top level). It
 * lands last among its new siblings, and its whole subtree comes with it.
 * Refused — returns false — when `parentId` is the section itself or one of
 * its own descendants, which would detach the subtree from the tree.
 */
export function setBotSectionParent(id: string, parentId: null | string, roster: RosterRow[] = []): boolean {
  const list = $botSections.get()
  const section = list.find(s => s.id === id)
  const descendants = sectionDescendantIds(id, list)

  if (
    !section ||
    (parentId && (parentId === id || descendants.has(parentId) || !list.some(s => s.id === parentId))) ||
    (section.parentId || null) === (parentId || null)
  ) {
    return false
  }

  const moved: BotSection = parentId ? { ...section, parentId } : { id: section.id, name: section.name }

  persistBotSections([...list.filter(s => s.id !== id), moved])
  void restampSections([id, ...descendants], roster)

  return true
}

/**
 * Sections another desktop made. The section RECORD lives in that machine's
 * plugin storage, but every member's ui_meta reaches this machine carrying the
 * section's id AND name — so rebuild the records we have never seen, and the
 * roster draws the same folders here. A known section takes the members' name
 * only when every member agrees on it (a rename elsewhere, fully stamped);
 * while members disagree — a re-stamp still in flight — the local name stays.
 * Order and empty sections remain this desktop's own. The roster pane calls
 * this on every roster/meta change.
 */
export function adoptBotSectionsFromMeta(roster: RosterRow[], metaByName: Record<string, BotMeta>): void {
  const names = new Map<string, Set<string>>()
  // Parent votes: '' is "top level". Only members that carry an ancestry
  // field vote — a member filed before nesting existed says nothing about it.
  const parents = new Map<string, Set<string>>()

  const note = (id: string, name: string, parentId?: string) => {
    names.set(id, (names.get(id) || new Set()).add(name))

    if (parentId !== undefined) {
      parents.set(id, (parents.get(id) || new Set()).add(parentId))
    }
  }

  for (const bot of roster || []) {
    const meta = bot ? botRosterMeta(bot, metaByName) : null
    const id = meta?.sectionId ? String(meta.sectionId) : null
    const name = String(meta?.sectionName || '').trim()

    if (!id || !name) {
      continue
    }

    const carried = meta?.sectionParents
    const chain = normalizeSectionAncestors(carried)

    chain.forEach((link, i) => note(link.id, link.name, i ? chain[i - 1]!.id : ''))
    note(id, name, chain.length ? chain.at(-1)!.id : carried === null ? '' : undefined)
  }

  const agreed = (votes: Map<string, Set<string>>, id: string): null | string => {
    const set = votes.get(id)

    return set?.size === 1 ? [...set][0]! : null
  }

  const local = $botSections.get()
  const known = new Set(local.map(s => s.id))

  // A section whose members this desktop is still re-stamping keeps its local
  // name and parent: the members' stale values are the change in flight, not
  // a change made elsewhere.
  const settled = (id: string) => !pendingRestamps.has(id)

  const withParent = (section: BotSection, parentId: null | string): BotSection =>
    parentId ? { ...section, parentId } : { id: section.id, name: section.name }

  const updated = local.map(s => {
    if (!settled(s.id)) {
      return s
    }

    const parent = agreed(parents, s.id)

    return withParent({ ...s, name: agreed(names, s.id) ?? s.name }, parent === null ? s.parentId || null : parent)
  })

  const adopted = [...names.keys()]
    .filter(id => !known.has(id) && !pendingSectionDeletes.has(id))
    .map(id => withParent({ id, name: [...names.get(id)!][0]! }, [...(parents.get(id) || [])][0] || null))

  const next = normalizeBotSections([...updated, ...adopted])

  if (
    next.length !== local.length ||
    next.some(
      (s, i) =>
        s.id !== local[i]?.id || s.name !== local[i]?.name || (s.parentId || null) !== (local[i]?.parentId || null)
    )
  ) {
    persistBotSections(next)
  }
}

function normalizeSectionAncestors(value: unknown): SectionAncestor[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(link => ({
      id: String((link as SectionAncestor)?.id || '').trim(),
      name: String((link as SectionAncestor)?.name || '').trim()
    }))
    .filter(link => link.id && link.name)
}

/**
 * The other half of adoptBotSectionsFromMeta: bots filed before the name rode
 * along carry only `sectionId`, and a desktop that never made that section
 * has nothing to rebuild it from. So the desktop that DOES know the section —
 * usually the one that created it — stamps the name onto every such member
 * through the same one-write-per-profile path filing uses. Returns the members
 * being stamped. Runs once per member: the write sets `sectionName`, so the
 * next roster pass finds nothing to do. Members of a section nobody here
 * knows are left alone — there is no name to give them.
 */
export function backfillBotSectionNames(roster: RosterRow[], metaByName: Record<string, BotMeta>): RosterRow[] {
  const list = $botSections.get()
  const known = new Set(list.map(s => s.id))
  const bySection = new Map<string, RosterRow[]>()

  for (const bot of roster || []) {
    const meta = bot ? botRosterMeta(bot, metaByName) : null
    const id = meta?.sectionId ? String(meta.sectionId) : null

    // A member of a NESTED section filed without its ancestry (by a desktop
    // that predates nesting) needs it stamped for the same reason it needs
    // the name: so other desktops can rebuild where the section sits.
    const missingAncestry =
      Boolean(id) && !Array.isArray(meta?.sectionParents) && sectionAncestors(id!, list).length > 0

    if (id && known.has(id) && (!String(meta?.sectionName || '').trim() || missingAncestry)) {
      bySection.set(id, [...(bySection.get(id) || []), bot])
    }
  }

  for (const [id, members] of bySection) {
    void moveBotsToSection(members, id)
  }

  return [...bySection.values()].flat()
}

/**
 * Delete the section only. Its members are not deleted and not hidden — they
 * move up to the section's parent (Unassigned for a top-level section), which
 * is the whole reason membership lives on the bot rather than on the section.
 * Its child sections move up a level the same way. Returns an undo that puts
 * the section back in its slot, re-nests its children and refiles the same
 * bots, so the delete needs no confirmation.
 */
export function deleteBotSection(id: string, roster: RosterRow[] = []): { members: RosterRow[]; undo: () => void } {
  const list = $botSections.get()
  const index = list.findIndex(s => s.id === id)
  const section = list[index]
  const parentId = section?.parentId || null
  const members = (roster || []).filter(bot => botSectionId(bot, $botMeta.get()) === id)
  const children = list.filter(s => s.parentId === id).map(s => s.id)
  const descendants = sectionDescendantIds(id, list)

  const reparent = (sections: BotSection[], ids: string[], to: null | string) =>
    sections.map(s => (ids.includes(s.id) ? (to ? { ...s, parentId: to } : { id: s.id, name: s.name }) : s))

  const token = Symbol(id)

  pendingSectionDeletes.set(id, token)
  persistBotSections(
    reparent(
      list.filter(s => s.id !== id),
      children,
      parentId
    )
  )
  // The descendants' members carry the deleted section in their ancestry;
  // until they are re-stamped it must not be adopted back from them.
  void moveBotsToSection(members, parentId)
    .then(() => restampSections(descendants, roster))
    .finally(() => {
      if (pendingSectionDeletes.get(id) === token) {
        pendingSectionDeletes.delete(id)
      }
    })

  return {
    members,
    undo: () => {
      if (!section) {
        return
      }

      pendingSectionDeletes.delete(id)
      const current = $botSections.get().filter(s => s.id !== id)

      current.splice(Math.min(index, current.length), 0, section)
      persistBotSections(reparent(current, children, id))
      void moveBotsToSection(members, id).then(() => restampSections(descendants, roster))
    }
  }
}

/** Swap `id` with its neighbour among its siblings (`delta` -1 / +1). */
export function moveBotSection(id: string, delta: number): void {
  const list = $botSections.get()
  const section = list.find(s => s.id === id)

  if (!section) {
    return
  }

  const siblings = list.filter(s => (s.parentId || null) === (section.parentId || null))
  const other = siblings[siblings.indexOf(section) + delta]

  if (!other) {
    return
  }

  const next = list.slice()

  next[list.indexOf(section)] = other
  next[list.indexOf(other)] = section
  persistBotSections(next)
}

/**
 * `null` clears the assignment (back to Unassigned). One `saveBotMeta` per
 * bot — membership is a field on each bot's own profile, so that IS one write
 * per profile — and the writes run in sequence rather than fanned out, so the
 * shared local snapshot is never committed by two saves at once. The section's
 * NAME rides along: the record itself is local to the desktop that made it,
 * and the name is what lets another desktop rebuild it (adoptBotSectionsFromMeta).
 */
export async function moveBotsToSection(bots: RosterRow[], sectionId: null | string): Promise<void> {
  const sectionName = (sectionId && $botSections.get().find(s => s.id === sectionId)?.name) || null
  const ancestors = sectionId ? sectionAncestors(sectionId, $botSections.get()) : []

  for (const bot of bots || []) {
    if (!bot) {
      continue
    }

    // Deleted while this loop was still walking its members (a rename's
    // re-stamp stuck behind a slow write): filing the rest would put them back
    // into a section that no longer exists.
    if (sectionId && !$botSections.get().some(s => s.id === sectionId)) {
      return
    }

    const current = botRosterMeta(bot, $botMeta.get())
    const carried = normalizeSectionAncestors(current?.sectionParents)
    // Ancestry is written only when there is some to write or some to clear,
    // so filing into a top-level section writes exactly what it always did.
    const ancestryChanged = JSON.stringify(carried) !== JSON.stringify(ancestors)

    if (
      botSectionId(bot, $botMeta.get()) !== (sectionId || null) ||
      (current?.sectionName || null) !== sectionName ||
      ancestryChanged
    ) {
      await saveBotMeta(bot, {
        sectionId: sectionId || null,
        sectionName,
        ...(ancestors.length || carried.length ? { sectionParents: ancestors.length ? ancestors : null } : {})
      })
    }
  }
}

export function botSectionId(bot: RosterRow, metaByName: Record<string, BotMeta>): null | string {
  const id = botRosterMeta(bot, metaByName)?.sectionId

  return id ? String(id) : null
}

// ── group chats ──────────────────────────────────────────────────────────────
//
// A group chat files into a section by the same membership-on-the-item rule as
// a bot, but a group has no profile meta to carry the field — its room record
// is its only durable identity. So the assignment is a field on the room and
// rides the room's own persistence (plugin storage), which is also why it is
// deliberately NOT part of the bounded gateway sync projection: that mirror
// carries conversations to other clients, not this machine's sidebar layout —
// the same local scope the section list itself has.

/** The drag payload prefix that marks an in-flight GROUP row (vs a bot's
 *  roster key). */
export const GROUP_DRAG_PREFIX = 'group:'

export function groupDragKey(name: string): string {
  return `${GROUP_DRAG_PREFIX}${name}`
}

/** A group's section, off the live room record. */
export function groupChatSectionId(name: string, rooms: Record<string, GroupChat>): null | string {
  const id = rooms?.[name]?.sectionId

  return id ? String(id) : null
}

/** File `groups` into a section (`null` clears, back to the group-chat
 *  bucket). One room write per group whose assignment actually changes,
 *  through `updateGroupChat` so the durable record and the atom move together. */
export function moveGroupChatsToSection(groups: string[], sectionId: null | string): void {
  for (const name of groups || []) {
    if (!name || groupChatSectionId(name, $groupChats.get()) === (sectionId || null)) {
      continue
    }

    updateGroupChat(
      name,
      (room: GroupChat) => ({
        ...room,
        sectionId: sectionId || null
      }),
      // Layout-only: no reason to publish the conversation projection.
      { sync: false }
    )
  }
}

export interface SectionBlock<TRow> {
  id: null | string
  key: string
  name: string
  rows: TRow[]
}

/**
 * Split roster rows into section blocks, in section order, with Unassigned
 * last. Pure, and returns EVERY row exactly once: a row whose `sectionId`
 * names a section that no longer exists lands in Unassigned rather than
 * vanishing, which is what makes deleting a section safe. Group rows seat per
 * their room record's `sectionId` (`rooms`); a group with no room yet is
 * unassigned.
 */
export function groupRowsBySection<TRow extends { bot?: RosterRow } | RosterRow>(
  rows: TRow[],
  sections: unknown,
  metaByName: Record<string, BotMeta>,
  groupRooms: Record<string, GroupChat> = {}
): SectionBlock<TRow>[] {
  const list = normalizeBotSections(sections)
  const known = new Set(list.map(s => s.id))
  const byId = new Map<string, TRow[]>(list.map(s => [s.id, [] as TRow[]]))
  const loose: TRow[] = []

  for (const row of rows || []) {
    const group = (row as { kind?: string; name?: string })?.kind === 'group' ? row : null

    const id = group
      ? groupChatSectionId(String((group as { name?: string }).name || ''), groupRooms)
      : botSectionId(((row as { bot?: RosterRow })?.bot || row) as RosterRow, metaByName)

    if (id && known.has(id)) {
      byId.get(id)!.push(row)
    } else {
      loose.push(row)
    }
  }

  const blocks: SectionBlock<TRow>[] = list.map(section => ({
    id: section.id,
    key: `section:${section.id}`,
    name: section.name,
    rows: byId.get(section.id) || []
  }))

  blocks.push({ id: null, key: UNASSIGNED_SECTION_KEY, name: '', rows: loose })

  return blocks
}

export interface SectionTreeNode<TRow> {
  block: SectionBlock<TRow>
  children: SectionTreeNode<TRow>[]
  /** Rows in this section and every section nested under it — the heading's
   *  count, so a collapsed parent still says how many bots it holds. */
  total: number
}

/**
 * Arrange `groupRowsBySection`'s flat blocks into the section tree (sibling
 * order as stored), with Unassigned kept last at the top level. Pure.
 */
export function nestSectionBlocks<TRow>(blocks: SectionBlock<TRow>[], sections: unknown): SectionTreeNode<TRow>[] {
  const list = normalizeBotSections(sections)
  const byId = new Map(blocks.filter(b => b.id).map(b => [b.id!, b]))

  const build = (parentId: null | string): SectionTreeNode<TRow>[] =>
    list
      .filter(s => (s.parentId || null) === parentId && byId.has(s.id))
      .map(s => {
        const block = byId.get(s.id)!
        const children = build(s.id)

        return { block, children, total: block.rows.length + children.reduce((n, c) => n + c.total, 0) }
      })

  const unassigned = blocks.find(b => !b.id)

  return [...build(null), ...(unassigned ? [{ block: unassigned, children: [], total: unassigned.rows.length }] : [])]
}

// ── drag and drop ────────────────────────────────────────────────────────────
//
// Filing a bot by dragging it onto a section, which is the gesture people
// reach for first; the row's "Move to section" submenu is the same action
// for anyone who does not.
//
// A CUSTOM MIME TYPE, not `text/plain`: the roster shares a window with the
// composer, the transcript and the tab strip, all of which accept dropped
// text. A private type means a bot dragged onto any of them is simply not a
// valid payload there, instead of pasting its roster key into someone's
// message. `dataTransfer.types` is readable during dragover (the DATA itself
// is not, by design), so a drop target can still light up correctly.

export const BOT_DRAG_MIME = 'application/x-hermes-bot-key'
