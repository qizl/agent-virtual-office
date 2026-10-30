import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectIntegrationConfig, detectProjectMode, getPlatformConfig } from '../src/systems/platformDetect.js'
import { startDashboardIntegration, validateDashboardEnvelope } from '../src/inference/dashboardIntegration.js'
import { mawHandoffId, validateDashboardSnapshot } from '../src/inference/dashboardSnapshot.js'
import { ZONE_FLOOR_RECTS } from '../src/systems/movementSystem.js'
import { useOfficeStore } from '../src/systems/store.js'

function envelope(seq = 1, overrides = {}) {
  return { server_epoch: 100, seq, snapshot: { schema: 'avo.maw-snapshot/1', sampled_at: 1000,
    workflow: 'develop', quality: 'ok', quality_detail: null, terminal: null,
    members: [{ id: 'member1', role: 'executor', status: 'working', label: 'slice', detail: null,
      round: 1, task_kind: 'dev', verdict: null, terminate: null, stalled: false }], ...overrides } }
}
function reply(data, status = 200) {
  const body = JSON.stringify(data)
  return { ok: status < 400, status, json: async () => data, text: async () => body }
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const config = { integration: 'dashboard', project: 'project a', task: 'task&1', error: null }
const entryStorageKey = (binding = config) => `avo:dashboard-entry:v1:${JSON.stringify([binding.project, binding.task])}`
function mockSessionStorage(entries = []) {
  const values = new Map(entries)
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  }
}
let cleanup
let entryStorage

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  entryStorage = mockSessionStorage()
  vi.stubGlobal('sessionStorage', entryStorage)
  useOfficeStore.setState({ mode: 'maw', integration: 'dashboard', agents: {}, mawMeta: null,
    dashboardSync: null, dashboardRetry: 0, showWorkflow: false, isPaused: false })
})
afterEach(() => { cleanup?.(); cleanup = null; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Dashboard mode and read-only entry points', () => {
  it('is opt-in, requires both explicit bindings and forces full MAW despite a panel override', () => {
    expect(detectIntegrationConfig('')).toMatchObject({ integration: null })
    expect(detectIntegrationConfig('?integration=other')).toMatchObject({ integration: null })
    expect(detectIntegrationConfig('?integration=dashboard&project=a')).toMatchObject({ error: 'missing-task' })
    expect(detectIntegrationConfig('?integration=dashboard&task=b')).toMatchObject({ error: 'missing-project' })
    vi.stubGlobal('window', { location: { search: '?integration=dashboard&mode=panel&project=a&task=b' } })
    expect(detectProjectMode()).toBe('maw')
    expect(getPlatformConfig('embedded', 'dashboard')).toMatchObject({ showControlPanel: true, animationQuality: 'full' })
    expect(getPlatformConfig('embedded').showControlPanel).toBe(false)
  })

  it('guards the mutation actions while preserving display settings and standalone interactions', () => {
    useOfficeStore.getState().applyMawSnapshot(envelope())
    const state = useOfficeStore.getState()
    state.setManualAgentStatus('member1~executor', 'done')
    state.triggerWorkflow()
    state.applyExternalStatus([{ agentId: 'member1~executor', status: 'thinking' }], { source: 'idle-gap-infer' })
    expect(useOfficeStore.getState().agents['member1~executor'].status).toBe('working')
    expect(useOfficeStore.getState().showWorkflow).toBe(false)
    state.togglePause()
    expect(useOfficeStore.getState().isPaused).toBe(true)
    useOfficeStore.setState({ integration: null })
    state.setManualAgentStatus('member1~executor', 'done')
    state.triggerWorkflow()
    expect(useOfficeStore.getState().agents['member1~executor'].status).toBe('done')
    expect(useOfficeStore.getState().showWorkflow).toBe(true)
  })
})

