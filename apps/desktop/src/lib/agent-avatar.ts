import { LruCache } from '@/lib/lru-cache'
import { $gateway } from '@/store/gateway'

// sender handle -> avatar data URL. Module-level so a chat full of notices
// from one bot resolves once. Bounded LRU: handles are parsed out of message
// text (unbounded distinct senders over a long session list) and hits hold
// base64 avatar data URLs, so an unbounded map pins image bytes for the
// window's lifetime. Eviction only costs a refetch.
// Misses expire after 30s — an avatar can appear at any moment (bot just
// created, art backfill still running), and a permanent negative cache
// froze the 🤖 glyph until an app restart.
const AGENT_AVATAR_CACHE_MAX = 128
export const agentAvatarCache = new LruCache<string, { at: number; url: null | string }>(AGENT_AVATAR_CACHE_MAX)
const AVATAR_MISS_TTL_MS = 30_000
const agentAvatarInflight = new Map<string, Promise<null | string>>()

export async function resolveAgentAvatar(handle: string): Promise<null | string> {
  const key = handle.trim().toLowerCase()

  if (!key) {
    return null
  }

  const hit = agentAvatarCache.get(key)

  if (hit) {
    if (hit.url !== null) {
      return hit.url
    }

    // Negative entry: honor it only within the TTL, then re-probe.
    if (Date.now() - hit.at < AVATAR_MISS_TTL_MS) {
      return null
    }
  }

  const inflight = agentAvatarInflight.get(key)

  if (inflight) {
    return inflight
  }

  const run = (async (): Promise<null | string> => {
    try {
      const gateway = $gateway.get()

      if (!gateway) {
        return null
      }

      const res = await gateway.request<{ profiles?: Array<{ has_avatar?: boolean; name: string }> }>('profiles.list', {
        include_sessions: false
      })

      const profiles = res?.profiles ?? []
      let profile = profiles.find(p => p.name.toLowerCase() === key)

      // 'hermes' is the conventional alias for the primary profile.
      if (!profile && key === 'hermes') {
        profile = profiles.find(p => p.name === 'default')
      }

      if (!profile?.has_avatar) {
        return null
      }

      const asset = await gateway.request<{ data?: string; found?: boolean }>('profiles.get_asset', {
        asset: 'avatar',
        name: profile.name
      })

      return asset?.found && asset.data ? asset.data : null
    } catch {
      // Older gateway (no profiles.* RPCs) or transient failure — the 🤖
      // glyph fallback is always correct.
      return null
    } finally {
      agentAvatarInflight.delete(key)
    }
  })()

  agentAvatarInflight.set(key, run)
  const out = await run
  agentAvatarCache.set(key, { at: Date.now(), url: out })

  return out
}
