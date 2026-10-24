import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let win
let store

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  win = new EventTarget()
  win.location = { href: 'http://127.0.0.1:8765/office/', search: '?integration=dashboard&project=one&task=fixed' }
  win.parent = win
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', { querySelector: () => null, getElementById: () => null })
  vi.stubGlobal('navigator', { userAgent: '' })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
  // Import after installing the window so this exercises the real module-level
  // storage listener, including its registration, rather than a copied handler.
  store = (await import('../src/systems/store.js')).useOfficeStore
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

function storagePause(newValue) {
  const event = new Event('storage')
  Object.defineProperties(event, { key: { value: 'office-paused' }, newValue: { value: newValue } })
  win.dispatchEvent(event)
}

describe('Dashboard history owns pause across tabs', () => {
  it.each(['playing', 'paused', 'ended'])('ignores another tab resuming animations while history is %s', (state) => {
    const agents = { recorded: { id: 'recorded', status: 'blocked', behavior: 'scratch-head', position: { x: 300, y: 200 } } }
    store.setState({ integration: 'dashboard', dashboardHistory: { state, step: 1, total: 2 }, isPaused: true, agents })
    storagePause('false')
    expect(store.getState().isPaused).toBe(true)
    expect(store.getState().dashboardHistory).toEqual({ state, step: 1, total: 2 })
    expect(store.getState().agents).toBe(agents)
    storagePause('true')
    expect(store.getState().isPaused).toBe(true)
  })

  it('retains cross-tab preference sync in live Dashboard and standalone views', () => {
    for (const integration of ['dashboard', null]) {
      store.setState({ integration, dashboardHistory: { state: 'live' }, isPaused: true })
      storagePause('false')
      expect(store.getState().isPaused).toBe(false)
      storagePause('true')
      expect(store.getState().isPaused).toBe(true)
    }
  })

  it('resumes normal cross-tab syncing after leaving history', () => {
    store.setState({ integration: 'dashboard', dashboardHistory: { state: 'paused' }, isPaused: true })
    storagePause('false')
    expect(store.getState().isPaused).toBe(true)
    store.setState({ dashboardHistory: null })
    storagePause('false')
    expect(store.getState().isPaused).toBe(false)
  })
})
