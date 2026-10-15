/**
 * The chrome for user sections: the foldable heading (the roster's own
 * `RosterSectionHeader`, with a ⋯ menu and a right-click menu that drive the
 * same actions), the name dialog used for both New section and Rename (the
 * same shape the app's session rename uses), and the drop zone a section
 * block sits in. The model is in `user-sections.ts`; nothing here holds state
 * that outlives a dialog.
 */

import {
  Button,
  cn,
  Codicon,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  isSubmitEnter,
  useI18n,
  useValue
} from '@hermes/plugin-sdk'
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { useBots } from './i18n'
import { RosterSectionHeader } from './roster-sections'
import { SECTION_COLOR_KEYS, SECTION_PALETTE, type SectionColorKey } from './section-colors'
import { $draggingBot, $sectionDropTarget, BOT_DRAG_MIME } from './user-sections'

// ── name dialog ──────────────────────────────────────────────────────────────

interface SectionNameDialogProps {
  /** Blank for New section, the current name for Rename. */
  initialName: string
  mode: 'create' | 'rename'
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
  open: boolean
  /** Creating inside this section — titles the dialog with where it lands. */
  parentName?: string
}

/** One small dialog for both creating and renaming a section — the app renames
 *  sessions through the same Dialog + Input + Cancel/Save shape, so a section
 *  rename feels like every other rename. */
