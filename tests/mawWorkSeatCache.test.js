// CR-15 work-seat association cache: persistence round-trip, damage handling,
// pruning, and the history roster honoring cached bindings. Run with vitest.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadWorkSeatCache, saveWorkSeatCache } from '../src/systems/mawWorkSeatCache.js'
import { historyRosterFor } from '../src/inference/dashboardIntegration.js'
import { useOfficeStore } from '../src/systems/store.js'

// The vitest default environment has no localStorage — stub the tiny surface
// the cache uses so the real read/write/prune paths are exercised.
class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}

const stepsWith = (members) => [{ snapshot: { members: members.map(({ id, role }) => ({ id, role, status: 'working' })) } }]

describe('mawWorkSeatCache', () => {
  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage()
  })
  afterEach(() => {
    delete globalThis.localStorage
  })

  it('round-trips one task member↔seat bindings', () => {
    const seats = { 'executor-1': { x: 340, y: 364 }, 'reviewer-1': { x: 140, y: 384 } }
    saveWorkSeatCache('proj', 'task-a', seats)
    const loaded = loadWorkSeatCache('proj', 'task-a')
    expect(loaded.get('executor-1')).toEqual({ x: 340, y: 364 })
    expect(loaded.get('reviewer-1')).toEqual({ x: 140, y: 384 })
    expect(loadWorkSeatCache('proj', 'task-b')).toBeNull() // per-task isolation
  })

  it('filters invalid entries and keeps the first claimant of a duplicated seat', () => {
    saveWorkSeatCache('proj', 'task-a', {
      'ok-1': { x: 340, y: 364 },
      bad: { x: Number.NaN, y: 100 },
      'ok-2': { x: 340, y: 364 }, // duplicate seat — cache damage
    })
    const loaded = loadWorkSeatCache('proj', 'task-a')
    expect(loaded.size).toBe(1)
    expect(loaded.has('ok-1')).toBe(true)
    expect(loaded.has('ok-2')).toBe(false)
  })

  it('ignores corrupted storage and rebuilds on the next save', () => {
    globalThis.localStorage.setItem('avo:maw-work-seats:v1', '{broken json')
    expect(loadWorkSeatCache('proj', 'task-a')).toBeNull()
    saveWorkSeatCache('proj', 'task-a', { 'executor-1': { x: 340, y: 364 } })
    expect(loadWorkSeatCache('proj', 'task-a').get('executor-1')).toEqual({ x: 340, y: 364 })
  })

  it('prunes to the eight most recently written tasks', () => {
    for (let i = 0; i < 9; i += 1) {
      saveWorkSeatCache('proj', `task-${i}`, { 'executor-1': { x: 340 + i, y: 364 } })
    }
    expect(loadWorkSeatCache('proj', 'task-0')).toBeNull() // oldest evicted
    expect(loadWorkSeatCache('proj', 'task-8').get('executor-1')).toEqual({ x: 348, y: 364 })
    expect(loadWorkSeatCache('proj', 'task-1').get('executor-1')).toEqual({ x: 341, y: 364 })
  })

  it('history roster honors cached bindings; manager stays on the gate; uncached fill freely', () => {
    saveWorkSeatCache('proj', 'task-a', {
      'executor-1': { x: 460, y: 364 },
      'decision-maker-1': { x: 260, y: 264 },
      'manager-1': { x: 500, y: 500 }, // cache must never move the manager off the gate
    })
    const roster = historyRosterFor(stepsWith([
      { id: 'manager-1', role: 'manager' },
      { id: 'decision-maker-1', role: 'decision-maker' },
      { id: 'executor-1', role: 'executor' },
      { id: 'executor-2', role: 'executor' },
    ]), loadWorkSeatCache('proj', 'task-a'))
    const seatOf = (key) => Object.values(roster).find((entry) => entry.maw.key === key).maw.workSeat
    expect(seatOf('executor-1')).toEqual({ x: 460, y: 364 })
    expect(seatOf('decision-maker-1')).toEqual({ x: 260, y: 264 })
    expect(seatOf('manager-1')).toEqual({ x: 100, y: 80 }) // CR-2 gate
    // the uncached second executor fills a free seat, never a cached one
    expect(JSON.stringify(seatOf('executor-2'))).not.toBe(JSON.stringify({ x: 460, y: 364 }))
    // every seat is unique across the roster
    const signatures = Object.values(roster).map((entry) => `${entry.maw.workSeat.x},${entry.maw.workSeat.y}`)
    expect(new Set(signatures).size).toBe(signatures.length)
  })

  it('a roster change keeps cached members pinned and re-randomizes only newcomers', () => {
    saveWorkSeatCache('proj', 'task-a', {
      'executor-1': { x: 340, y: 364 },
      'executor-gone': { x: 460, y: 364 },
    })
    const roster = historyRosterFor(stepsWith([
      { id: 'executor-1', role: 'executor' },
      { id: 'executor-new', role: 'executor' },
    ]), loadWorkSeatCache('proj', 'task-a'))
    const seatOf = (key) => Object.values(roster).find((entry) => entry.maw.key === key).maw.workSeat
    expect(seatOf('executor-1')).toEqual({ x: 340, y: 364 }) // pinned
    const signatures = Object.values(roster).map((entry) => `${entry.maw.workSeat.x},${entry.maw.workSeat.y}`)
    expect(new Set(signatures).size).toBe(signatures.length) // newcomer got a free seat
  })
})

