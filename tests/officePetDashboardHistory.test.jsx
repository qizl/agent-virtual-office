import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ state: {}, effects: [] }))
vi.mock('react', async (original) => ({
  ...(await original()),
  useEffect: (effect) => { harness.effects.push(effect) },
}))
vi.mock('../src/systems/store.js', () => ({ useOfficeStore: (selector) => selector(harness.state) }))
vi.mock('../src/components/useTransientFlag.js', () => ({ useTransientFlag: () => [false, () => {}] }))
import OfficePet from '../src/components/OfficePet.jsx'

beforeEach(() => {
  vi.useFakeTimers()
  harness.effects = []
  harness.state = { officePet: true, reducedMotion: false, mood: 'normal', externalStatus: {},
    agents: {}, activeEvent: null, sceneScale: 1, petType: 'cat', integration: 'dashboard', mawMeta: null }
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

function renderPet() {
  const html = renderToStaticMarkup(<svg><OfficePet /></svg>)
  const cleanups = harness.effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function')
  return { html, cleanup: () => cleanups.forEach((cleanup) => cleanup()) }
}

describe('Historical office pet', () => {
  it('keeps historical pets stationary without a wandering timer or CSS glide', () => {
    harness.state.mawMeta = { dashboard_history: true }
    const pet = renderPet()
    expect(pet.html).toContain('data-office-pet="wander"')
    expect(pet.html).not.toContain('transition:transform')
    expect(vi.getTimerCount()).toBe(0)
    pet.cleanup()
  })

  it.each(['dashboard', null])('retains ambient motion in live %s views', (integration) => {
    harness.state.integration = integration
    const pet = renderPet()
    expect(pet.html).toContain('transition:transform')
    expect(vi.getTimerCount()).toBe(1)
    pet.cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })
})
