import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.useRealTimers())

async function renderControlPanelWithMockStore(overrides = {}) {
  vi.resetModules()

  const statusColors = {
    idle: '#888',
    working: '#EF9F27',
    done: '#5CB88A',
    blocked: '#E24B4A',
    planning: '#8B7FD6',
    'awaiting-approval': '#1E9FD4',
  }

  const mockState = {
    agents: {
      dev: {
        id: 'dev',
        status: 'idle',
        behavior: 'reading-screen',
        color: '#1D9E75',
      },
    },
    isPaused: false,
    officeCalm: { mode: "unknown", eligibleSince: null },
    experienceFlags: { calmEnabled: false },
    togglePause: () => {},
    rosterMode: false,
    toggleRosterMode: () => {},
    weatherEffects: false,
    toggleWeatherEffects: () => {},
    lightingEnabled: false,
    toggleLighting: () => {},
    soundscapeEnabled: false,
    toggleSoundscape: () => {},
    officePet: false,
    toggleOfficePet: () => {},
    petType: 'cat',
    setPetType: () => {},
    theme: 'classic',
    setTheme: () => {},
    mood: 'normal',
    watchdogRestarts: 0,
    triggerWorkflow: () => {},
    activeEvent: null,
    hour: 9,
    minute: 5,
    externalStatus: {
      dev: { status: 'done', task: 'Edit' },
    },
    statusSource: 'external',
    tokens: {},
    integrationHealth: { state: 'online' },
    reducedMotion: true,
    dailyDoneLedger: { counts: {} },
    dailyBlockedLedger: { counts: {} },
    ...overrides,
  }

  const storeHook = (selector) => selector(mockState)
  storeHook.setState = () => {}
  storeHook.getState = () => mockState

  vi.doMock('../src/systems/store', () => ({
    STATUS_COLORS: statusColors,
    useOfficeStore: storeHook,
  }))
  vi.doMock('../src/systems/store.js', () => ({
    STATUS_COLORS: statusColors,
    useOfficeStore: storeHook,
  }))
  vi.doMock('../src/i18n', () => ({
    behaviorLabel: (behavior) => behavior,
    charName: (id) => ({ dev: 'Developer' }[id] || id),
    t: (_key, fallback) => fallback,
    setLocale: () => {},
    availableLocales: () => ['en', 'zh-TW'],
    useLocale: () => 'en',
    eventName: (id) => id,
  }))
  vi.doMock('../src/i18n.js', () => ({
    behaviorLabel: (behavior) => behavior,
    charName: (id) => ({ dev: 'Developer' }[id] || id),
    t: (_key, fallback) => fallback,
    setLocale: () => {},
    availableLocales: () => ['en', 'zh-TW'],
    useLocale: () => 'en',
    eventName: (id) => id,
  }))

  const { renderToStaticMarkup } = await import('react-dom/server')
  const { default: ControlPanel } = await import('../src/components/ControlPanel.jsx')
  return { html: renderToStaticMarkup(<ControlPanel mode="full" />), statusColors }
}

