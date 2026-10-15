/**
 * The org chart workspace tab: the roster's sections as a top-down hierarchy
 * on a pannable, zoomable canvas. Every bot card opens that bot's chat — the
 * same open path as a roster row click. The data is `org-chart.ts`; this file
 * is layout and the canvas gestures.
 */

import { Button, cn, Codicon, host, Tip, useValue } from '@hermes/plugin-sdk'
import { type PointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { avatarColor, botAppearance, BotFace } from './avatar'
import { isBackfilledFacePng } from './avatar-image'
import { botDesignation } from './bot-row-subtitle'
import { $botMeta, botRosterKey, useRoster } from './data'
import { botsText, useBots } from './i18n'
import { displayName } from './labels'
import { buildOrgChart, type OrgChartNode } from './org-chart'
import { openRosterBot } from './roster-actions'
import { botRosterMeta } from './routing'
import { ID } from './shared'
import type { RosterRow } from './types'
import { $botSections, createBotSection } from './user-sections'
import { SectionNameDialog } from './user-sections-ui'

const MIN_SCALE = 0.25
const MAX_SCALE = 2
const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

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

// ── cards ────────────────────────────────────────────────────────────────────

function OrgBotCard({ bot }: { bot: RosterRow }) {
  const b = useBots()
  const allMeta = useValue($botMeta)
  const meta = botRosterMeta(bot, allMeta)
  const name = displayName(bot, meta)
  const designation = botDesignation(bot, meta)
  const { color, image, shape } = botAppearance(bot.name, meta)
  const photo = Boolean(image && !isBackfilledFacePng(image))

  return (
    <Tip label={b.org.chatWith(name)}>
      <button
        aria-label={b.org.chatWith(name)}
        className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--ui-control-hover-background) focus-visible:ring-1 focus-visible:ring-(--ui-accent) focus-visible:outline-none"
        data-slot="org-chart-bot"
        onClick={() => void openRosterBot(bot)}
        type="button"
      >
        <BotFace
          color={avatarColor(color, bot.name)}
          image={photo ? image : null}
          name={bot.name}
          shape={shape}
          size={32}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-medium text-(--ui-text-primary)">{name}</span>
          {designation ? (
            <span className="block truncate text-[0.6875rem] text-(--ui-text-tertiary)">{designation}</span>
          ) : null}
        </span>
      </button>
    </Tip>
  )
}

/** Columns for a section's bot grid: wide enough that a big department does
 *  not become a tall single column, narrow enough that a lone lead stays a
 *  compact card. */
function botColumns(count: number): number {
  return count >= 7 ? 3 : count >= 2 ? 2 : 1
}

function OrgSectionCard({
  bots,
  depth,
  name,
  total
}: {
  bots: RosterRow[]
  depth: number
  name: string
  total: number
}) {
  const b = useBots()
  const cols = botColumns(bots.length)

  return (
    <div
      className={cn(
        'rounded-xl border bg-(--ui-bg-elevated) shadow-sm',
        depth === 0 ? 'border-(--ui-stroke-secondary)' : 'border-(--ui-stroke-tertiary)'
      )}
      data-slot="org-chart-section"
      style={{ width: `${cols * 12.5 + 1}rem` }}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-3 pt-2.5 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)">
        <Codicon className="shrink-0" name="folder" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 font-normal tabular-nums text-(--ui-text-quaternary)">{total}</span>
      </div>
      {bots.length ? (
        <div className="grid gap-0.5 px-1.5 pb-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {bots.map(bot => (
            <OrgBotCard bot={bot} key={botRosterKey(bot)} />
          ))}
        </div>
      ) : total ? null : (
        <div className="mx-2 mb-2 rounded-md border border-dashed border-(--ui-stroke-secondary) px-2 py-2 text-center text-[0.6875rem] text-(--ui-text-quaternary)">
          {b.org.empty}
        </div>
      )}
    </div>
  )
}

// ── tree layout ──────────────────────────────────────────────────────────────
//
// Classic top-down org chart from plain flex boxes: a vertical stub under the
// parent, then a row of children, each with its own stub up to a shared
// horizontal rail that spans from the first child's centre to the last's.

const LINE = 'bg-(--ui-stroke-secondary)'

