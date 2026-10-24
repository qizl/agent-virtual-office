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
    expect(p.onFrame).toHaveBeenLastCalledWith(data.steps[0].snapshot, expect.objectContaining({ reason: 'restart' }))
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
    expect(p.onFrame).toHaveBeenLastCalledWith(data.final_snapshot, expect.objectContaining({ reason: 'end' }))
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
    expect(p.onFrame).toHaveBeenLastCalledWith(fixture().steps[0].snapshot, expect.objectContaining({ reason: 'restart' }))
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

  it('seeks only to bounded integer presentation time and keeps paused positioning separate from playback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(fixture())))
    const onProgress = vi.fn()
    const p = player({ onProgress })
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(1250)
    p.controller.toggle()
    expect(p.state()).toMatchObject({ state: 'paused', position_ms: 1250, duration_ms: 8000 })
    for (const invalid of [-1, 8001, 1.5, Infinity, NaN, '4000']) expect(p.controller.seek(invalid)).toBe(false)
    p.send({ ...command('seek'), position_ms: 4500 })
    expect(p.state()).toMatchObject({ state: 'paused', step: 2, position_ms: 4500, locating: true })
    await vi.advanceTimersByTimeAsync(250)
    expect(onProgress.mock.lastCall[0]).toMatchObject({ position_ms: 4500, transition_elapsed_ms: 250 })
    await vi.advanceTimersByTimeAsync(250)
    expect(p.state()).toMatchObject({ state: 'paused', position_ms: 4500, locating: false })
    const count = onProgress.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(onProgress).toHaveBeenCalledTimes(count)
    p.controller.toggle()
    await vi.advanceTimersByTimeAsync(3500)
    expect(p.state()).toMatchObject({ state: 'ended', position_ms: 8000 })
    p.controller.seek(100)
    expect(p.state()).toMatchObject({ state: 'paused', position_ms: 100 })
    await vi.advanceTimersByTimeAsync(500)
    expect(p.state()).toMatchObject({ state: 'paused', position_ms: 100, locating: false })
  })

  it('keeps playing after a seek, cancels obsolete positioning and freezes immediately on an ordinary pause', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(fixture())))
    const p = player()
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(100)
    p.controller.seek(5000)
    await vi.advanceTimersByTimeAsync(200)
    p.controller.seek(500)
    expect(p.state()).toMatchObject({ state: 'playing', step: 1, position_ms: 500, locating: true })
    await vi.advanceTimersByTimeAsync(100)
    p.controller.toggle()
    const frozen = p.state()
    await vi.advanceTimersByTimeAsync(5000)
    expect(p.state()).toEqual(frozen)
    p.controller.toggle()
    await vi.advanceTimersByTimeAsync(500)
    expect(p.state()).toMatchObject({ state: 'playing', position_ms: 600, locating: false })
    p.controller.seek(8000)
    expect(p.state()).toMatchObject({ state: 'ended', position_ms: 8000 })
  })

  it('samples presentation with requestAnimationFrame while throttling parent state from the same clock', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(fixture())))
    const host = fakeScope()
    host.scope.requestAnimationFrame = vi.fn((callback) => setTimeout(callback, 16))
    host.scope.cancelAnimationFrame = vi.fn(clearTimeout)
    const onProgress = vi.fn()
    const p = player({ scope: host.scope, onProgress })
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(160)
    expect(host.scope.requestAnimationFrame).toHaveBeenCalled()
    expect(onProgress.mock.calls.length).toBeGreaterThan(p.onState.mock.calls.length)
    expect(onProgress.mock.lastCall[0].position_ms).toBe(160)
    p.controller.toggle()
    const count = onProgress.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(onProgress).toHaveBeenCalledTimes(count)
    p.controller.destroy()
    expect(host.scope.cancelAnimationFrame).toHaveBeenCalled()
  })

  it('publishes the last paused positioning status even when completion falls inside the throttle window', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(fixture())))
    const host = fakeScope()
    host.scope.requestAnimationFrame = vi.fn((callback) => setTimeout(callback, 20))
    host.scope.cancelAnimationFrame = vi.fn(clearTimeout)
    const p = player({ scope: host.scope })
    p.controller.onTerminal('completed')
    await vi.advanceTimersByTimeAsync(0)
    p.controller.toggle()
    p.controller.seek(4500)
    await vi.advanceTimersByTimeAsync(480)
    expect(p.state()).toMatchObject({ state: 'paused', locating: true })
    await vi.advanceTimersByTimeAsync(20)
    expect(p.state()).toMatchObject({ state: 'paused', position_ms: 4500, locating: false })
    expect(host.scope.parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      state: 'paused', position_ms: 4500, locating: false,
    }), host.scope.location.origin)
    const count = p.onState.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(p.onState).toHaveBeenCalledTimes(count)
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
  it('replaces historical facts without remounting character identities', () => {
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
      expect(agentRenderKey(id, state.mawMeta)).toBe(liveKey)
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

  it('keeps displayed positions continuous across actor changes and seeks while restoring only target-frame facts', async () => {
    const host = fakeScope()
    vi.stubGlobal('window', host.scope)
    const base = snapshot('idle')
    base.members.push({ ...base.members[0], id: 'reviewer', role: 'reviewer', label: 'No activity in this frame', task_kind: null, round: null, verdict: null })
    base.members[0].verdict = null
    const publication = structuredClone(base)
    publication.members[0].status = 'planning'
    const delivery = structuredClone(base)
    delivery.members[0].status = 'awaiting-approval'
    const result = structuredClone(base)
    result.members[1] = { ...result.members[1], status: 'done', verdict: 'fail', task_kind: 'review', round: 1 }
    const cue = (actor, activity, type, seq, ref = null) => ({ actor_member_id: actor, activity,
      task: { seq, round: 1, type, source_ref: `${actor === 'reviewer' ? 'reviewer' : 'executor'}-1/task-${String(seq).padStart(3, '0')}.json`, ref_task: ref },
      related_member_ids: ref ? ['executor'] : [] })
    const steps = [publication, delivery, result].map((frame, i) => ({ id: `step-${i}`, kind: 'task-record', label: `Recorded step ${i}`,
      recorded_at: null, source_refs: [], snapshot: frame, cue: i < 2 ? cue('executor', i === 0 ? 'publication' : 'delivery', 'dev', 1)
        : cue('reviewer', 'result', 'review', 2, 'executor-1/task-001.json') }))
    const data = fixture({ steps, final_snapshot: { ...result, terminal: 'completed-with-findings' } })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url) => url.startsWith('/api/visualization/history')
      ? reply(data) : { ok: true, status: 200, json: async () => ({ ok: true, data: { server_epoch: 1, seq: 1, snapshot: data.final_snapshot } }) }))
    const cleanup = startDashboardIntegration(useOfficeStore, config)
    cleanups.push(cleanup)
    await vi.advanceTimersByTimeAsync(3950)
    const id = 'executor~executor'
    const before = useOfficeStore.getState().dashboardHistoryPresentation.agents[id].position
    await vi.advanceTimersByTimeAsync(50)
    expect(useOfficeStore.getState().dashboardHistoryPresentation.agents[id].position).toMatchObject(before)
    await vi.advanceTimersByTimeAsync(4100)
    const current = useOfficeStore.getState()
    expect(current.agents['reviewer~reviewer'].maw.verdict).toBe('fail')
    expect(current.dashboardHistoryPresentation.agents['reviewer~reviewer'].active).toBe(true)
    current.togglePause()
    const frozen = structuredClone(useOfficeStore.getState().dashboardHistoryPresentation)
    await vi.advanceTimersByTimeAsync(5000)
    expect(useOfficeStore.getState().dashboardHistoryPresentation).toEqual(frozen)
    expect(useOfficeStore.getState().dashboardHistory).toMatchObject({ state: 'paused', duration_ms: 12000 })
    host.send({ ...command('seek'), position_ms: 1500 })
    const sought = useOfficeStore.getState()
    expect(sought.dashboardHistory).toMatchObject({ state: 'paused', step: 1, position_ms: 1500, locating: true })
    expect(sought.dashboardHistoryPresentation.agents[id].position.x).toBe(frozen.agents[id].position.x)
    expect(sought.dashboardHistoryPresentation.agents[id].position.y).toBe(frozen.agents[id].position.y)
    expect(sought.agents['reviewer~reviewer'].maw.verdict).toBeNull()
    expect(sought.dashboardHistoryPresentation.agents['reviewer~reviewer'].active).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    const located = structuredClone(useOfficeStore.getState().dashboardHistoryPresentation)
    expect(useOfficeStore.getState().dashboardHistory).toMatchObject({ state: 'paused', position_ms: 1500, locating: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(useOfficeStore.getState().dashboardHistoryPresentation).toEqual(located)
    // Playing seek holds target time while locating, then crosses a step boundary
    // from the current visible coordinate rather than reviving the old transition.
    useOfficeStore.getState().togglePause()
    host.send({ ...command('seek'), position_ms: 3990 })
    await vi.advanceTimersByTimeAsync(500)
    const beforeBoundary = useOfficeStore.getState().dashboardHistoryPresentation.agents[id].position
    await vi.advanceTimersByTimeAsync(50)
    const afterBoundary = useOfficeStore.getState().dashboardHistoryPresentation.agents[id].position
    expect(useOfficeStore.getState().dashboardHistory.step).toBe(2)
    expect(Math.hypot(beforeBoundary.x - afterBoundary.x, beforeBoundary.y - afterBoundary.y)).toBeLessThan(2)
    host.send({ ...command('seek'), position_ms: 12000 })
    const endSeekFrom = useOfficeStore.getState().dashboardHistoryPresentation.agents[id].position
    expect(endSeekFrom.x).toBe(afterBoundary.x)
    expect(endSeekFrom.y).toBe(afterBoundary.y)
    expect(useOfficeStore.getState().dashboardHistory).toMatchObject({ state: 'ended', position_ms: 12000 })
    await vi.advanceTimersByTimeAsync(500)
    expect(useOfficeStore.getState().dashboardHistoryPresentation.agents[id].position).toMatchObject(useOfficeStore.getState().agents[id].position)
    useOfficeStore.getState().togglePause() // replay, without remounting the characters
    await vi.advanceTimersByTimeAsync(11950)
    const beforeEnd = useOfficeStore.getState().dashboardHistoryPresentation.agents[id].position
    await vi.advanceTimersByTimeAsync(50)
    const ended = useOfficeStore.getState()
    expect(ended.dashboardHistory.state).toBe('ended')
    expect(ended.dashboardHistoryPresentation.agents[id].position.x).toBe(beforeEnd.x)
    expect(ended.dashboardHistoryPresentation.agents[id].position.y).toBe(beforeEnd.y)
    expect(ended.dashboardHistoryPresentation.agents['reviewer~reviewer'].behavior).toBe('idle')
    cleanup()
    expect(useOfficeStore.getState().dashboardHistoryPresentation).toBeNull()
  })
})
