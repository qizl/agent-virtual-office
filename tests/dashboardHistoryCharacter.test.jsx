import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ state: null }))
vi.mock('../src/systems/store.js', async (original) => {
  const real = await original()
  const useOfficeStore = (selector) => selector(harness.state)
  useOfficeStore.getState = () => harness.state
  return { ...real, useOfficeStore }
})
import AgentCharacter from '../src/components/AgentCharacter.jsx'
import BehaviorBubble from '../src/components/BehaviorBubble.jsx'

beforeEach(() => {
  harness.state = { integration: 'dashboard', mawMeta: { dashboard_history: true }, reducedMotion: false,
    helpers: [], externalStatus: {}, recurringFailureLog: {}, reluctant: {}, effort: 'normal', sceneScale: 1,
    sceneBounds: { minX: 0, minY: 0, w: 800, h: 560 }, dashboardHistory: { state: 'paused' },
    agents: { 'dev~executor': { id: 'dev~executor', status: 'awaiting-approval', behavior: 'await-approval',
      expression: 'normal', bubble: 'Recorded delivery', position: { x: 650, y: 300 }, isMoving: false } },
    dashboardHistoryPresentation: { step_id: 'delivery', stage: '交付记录', agents: {
      'dev~executor': { position: { x: 340.5, y: 364.25 }, behavior: 'pass-document', expression: 'normal',
        active: true, related: false, isMoving: false, frame: 2, walkFrame: 2, facing: 'down' },
    } },
  }
})
const render = () => renderToStaticMarkup(<svg><AgentCharacter agent={{ id: 'dev~executor', color: '#123456' }} /></svg>)

describe('Controlled historical character', () => {
  it('renders presentation position and gesture while preserving the observed status', () => {
    const html = render()
    expect(html).toContain('translate(340.5, 364.25)')
    expect(html).toContain('data-agent-status="awaiting-approval"')
    expect(html).toContain('data-agent-behavior="pass-document"')
    expect(html).toContain('data-history-actor="1"')
    expect(html).toContain('交付记录 · Recorded')
    expect(html).toContain('transition:none')
  })

  it('removes a later result bubble immediately when a target frame has no actor', () => {
    harness.state.agents['dev~executor'].bubble = 'Later verdict must not survive'
    harness.state.dashboardHistoryPresentation.agents['dev~executor'].active = false
    const html = render()
    expect(html).not.toContain('Later verdict')
    expect(html).not.toContain('speech-bubble')
    expect(html).not.toContain('data-history-actor="1"')
  })

  it('makes controlled bubbles immediate while retaining default live fades', () => {
    const history = renderToStaticMarkup(<svg><BehaviorBubble x={0} y={0} message="Recorded" instant /></svg>)
    const live = renderToStaticMarkup(<svg><BehaviorBubble x={0} y={0} message="Live" /></svg>)
    expect(history).toContain('data-bubble-visible="1"')
    expect(history).toContain('transition:none')
    expect(live).toContain('transition:opacity 0.3s, transform 0.3s')
  })
})