// Store build-time consult (the user-visible half of CR-15): a reloaded task
// must MOUNT figures at their cached desks — the build-time workSeat stamp runs
// before the choreographer, so a random stamp here would visibly change the
// association before any later correction.
describe('CR-15 store build-time seat consult', () => {
  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage()
  })
  afterEach(() => {
    delete globalThis.localStorage
  })

  function mawEnvelope(members) {
    return { server_epoch: 1, seq: 1,
      snapshot: { schema: 'avo.maw-snapshot/1', workflow: 'MAW 流程', quality: 'ok', quality_detail: null,
        terminal: null, sampled_at: 1000,
        members: members.map(({ id, role, status }) => ({
          id, role, status, label: id, round: 1, task_kind: 'dev', verdict: null })) } }
  }

  it('a reloaded task mounts members at their cached desks', () => {
    const store = useOfficeStore
    store.setState({ mode: 'maw', integration: 'dashboard', agents: {}, mawMeta: null })
    saveWorkSeatCache('proj', 'task-a', { 'executor-1': { x: 460, y: 364 }, 'reviewer-1': { x: 140, y: 384 } })
    store.getState().setMawWorkSeatCache(loadWorkSeatCache('proj', 'task-a'))
    store.getState().applyMawSnapshot(mawEnvelope([
      { id: 'manager-1', role: 'manager', status: 'working' },
      { id: 'executor-1', role: 'executor', status: 'working' },
      { id: 'reviewer-1', role: 'reviewer', status: 'working' },
    ]))
    const agents = store.getState().agents
    const agentOf = (key) => Object.values(agents).find((agent) => agent.maw?.key === key)
    expect(agentOf('executor-1').maw.workSeat).toEqual({ x: 460, y: 364 })
    expect(agentOf('executor-1').position).toEqual({ x: 460, y: 364 }) // mounts AT the cached desk
    expect(agentOf('reviewer-1').maw.workSeat).toEqual({ x: 140, y: 384 })
    expect(agentOf('reviewer-1').position).toEqual({ x: 140, y: 384 })
    expect(agentOf('manager-1').position).toEqual({ x: 100, y: 80 }) // CR-2 gate
  })

  it('an absent cache keeps the random allocation unique without crashing', () => {
    const store = useOfficeStore
    store.setState({ mode: 'maw', integration: 'dashboard', agents: {}, mawMeta: null })
    store.getState().setMawWorkSeatCache(null)
    store.getState().applyMawSnapshot(mawEnvelope([
      { id: 'executor-1', role: 'executor', status: 'working' },
      { id: 'executor-2', role: 'executor', status: 'working' },
    ]))
    const [a, b] = Object.values(store.getState().agents).map((agent) => agent.maw.workSeat)
    expect(`${a.x},${a.y}`).not.toBe(`${b.x},${b.y}`)
  })
})
