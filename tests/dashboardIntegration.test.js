import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectIntegrationConfig, detectProjectMode, getPlatformConfig } from '../src/systems/platformDetect.js'
import { startDashboardIntegration, validateDashboardEnvelope } from '../src/inference/dashboardIntegration.js'
import { mawHandoffId, validateDashboardSnapshot } from '../src/inference/dashboardSnapshot.js'
import { useOfficeStore } from '../src/systems/store.js'

function envelope(seq = 1, overrides = {}) {
  return { server_epoch: 100, seq, snapshot: { schema: 'avo.maw-snapshot/1', sampled_at: 1000,
    workflow: 'develop', quality: 'ok', quality_detail: null, terminal: null,
    members: [{ id: 'member1', role: 'executor', status: 'working', label: 'slice', detail: null,
      round: 1, task_kind: 'dev', verdict: null, terminate: null, stalled: false }], ...overrides } }
}
function reply(data, status = 200) { return { ok: status < 400, status, json: async () => data } }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const config = { integration: 'dashboard', project: 'project a', task: 'task&1', error: null }
let cleanup

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    expect(validateDashboardSnapshot({ ...base, handoffs: [base.handoffs[0], base.handoffs[0]] })).toBe(false)
    expect(validateDashboardSnapshot({ schema: 'avo.maw-snapshot/1', sampled_at: 1000, quality: 'ok',
      quality_detail: null, workflow: null, terminal: null, members: [] })).toBe(true)
  })
})

describe('Dashboard fixed binding and lifecycle', () => {
  it('hydrates a running task at its current workstations without entry or old handoffs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: true, data: envelope(1, {
      assignment_state: 'assigned',
    }) })))
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(8000)
    const agent = useOfficeStore.getState().agents['member1~executor']
    expect(agent.position).toEqual(agent.maw.workSeat)
    expect(agent).toMatchObject({ inGroupEvent: false, isMoving: false, groupTarget: null })
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(1)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
  })

  it('only opens after observing a complete unassigned state followed by assignment', async () => {
    const idle = { ...envelope().snapshot.members[0], status: 'idle', task_kind: null, round: null }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(1, { assignment_state: 'unassigned', members: [idle] }) }))
      .mockResolvedValue(reply({ ok: true, data: envelope(2, { assignment_state: 'assigned' }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    const initial = useOfficeStore.getState().agents['member1~executor']
    expect(initial.position).toEqual(initial.maw.workSeat)
    expect(initial.inGroupEvent).toBe(false)
    await vi.advanceTimersByTimeAsync(2001)
    const entering = useOfficeStore.getState().agents['member1~executor']
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(1)
    expect(entering.position).not.toEqual(entering.maw.workSeat)
    expect(entering.inGroupEvent).toBe(true)
    expect(entering.groupTarget).toEqual(entering.maw.workSeat)
  })

  it('does not consume hydration on empty data or infer a start from unknown or failed observations', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, data: { ...envelope(), snapshot: null } }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(2, { assignment_state: 'unknown' }) }))
      .mockResolvedValueOnce(reply({ ok: true, data: envelope(3, { assignment_state: 'unassigned' }) }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(reply({ ok: true, data: envelope(4, { assignment_state: 'assigned' }) }))
    vi.stubGlobal('fetch', fetchMock)
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().mawMeta.dashboard_hydration).toBe(0)
    await vi.advanceTimersByTimeAsync(8000)
    const agent = useOfficeStore.getState().agents['member1~executor']
    expect(agent.position).toEqual(agent.maw.workSeat)
    expect(agent.inGroupEvent).toBe(false)
    expect(useOfficeStore.getState().mawMeta.dashboard_opening).toBe(0)
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


  it.each([404, 410])('clears removed projects with the backend project-not-registered code (HTTP %s)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: false, error: { code: 'project-not-registered' } }, status)))
    useOfficeStore.getState().applyMawSnapshot(envelope())
    cleanup = startDashboardIntegration(useOfficeStore, config)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOfficeStore.getState().agents).toEqual({})
    expect(useOfficeStore.getState().dashboardSync).toMatchObject({ state: 'missing', code: 'project-not-found' })
  })

})