export function SectionNameDialog({
  initialName,
  mode,
  onOpenChange,
  onSubmit,
  open,
  parentName
}: SectionNameDialogProps) {
  const { t } = useI18n()
  const b = useBots()
  const [value, setValue] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(initialName)
      window.setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [initialName, open])

  const submit = () => {
    const next = value.trim()

    if (!next) {
      return
    }

    onOpenChange(false)

    if (mode === 'create' || next !== initialName.trim()) {
      onSubmit(next)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {mode === 'rename'
              ? b.sections.renameTitle
              : parentName
                ? b.sections.newSubTitle(parentName)
                : b.sections.newTitle}
          </DialogTitle>
        </DialogHeader>
        <Input
          aria-label={b.sections.nameLabel}
          autoFocus
          maxLength={40}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (isSubmitEnter(event)) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={b.sections.namePlaceholder}
          ref={inputRef}
          value={value}
        />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={!value.trim()} onClick={submit} type="button">
            {mode === 'create' ? b.sections.create : t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── heading ──────────────────────────────────────────────────────────────────

/** One entry of the "Move into" list: a section (indented by `depth`) or the
 *  top level (`id` null). */
export interface SectionMoveTarget {
  /** Already where this section sits, or inside it — listed but not offered. */
  disabled: boolean
  depth: number
  id: null | string
  name: string
}

interface UserSectionHeaderProps {
  canMoveDown: boolean
  canMoveUp: boolean
  collapsed: boolean
  /** Drawn colour of the section (its root's). */
  color?: string
  /** The picked colour key, null when automatic. Only a top-level section
   *  passes `onColor`; a subsection follows its root. */
  colorKey?: null | string
  count: number
  /** null for Unassigned, which has no record and therefore no menu. */
  id: null | string
  moveTargets?: SectionMoveTarget[]
  name: string
  onDelete: () => void
  onColor?: (key: null | SectionColorKey) => void
  onMove: (delta: number) => void
  /** Top-level sections only: toggle "shared department" (below the divider). */
  onShared?: (shared: boolean) => void
  onNewSubsection?: () => void
  onRename: () => void
  onReparent?: (parentId: null | string) => void
  onToggle: () => void
  shared?: boolean
}

export function UserSectionHeader({
  canMoveDown,
  canMoveUp,
  collapsed,
  color,
  colorKey = null,
  count,
  id,
  moveTargets = [],
  name,
  onColor,
  onDelete,
  onMove,
  onNewSubsection,
  onRename,
  onReparent,
  onShared,
  onToggle,
  shared = false
}: UserSectionHeaderProps) {
  const b = useBots()
  const { t } = useI18n()

  // Unassigned has no record to rename, reorder or delete — it is whatever is
  // left over — so it gets the plain heading rather than a menu of disabled
  // items.
  if (!id) {
    return (
      <RosterSectionHeader
        collapsed={collapsed}
        count={count}
        icon="inbox"
        label={b.sections.unassigned}
        onToggle={onToggle}
      />
    )
  }

  // RIGHT-CLICK IS THE SAME MENU. The ⋯ button only appears on hover and is a
  // small target; right-clicking the heading is what people actually try
  // first. Both drive the identical actions, so neither can drift.
  const items = [
    { icon: 'edit', label: b.sections.rename, onSelect: onRename },
    ...(onNewSubsection ? [{ icon: 'new-folder', label: b.sections.newSubsection, onSelect: onNewSubsection }] : []),
    { disabled: !canMoveUp, icon: 'arrow-up', label: b.sections.moveUp, onSelect: () => onMove(-1) },
    { disabled: !canMoveDown, icon: 'arrow-down', label: b.sections.moveDown, onSelect: () => onMove(1) },
    ...(onShared
      ? [
          {
            icon: shared ? 'arrow-small-up' : 'arrow-small-down',
            label: shared ? b.sections.unmarkShared : b.sections.markShared,
            onSelect: () => onShared(!shared)
          }
        ]
      : [])
  ]

  // "Move into": the whole tree, indented, with the top level first. Sections
  // the move would be refused for (its current parent, itself, its own
  // subtree) stay listed but disabled, so the tree reads the same as the pane.
  const offered = onReparent && moveTargets.some(target => !target.disabled)

  // "Color": automatic, then the palette as swatches. The current choice is
  // disabled rather than checked, matching how "Move into" marks where the
  // section already sits.
  const colorChoices: { disabled: boolean; key: null | SectionColorKey; label: string; swatch: string }[] = onColor
    ? [
        { disabled: !colorKey, key: null, label: b.sections.colorAuto, swatch: '' },
        ...SECTION_COLOR_KEYS.map(key => ({
          disabled: colorKey === key,
          key,
          label: b.sections.colorName(key),
          swatch: SECTION_PALETTE[key]
        }))
      ]
    : []

  const colorLabel = (choice: (typeof colorChoices)[number]) => (
    <span className="flex items-center">
      <span
        className="mr-2 size-3 shrink-0 rounded-full border border-(--ui-stroke-secondary)"
        style={choice.swatch ? { background: choice.swatch } : undefined}
      />
      {choice.label}
    </span>
  )

  const moveTargetLabel = (target: SectionMoveTarget) => (
    <span className="flex min-w-0 items-center" style={{ paddingLeft: `${target.depth * 0.75}rem` }}>
      <Codicon className="mr-1.5 shrink-0" name={target.id ? 'folder' : 'list-tree'} />
      <span className="truncate">{target.id ? target.name : b.sections.topLevel}</span>
    </span>
  )

  const action = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={b.sections.options(name)}
          className="shrink-0 rounded-md p-0.5 text-(--ui-text-quaternary) opacity-0 transition hover:text-foreground group-hover/section:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          type="button"
        >
          <Codicon name="ellipsis" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map(item => (
          <DropdownMenuItem disabled={item.disabled} key={item.label} onSelect={item.onSelect}>
            <Codicon className="mr-1.5" name={item.icon} />
            {item.label}
          </DropdownMenuItem>
        ))}
        {offered ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Codicon className="mr-1.5" name="folder-opened" />
              {b.sections.moveSectionInto}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {moveTargets.map(target => (
                <DropdownMenuItem
                  disabled={target.disabled}
                  key={target.id ?? 'top-level'}
                  onSelect={() => onReparent(target.id)}
                >
                  {moveTargetLabel(target)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {colorChoices.length ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Codicon className="mr-1.5" name="symbol-color" />
              {b.sections.color}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {colorChoices.map(choice => (
                <DropdownMenuItem
                  disabled={choice.disabled}
                  key={choice.key ?? 'auto'}
                  onSelect={() => onColor?.(choice.key)}
                >
                  {colorLabel(choice)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} variant="destructive">
          <Codicon className="mr-1.5" name="trash" />
          {t.common.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-section-id={id} data-slot="bots-section-heading">
          <RosterSectionHeader
            action={action}
            collapsed={collapsed}
            color={color}
            count={count}
            icon="folder"
            label={name}
            onDoubleClick={onRename}
            onToggle={onToggle}
            tip={b.sections.headingTip}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {items.map(item => (
          <ContextMenuItem disabled={item.disabled} key={item.label} onSelect={item.onSelect}>
            {item.label}
          </ContextMenuItem>
        ))}
        {offered ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>{b.sections.moveSectionInto}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {moveTargets.map(target => (
                <ContextMenuItem
                  disabled={target.disabled}
                  key={target.id ?? 'top-level'}
                  onSelect={() => onReparent(target.id)}
                >
                  {moveTargetLabel(target)}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        {colorChoices.length ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>{b.sections.color}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {colorChoices.map(choice => (
                <ContextMenuItem
                  disabled={choice.disabled}
                  key={choice.key ?? 'auto'}
                  onSelect={() => onColor?.(choice.key)}
                >
                  {colorLabel(choice)}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onDelete} variant="destructive">
          {t.common.delete}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ── drop zone ────────────────────────────────────────────────────────────────

/** While a bot is in flight, Escape cancels the gesture. Mount once in the
 *  roster pane. */
export function useEscapeCancelsBotDrag(): void {
  const dragging = useValue($draggingBot)

  useEffect(() => {
    if (!dragging) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        $draggingBot.set(null)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [dragging])
}

interface SectionDropZoneProps {
  children: ReactNode
  /** Tints the nested rail with the section's colour. */
  color?: string
  /** Whether the dragged bot is already filed here — then the zone is not a
   *  target, and the OS shows the no-drop cursor instead of a highlight that
   *  promises a move that would change nothing. */
  isSource: boolean
  /** Drawn inside a gateway bucket or a parent section: indented under a
   *  hairline rail so the two heading levels read as parent and child. */
  nested?: boolean
  onDropBot: (rosterKey: string) => void
  /** Unique per block; names this zone in `$sectionDropTarget`. */
  zoneKey: string
}

/** A section block as a drop target: the whole block (heading + rows, or the
 *  empty placeholder) lights up while a bot is over it. Blocks nest, and the
 *  innermost block under the pointer is the target — its parent's block,
 *  which also contains the pointer, neither lights nor takes the drop. */
export function SectionDropZone({ children, color, isSource, nested, onDropBot, zoneKey }: SectionDropZoneProps) {
  const dragging = useValue($draggingBot)
  const target = useValue($sectionDropTarget)
  const armed = Boolean(dragging) && !isSource
  const lit = armed && target === zoneKey

  // Escape cancels the gesture: the in-flight key is cleared (see the
  // keydown hook in the roster pane), so every zone disarms at once and a
  // drop that still lands is refused below. Clear the target so the next
  // drag starts clean.
  useEffect(() => {
    if (!dragging && $sectionDropTarget.get() === zoneKey) {
      $sectionDropTarget.set(null)
    }
  }, [dragging, zoneKey])

  // The innermost zone CLAIMS any bot drag over it — even as the source, so a
  // drag hovering a bot's own section is a no-drop there rather than bubbling
  // up and offering to move the bot to the parent section.
  const claim = (event: DragEvent) => {
    if (!dragging || !event.dataTransfer.types.includes(BOT_DRAG_MIME)) {
      return
    }

    event.stopPropagation()

    if (!armed) {
      if ($sectionDropTarget.get() !== null) {
        $sectionDropTarget.set(null)
      }

      return
    }

    // preventDefault is what MAKES this a drop target — without it the
    // browser refuses the drop and the cursor stays "no entry".
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'

    if ($sectionDropTarget.get() !== zoneKey) {
      $sectionDropTarget.set(zoneKey)
    }
  }

  return (
    <div
      className={cn(
        'relative min-w-0 rounded-md transition-[background-color,box-shadow] duration-100',
        nested && 'ml-2.5 border-l border-(--ui-stroke-tertiary) pl-1',
        // While a drag is live, every valid target gets a faint outline so the
        // user can see where a drop is allowed before hovering one.
        armed && 'ring-1 ring-inset ring-(--ui-stroke-secondary)',
        lit && 'bg-(--ui-accent)/10 ring-(--ui-accent)'
      )}
      data-drop-over={lit ? 'true' : undefined}
      data-slot="bots-section"
      onDragEnter={claim}
      onDragLeave={event => {
        // Only clear when the pointer leaves the BLOCK, not when it crosses
        // between the rows inside it — dragleave fires on every child
        // boundary, which otherwise strobes the highlight.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && $sectionDropTarget.get() === zoneKey) {
          $sectionDropTarget.set(null)
        }
      }}
      onDragOver={claim}
      onDrop={event => {
        if (!event.dataTransfer.types.includes(BOT_DRAG_MIME)) {
          return
        }

        // Handled here, by the innermost block: an enclosing section must not
        // refile the bot a second time.
        event.stopPropagation()
        $sectionDropTarget.set(null)
        // The dropped row remounts under its new section, so its own dragend
        // never reaches the new node — clear the in-flight state here or the
        // row stays faded after a successful drop.
        $draggingBot.set(null)

        const key = event.dataTransfer.getData(BOT_DRAG_MIME)

        // No in-flight key means the user pressed Escape mid-drag: refuse.
        if (!key || !dragging || isSource) {
          return
        }

        event.preventDefault()
        onDropBot(key)
      }}
      style={nested && color ? { borderLeftColor: `color-mix(in srgb, ${color} 55%, transparent)` } : undefined}
    >
      {children}
    </div>
  )
}
