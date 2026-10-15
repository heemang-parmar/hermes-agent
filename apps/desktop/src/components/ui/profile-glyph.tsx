import { useEffect, useState } from 'react'

import { agentAvatarCache, resolveAgentAvatar } from '@/lib/agent-avatar'
import { profileColorSoft } from '@/lib/profile-color'
import { profileShortLabel } from '@/lib/profile-short-label'
import { cn } from '@/lib/utils'

import { Codicon } from './codicon'

/** The profile's avatar image on the active gateway (the one chat notices from
 *  that agent wear), or null while it loads / when it has none. `null` name
 *  skips the lookup, so callers can opt in without breaking hook order. */
function useProfileAvatar(name: null | string): null | string {
  const [url, setUrl] = useState<null | string>(() => (name ? (agentAvatarCache.get(name.toLowerCase())?.url ?? null) : null))

  useEffect(() => {
    if (!name) {
      return undefined
    }

    let live = true

    void resolveAgentAvatar(name).then(next => {
      if (live && next) {
        setUrl(next)
      }
    })

    return () => {
      live = false
    }
  }, [name])

  return name ? url : null
}

/** A profile's mark, in one place: the default profile is the `home` icon (it
 *  has no color of its own and an initial would read as just another named
 *  profile); every other profile is a soft tint of its color carrying its
 *  initial. `label` (the display name) supplies the initial when given, so a
 *  renamed profile doesn't wear its id's letter. `withAvatar` shows the
 *  profile's avatar image once it resolves — only for profiles on the active
 *  gateway, since that is where the lookup runs. Callers resolve the color
 *  from `$profileColors`. */
export function ProfileGlyph({
  className,
  color,
  isDefault,
  label,
  name,
  withAvatar = false,
  ...props
}: Omit<React.ComponentProps<'span'>, 'color'> & {
  color: null | string
  isDefault: boolean
  label?: string
  name: string
  withAvatar?: boolean
}) {
  const avatar = useProfileAvatar(withAvatar ? name : null)

  if (avatar) {
    return (
      <span className={cn('grid size-4 shrink-0 place-items-center', className)} {...props}>
        <img alt="" className="size-full rounded-[3px] object-cover" src={avatar} />
      </span>
    )
  }

  if (isDefault) {
    return (
      <span className={cn('grid size-4 shrink-0 place-items-center', className)} {...props}>
        <Codicon className="text-(--ui-text-quaternary)" name="home" size="0.75rem" />
      </span>
    )
  }

  const initial = profileShortLabel(label || name)

  return (
    <span
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[3px] text-[0.5rem] font-semibold uppercase leading-none',
        className
      )}
      style={{ backgroundColor: profileColorSoft(color ?? 'var(--ui-text-quaternary)', 22), color: color ?? undefined }}
      {...props}
    >
      {initial}
    </span>
  )
}
