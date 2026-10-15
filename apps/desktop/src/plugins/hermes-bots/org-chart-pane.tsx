/**
 * The org chart workspace tab: the roster's sections drawn as an organisation
 * on a pannable, zoomable canvas. Every bot card opens that bot's chat — the
 * same open path as a roster row click. The data is `org-chart.ts`; colours
 * are `section-colors.ts` (the same ones the roster's folders wear); this file
 * is layout and the canvas gestures.
 *
 * Layout, top to bottom — the shape of a classic org chart:
 *   * the FIRST section (the founder's office) as a banner, its first bot as
 *     the large centre card and the rest beside it;
 *   * the companies — every other section of ordinary size — as tinted
 *     columns hanging off one rail: the section's first bot is its lead,
 *     drawn large, the rest listed under it, and nested sections as inset
 *     panels inside the column;
 *   * large sections (departments) as full-width panels of portrait tiles,
 *     one labelled row per nested section.
 * Sections with no visible bot anywhere in them are left out: the chart shows
 * who is there, the roster is where folders are managed.
 */

import { Button, cn, Codicon, host, Tip, useValue } from '@hermes/plugin-sdk'
import { type CSSProperties, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { avatarColor, botAppearance, BotFace } from './avatar'
import { isBackfilledFacePng } from './avatar-image'
import { botDesignation } from './bot-row-subtitle'
import { $botMeta, botRosterKey, useRoster } from './data'
import { botsText, useBots } from './i18n'
import { displayName } from './labels'
import { buildOrgChart, type OrgChartNode } from './org-chart'
import { openRosterBot } from './roster-actions'
import { botRosterMeta } from './routing'
import { SECTION_PALETTE, sectionColor, sectionTint } from './section-colors'
import { ID } from './shared'
import type { RosterRow } from './types'
import { $botSections, type BotSection } from './user-sections'

const MIN_SCALE = 0.25
const MAX_SCALE = 2
const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

/** With no section marked "shared department", a top-level section this big
 *  is drawn as a department panel rather than a company column. */
const DEPARTMENT_MIN_BOTS = 8

const SERIF: CSSProperties = { fontFamily: 'ui-serif, "New York", Georgia, "Times New Roman", serif' }

/** Readable accent text on either theme. */
const accentText = (color: string) => `color-mix(in srgb, ${color} 72%, var(--ui-text-primary))`

/** Open (or front) the org chart tab. */
export function openOrgChart(): void {
  if (typeof host.openWorkspace !== 'function') {
    host.notify({ kind: 'info', message: botsText().screen.openNeedsUpdate })

    return
  }

  host.openWorkspace(`${ID}:org-chart`, {
    minWidth: '24rem',
    render: () => <OrgChartPane />,
    title: botsText().org.title
  })
}

// ── one bot, three sizes ─────────────────────────────────────────────────────

function useBotCard(bot: RosterRow) {
  const b = useBots()
  const allMeta = useValue($botMeta)
  const meta = botRosterMeta(bot, allMeta)
  const name = displayName(bot, meta)
  const { color, image, shape } = botAppearance(bot.name, meta)
  const photo = Boolean(image && !isBackfilledFacePng(image))

  const face = (size: number) => (
    <BotFace
      color={avatarColor(color, bot.name)}
      image={photo ? image : null}
      name={bot.name}
      shape={shape}
      size={size}
    />
  )

  return { designation: botDesignation(bot, meta), face, label: b.org.chatWith(name), name }
}

const CARD_BUTTON =
  'min-w-0 rounded-lg text-left transition-[background-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-md focus-visible:ring-2 focus-visible:ring-(--ui-accent) focus-visible:outline-none'

/** A section's lead: large face, serif name. */
function BotHero({ bot, color, size = 'md' }: { bot: RosterRow; color: string; size?: 'lg' | 'md' }) {
  const { designation, face, label, name } = useBotCard(bot)
  const large = size === 'lg'

  return (
    <Tip label={label}>
      <button
        aria-label={label}
        className={cn(CARD_BUTTON, 'flex w-full items-center gap-3 p-2 hover:bg-(--ui-bg-elevated)/60')}
        data-slot="org-chart-bot"
        onClick={() => void openRosterBot(bot)}
        type="button"
      >
        {face(large ? 72 : 56)}
        <span className="min-w-0 flex-1">
          <span
            className={cn('block truncate leading-tight font-semibold', large ? 'text-[1.75rem]' : 'text-[1.375rem]')}
            style={{ ...SERIF, color: accentText(color) }}
          >
            {name}
          </span>
          {designation ? (
            <span className="mt-0.5 block text-[0.75rem] leading-snug text-(--ui-text-secondary)">{designation}</span>
          ) : null}
        </span>
      </button>
    </Tip>
  )
}

/** A team member under a lead. */
function BotListRow({ bot, color }: { bot: RosterRow; color: string }) {
  const { designation, face, label, name } = useBotCard(bot)

  return (
    <Tip label={label}>
      <button
        aria-label={label}
        className={cn(CARD_BUTTON, 'flex w-full items-center gap-2.5 px-2 py-1.5 hover:bg-(--ui-bg-secondary)')}
        data-slot="org-chart-bot"
        onClick={() => void openRosterBot(bot)}
        type="button"
      >
        {face(40)}
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[0.9375rem] leading-tight font-semibold"
            style={{ ...SERIF, color: accentText(color) }}
          >
            {name}
          </span>
          {designation ? (
            <span className="block truncate text-[0.6875rem] text-(--ui-text-tertiary)">{designation}</span>
          ) : null}
        </span>
      </button>
    </Tip>
  )
}

/** A department member: portrait tile. */
function BotTile({ bot, color }: { bot: RosterRow; color: string }) {
  const { designation, face, label, name } = useBotCard(bot)

  return (
    <Tip label={label}>
      <button
        aria-label={label}
        className={cn(CARD_BUTTON, 'flex flex-col items-center gap-1.5 border px-2 pt-3 pb-2.5 text-center')}
        data-slot="org-chart-bot"
        onClick={() => void openRosterBot(bot)}
        style={{ background: sectionTint(color, 9), borderColor: sectionTint(color, 32) }}
        type="button"
      >
        {face(56)}
        <span
          className="block w-full truncate text-[0.9375rem] leading-tight font-semibold"
          style={{ ...SERIF, color: accentText(color) }}
        >
          {name}
        </span>
        {designation ? (
          <span className="line-clamp-2 block w-full text-[0.6875rem] leading-snug text-(--ui-text-tertiary)">
            {designation}
          </span>
        ) : null}
      </button>
    </Tip>
  )
}

// ── sections ─────────────────────────────────────────────────────────────────

function countLabel(total: number) {
  return `${total} ${total === 1 ? 'bot' : 'bots'}`
}

/** A nested section inside a company column: an inset panel, labelled, with
 *  its own nested sections indented under a rail in the company colour. */
function InsetSection({ color, node }: { color: string; node: OrgChartNode }) {
  return (
    <div
      className="rounded-lg border bg-(--ui-bg-elevated) p-1.5"
      data-slot="org-chart-section"
      style={{ borderColor: sectionTint(color, 28) }}
    >
      <div
        className="flex items-center gap-1.5 px-2 pt-1 pb-1 text-[0.625rem] font-semibold tracking-wider uppercase"
        style={{ color: accentText(color) }}
      >
        <span className="min-w-0 flex-1 truncate">{node.section.name}</span>
        <span className="shrink-0 font-normal tabular-nums opacity-70">{node.total}</span>
      </div>
      {node.bots.map(bot => (
        <BotListRow bot={bot} color={color} key={botRosterKey(bot)} />
      ))}
      {node.children.length ? (
        <div className="mt-1 ml-2 grid gap-1.5 border-l-2 pl-2" style={{ borderColor: sectionTint(color, 40) }}>
          {node.children.map(child => (
            <InsetSection color={color} key={child.section.id} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A company: tinted column, its lead large, the team and nested sections
 *  under it. */
function CompanyColumn({ color, node }: { color: string; node: OrgChartNode }) {
  const [lead, ...team] = node.bots

  return (
    <div
      className="flex w-[19rem] flex-col gap-2 rounded-2xl border-[1.5px] p-3 shadow-sm"
      data-slot="org-chart-section"
      style={{ background: sectionTint(color, 10), borderColor: sectionTint(color, 45) }}
    >
      <div className="px-1">
        <div className="text-[1.125rem] leading-tight font-bold" style={{ ...SERIF, color: accentText(color) }}>
          {node.section.name}
        </div>
        <div className="mt-0.5 text-[0.6875rem] text-(--ui-text-tertiary)">{countLabel(node.total)}</div>
      </div>
      {lead ? <BotHero bot={lead} color={color} /> : null}
      {team.length || node.children.length ? (
        <div className="grid gap-1.5">
          {team.length ? (
            <div
              className="rounded-lg border bg-(--ui-bg-elevated) p-1"
              style={{ borderColor: sectionTint(color, 28) }}
            >
              {team.map(bot => (
                <BotListRow bot={bot} color={color} key={botRosterKey(bot)} />
              ))}
            </div>
          ) : null}
          {node.children.map(child => (
            <InsetSection color={color} key={child.section.id} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A department: full-width panel of portrait tiles, one labelled row per
 *  nested section. Tiles cycle the palette so a big team stays scannable. */
function DepartmentPanel({ color, node }: { color: string; node: OrgChartNode }) {
  const tones = Object.values(SECTION_PALETTE)

  const rows: { bots: RosterRow[]; key: string; label: null | string }[] = [
    ...(node.bots.length ? [{ bots: node.bots, key: 'direct', label: null }] : []),
    ...flattenForTiles(node.children)
  ]

  let tone = 0

  return (
    <section className="w-full" data-slot="org-chart-section">
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h3 className="text-[1.125rem] font-bold" style={{ ...SERIF, color: accentText(color) }}>
          {node.section.name}
        </h3>
        <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{countLabel(node.total)}</span>
      </div>
      <div
        className="grid gap-4 rounded-2xl border bg-(--ui-bg-elevated) p-4 shadow-sm"
        style={{ borderColor: sectionTint(color, 30) }}
      >
        {rows.map(row => (
          <div key={row.key}>
            {row.label ? (
              <div className="mb-2 text-[0.625rem] font-semibold tracking-wider text-(--ui-text-tertiary) uppercase">
                {row.label}
              </div>
            ) : null}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5">
              {row.bots.map(bot => (
                <BotTile bot={bot} color={tones[tone++ % tones.length]!} key={botRosterKey(bot)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** A department's nested sections as tile rows, depth-first, labelled with
 *  their path below the department. */
function flattenForTiles(
  nodes: OrgChartNode[],
  prefix = ''
): { bots: RosterRow[]; key: string; label: null | string }[] {
  return nodes.flatMap(node => {
    const label = prefix ? `${prefix} · ${node.section.name}` : node.section.name

    return [
      ...(node.bots.length ? [{ bots: node.bots, key: node.section.id, label }] : []),
      ...flattenForTiles(node.children, label)
    ]
  })
}

/** The founder's office: the first bot as the large centre card, the others
 *  beside it, all in the section's colour. */
function LeadershipBanner({ color, node }: { color: string; node: OrgChartNode }) {
  const [principal, ...others] = node.bots
  const left = others.filter((_, i) => i % 2 === 1)
  const right = others.filter((_, i) => i % 2 === 0)

  const side = (bots: RosterRow[]) =>
    bots.map(bot => (
      <div
        className="w-[17rem] rounded-xl border p-2 shadow-sm"
        key={botRosterKey(bot)}
        style={{ background: sectionTint(color, 7), borderColor: sectionTint(color, 30) }}
      >
        <BotHero bot={bot} color={color} />
      </div>
    ))

  return (
    <div className="flex flex-col items-center" data-slot="org-chart-section">
      <div
        className="mb-3 text-[0.6875rem] font-semibold tracking-[0.2em] uppercase"
        style={{ color: accentText(color) }}
      >
        {node.section.name}
      </div>
      <div className="flex items-center gap-6">
        {side(left)}
        {principal ? (
          <div
            className="w-[21rem] rounded-2xl border-[1.5px] p-3 shadow-md"
            style={{ background: sectionTint(color, 12), borderColor: sectionTint(color, 50) }}
          >
            <BotHero bot={principal} color={color} size="lg" />
          </div>
        ) : null}
        {side(right)}
      </div>
      {node.children.length ? (
        <div className="mt-3 flex gap-3">
          {node.children.map(child => (
            <div className="w-[17rem]" key={child.section.id}>
              <InsetSection color={color} node={child} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── the organisation ─────────────────────────────────────────────────────────

const LINE = 'bg-(--ui-stroke-secondary)'

function Organization({
  roots,
  sections,
  unassigned
}: {
  roots: OrgChartNode[]
  sections: BotSection[]
  unassigned: RosterRow[]
}) {
  const b = useBots()
  const colorOf = (node: OrgChartNode) => sectionColor(node.section.id, sections)

  // The founder's office leads only when there is something under it.
  const [head, ...rest] = roots.length > 1 ? roots : [undefined, ...roots]
  // The roster's "shared department" mark decides; the size rule is only the
  // fallback for a roster that has never marked one.
  const anyMarked = sections.some(section => section.shared)

  const isDepartment = (node: OrgChartNode) =>
    anyMarked ? Boolean(node.section.shared) : node.total >= DEPARTMENT_MIN_BOTS

  const companies = rest.filter(node => node && !isDepartment(node)) as OrgChartNode[]
  const departments = rest.filter(node => node && isDepartment(node)) as OrgChartNode[]

  return (
    <div className="flex min-w-[60rem] flex-col items-stretch gap-8 p-6">
      {head ? <LeadershipBanner color={colorOf(head)} node={head} /> : null}

      {companies.length ? (
        <div className="flex flex-col items-center">
          {head ? <div className={cn('h-6 w-px', LINE)} /> : null}
          <div className="flex items-start">
            {companies.map((node, i) => (
              <div className="relative flex flex-col items-center px-2.5 pt-6" key={node.section.id}>
                {companies.length > 1 ? (
                  <div
                    className={cn(
                      'absolute top-0 h-px',
                      LINE,
                      i === 0 ? 'right-0 left-1/2' : i === companies.length - 1 ? 'right-1/2 left-0' : 'right-0 left-0'
                    )}
                  />
                ) : null}
                <div className={cn('absolute top-0 left-1/2 h-6 w-px', LINE)} />
                <CompanyColumn color={colorOf(node)} node={node} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {departments.map(node => (
        <DepartmentPanel color={colorOf(node)} key={node.section.id} node={node} />
      ))}

      {unassigned.length ? (
        <DepartmentPanel
          color={SECTION_PALETTE.slate}
          node={{
            bots: unassigned,
            children: [],
            section: { id: 'unassigned', name: b.sections.unassigned },
            total: unassigned.length
          }}
        />
      ) : null}
    </div>
  )
}

/** Drop sections with no visible bot anywhere under them. */
function populated(nodes: OrgChartNode[]): OrgChartNode[] {
  return nodes.filter(node => node.total > 0).map(node => ({ ...node, children: populated(node.children) }))
}

// ── canvas ───────────────────────────────────────────────────────────────────

interface View {
  scale: number
  x: number
  y: number
}

export function OrgChartPane() {
  const b = useBots()
  const { data } = useRoster()
  const allMeta = useValue($botMeta)
  const sections = useValue($botSections)
  const roster = useMemo(() => (Array.isArray(data?.profiles) ? (data.profiles as RosterRow[]) : []), [data])
  const chart = useMemo(() => buildOrgChart(roster, sections, allMeta), [roster, sections, allMeta])
  const roots = useMemo(() => populated(chart.roots), [chart])

  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const drag = useRef<null | { id: number; x: number; y: number }>(null)
  // Until the user pans or zooms, the chart keeps itself fitted as it grows
  // (rosters and avatars land over several renders); after that the view is
  // theirs and only the Fit button re-fits.
  const touched = useRef(false)

  const markTouched = useCallback(() => {
    touched.current = true
  }, [])

  const fit = useCallback(() => {
    const viewport = viewportRef.current
    const content = contentRef.current

    if (!viewport || !content || !viewport.clientWidth) {
      return
    }

    // offsetWidth/Height are the UNtransformed size, which is what the scale
    // multiplies. Fit the width; a tall chart scrolls.
    const width = content.offsetWidth
    const scale = clampScale(Math.min(1, (viewport.clientWidth - 32) / width))

    setView({ scale, x: Math.max(16, (viewport.clientWidth - width * scale) / 2), y: 16 })
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current

    if (!viewport || !content || typeof ResizeObserver !== 'function') {
      fit()

      return
    }

    const observer = new ResizeObserver(() => {
      if (!touched.current) {
        fit()
      }
    })

    observer.observe(viewport)
    observer.observe(content)

    return () => observer.disconnect()
  }, [fit])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const viewport = viewportRef.current
    const px = cx ?? (viewport ? viewport.clientWidth / 2 : 0)
    const py = cy ?? (viewport ? viewport.clientHeight / 2 : 0)

    touched.current = true
    setView(current => {
      const scale = clampScale(current.scale * factor)
      const k = scale / current.scale

      // Keep the point under the cursor fixed while the scale changes.
      return { scale, x: px - (px - current.x) * k, y: py - (py - current.y) * k }
    })
  }, [])

  // Wheel pans; ⌘/Ctrl + wheel (and trackpad pinch, which arrives as
  // ctrl+wheel) zooms. Bound natively because React's wheel listener is
  // passive and could not stop the page from scrolling.
  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()

      if (event.ctrlKey || event.metaKey) {
        const rect = viewport.getBoundingClientRect()

        zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top)
      } else {
        markTouched()
        setView(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
      }
    }

    viewport.addEventListener('wheel', onWheel, { passive: false })

    return () => viewport.removeEventListener('wheel', onWheel)
  }, [markTouched, zoomAt])

  // Drag the background to pan. A press on a bot card is a click, not a pan.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) {
      return
    }

    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current

    if (!start || start.id !== event.pointerId) {
      return
    }

    touched.current = true
    drag.current = { id: start.id, x: event.clientX, y: event.clientY }
    setView(current => ({ ...current, x: current.x + event.clientX - start.x, y: current.y + event.clientY - start.y }))
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) {
      drag.current = null
    }
  }

  const controls = [
    { icon: 'zoom-out', label: b.org.zoomOut, onClick: () => zoomAt(1 / 1.2) },
    { icon: 'zoom-in', label: b.org.zoomIn, onClick: () => zoomAt(1.2) },
    {
      icon: 'screen-full',
      label: b.org.fit,
      onClick: () => {
        touched.current = false
        fit()
      }
    }
  ]

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-(--ui-bg-secondary)" data-slot="org-chart">
      <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-0.5 shadow-sm">
        {controls.map(control => (
          <Tip key={control.icon} label={control.label}>
            <Button
              aria-label={control.label}
              className="rounded-md text-(--ui-text-tertiary) hover:text-foreground"
              onClick={control.onClick}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name={control.icon} />
            </Button>
          </Tip>
        ))}
        <Tip label={b.org.resetZoom}>
          <button
            className="min-w-11 rounded-md px-1 text-[0.6875rem] text-(--ui-text-tertiary) tabular-nums hover:text-foreground"
            onClick={() => zoomAt(1 / view.scale)}
            type="button"
          >
            {Math.round(view.scale * 100)}%
          </button>
        </Tip>
      </div>

      <div
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        ref={viewportRef}
        style={{
          backgroundImage: 'radial-gradient(circle, var(--ui-stroke-tertiary) 1px, transparent 1.2px)',
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${22 * view.scale}px ${22 * view.scale}px`
        }}
      >
        <div
          className="absolute top-0 left-0 w-max origin-top-left"
          ref={contentRef}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {roots.length || chart.unassigned.length ? (
            <Organization roots={roots} sections={sections} unassigned={chart.unassigned} />
          ) : (
            <p className="m-10 max-w-xs text-[0.75rem] text-(--ui-text-tertiary)">{b.org.noSections}</p>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-2 left-3 rounded-md bg-(--ui-bg-elevated)/80 px-2 py-0.5 text-[0.6875rem] text-(--ui-text-quaternary)">
        {b.org.hint}
      </div>
    </div>
  )
}
