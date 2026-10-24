import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDashboardHistoryController, validateDashboardHistory } from '../src/inference/dashboardHistory.js'
import { startDashboardIntegration } from '../src/inference/dashboardIntegration.js'
import { useOfficeStore } from '../src/systems/store.js'
import { agentRenderKey } from '../src/components/PixelOffice.jsx'

const config = { integration: 'dashboard', project: 'project a', task: 'task&1', error: null }
function snapshot(status = 'blocked', terminal = null) {
  return { schema: 'avo.maw-snapshot/1', sampled_at: 1000, workflow: 'develop', quality: 'ok',
    quality_detail: null, terminal, members: [{ id: 'executor', role: 'executor', status, label: 'Recorded result',
      detail: null, round: 1, task_kind: 'dev', verdict: status === 'blocked' ? 'fail' : 'pass', terminate: null, stalled: false }] }
}
function fixture(overrides = {}) {
  return { schema: 'avo.maw-history/1', project: config.project, task: config.task,
    terminal: 'completed-with-findings', eligible: true, complete: false, warnings: ['Some transaction history is missing'],
    steps: [
      { id: 'result-1', kind: 'task-result', label: 'Recorded failed review', recorded_at: null,
        source_refs: ['tasks/reviewer.json'], snapshot: snapshot() },
      { id: 'result-2', kind: 'task-result', label: 'Recorded repair result', recorded_at: '2026-10-24T08:00:00Z',
        source_refs: ['tasks/executor.json'], snapshot: snapshot('done') },
    ], final_snapshot: snapshot('done', 'completed-with-findings'), ...overrides }
}
function reply(data, ok = true) { return { ok, text: async () => JSON.stringify({ ok, data }) } }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
function fakeScope() {
  const listeners = new Map()
  const svg = { pauseAnimations: vi.fn(), unpauseAnimations: vi.fn() }
  const scope = { location: { origin: 'http://127.0.0.1:8765' }, parent: { postMessage: vi.fn() },
    document: { querySelectorAll: () => [svg] },
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name) } }
  return { scope, svg, send(data, overrides = {}) { listeners.get('message')?.({ source: scope.parent, origin: scope.location.origin, data, ...overrides }) } }
}
function command(command = 'toggle', binding = config) {
  return { schema: 'avo.dashboard.history-command/1', project: binding.project, task: binding.task, command }
}
const cleanups = []
function player(overrides = {}) {
  const host = fakeScope()
  const hooks = { onStart: vi.fn(), onFrame: vi.fn(), onState: vi.fn(), onPause: vi.fn() }
  const controller = createDashboardHistoryController({ config, ...hooks, scope: host.scope, ...overrides })
  cleanups.push(() => controller.destroy())
  return { ...host, ...hooks, controller, state: () => hooks.onState.mock.lastCall[0] }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  useOfficeStore.setState({ mode: 'maw', integration: 'dashboard', agents: {}, mawMeta: null,
    dashboardSync: null, dashboardRetry: 0, dashboardHistory: null, dashboardHistoryToggle: 0, isPaused: false })
})
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Recorded history boundary', () => {
  it('accepts partial recorded history while rejecting swapped binding, invalid frames, duplicate milestones and terminal conflicts', () => {
    expect(validateDashboardHistory(fixture(), config)).toBe(true)
    expect(validateDashboardHistory(fixture({ steps: [] }), config)).toBe(true)
    expect(validateDashboardHistory(fixture({ project: 'other' }), config)).toBe(false)
    expect(validateDashboardHistory(fixture({ task: 'other' }), config)).toBe(false)
    expect(validateDashboardHistory(fixture({ final_snapshot: snapshot('done', 'completed') }), config)).toBe(false)
    expect(validateDashboardHistory(fixture({ terminal: 'cancelled' }), config)).toBe(false)
    expect(validateDashboardHistory(fixture({ steps: [...fixture().steps, fixture().steps[0]] }), config)).toBe(false)
    expect(validateDashboardHistory(fixture({ steps: [{ ...fixture().steps[0], recorded_at: 'not a time' }] }), config)).toBe(false)
    expect(validateDashboardHistory(fixture({ steps: [{ ...fixture().steps[0], snapshot: snapshot('invented') }] }), config)).toBe(false)
    expect(validateDashboardHistory(fixture({ steps: Array.from({ length: 201 }, (_, i) => ({ ...fixture().steps[0], id: `${i}` })) }), config)).toBe(false)
    expect(validateDashboardHistory(fixture({ padding: 'x'.repeat(1024 * 1024) }), config)).toBe(false)
  })

  it('does not require transaction history or timestamps and retains failed result facts without final conclusions on earlier frames', async () => {
    const data = fixture()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(data)))
    const p = player()
    p.controller.onTerminal('completed-with-findings')
    await vi.advanceTimersByTimeAsync(0)
    expect(p.onFrame).toHaveBeenLastCalledWith(data.steps[0].snapshot)
    expect(p.onFrame.mock.lastCall[0]).toMatchObject({ terminal: null, members: [{ status: 'blocked', verdict: 'fail' }] })
    expect(p.state()).toMatchObject({ state: 'playing', step: 1, total: 2, complete: false, recorded_at: null })
    expect(p.state().message).toContain('任务记录回顾 · 非实时')
    expect(p.state().message).toContain('时间未记录')
    expect(p.state().message).toContain('历史不完整')
  })
})

