/**
 * The org chart is the roster's sections drawn as a tree — not a second
 * model. These pin that it nests exactly as the sections do, counts a
 * subtree, keeps empty sections (somewhere to file a bot), and leaves hidden
 * bots out the way the roster's sections do.
 */

import { describe, expect, it } from 'vitest'

import { buildOrgChart } from './org-chart'
import type { RosterRow } from './types'

const bot = (name: string) => ({ name }) as RosterRow

const sections = [
  { id: 'oil', name: 'One Infinity Labs' },
  { id: 'labs', name: '1Labs AI', parentId: 'oil' },
  { id: 'foundation', name: 'Virusha Foundation' }
]

describe('buildOrgChart', () => {
  it('nests the sections, counts each subtree, and keeps empty sections', () => {
    const chart = buildOrgChart([bot('shiven'), bot('ayan'), bot('loose')], sections, {
      shiven: { sectionId: 'oil' },
      ayan: { sectionId: 'labs' }
    })

    expect(
      chart.roots.map(node => [
        node.section.name,
        node.total,
        node.bots.map(b => b.name),
        node.children.map(c => [c.section.name, c.bots.map(b => b.name)])
      ])
    ).toEqual([
      ['One Infinity Labs', 2, ['shiven'], [['1Labs AI', ['ayan']]]],
      ['Virusha Foundation', 0, [], []]
    ])
    expect(chart.unassigned.map(b => b.name)).toEqual(['loose'])
  })

  it('leaves hidden bots and ghost rows out', () => {
    const chart = buildOrgChart([bot('shiven'), bot('worker'), { name: 'twin', ghost: true } as RosterRow], sections, {
      shiven: { sectionId: 'oil' },
      worker: { hidden: true, sectionId: 'oil' },
      twin: { sectionId: 'oil' }
    })

    expect(chart.roots[0]!.bots.map(b => b.name)).toEqual(['shiven'])
    expect(chart.roots[0]!.total).toBe(1)
  })

  it("leaves out a connection's bare default profile but keeps a named or filed one", () => {
    const laptop = { connectionId: 'local', connectionLabel: 'This MacBook', name: 'default', remoteSource: true } as RosterRow
    const studio = { connectionId: 'studio', display_name: 'Ariv', name: 'default', remoteSource: true } as RosterRow
    const filed = { connectionId: 'other', name: 'default', sourceScoped: true } as RosterRow

    const chart = buildOrgChart([laptop, studio, filed, bot('loose')], sections, {
      'other::default': { sectionId: 'foundation' }
    })

    expect(chart.unassigned.map(b => b.connectionId ?? b.name)).toEqual(['studio', 'loose'])
    expect(chart.roots.find(node => node.section.id === 'foundation')!.bots.map(b => b.connectionId)).toEqual(['other'])
  })
})