describe('Dashboard envelope validation', () => {
  it('accepts the existing snapshot and rejects invalid order, schema, identities and limits', () => {
    expect(validateDashboardEnvelope(envelope())).toBe(true)
    expect(validateDashboardEnvelope({ ...envelope(), seq: NaN })).toBe(false)
    expect(validateDashboardEnvelope(envelope(1, { schema: 'other' }))).toBe(false)
    expect(validateDashboardEnvelope(envelope(1, { members: [{ id: '../bad', role: 'executor', status: 'working' }] }))).toBe(false)
    const member = envelope().snapshot.members[0]
    expect(validateDashboardEnvelope(envelope(1, { members: [member, member] }))).toBe(false)
    expect(validateDashboardEnvelope(envelope(1, { members: Array.from({ length: 50 }, (_, i) => ({ ...member, id: `m${i}` })) }))).toBe(true)
    expect(validateDashboardEnvelope(envelope(1, { members: Array.from({ length: 51 }, (_, i) => ({ ...member, id: `m${i}` })) }))).toBe(false)
    expect(validateDashboardEnvelope(envelope(1, { workflow: 'x'.repeat(201) }))).toBe(false)
    expect(validateDashboardEnvelope(envelope(1, { members: [{ ...member, label: '中'.repeat(200), detail: '中'.repeat(200) }], unexpected: 'x'.repeat(16384) }))).toBe(false)
    const atLimit = envelope()
    atLimit.snapshot.padding = ''
    atLimit.snapshot.padding = 'x'.repeat(16384 - new TextEncoder().encode(JSON.stringify(atLimit.snapshot)).byteLength)
    expect(new TextEncoder().encode(JSON.stringify(atLimit.snapshot)).byteLength).toBe(16384)
    expect(validateDashboardEnvelope(atLimit)).toBe(true)
    atLimit.snapshot.padding += 'x'
    expect(validateDashboardEnvelope(atLimit)).toBe(false)
    expect(validateDashboardEnvelope({ server_epoch: 1, seq: 0, snapshot: null })).toBe(true)

  })

  it('validates exact-task handoff relations while preserving legacy snapshots', () => {
    expect(mawHandoffId('submission', 'exec-1', 'rev-1', 'executor-1/task-001.json', 'reviewer-1/task-002.json'))
      .toBe('4534b921036473945a2e397f0428183c')
    const base = {
      schema: 'avo.maw-snapshot/1', sampled_at: 1000, quality: 'ok', quality_detail: null,
      workflow: null, terminal: null, members: [
        { id: 'exec-1', role: 'executor', status: 'awaiting-approval',
          current_task: { seq: 1, round: 1, type: 'dev', source_ref: 'executor-1/task-001.json', ref_task: null } },
        { id: 'rev-1', role: 'reviewer', status: 'planning',
          current_task: { seq: 2, round: 1, type: 'review', source_ref: 'reviewer-1/task-002.json', ref_task: 'executor-1/task-001.json' } },
      ], assignment_state: 'assigned', handoff_state: 'complete',
      handoffs: [{ id: mawHandoffId('submission', 'exec-1', 'rev-1', 'executor-1/task-001.json', 'reviewer-1/task-002.json'),
        kind: 'submission', sender_member_id: 'exec-1', recipient_member_id: 'rev-1',
        source_task: 'executor-1/task-001.json', target_task: 'reviewer-1/task-002.json' }],
    }
    expect(validateDashboardSnapshot(base)).toBe(true)
    expect(validateDashboardSnapshot({ ...base, handoffs: [{ ...base.handoffs[0], recipient_member_id: 'foreign' }] })).toBe(false)
    expect(validateDashboardSnapshot({ ...base, handoffs: [{ ...base.handoffs[0], target_task: 'reviewer-1/task-099.json' }] })).toBe(false)
    expect(validateDashboardSnapshot({ ...base, assignment_state: 'maybe' })).toBe(false)
    for (const execution_state of ['not-started', 'started', 'unknown']) {
      expect(validateDashboardSnapshot({ ...base, execution_state })).toBe(true)
    }
    for (const execution_state of ['assigned', '', null, true, 0, [], {}]) {
      expect(validateDashboardSnapshot({ ...base, execution_state })).toBe(false)
    }
    expect(validateDashboardSnapshot({ ...base, handoffs: [base.handoffs[0], base.handoffs[0]] })).toBe(false)
    expect(validateDashboardSnapshot({ schema: 'avo.maw-snapshot/1', sampled_at: 1000, quality: 'ok',
      quality_detail: null, workflow: null, terminal: null, members: [] })).toBe(true)
  })
})