describe('Iframe-owned playback lifecycle', () => {
  it('autoplays completed tasks once, preserves the remaining four-second step on pause and stops at the final frame without looping', async () => {
    const data = fixture()
    const fetchMock = vi.fn().mockResolvedValue(reply(data))
    vi.stubGlobal('fetch', fetchMock)
    const p = player()
    p.controller.onTerminal('cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
    p.controller.onTerminal('completed-with-findings')
    p.controller.onTerminal('completed-with-findings')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/visualization/history?project=project+a&task=task%261')
    expect(p.onStart).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1250)
    p.controller.toggle()
    expect(p.state().state).toBe('paused')
    expect(p.svg.pauseAnimations).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20000)
    expect(p.onFrame).toHaveBeenCalledOnce()
    p.controller.toggle()
    await vi.advanceTimersByTimeAsync(2749)
    expect(p.onFrame).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(p.state()).toMatchObject({ state: 'playing', step: 2 })
    await vi.advanceTimersByTimeAsync(4000)
    expect(p.state()).toMatchObject({ state: 'ended', step: 2 })
    expect(p.onFrame).toHaveBeenLastCalledWith(data.final_snapshot)
    const count = p.onFrame.mock.calls.length
    await vi.advanceTimersByTimeAsync(20000)
    expect(p.onFrame).toHaveBeenCalledTimes(count)
  })

  it('restart cancels the old step timer and establishes a clean first frame from paused or ended playback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(fixture())))
    const p = player()
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(3000)
    p.controller.toggle()
    p.controller.restart()
    expect(p.state()).toMatchObject({ state: 'playing', step: 1 })
    await vi.advanceTimersByTimeAsync(3999)
    expect(p.state().step).toBe(1)
    await vi.advanceTimersByTimeAsync(4001)
    expect(p.state().state).toBe('ended')
    p.controller.toggle()
    expect(p.state()).toMatchObject({ state: 'playing', step: 1 })
    expect(p.onFrame).toHaveBeenLastCalledWith(fixture().steps[0].snapshot)
  })

  it('disables unavailable history, reports bounded failures and permits an explicit retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(fixture({ eligible: false, steps: [], warnings: ['terminal-conflict'] })))
      .mockResolvedValueOnce({ ok: true, text: async () => 'x'.repeat(1024 * 1024 + 1) })
      .mockResolvedValue(reply(fixture()))
    vi.stubGlobal('fetch', fetchMock)
    const p = player()
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(p.state()).toMatchObject({ state: 'unavailable', code: 'history-unavailable', total: 0 })
    expect(p.state().message).toContain('终局记录冲突')
    expect(p.onStart).not.toHaveBeenCalled()
    p.controller.toggle()
    await vi.advanceTimersByTimeAsync(0)
    expect(p.state()).toMatchObject({ state: 'error', code: 'history-too-large' })
    p.controller.toggle()
    await vi.advanceTimersByTimeAsync(0)
    expect(p.state().state).toBe('playing')
  })

  it('accepts eligible completion with no recorded milestones and keeps playback unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(fixture({ steps: [], warnings: ['playable-history-unavailable'] }))))
    const p = player()
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(p.state()).toMatchObject({ state: 'unavailable', total: 0 })
    expect(p.state().message).toContain('没有可播放的已记录里程碑')
    expect(() => p.send(command('restart'))).not.toThrow()
    expect(p.onStart).not.toHaveBeenCalled()
    expect(p.onFrame).not.toHaveBeenCalled()
  })

  it('cancels a streamed history body at the byte limit before parsing it', async () => {
    const reader = { read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(600000) }), cancel: vi.fn() }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => reader } })
    vi.stubGlobal('fetch', fetchMock)
    const p = player()
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(reader.read).toHaveBeenCalledTimes(2)
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(p.state()).toMatchObject({ state: 'error', code: 'history-too-large' })
    expect(p.onStart).not.toHaveBeenCalled()
  })

  it('aborts requests on timeout or teardown and ignores late history responses after task replacement', async () => {
    const pending = deferred()
    const fetchMock = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    const p = player()
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(p.state()).toMatchObject({ state: 'error', code: 'history-timeout' })
    p.controller.toggle()
    await vi.advanceTimersByTimeAsync(0)
    p.controller.destroy()
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true)
    pending.resolve(reply(fixture()))
    await vi.advanceTimersByTimeAsync(10000)
    expect(p.onFrame).not.toHaveBeenCalled()
    expect(p.onStart).not.toHaveBeenCalled()
  })

  it('accepts commands only from the exact same-origin parent and fixed project/task, preserving independent iframe clocks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url) => reply(fixture({ task: url.includes('task=second') ? 'second' : config.task }))))
    const p = player()
    const other = player({ config: { ...config, task: 'second' } })
    p.controller.onTerminal('completed')
    other.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(0)
    p.send(command(), { origin: 'https://other.example' })
    p.send(command(), { source: other.scope.parent })
    p.send(command('toggle', { ...config, task: 'other' }))
    p.send({ ...command(), schema: 'other' })
    expect(p.state().state).toBe('playing')
    p.send(command())
    expect(p.state().state).toBe('paused')
    expect(other.state().state).toBe('playing')
    await vi.advanceTimersByTimeAsync(4000)
    expect(p.state().step).toBe(1)
    expect(other.state().step).toBe(2)
    expect(p.scope.parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      schema: 'avo.dashboard.history-state/1', project: config.project, task: config.task, state: 'paused',
    }), p.scope.location.origin)
  })
})

