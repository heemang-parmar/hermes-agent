/**
 * Section drop zones nest (a subsection's block sits inside its parent's), so
 * a drop must land in exactly ONE section — the innermost under the pointer.
 * If the drop bubbled, the parent would refile the bot a second time and it
 * would end up in the parent instead of the subsection the user aimed at.
 */

import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $draggingBot, $sectionDropTarget, BOT_DRAG_MIME } from './user-sections'
import { SectionDropZone } from './user-sections-ui'

afterEach(() => {
  cleanup()
  $draggingBot.set(null)
  $sectionDropTarget.set(null)
})

function dragEvent(target: Element, type: 'dragOver' | 'drop', key = 'bot:nirmaan') {
  const event = createEvent[type](target)

  Object.defineProperty(event, 'dataTransfer', {
    value: { dropEffect: 'none', getData: () => key, types: [BOT_DRAG_MIME] }
  })

  return event
}

function mount() {
  const onParent = vi.fn()
  const onChild = vi.fn()

  render(
    <SectionDropZone isSource={false} onDropBot={onParent} zoneKey="parent">
      <span>Blue Barrows</span>
      <SectionDropZone isSource={false} nested onDropBot={onChild} zoneKey="child">
        <span>Kindly Objects</span>
      </SectionDropZone>
    </SectionDropZone>
  )

  return { child: screen.getByText('Kindly Objects'), onChild, onParent, parent: screen.getByText('Blue Barrows') }
}

describe('nested section drop zones', () => {
  it('a drop into a subsection files the bot there only, not also into the parent', () => {
    const { child, onChild, onParent } = mount()

    // A row's dragstart sets this and the pane re-renders before the first dragover.
    act(() => $draggingBot.set('bot:nirmaan'))
    fireEvent(child, dragEvent(child, 'dragOver'))
    expect($sectionDropTarget.get()).toBe('child')

    fireEvent(child, dragEvent(child, 'drop'))

    expect(onChild).toHaveBeenCalledWith('bot:nirmaan')
    expect(onParent).not.toHaveBeenCalled()
  })

  it('the parent is the target when the pointer is over its own area', () => {
    const { onChild, onParent, parent } = mount()

    // A row's dragstart sets this and the pane re-renders before the first dragover.
    act(() => $draggingBot.set('bot:nirmaan'))
    fireEvent(parent, dragEvent(parent, 'dragOver'))
    expect($sectionDropTarget.get()).toBe('parent')

    fireEvent(parent, dragEvent(parent, 'drop'))

    expect(onParent).toHaveBeenCalledWith('bot:nirmaan')
    expect(onChild).not.toHaveBeenCalled()
  })

  it('hovering the section a bot is already in does not offer the parent instead', () => {
    const onParent = vi.fn()

    render(
      <SectionDropZone isSource={false} onDropBot={onParent} zoneKey="parent">
        <SectionDropZone isSource nested onDropBot={vi.fn()} zoneKey="child">
          <span>Kindly Objects</span>
        </SectionDropZone>
      </SectionDropZone>
    )

    const child = screen.getByText('Kindly Objects')

    // A row's dragstart sets this and the pane re-renders before the first dragover.
    act(() => $draggingBot.set('bot:nirmaan'))
    fireEvent(child, dragEvent(child, 'dragOver'))
    fireEvent(child, dragEvent(child, 'drop'))

    expect($sectionDropTarget.get()).toBeNull()
    expect(onParent).not.toHaveBeenCalled()
  })
})