describe('ControlPanel — presence rail render contract', () => {
  it('reserves the actual Dashboard footer height in the office flex layout', async () => {
    const { html } = await renderControlPanelWithMockStore({
      integration: 'dashboard',
      dashboardSync: { state: 'error', code: 'read-failed', lastValidAt: null },
    })
    const wrapper = html.slice(0, html.indexOf('>') + 1)
    expect(wrapper).toContain('data-dashboard-controls="true"')
    expect(wrapper).toContain('relative w-full shrink-0')
    expect(wrapper).not.toContain('fixed')
    expect(html).toContain('flex flex-wrap items-center justify-center')
  })

  it('renders a fixed-width local wall clock across midnight independently of sample time and scene pause', async () => {
    vi.useFakeTimers()
    const midnight = new Date(2026, 9, 27, 23, 59, 59).getTime()
    const state = {
      integration: 'dashboard', isPaused: true,
      dashboardSync: { state: 'synced', code: null, lastValidAt: 10000, retrying: false },
    }
    vi.setSystemTime(midnight)
    const before = (await renderControlPanelWithMockStore(state)).html
    vi.setSystemTime(midnight + 1000)
    const after = (await renderControlPanelWithMockStore(state)).html
    const clock = (html) => html.match(/<time[^>]*data-dashboard-clock[^>]*>[\s\S]*?<\/time>/)?.[0]
    expect(clock(before)).toContain('23:59:59</time>')
    expect(clock(after)).toContain('00:00:00</time>')
    expect(clock(after)).toContain('w-[8ch]')
    expect(clock(after)).toContain('font-mono tabular-nums')
    expect(clock(after)).toContain(`dateTime="${new Date(midnight + 1000).toISOString()}"`)
    const live = after.match(/<div[^>]*data-dashboard-sync="synced"[\s\S]*?<\/div>/)[0]
    expect(live).not.toContain('role="status"')
    expect(live).not.toContain('synced</span>')
    expect(live).not.toContain('Last sample')
    expect(live).not.toContain('<button')
    expect(after).not.toContain('09:05')
  })

  it.each([null, { state: 'loading', retrying: true }])('shows the live clock without initial synchronization wording (%j)', async (dashboardSync) => {
    const { html } = await renderControlPanelWithMockStore({ integration: 'dashboard', dashboardSync })
    expect(html).toContain('data-dashboard-clock')
    expect(html).not.toContain('loading</span>')
    expect(html).not.toContain('Retry</button>')
  })

  it.each(['loading', 'configuration-error'])('does not offer retry for %s', async (state) => {
    const { html } = await renderControlPanelWithMockStore({
      integration: 'dashboard', dashboardSync: { state, lastValidAt: null, retrying: state === 'loading' },
    })
    const sync = html.match(/<div[^>]*data-dashboard-sync="[^" ]+"[\s\S]*?<\/div>/)[0]
    expect(sync).not.toContain('<button')
  })

  it.each(['error', 'missing', 'stale'])('offers retry only for the recoverable %s state and disables pending retries', async (state) => {
    const render = async (retrying) => (await renderControlPanelWithMockStore({
      integration: 'dashboard', dashboardSync: { state, code: 'read-failed', lastValidAt: 10000, retrying },
    })).html.match(/<div[^>]*data-dashboard-sync="[^" ]+"[\s\S]*?<\/div>/)[0]
    const idle = await render(false)
    const pending = await render(true)
    expect(idle).toContain('Retry</button>')
    expect(idle).not.toContain('disabled=""')
    expect(pending).toContain('disabled=""')
    expect(pending).toMatch(new RegExp(`<span[^>]*>${state}</span>`))
    expect(pending).toContain('read-failed')
  })

  it('preserves the standalone fixed footer', async () => {
    const { html } = await renderControlPanelWithMockStore()
    const wrapper = html.slice(0, html.indexOf('>') + 1)
    expect(wrapper).toContain('fixed bottom-0 left-0 right-0')
    expect(wrapper).not.toContain('data-dashboard-controls')
    expect(html).toContain('09:05')
    expect(html).not.toContain('data-dashboard-clock')
  })

  it('labels historical scenes and derives pause controls from the replay clock', async () => {
    const { html } = await renderControlPanelWithMockStore({
      integration: 'dashboard', isPaused: true,
      dashboardSync: { state: 'synced' },
      dashboardHistory: { state: 'playing', message: '任务记录回顾 · 非实时 · 时间未记录', label: 'Recorded result' },
    })
    expect(html).toContain('data-dashboard-history="playing"')
    expect(html).toContain('任务记录回顾 · 非实时 · 时间未记录')
    expect(html).toContain('Recorded result')
    expect(html).toContain('aria-label="Pause"')
    expect(html).not.toContain('data-dashboard-sync')
    expect(html).not.toContain('data-dashboard-clock')
    expect(html).toContain('09:05')
  })

  it('renders the normalized external status for the rail dot and screen-reader text', async () => {
    const { html, statusColors } = await renderControlPanelWithMockStore()

    expect(html).toContain(`background-color:${statusColors.done}`)
    expect(html).toContain('<span class="sr-only">done</span>')
    expect(html).not.toContain('<span class="sr-only">idle</span>')
  })
})