describe('History owns the office scene', () => {
  it('replaces live terminal presentation and each historical frame with a fresh character identity', () => {
    const id = 'executor~executor'
    useOfficeStore.getState().applyMawSnapshot({ server_epoch: 1, seq: 1, snapshot: snapshot('done', 'completed-with-findings') })
    const liveKey = agentRenderKey(id, useOfficeStore.getState().mawMeta)
    const neutral = snapshot('idle')
    neutral.members[0].label = 'Role record not yet reviewed'
    for (const seq of [1, 2, 3]) {
      useOfficeStore.getState().applyMawSnapshot({ server_epoch: 0, seq, snapshot: neutral, dashboard_history: true })
      const state = useOfficeStore.getState()
      expect(state.mawMeta).toMatchObject({ terminal: null, dashboard_history: true, seq })
      expect(state.agents[id]).toMatchObject({ name: 'Role record not yet reviewed', bubble: 'Role record not yet reviewed', status: 'idle' })
      expect(agentRenderKey(id, state.mawMeta)).toBe(`${id}:history:${seq}`)
      expect(agentRenderKey(id, state.mawMeta)).not.toBe(liveKey)
    }
    expect(agentRenderKey(id, { seq: 999 })).toBe(liveKey)
  })

  it('stops live polling and choreography, rebuilds stationary frames and routes Space/pause without changing the animation preference', async () => {
    const data = fixture()
    const live = { server_epoch: 1, seq: 1, snapshot: data.final_snapshot }
    const fetchMock = vi.fn().mockImplementation(async (url) => url.startsWith('/api/visualization/history')
      ? reply(data) : { ok: true, status: 200, json: async () => ({ ok: true, data: live }) })
    vi.stubGlobal('fetch', fetchMock)
    const cleanup = startDashboardIntegration(useOfficeStore, config)
    cleanups.push(cleanup)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = useOfficeStore.getState()
    expect(first.dashboardHistory).toMatchObject({ state: 'playing', step: 1 })
    expect(first.mawMeta.terminal).toBeNull()
    expect(first.isPaused).toBe(true)
    expect(first.agents['executor~executor']).toMatchObject({ status: 'blocked', isMoving: false, inGroupEvent: false })
    first.togglePause()
    expect(useOfficeStore.getState().dashboardHistory.state).toBe('paused')
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useOfficeStore.getState().dashboardHistory.step).toBe(1)
    expect(useOfficeStore.getState().mawMeta.quality).toBe('ok')
    useOfficeStore.getState().togglePause()
    await vi.advanceTimersByTimeAsync(4000)
    const second = useOfficeStore.getState()
    expect(second.dashboardHistory.step).toBe(2)
    expect(second.agents['executor~executor']).toMatchObject({ status: 'done', isMoving: false, inGroupEvent: false })
    expect(second.agents['executor~executor'].journeyTarget).toBeUndefined()
    cleanup()
    expect(useOfficeStore.getState()).toMatchObject({ isPaused: false, dashboardHistory: null })
  })
})
