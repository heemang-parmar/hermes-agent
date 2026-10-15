/**
 * The bot row's second line: a fixed job designation when the profile sets
 * one, otherwise the canonical chat's latest-message preview.
 *
 * A designation REPLACES the preview rather than sitting beside it, so the
 * line never moves with chat traffic; the latest message stays in the chat.
 * `description` is never a fallback — descriptions are long policy text.
 */

import { stripPreviewMarkdown } from './labels'
import { A2A_PREFIX_RE, previewKind } from './row-helpers'
import type { BotMeta, RosterRow } from './types'

export interface BotRowSubtitle {
  designation: string
  /** Bot-to-bot DM preview; drives the italic style. Never true with a designation. */
  fromBot: boolean
  preview: string
}

/** The profile's designation: Bot Mode meta first, then the row's own ui_meta. */
export function botDesignation(bot: RosterRow, meta?: BotMeta | null): string {
  const raw = meta?.designation ?? bot?.ui_meta?.['hermes-bots']?.designation

  return typeof raw === 'string' ? raw.trim() : ''
}

export function botRowSubtitle(designation: string, rawPreview?: null | string): BotRowSubtitle {
  if (designation) {
    return { designation, fromBot: false, preview: '' }
  }

  const fromBot = Boolean(previewKind(rawPreview).fromBot)

  // DM previews read like DMs: strip the delivery prefix, keep the message.
  const preview = stripPreviewMarkdown(
    fromBot ? (rawPreview || '').replace(A2A_PREFIX_RE, '').trim() || '…' : rawPreview || ''
  )

  return { designation: '', fromBot, preview }
}