function OrgChildren({ depth, nodes }: { depth: number; nodes: OrgChartNode[] }) {
  if (!nodes.length) {
    return null
  }

  return (
    <>
      <div className={cn('h-6 w-px', LINE)} />
      <div className="flex items-start">
        {nodes.map((node, i) => (
          <div className="relative flex flex-col items-center px-3 pt-6" key={node.section.id}>
            {nodes.length > 1 ? (
              <div
                className={cn(
                  'absolute top-0 h-px',
                  LINE,
                  i === 0 ? 'right-0 left-1/2' : i === nodes.length - 1 ? 'right-1/2 left-0' : 'right-0 left-0'
                )}
              />
            ) : null}
            <div className={cn('absolute top-0 left-1/2 h-6 w-px', LINE)} />
            <OrgBranch depth={depth} node={node} />
          </div>
        ))}
      </div>
    </>
  )
}

function OrgBranch({ depth, node }: { depth: number; node: OrgChartNode }) {
  return (
    <div className="flex flex-col items-center">
      <OrgSectionCard bots={node.bots} depth={depth} name={node.section.name} total={node.total} />
      <OrgChildren depth={depth + 1} nodes={node.children} />
    </div>
  )
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
  const [creating, setCreating] = useState(false)

  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ scale: 1, x: 24, y: 24 })
  const drag = useRef<null | { id: number; x: number; y: number }>(null)
  const fitted = useRef(false)

  const fit = useCallback(() => {
    const viewport = viewportRef.current
    const content = contentRef.current

    if (!viewport || !content) {
      return
    }

    // offsetWidth/Height are the UNtransformed size, which is what the scale
    // multiplies.
    const width = content.offsetWidth
    const height = content.offsetHeight
    const scale = clampScale(Math.min(1, (viewport.clientWidth - 48) / width, (viewport.clientHeight - 48) / height))

    setView({ scale, x: (viewport.clientWidth - width * scale) / 2, y: 24 })
  }, [])

  // Fit once, when the first roster lands; after that the view is the user's.
  useLayoutEffect(() => {
    if (!fitted.current && roster.length) {
      fitted.current = true
      fit()
    }
  }, [fit, roster.length])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const viewport = viewportRef.current
    const px = cx ?? (viewport ? viewport.clientWidth / 2 : 0)
    const py = cy ?? (viewport ? viewport.clientHeight / 2 : 0)

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
        setView(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
      }
    }

    viewport.addEventListener('wheel', onWheel, { passive: false })

    return () => viewport.removeEventListener('wheel', onWheel)
  }, [zoomAt])

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
    { icon: 'screen-full', label: b.org.fit, onClick: fit }
  ]

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-(--ui-bg-primary)" data-slot="org-chart">
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
            className="min-w-11 rounded-md px-1 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary) hover:text-foreground"
            onClick={() => zoomAt(1 / view.scale)}
            type="button"
          >
            {Math.round(view.scale * 100)}%
          </button>
        </Tip>
        <div className="mx-0.5 h-4 w-px bg-(--ui-stroke-tertiary)" />
        <Tip label={b.sections.newSection}>
          <Button
            aria-label={b.sections.newSection}
            className="rounded-md text-(--ui-text-tertiary) hover:text-foreground"
            onClick={() => setCreating(true)}
            size="icon-xs"
            variant="ghost"
          >
            <Codicon name="new-folder" />
          </Button>
        </Tip>
      </div>

      <div
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        ref={viewportRef}
      >
        <div
          className="absolute top-0 left-0 w-max origin-top-left"
          ref={contentRef}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <div className="flex flex-col items-center p-2">
            <div className="rounded-full border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-4 py-1.5 text-[0.75rem] font-semibold uppercase tracking-wider text-(--ui-text-secondary) shadow-sm">
              {b.org.root}
            </div>
            {chart.roots.length ? (
              <OrgChildren depth={0} nodes={chart.roots} />
            ) : (
              <p className="mt-6 max-w-xs text-center text-[0.75rem] text-(--ui-text-tertiary)">{b.org.noSections}</p>
            )}
            {chart.unassigned.length ? (
              <div className="mt-10">
                <OrgSectionCard
                  bots={chart.unassigned}
                  depth={0}
                  name={b.sections.unassigned}
                  total={chart.unassigned.length}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-2 left-3 text-[0.6875rem] text-(--ui-text-quaternary)">
        {b.org.hint}
      </div>

      <SectionNameDialog
        initialName=""
        mode="create"
        onOpenChange={setCreating}
        onSubmit={name => void createBotSection(name)}
        open={creating}
      />
    </div>
  )
}
