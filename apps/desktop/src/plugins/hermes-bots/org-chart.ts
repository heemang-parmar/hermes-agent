/**
 * ORG CHART — the roster's user sections drawn as a hierarchy.
 *
 * Not a second organisation model: the chart IS the Bots pane's sections
 * (`user-sections.ts`) — same tree, same membership on each bot — so filing a
 * bot or nesting a section in the roster moves it here too, and the chart can
 * never disagree with the sidebar. Hidden bots stay out, as they do in the
 * roster's sections. Pure; the pane renders it.
 */

import { isBotHidden } from './hidden-bots'
import type { BotMeta, RosterRow } from './types'
import { type BotSection, groupRowsBySection, nestSectionBlocks, type SectionTreeNode } from './user-sections'

export interface OrgChartNode {
  bots: RosterRow[]
  children: OrgChartNode[]
  section: BotSection
  /** Bots in this section and every section under it. */
  total: number
}

export interface OrgChart {
  roots: OrgChartNode[]
  /** Visible bots filed in no section — drawn after the tree. */
  unassigned: RosterRow[]
}

export function buildOrgChart(
  roster: RosterRow[],
  sections: BotSection[],
  metaByName: Record<string, BotMeta>
): OrgChart {
  const visible = (roster || []).filter(bot => bot && !bot.ghost && !isBotHidden(bot, metaByName))
  const tree = nestSectionBlocks(groupRowsBySection(visible, sections, metaByName), sections)
  const byId = new Map(sections.map(section => [section.id, section]))

  const convert = (node: SectionTreeNode<RosterRow>): OrgChartNode => ({
    bots: node.block.rows,
    children: node.children.map(convert),
    section: byId.get(node.block.id!)!,
    total: node.total
  })

  return {
    roots: tree.filter(node => node.block.id && byId.has(node.block.id)).map(convert),
    unassigned: tree.find(node => !node.block.id)?.block.rows ?? []
  }
}
