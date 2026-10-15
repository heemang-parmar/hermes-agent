import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { resolveAgentAvatar } = vi.hoisted(() => ({ resolveAgentAvatar: vi.fn() }))

vi.mock('@/lib/agent-avatar', () => ({
  agentAvatarCache: new Map(),
  resolveAgentAvatar
}))

const { ProfileGlyph } = await import('./profile-glyph')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProfileGlyph', () => {
  it('preserves the first readable grapheme across scripts and emoji', () => {
    const names = [
      '研究助手',
      'Работа',
      'Ελληνικά',
      'Álvaro',
      'A\u0301lvaro',
      '👨‍💻',
      '🇨🇳',
      '1️⃣ helper',
      '𠮷野',
      '--dev',
      ''
    ]

    const expected = ['研', 'Р', 'Ε', 'Á', 'A\u0301', '👨‍💻', '🇨🇳', '1️⃣', '𠮷', 'd', '?']

    const { container } = render(
      <>
        {names.map(name => (
          <ProfileGlyph color={null} isDefault={false} key={name} name={name} />
        ))}
      </>
    )

    expect(Array.from(container.children, child => child.textContent)).toEqual(expected)
  })

  it('keeps the default profile home mark instead of using an initial', () => {
    const { container } = render(<ProfileGlyph color={null} isDefault name="研究助手" />)

    expect(container.textContent).toBe('')
    expect(container.querySelector('.codicon-home')).not.toBeNull()
  })

  it("takes its initial from the display name, not the profile's id", () => {
    const { container } = render(<ProfileGlyph color="#2563eb" isDefault={false} label="Shryava" name="aira" />)

    expect(container.textContent).toBe('S')
  })

  it("shows the profile's avatar when asked, the initial until it resolves", async () => {
    resolveAgentAvatar.mockResolvedValue('data:image/png;base64,AAAA')

    const { container } = render(
      <ProfileGlyph color="#2563eb" isDefault={false} label="Kyrah" name="kyra" withAvatar />
    )

    expect(container.textContent).toBe('K')
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA'))
    expect(resolveAgentAvatar).toHaveBeenCalledWith('kyra')
  })

  it('never looks an avatar up unless asked (other gateways have their own profiles)', () => {
    const { container } = render(<ProfileGlyph color="#2563eb" isDefault={false} name="kyra" />)

    expect(container.querySelector('img')).toBeNull()
    expect(resolveAgentAvatar).not.toHaveBeenCalled()
  })
})
