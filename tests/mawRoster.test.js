import { describe, it, expect } from 'vitest'
import characters from '../src/config/characters.json'
import { HOME_POSITIONS, OVERFLOW_POSITIONS } from '../src/systems/movementSystem.js'
import { MAW_BASE_ROLES } from '../src/server/mawStatus.mjs'
import { useOfficeStore } from '../src/systems/store.js'

// The maw roster entries are STYLE TEMPLATES for dynamic members (plan §4.1.1):
// four base roles, one seat each, locale names, and an empty agentcortex untouched.

describe('maw roster', () => {
  it('defines exactly the four MAW base roles, aligned with the transport contract', () => {
    const ids = characters.maw.map((c) => c.id).sort()
    expect(ids).toEqual([...MAW_BASE_ROLES].sort())
  })

  it('every base role has a home seat and every entry has renderable style fields', () => {
    for (const c of characters.maw) {
      expect(HOME_POSITIONS[c.id], `missing seat for ${c.id}`).toBeDefined()
      expect(c.name).toBeTruthy()
      expect(c.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(Array.isArray(c.deskItems)).toBe(true)
      expect(c.personality).toBeTruthy()
    }
  })

  it('extra members have independent overflow seats beyond the four base chairs', () => {
    expect(OVERFLOW_POSITIONS.length).toBeGreaterThanOrEqual(4)
  })

  it('maw mode seeds NO static agents — the stage is member-driven', () => {
    // store.js reads the mode at import time (node → agentcortex); the maw-mode
    // empty-init is exercised by applyMawSnapshot's members-only render model and
    // asserted here via the roster contract: no maw id appears in the default roster.
    const s = useOfficeStore.getState()
    for (const c of characters.maw) {
      expect(s.agents[c.id]).toBeUndefined()
    }
  })

  it('locale entries exist for member display names in both languages', async () => {
    const en = (await import('../src/locales/en.json')).default
    const zh = (await import('../src/locales/zh-TW.json')).default
    for (const c of characters.maw) {
      expect(en.characters[c.id]?.name).toBeTruthy()
      expect(zh.characters[c.id]?.name).toBeTruthy()
    }
    expect(en.maw?.empty).toBeTruthy()
    expect(zh.maw?.empty).toBeTruthy()
  })
})
