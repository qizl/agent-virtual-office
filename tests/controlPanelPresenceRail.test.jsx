import React from 'react'
import { describe, expect, it, vi } from 'vitest'

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

  it('preserves the standalone fixed footer', async () => {
    const { html } = await renderControlPanelWithMockStore()
    const wrapper = html.slice(0, html.indexOf('>') + 1)
    expect(wrapper).toContain('fixed bottom-0 left-0 right-0')
    expect(wrapper).not.toContain('data-dashboard-controls')
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
  })

  it('renders the normalized external status for the rail dot and screen-reader text', async () => {
    const { html, statusColors } = await renderControlPanelWithMockStore()

    expect(html).toContain(`background-color:${statusColors.done}`)
    expect(html).toContain('<span class="sr-only">done</span>')
    expect(html).not.toContain('<span class="sr-only">idle</span>')
  })
})
