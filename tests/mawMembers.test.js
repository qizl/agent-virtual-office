import { describe, it, expect, beforeEach } from 'vitest'
import { useOfficeStore } from '../src/systems/store.js'

// applyMawSnapshot: every submission is the FULL member set. Members render as
// dynamic `<key>~<base-role>` agents; absent members are removed; an epoch bump
// or null snapshot is a full clear; updates preserve live motion state.

function envelope(epoch, members, extra = {}) {
  return {
    server_epoch: epoch,
    seq: 1,
    snapshot: {
      workflow: 'MAW 执行与审核流程 · develop',
      quality: 'ok',
      quality_detail: null,
      terminal: null,
      sampled_at: 1000,
      members,
      ...extra,
    },
    ...extra,
  }
}

function member(id, role, status = 'working', label = null, extra = {}) {
  return { id, role, status, label, detail: null, round: 1, task_kind: 'dev', verdict: null, terminate: null, stalled: false, ...extra }
}

describe('applyMawSnapshot', () => {
  beforeEach(() => {
    useOfficeStore.setState({ mode: 'maw', agents: {}, mawMeta: null })
  })

  it('creates dynamic members with <key>~<role> identities styled by the base role', () => {
    useOfficeStore.getState().applyMawSnapshot(envelope(1, [
      member('slice01', 'executor', 'working', 'slice-001 · round 1'),
      member('rev01x', 'reviewer', 'idle'),
    ]))
    const s = useOfficeStore.getState()
    const ids = Object.keys(s.agents)
    expect(ids).toEqual(['slice01~executor', 'rev01x~reviewer'])
    expect(s.agents['slice01~executor'].mawMember).toBe(true)
    expect(s.agents['slice01~executor'].status).toBe('working')
    expect(s.agents['slice01~executor'].behavior).toBe('typing')
    expect(s.agents['slice01~executor'].color).toBeDefined()
    expect(s.agents['rev01x~reviewer'].maw.verdict).toBeNull()
    expect(s.mawMeta.workflow).toBe('MAW 执行与审核流程 · develop')
  })

  it('maps statuses to honest animations (no fabricated tool activity)', () => {
    useOfficeStore.getState().applyMawSnapshot(envelope(1, [
      member('m1xxxx', 'manager', 'awaiting-approval', '等待交付评估'),
      member('m2xxxx', 'decision-maker', 'blocked'),
      member('m3xxxx', 'executor', 'done'),
      member('m4xxxx', 'reviewer', 'planning'),
    ]))
    const a = useOfficeStore.getState().agents
    expect(a['m1xxxx~manager'].behavior).toBe('await-approval')
    expect(a['m2xxxx~decision-maker'].behavior).toBe('scratch-head')
    expect(a['m2xxxx~decision-maker'].expression).toBe('confused')
    expect(a['m3xxxx~executor'].expression).toBe('happy')
    expect(a['m3xxxx~executor'].behavior).toBe('idle')
    expect(a['m4xxxx~reviewer'].behavior).toBe('gantt-chart')
  })

  it('removes absent members on the next snapshot (full-set replacement)', () => {
    useOfficeStore.getState().applyMawSnapshot(envelope(1, [
      member('keep01', 'executor'),
      member('gone1', 'reviewer'),
    ]))
    useOfficeStore.getState().applyMawSnapshot(envelope(1, [member('keep01', 'executor', 'working')], { seq: 2 }))
    const ids = Object.keys(useOfficeStore.getState().agents)
    expect(ids).toEqual(['keep01~executor'])
  })

  it('updates keep live motion state; a server-epoch bump is a full replace', () => {
    const store = useOfficeStore.getState()
    store.applyMawSnapshot(envelope(1, [member('walk01', 'executor', 'working', 'round 1')]))
    const before = useOfficeStore.getState().agents['walk01~executor']
    useOfficeStore.setState({ agents: { ...useOfficeStore.getState().agents, 'walk01~executor': { ...before, position: { x: 111, y: 222 }, isMoving: true } } })

    useOfficeStore.getState().applyMawSnapshot(envelope(1, [member('walk01', 'executor', 'awaiting-approval', '已交付待评审')], { seq: 2 }))
    const updated = useOfficeStore.getState().agents['walk01~executor']
    expect(updated.position).toEqual({ x: 111, y: 222 })
    expect(updated.isMoving).toBe(true)
    expect(updated.status).toBe('awaiting-approval')
    expect(updated.behavior).toBe('await-approval')

    useOfficeStore.getState().applyMawSnapshot(envelope(2, []))
    expect(Object.keys(useOfficeStore.getState().agents)).toEqual([])
  })

  it('a null snapshot (no-data) clears the team and keeps meta', () => {
    useOfficeStore.getState().applyMawSnapshot(envelope(1, [member('gone2', 'executor')]))
    useOfficeStore.getState().applyMawSnapshot({ server_epoch: 1, seq: 2, snapshot: null })
    const s = useOfficeStore.getState()
    expect(Object.keys(s.agents)).toEqual([])
    expect(s.mawMeta.sampled_at).toBeNull()
  })

  it('a stale snapshot rests the figures but keeps their honest status text', () => {
    useOfficeStore.getState().applyMawSnapshot(envelope(1, [
      member('stale1', 'executor', 'working', 'slice-001'),
      member('stale2', 'reviewer', 'blocked', 'needs recheck'),
    ], { quality: 'stale', quality_detail: 'producer-lease-expired' }))
    const a = useOfficeStore.getState().agents
    expect(a['stale1~executor'].behavior).toBe('idle') // work animation stopped
    expect(a['stale1~executor'].expression).toBe('normal')
    expect(a['stale1~executor'].status).toBe('working') // facts stay honest
    expect(a['stale2~reviewer'].status).toBe('blocked')
    expect(useOfficeStore.getState().mawMeta.quality).toBe('stale')
  })

  it('a full 50-member same-role snapshot seats every member on a unique spot', () => {
    const members = Array.from({ length: 50 }, (_, i) => member(`full${String(i).padStart(2, '0')}`, 'executor'))
    useOfficeStore.getState().applyMawSnapshot(envelope(1, members))
    const positions = Object.values(useOfficeStore.getState().agents).map((a) => `${a.position.x},${a.position.y}`)
    expect(positions).toHaveLength(50)
    expect(new Set(positions).size).toBe(50)
  })

  it('ignores snapshots in non-maw modes (default office stays organic)', () => {
    useOfficeStore.setState({ mode: 'agentcortex' })
    useOfficeStore.getState().applyMawSnapshot(envelope(1, [member('leak01', 'executor')]))
    expect(Object.keys(useOfficeStore.getState().agents)).toEqual([])
  })
})
