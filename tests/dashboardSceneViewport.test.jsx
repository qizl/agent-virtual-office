import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Server rendering otherwise reads Zustand's initial snapshot, not the selected mode.
vi.mock('../src/systems/store', async (original) => {
  const actual = await original()
  const hook = Object.assign((selector) => selector(actual.useOfficeStore.getState()), actual.useOfficeStore)
  return { ...actual, useOfficeStore: hook }
})
import PixelOffice from '../src/components/PixelOffice.jsx'
import { useOfficeStore } from '../src/systems/store'

const initial = useOfficeStore.getState()
afterEach(() => useOfficeStore.setState(initial, true))

describe('Dashboard scene viewport paint', () => {
  it.each(['playing', 'paused', 'ended'])('paints letterbox gutters during %s playback without changing scene geometry', (state) => {
    useOfficeStore.setState({ integration: 'dashboard', rosterMode: false,
      dashboardHistory: { state }, agents: {}, mawMeta: null })
    const html = renderToStaticMarkup(<PixelOffice />)
    const svg = html.match(/<svg\b[^>]*>/)[0]
    expect(svg).toContain('bg-[#F5F2EB] dark:bg-[#1a1814]')
    expect(svg).toContain('viewBox="0 0 800 560"')
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"')
    expect((html.match(/<svg\b/g) || [])).toHaveLength(1)
  })

  it('preserves transparent standalone and compact scene viewports', () => {
    useOfficeStore.setState({ integration: null, rosterMode: false, agents: {} })
    for (const mode of ['full', 'panel']) {
      const svg = renderToStaticMarkup(<PixelOffice mode={mode} />).match(/<svg\b[^>]*>/)[0]
      expect(svg).toContain('class="w-full h-full"')
      expect(svg).not.toContain('bg-[')
    }
  })
})