describe('Dashboard fixed binding and lifecycle', () => {
  it('hydrates an interrupted pre-start opening when the same task is remounted in the same tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: true,
      data: envelope(1, { execution_state: 'not-started' }) })))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(useOfficeStore.getState().agents['member1~executor'].inGroupEvent).toBe(true)
    cleanup()

    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    const state = useOfficeStore.getState()
    expect(state.mawMeta).toMatchObject({ dashboard_opening: 0, dashboard_hydration: 1 })
    expect(state.agents['member1~executor'].position).toEqual(state.agents['member1~executor'].maw.workSeat)
    expect(state.agents['member1~executor'].inGroupEvent).toBe(false)
  })

  it('marks a complete first pre-start observation before applying its opening snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: true,
      data: envelope(1, { execution_state: 'not-started' }) })))
    const applySnapshot = vi.spyOn(useOfficeStore.getState(), 'applyMawSnapshot')
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)

    expect(entryStorage.setItem).toHaveBeenCalledExactlyOnceWith(entryStorageKey(), '1')
    expect(entryStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(applySnapshot.mock.invocationCallOrder[0])
  })

  it('isolates the opening marker by project and task, while a new tab session can open again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ ok: true,
      data: envelope(1, { execution_state: 'not-started' }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(entryStorage.getItem).toHaveBeenCalledExactlyOnceWith(entryStorageKey())
    expect(entryStorage.setItem).toHaveBeenCalledExactlyOnceWith(entryStorageKey(), '1')

    for (const binding of [{ ...config, task: 'other-task' }, { ...config, project: 'other-project' }]) {
      cleanup()
      cleanup = startDashboardIntegration(useOfficeStore, binding)
      await vi.advanceTimersByTimeAsync(0)
      expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
      expect(entryStorage.getItem).toHaveBeenLastCalledWith(entryStorageKey(binding))
      expect(entryStorage.setItem).toHaveBeenLastCalledWith(entryStorageKey(binding), '1')
    }

    cleanup()
    entryStorage = mockSessionStorage()
    vi.stubGlobal('sessionStorage', entryStorage)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(entryStorage.setItem).toHaveBeenCalledExactlyOnceWith(entryStorageKey(), '1')
  })

  it.each([
    ['started', envelope(1, { execution_state: 'started' })],
    ['terminal', envelope(1, { execution_state: 'started', terminal: 'cancelled' })],
    ['unknown', envelope(1, { execution_state: 'unknown' })],
    ['legacy', envelope()],
    ['empty', { ...envelope(1), snapshot: null }],
    ['degraded', envelope(1, { quality: 'degraded', execution_state: 'not-started' })],
    ['invalid', envelope(1, { schema: 'invalid', execution_state: 'not-started' })],
  ])('does not consult session storage for a first %s observation', async (_label, first) => {
    const storageGetter = vi.fn(() => entryStorage)
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: storageGetter })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: true, data: first })))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(entryStorage.getItem).not.toHaveBeenCalled()
    expect(entryStorage.setItem).not.toHaveBeenCalled()
    expect(storageGetter).not.toHaveBeenCalled()
  })

  it('does not consult session storage for a failed first observation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(entryStorage.getItem).not.toHaveBeenCalled()
    expect(entryStorage.setItem).not.toHaveBeenCalled()
  })

  it('uses a pre-existing same-task marker to baseline prior handoffs after an unknown observation', async () => {
    const dev = { seq: 1, round: 1, type: 'dev', source_ref: 'executor-1/task-001.json', ref_task: null }
    const review = { seq: 2, round: 1, type: 'review', source_ref: 'reviewer-1/task-002.json', ref_task: dev.source_ref }
    const members = [
      { id: 'executor-one', role: 'executor', status: 'awaiting-approval', current_task: dev },
      { id: 'reviewer-one', role: 'reviewer', status: 'planning', current_task: review },
    ]
    const oldSubmission = { id: mawHandoffId('submission', members[0].id, members[1].id, dev.source_ref, review.source_ref),
      kind: 'submission', sender_member_id: members[0].id, recipient_member_id: members[1].id,
      source_task: dev.source_ref, target_task: review.source_ref }
    entryStorage = mockSessionStorage([[entryStorageKey(), '1']])
    vi.stubGlobal('sessionStorage', entryStorage)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, {
        execution_state: 'unknown', handoff_state: 'unavailable', members, handoffs: [],
      }) }))
      .mockResolvedValue(reply({ ok: true, data: envelope(2, {
        execution_state: 'not-started', assignment_state: 'assigned', handoff_state: 'complete', members,
        handoffs: [oldSubmission],
      }) })))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(entryStorage.getItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    const state = useOfficeStore.getState()
    expect(state.mawMeta).toMatchObject({ dashboard_opening: 0, dashboard_hydration: 2 })
    expect(Object.values(state.agents).every((agent) => agent.position.x === agent.maw.workSeat.x
      && agent.position.y === agent.maw.workSeat.y && !agent.inGroupEvent)).toBe(true)
    expect(entryStorage.getItem).toHaveBeenCalledExactlyOnceWith(entryStorageKey())
    expect(entryStorage.setItem).not.toHaveBeenCalled()
  })

  it.each(['getter', 'getItem', 'setItem'])('bounds a failing storage %s diagnostic to once per mount', async (operation) => {
    const failure = new Error('private session failure detail')
    if (operation === 'getter') {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw failure } })
    } else entryStorage[operation].mockImplementation(() => { throw failure })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: true,
      data: envelope(1, { execution_state: 'not-started' }) })))

    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(6000)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain(failure.message)

    cleanup()
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(6000)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('does not use the live entry marker for terminal history playback or replay', async () => {
    const completed = envelope(1, { execution_state: 'started', terminal: 'completed' })
    const history = { schema: 'avo.maw-history/1', project: config.project, task: config.task,
      terminal: 'completed', eligible: true, complete: true, warnings: [],
      steps: [{ id: 'completion', kind: 'task-result', label: 'Recorded completion', recorded_at: null,
        source_refs: ['tasks/executor/task-001.json'], snapshot: completed.snapshot }],
      final_snapshot: completed.snapshot }
    const storageGetter = vi.fn(() => entryStorage)
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: storageGetter })
    vi.stubGlobal('fetch', vi.fn(async (url) => reply({ ok: true,
      data: url.startsWith('/api/visualization/history') ? history : completed })))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardHistory.state).toBe('playing')
    useOfficeStore.getState().togglePause()
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardHistory.state).toBe('paused')
    useOfficeStore.getState().togglePause()
    await vi.advanceTimersByTimeAsync(useOfficeStore.getState().dashboardHistory.duration_ms + 50)
    expect(useOfficeStore.getState().dashboardHistory.state).toBe('ended')
    useOfficeStore.getState().togglePause()
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardHistory).toMatchObject({ state: 'playing', position_ms: 0 })
    expect(storageGetter).not.toHaveBeenCalled()
    expect(entryStorage.getItem).not.toHaveBeenCalled()
    expect(entryStorage.setItem).not.toHaveBeenCalled()
  })

  it('hydrates a running task at its current workstations without entry or old handoffs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: true, data: envelope(1, {
      assignment_state: 'assigned', execution_state: 'started',
    }) })))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(8000)
    const agent = useOfficeStore.getState().agents['member1~executor']
    expect(agent.position).toEqual(agent.maw.workSeat)
    expect(agent).toMatchObject({ inGroupEvent: false, isMoving: false, groupTarget: null })
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(1)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
  })

  it('keeps the live scene after a task completes during the same visualization mount', async () => {
    const roles = ['manager', 'decision-maker', 'executor', 'reviewer']
    const members = roles.map((role, index) => ({ ...envelope().snapshot.members[0],
      id: `terminal-member-${index}`, role, status: 'working' }))
    const running = envelope(1, { execution_state: 'started', members })
    const completed = envelope(2, { execution_state: 'started', terminal: 'completed',
      members: members.map((member) => ({ ...member, status: 'done', verdict: 'pass' })) })
    const history = { schema: 'avo.maw-history/1', project: config.project, task: config.task,
      terminal: 'completed', eligible: true, complete: true, warnings: [],
      steps: [{ id: 'completion', kind: 'task-result', label: 'Recorded completion', recorded_at: null,
        source_refs: ['tasks/executor/task-001.json'], snapshot: completed.snapshot }],
      final_snapshot: completed.snapshot }
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (url.startsWith('/api/visualization/history')) return reply({ ok: true, data: history })
      return reply({ ok: true, data: fetchMock.mock.calls.length === 1 ? running : completed })
    })
    vi.stubGlobal('fetch', fetchMock)
    const walkerCleanup = useOfficeStore.subscribe(() => {
      for (const agent of Object.values(useOfficeStore.getState().agents)) {
        if (!agent?.inGroupEvent || !agent.groupTarget
          || (agent.position?.x === agent.groupTarget.x && agent.position?.y === agent.groupTarget.y)) continue
        setTimeout(() => {
          const current = useOfficeStore.getState().agents[agent.id]
          if (!current?.inGroupEvent || !current.groupTarget) return
          useOfficeStore.setState({ agents: { ...useOfficeStore.getState().agents,
            [agent.id]: { ...current, position: { ...current.groupTarget } } } })
        }, 500)
      }
    })
    cleanup = startDashboardIntegration(useOfficeStore, config)

    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(useOfficeStore.getState().dashboardHistory).toMatchObject({ state: 'live' })
      await vi.advanceTimersByTimeAsync(30_000)

      const live = useOfficeStore.getState()
      expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/visualization/history'))).toBe(false)
      expect(live.dashboardHistory).toMatchObject({ state: 'live' })
      expect(live.mawMeta).toMatchObject({ terminal: 'completed' })
      expect(live.isPaused).toBe(false)
      for (const agent of Object.values(live.agents)) {
        expect(agent.status).toBe('done')
        expect(agent.behavior).toBe('idle')
        const point = agent.groupTarget || agent.position
        expect([ZONE_FLOOR_RECTS.meetingRoom, ZONE_FLOOR_RECTS.lounge, ZONE_FLOOR_RECTS.research]
          .some((rect) => point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2),
        `${agent.id}: ${JSON.stringify(point)}`).toBe(true)
      }
      expect(Object.values(live.agents).some((agent) => agent.inGroupEvent)).toBe(true)

      cleanup()
      cleanup = null
      cleanup = startDashboardIntegration(useOfficeStore, config)
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/visualization/history'))).toBe(true)
      expect(useOfficeStore.getState().dashboardHistory).toMatchObject({ state: 'playing', step: 1 },
        JSON.stringify(useOfficeStore.getState().dashboardHistory))
    } finally {
      walkerCleanup()
    }
  })

  it.each([
    ['a failed request', reply({ ok: false, error: { code: 'read-failed' } }, 503)],
    ['an invalid snapshot', reply({ ok: true, data: envelope(1, { schema: 'invalid' }) })],
  ])('does not consume terminal autoplay eligibility after %s', async (_label, firstResponse) => {
    const completed = envelope(2, { execution_state: 'started', terminal: 'completed' })
    const history = { schema: 'avo.maw-history/1', project: config.project, task: config.task,
      terminal: 'completed', eligible: true, complete: true, warnings: [],
      steps: [{ id: 'completion', kind: 'task-result', label: 'Recorded completion', recorded_at: null,
        source_refs: ['tasks/executor/task-001.json'], snapshot: completed.snapshot }],
      final_snapshot: completed.snapshot }
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (url.startsWith('/api/visualization/history')) return reply({ ok: true, data: history })
      return fetchMock.mock.calls.length === 1 ? firstResponse : reply({ ok: true, data: completed })
    })
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/visualization/history'))).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/visualization/history'))).toBe(true)
    expect(useOfficeStore.getState().dashboardHistory).toMatchObject({ state: 'playing', step: 1 })
  })

  it('baselines old handoffs on the first determinate started fact after an unknown observation', async () => {
    const dev = { seq: 1, round: 1, type: 'dev', source_ref: 'executor-1/task-001.json', ref_task: null }
    const review = { seq: 2, round: 1, type: 'review', source_ref: 'reviewer-1/task-002.json', ref_task: dev.source_ref }
    const members = [
      { id: 'executor-one', role: 'executor', status: 'awaiting-approval', current_task: dev },
      { id: 'reviewer-one', role: 'reviewer', status: 'planning', current_task: review },
    ]
    const oldSubmission = { id: mawHandoffId('submission', members[0].id, members[1].id, dev.source_ref, review.source_ref),
      kind: 'submission', sender_member_id: members[0].id, recipient_member_id: members[1].id,
      source_task: dev.source_ref, target_task: review.source_ref }
    const newResult = { id: mawHandoffId('review-result', members[1].id, members[0].id, review.source_ref, dev.source_ref),
      kind: 'review-result', sender_member_id: members[1].id, recipient_member_id: members[0].id,
      source_task: review.source_ref, target_task: dev.source_ref }
    const started = { execution_state: 'started', handoff_state: 'complete', members, handoffs: [oldSubmission] }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, {
        execution_state: 'unknown', handoff_state: 'unavailable', members, handoffs: [],
      }) }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(2, started) }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(3, started) }))
      .mockResolvedValue(reply({ ok: true, data: envelope(4, { ...started, handoffs: [oldSubmission, newResult] }) })))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(2)
    for (const agent of Object.values(useOfficeStore.getState().agents)) {
      expect(agent.position).toEqual(agent.maw.workSeat)
      expect(agent.inGroupEvent).toBe(false)
    }
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(2)
    expect(Object.values(useOfficeStore.getState().agents).some((a) => a.inGroupEvent)).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(2)
    expect(Object.values(useOfficeStore.getState().agents).every((a) => a.inGroupEvent)).toBe(true)
  })

  it('opens every pre-start role to its work post at once, preserving routes when startup arrives', async () => {
    const idle = { ...envelope().snapshot.members[0], status: 'idle', task_kind: null, round: null }
    const members = [{ ...idle, id: 'manager1', role: 'manager' }, idle,
      { ...idle, id: 'reviewer1', role: 'reviewer' }]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, {
        execution_state: 'not-started', assignment_state: 'unassigned', members,
      }) }))
      .mockResolvedValue(reply({ ok: true, data: envelope(2, {
        execution_state: 'started', assignment_state: 'assigned', members: members.map((m) => ({ ...m, status: 'working' })),
      }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    const first = useOfficeStore.getState().agents
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(0)
    expect(first['manager1~manager'].groupTarget).toEqual({ x: 100, y: 80 })
    // CR-14 R13: shuffled launch slots (identity under the spy) — the manager
    // walks first, the others follow one slot apart
    expect(first['manager1~manager'].inGroupEvent).toBe(true)
    expect(first['member1~executor'].inGroupEvent).toBe(false) // its 600ms slot has not fired
    const routes = new Map()
    for (const agent of Object.values(first)) {
      routes.set(agent.id, agent.maw.workSeat)
      expect(agent.position).not.toEqual(agent.maw.workSeat)
    }
    useOfficeStore.getState().requestDashboardSync()
    await vi.advanceTimersByTimeAsync(599)
    expect(useOfficeStore.getState().agents['member1~executor'].inGroupEvent).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(useOfficeStore.getState().agents['member1~executor'].inGroupEvent).toBe(true)
    expect(useOfficeStore.getState().agents['member1~executor'].groupTarget).toEqual(routes.get('member1~executor'))
    expect(useOfficeStore.getState().agents['reviewer1~reviewer'].inGroupEvent).toBe(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(useOfficeStore.getState().agents['reviewer1~reviewer'].groupTarget).toEqual(routes.get('reviewer1~reviewer'))
    // the startup snapshot preserves every in-flight opening route (no restart)
    const updated = useOfficeStore.getState().agents
    for (const agent of Object.values(updated)) expect(agent.groupTarget).toEqual(routes.get(agent.id))
    expect(updated['manager1~manager'].position).toEqual(first['manager1~manager'].position)
    await vi.advanceTimersByTimeAsync(4000)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(0)
  })

  it('empty, unknown and failed observations do not consume the first determinate entry decision', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: { ...envelope(), snapshot: null } }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(2, { execution_state: 'unknown' }) }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(reply({ ok: true, data: envelope(4, { execution_state: 'not-started' }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(1)
    await vi.advanceTimersByTimeAsync(4001)
    const agent = useOfficeStore.getState().agents['member1~executor']
    expect(agent.position).not.toEqual(agent.maw.workSeat)
    expect(agent.inGroupEvent).toBe(true)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(useOfficeStore.getState().mawMeta.dashboard_recovery).toBe(1)
  })

  it('moves idle pre-start members to work posts and cancels pending entry on remount', async () => {
    const idle = { ...envelope().snapshot.members[0], status: 'idle', task_kind: null, round: null }
    const members = [{ ...idle, id: 'manager1', role: 'manager' }, idle]
    const fetchMock = vi.fn().mockResolvedValue(reply({ ok: true, data: envelope(1, { execution_state: 'not-started', members }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(600)
    const entering = useOfficeStore.getState().agents['member1~executor']
    expect(entering.status).toBe('idle')
    expect(entering.groupTarget).toEqual(entering.maw.workSeat)
    cleanup()
    fetchMock.mockResolvedValue(reply({ ok: true, data: envelope(2, { execution_state: 'started', members }) }))
    cleanup = startDashboardIntegration(useOfficeStore, { ...config, task: 'different-task' })
    await vi.advanceTimersByTimeAsync(5000)
    for (const agent of Object.values(useOfficeStore.getState().agents)) {
      expect(agent.position).toEqual(agent.maw.workSeat)
      expect(agent.inGroupEvent).toBe(false)
    }
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
  })

  it('does not reopen from assignment changes, later pre-start claims, terminal or legacy data', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, { execution_state: 'started', assignment_state: 'unassigned' }) }))
      .mockResolvedValue(reply({ ok: true, data: envelope(2, { execution_state: 'not-started', assignment_state: 'assigned' }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(4000)
    let agent = useOfficeStore.getState().agents['member1~executor']
    expect(agent.position).toEqual(agent.maw.workSeat)
    expect(agent.inGroupEvent).toBe(false)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
    cleanup()
    fetchMock.mockResolvedValue(reply({ ok: true, data: envelope(3, { execution_state: 'not-started', terminal: 'cancelled' }) }))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
    cleanup()
    fetchMock.mockResolvedValue(reply({ ok: true, data: envelope(4) }))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    agent = useOfficeStore.getState().agents['member1~executor']
    expect(agent.position).toEqual(agent.maw.workSeat)
    expect(useOfficeStore.getState().mawMeta.execution_state).toBe('unknown')
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
  })

  it('preserves a degraded positive start fact while requiring complete negative evidence for opening', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, { quality: 'degraded', execution_state: 'started' }) }))
      .mockResolvedValue(reply({ ok: true, data: envelope(2, { execution_state: 'not-started' }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(4000)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
    cleanup()
    fetchMock
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, { quality: 'degraded', execution_state: 'not-started' }) }))
      .mockResolvedValue(reply({ ok: true, data: envelope(2, { execution_state: 'not-started' }) }))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
    await vi.advanceTimersByTimeAsync(2001)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
  })

  it('fetches immediately with encoded fixed selection, single-flights retries, then polls every two seconds', async () => {
    const first = deferred()
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(reply({ ok: true, data: envelope(2) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/visualization/state?project=project+a&task=task%261')
    useOfficeStore.getState().requestDashboardSync()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    first.resolve(reply({ ok: true, data: envelope() }))
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
    const position = useOfficeStore.getState().agents['member1~executor'].position
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useOfficeStore.getState().agents['member1~executor'].position).toEqual(position)
  })

  it('keeps healthy background polls synchronized while retaining precise freshness', async () => {
    const pending = deferred()
    const fetchMock = vi.fn().mockResolvedValueOnce(reply({ ok: true, data: envelope() }))
      .mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'loading', lastValidAt: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'synced', lastValidAt: 10000 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'synced', lastValidAt: 10000 })
    pending.resolve(reply({ ok: true, data: envelope(2) }))
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'synced', lastValidAt: 12000, retrying: false })
  })

  it.each([
    ['error', () => Promise.reject(new Error('offline'))],
    ['missing', () => Promise.resolve(reply({ ok: false, error: { code: 'task-not-found' } }, 404))],
    ['stale', () => Promise.resolve(reply({ ok: true, data: envelope(1, { quality: 'stale' }) }))],
  ])('retains %s feedback throughout a pending retry and deduplicates repeated retries', async (state, initial) => {
    const pending = deferred()
    const fetchMock = vi.fn().mockImplementationOnce(initial).mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync.state).toBe(state)
    useOfficeStore.getState().requestDashboardSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state, retrying: true })
    useOfficeStore.getState().requestDashboardSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    pending.resolve(reply({ ok: true, data: envelope(2) }))
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'synced', retrying: false })
  })

  it('clears the previous binding synchronization status while the new task first loads', async () => {
    const old = deferred(), next = deferred()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    old.resolve(reply({ ok: true, data: envelope() }))
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
    cleanup()
    cleanup = startDashboardIntegration(useOfficeStore, { ...config, task: 'new-task' })
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'loading', lastValidAt: null })
    next.resolve(reply({ ok: true, data: envelope() }))
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
  })

  it('does not fetch or discover another task when configuration is incomplete', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    useOfficeStore.getState().applyMawSnapshot(envelope())
    cleanup = startDashboardIntegration(useOfficeStore, { ...config, task: null, error: 'missing-task' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useOfficeStore.getState().agents).toEqual({})
    expect(useOfficeStore.getState().dashboardSync.state).toBe('configuration-error')
  })

  it('aborts timeout and cleanup, and ignores every late response after exiting', async () => {
    const pending = deferred()
    const fetchMock = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('error')
    cleanup(); cleanup = null
    pending.resolve(reply({ ok: true, data: envelope() }))
    await vi.advanceTimersByTimeAsync(10000)
    expect(useOfficeStore.getState().agents).toEqual({})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('clears missing tasks, never falls back, and rejects older or invalid envelopes without extending freshness', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(5) }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(4) }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(6, { schema: 'bad' }) }))
      .mockResolvedValueOnce(reply({ ok: false, error: { code: 'task-not-found' } }, 404))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    const lastValidAt = useOfficeStore.getState().dashboardSync.lastValidAt
    await vi.advanceTimersByTimeAsync(4000)
    expect(useOfficeStore.getState().mawMeta.seq).toBe(5)
    expect(useOfficeStore.getState().dashboardSync.lastValidAt).toBe(lastValidAt)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().agents).toEqual({})
    expect(useOfficeStore.getState().dashboardSync.state).toBe('missing')
  })

  it('maps whitelisted visualization error codes and keeps unknown ones generic', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: false, error: { code: 'input-inconsistent' } }, 400))
      .mockResolvedValueOnce(reply({ ok: false, error: { code: 'member-limit' } }, 400))
      .mockResolvedValueOnce(reply({ ok: false, error: { code: 'future-server-code' } }, 400))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'error', code: 'input-inconsistent' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'error', code: 'member-limit' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'error', code: 'read-failed' })
  })

  it('serves a legitimate plan-revision degraded snapshot with visible members, then recovers after rebinding', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, {
        quality: 'degraded', quality_detail: 'plan-revision', execution_state: 'unknown',
        assignment_state: 'unknown', handoff_state: 'unavailable', handoffs: [],
        workflow: 'MAW win-r2 · plan' }) }))
      .mockResolvedValue(reply({ ok: true, data: envelope(2) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
    expect(useOfficeStore.getState().mawMeta).toMatchObject({ quality: 'degraded', quality_detail: 'plan-revision' })
    expect(Object.keys(useOfficeStore.getState().agents).length).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().mawMeta).toMatchObject({ quality: 'ok', quality_detail: null })
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
    expect(Object.keys(useOfficeStore.getState().agents).length).toBeGreaterThan(0)
  })

  it('client-stales after exactly 120s without valid responses, freezes movement and recovers current facts', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply({ ok: true, data: envelope() }))
      .mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    const id = 'member1~executor'
    const original = useOfficeStore.getState().agents[id]
    useOfficeStore.setState({ agents: { [id]: { ...original, inGroupEvent: true, isMoving: true,
      groupTarget: { x: 400, y: 244 }, journeyTarget: { x: 400, y: 244 } } } })
    await vi.advanceTimersByTimeAsync(119999)
    expect(useOfficeStore.getState().mawMeta.quality).toBe('ok')
    await vi.advanceTimersByTimeAsync(1)
    expect(useOfficeStore.getState().mawMeta.quality).toBe('stale')
    expect(useOfficeStore.getState().agents[id]).toMatchObject({ behavior: 'idle', isMoving: false, inGroupEvent: false, groupTarget: null, journeyTarget: null })
    expect(useOfficeStore.getState().isPaused).toBe(false)
    fetchMock.mockResolvedValue(reply({ ok: true, data: envelope(2, { members: [{ ...envelope().snapshot.members[0], status: 'done' }] }) }))
    useOfficeStore.getState().requestDashboardSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
    expect(useOfficeStore.getState().agents[id]).toMatchObject({ status: 'done', isMoving: false, inGroupEvent: false })
  })

  it('aborts an active view, rejects its late response, and keeps a replacement task isolated', async () => {
    const old = deferred()
    const fetchMock = vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValue(reply({ ok: true, data: envelope(3, { members: [{ ...envelope().snapshot.members[0], id: 'other' }] }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    const signal = fetchMock.mock.calls[0][1].signal
    cleanup()
    expect(signal.aborted).toBe(true)
    cleanup = startDashboardIntegration(useOfficeStore, { ...config, task: 'replacement' })
    await vi.advanceTimersByTimeAsync(0)
    old.resolve(reply({ ok: true, data: envelope(100) }))
    await vi.advanceTimersByTimeAsync(0)
    expect(Object.keys(useOfficeStore.getState().agents)).toEqual(['other~executor'])
    expect(useOfficeStore.getState().mawMeta.seq).toBe(3)
    expect(fetchMock.mock.calls[1][0]).toContain('task=replacement')
  })

  it('accepts a new epoch and rejects both an older epoch and changed content with the same key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(5) }))
      .mockResolvedValueOnce(reply({ ok: true, data: { ...envelope(1), server_epoch: 101 } }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(999) }))
      .mockResolvedValueOnce(reply({ ok: true, data: { ...envelope(1, { workflow: 'changed' }), server_epoch: 101 } }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().mawMeta).toMatchObject({ server_epoch: 101, seq: 1, workflow: 'develop' })
    const lastValidAt = useOfficeStore.getState().dashboardSync.lastValidAt
    await vi.advanceTimersByTimeAsync(4000)
    expect(useOfficeStore.getState().mawMeta).toMatchObject({ server_epoch: 101, seq: 1, workflow: 'develop' })
    expect(useOfficeStore.getState().dashboardSync.lastValidAt).toBe(lastValidAt)
  })

  it('keeps user animation pause independent and suppresses stale-era handovers on recovery', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply({ ok: true, data: envelope() }))
      .mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    useOfficeStore.getState().togglePause()
    await vi.advanceTimersByTimeAsync(120000)
    expect(useOfficeStore.getState().isPaused).toBe(true)
    fetchMock.mockResolvedValue(reply({ ok: true, data: envelope(2, { members: [
      { ...envelope().snapshot.members[0], status: 'awaiting-approval' },
      { ...envelope().snapshot.members[0], id: 'manager', role: 'manager', status: 'working' },
    ] }) }))
    useOfficeStore.getState().requestDashboardSync()
    await vi.advanceTimersByTimeAsync(4000)
    expect(useOfficeStore.getState().isPaused).toBe(true)
    expect(useOfficeStore.getState().agents['manager~manager'].inGroupEvent).toBe(false)
    expect(useOfficeStore.getState().agents['member1~executor']).toMatchObject({ status: 'awaiting-approval', inGroupEvent: false })
  })

  it('baselines current facts after a transient failure without replaying unseen handovers', async () => {
    const members = [...envelope().snapshot.members,
      { ...envelope().snapshot.members[0], id: 'manager', role: 'manager' }]
    const fetchMock = vi.fn().mockResolvedValueOnce(reply({ ok: true, data: envelope(1, { members }) }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(reply({ ok: true, data: envelope(2, { members: [
        { ...members[0], status: 'awaiting-approval' }, members[1],
      ] }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('error')
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
    expect(useOfficeStore.getState().mawMeta.dashboard_recovery).toBe(1)
    expect(useOfficeStore.getState().agents['manager~manager'].inGroupEvent).toBe(false)
    expect(useOfficeStore.getState().agents['member1~executor']).toMatchObject({ status: 'awaiting-approval', inGroupEvent: false })
  })


  it.each(['approach', 'conversation'])('AVO-205 cancels a factual %s on transport rejection without erasing or replaying facts', async (stage) => {
    const dev = { seq: 1, round: 1, type: 'dev', source_ref: 'executor-1/task-001.json', ref_task: null }
    const review = { seq: 2, round: 1, type: 'review', source_ref: 'reviewer-1/task-002.json', ref_task: dev.source_ref }
    const members = [
      { id: 'disconnect-executor', role: 'executor', status: 'working', current_task: dev },
      { id: 'disconnect-reviewer', role: 'reviewer', status: 'planning', current_task: review },
    ]
    const edge = { id: mawHandoffId('submission', members[0].id, members[1].id, dev.source_ref, review.source_ref),
      kind: 'submission', sender_member_id: members[0].id, recipient_member_id: members[1].id,
      source_task: dev.source_ref, target_task: review.source_ref }
    const facts = { execution_state: 'started', handoff_state: 'complete', members, handoffs: [edge] }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, { ...facts, handoffs: [] }) }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(2, facts) }))
      .mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(2000)
    expect(Object.values(useOfficeStore.getState().agents).every((a) => a.inGroupEvent)).toBe(true)
    if (stage === 'conversation') {
      useOfficeStore.setState({ agents: Object.fromEntries(Object.entries(useOfficeStore.getState().agents)
        .map(([id, agent]) => [id, { ...agent, position: { ...agent.groupTarget },
          isMoving: false, journeyTarget: null }])) })
      await vi.advanceTimersByTimeAsync(100)
      expect(Object.values(useOfficeStore.getState().agents).every((a) => a.behavior === 'chat')).toBe(true)
    }
    const taskFacts = () => Object.values(useOfficeStore.getState().agents)
      .map((a) => ({ id: a.id, status: a.status, current_task: a.maw.current_task }))
    const originalFacts = taskFacts()
    const releasedClaims = vi.spyOn(useOfficeStore.getState(), 'releaseAgentDoorClaims')
    try {
      await vi.advanceTimersByTimeAsync(stage === 'conversation' ? 1900 : 2000)
      expect(useOfficeStore.getState().dashboardSync.state).toBe('error')
      for (const agent of Object.values(useOfficeStore.getState().agents)) {
        expect(agent).toMatchObject({ inGroupEvent: false, isMoving: false, groupTarget: null, journeyTarget: null })
        expect(agent.behavior).not.toBe('chat')
        expect(releasedClaims).toHaveBeenCalledWith(agent.id)
      }
      expect(taskFacts()).toEqual(originalFacts)
      expect(useOfficeStore.getState().mawMeta).toMatchObject({ quality: 'ok', handoffs: [edge] })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(taskFacts()).toEqual(originalFacts)
      expect(Object.values(useOfficeStore.getState().agents).every((a) => !a.inGroupEvent && a.behavior !== 'chat')).toBe(true)

      fetchMock.mockResolvedValue(reply({ ok: true, data: envelope(3, facts) }))
      useOfficeStore.getState().requestDashboardSync()
      await vi.advanceTimersByTimeAsync(5000)
      expect(useOfficeStore.getState().dashboardSync.state).toBe('synced')
      expect(taskFacts()).toEqual(originalFacts)
      expect(Object.values(useOfficeStore.getState().agents).every((a) => !a.inGroupEvent && a.behavior !== 'chat')).toBe(true)
    } finally { releasedClaims.mockRestore() }
  })

  it('AVO-205 never replays an interrupted opening marker when the transport reconnects', async () => {
    const members = [{ ...envelope().snapshot.members[0], status: 'idle', task_kind: null, round: null }]
    const facts = { execution_state: 'not-started', members }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, facts) }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(reply({ ok: true, data: envelope(2, facts) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(useOfficeStore.getState().agents['member1~executor'].inGroupEvent).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().dashboardSync.state).toBe('error')
    await vi.advanceTimersByTimeAsync(7000)
    const current = useOfficeStore.getState()
    expect(current.dashboardSync.state).toBe('synced')
    expect(current.mawMeta.dashboard_opening).toBe(1)
    expect(current.agents['member1~executor']).toMatchObject({ status: 'idle',
      position: current.agents['member1~executor'].maw.workSeat, inGroupEvent: false, groupTarget: null })
  })

  it.each([404, 410])('clears removed projects with the backend project-not-registered code (HTTP %s)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: false, error: { code: 'project-not-registered' } }, status)))
    useOfficeStore.getState().applyMawSnapshot(envelope())
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().agents).toEqual({})
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'missing', code: 'project-not-found' })
  })

})
