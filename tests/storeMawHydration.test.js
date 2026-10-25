import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isOnFloor, isOnObstacle, visuallyOverlapping, ZONE_FLOOR_RECTS } from '../src/systems/movementSystem.js'
import { restSeatFor, startMawChoreography } from '../src/systems/mawChoreography.js'
import { useOfficeStore as store } from '../src/systems/store.js'

const members = (count) => Array.from({ length: count }, (_, index) => ({ id: `exec-${index}`, role: 'executor', status: 'working' }))
const envelope = (team, extra = {}) => ({ server_epoch: 1, seq: 1, dashboard_hydration: 1,
  snapshot: { workflow: 'develop', terminal: null, quality: 'ok', sampled_at: 1000,
    execution_state: 'started', members: team, ...extra } })
const inRect = (point, rect) => point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2

function collisions(agents) {
  const issues = []
  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index]
    if (!isOnFloor(agent.position.x, agent.position.y) || isOnObstacle(agent.position.x, agent.position.y)) {
      issues.push({ id: agent.id, position: agent.position, reason: 'furniture-or-floor' })
    }
    for (const other of agents.slice(index + 1)) {
      if (visuallyOverlapping(agent.position, other.position)) issues.push({ id: agent.id, other: other.id, reason: 'member-overlap' })
    }
  }
  return issues
}

let stop
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  store.setState({ mode: 'maw', integration: 'dashboard', agents: {}, mawMeta: null, isPaused: false })
})
afterEach(() => { stop?.(); stop = null; vi.useRealTimers(); vi.restoreAllMocks() })

describe('AVO-204 direct MAW hydration geometry', () => {
  it.each([9, 50])('places %i running executors on free floor with visual member clearance', (count) => {
    store.getState().applyMawSnapshot(envelope(members(count)))
    const agents = Object.values(store.getState().agents)
    expect(agents).toHaveLength(count)
    expect(collisions(agents)).toEqual([])
    for (const agent of agents) {
      expect(inRect(agent.position, ZONE_FLOOR_RECTS.mainOffice)).toBe(true)
      expect(agent.position).toEqual(agent.maw.workSeat)
    }
  })

  it('keeps safe work bindings through hydration reorder and a later choreography audit', async () => {
    const team = members(9)
    store.getState().applyMawSnapshot(envelope(team))
    const assigned = Object.fromEntries(Object.values(store.getState().agents).map((agent) => [agent.id, { ...agent.maw.workSeat }]))
    stop = startMawChoreography(store, { resumeCurrent: true })
    store.getState().applyMawSnapshot({ ...envelope([...team].reverse()), seq: 2, dashboard_hydration: 2 })
    const id = 'exec-8~executor'
    store.setState({ agents: { ...store.getState().agents, [id]: { ...store.getState().agents[id], position: { x: 200, y: 200 } } } })
    await vi.advanceTimersByTimeAsync(5000)
    const audited = store.getState().agents[id]
    expect(audited.maw.workSeat).toEqual(assigned[id])
    expect(audited.groupTarget).toEqual(assigned[id])
    expect(isOnObstacle(audited.groupTarget.x, audited.groupTarget.y)).toBe(false)
    for (const agent of Object.values(store.getState().agents)) expect(agent.maw.workSeat).toEqual(assigned[agent.id])
  })

  it('allocates distinct free meeting positions for colliding rest-seat hashes', () => {
    const bySeat = new Map()
    let pair
    for (let index = 0; index < 1000 && !pair; index += 1) {
      const id = `rest-${index}`
      const position = restSeatFor(`${id}~executor`).seat
      const key = JSON.stringify(position)
      if (bySeat.has(key)) pair = [bySeat.get(key), id]
      else bySeat.set(key, id)
    }
    expect(pair).toHaveLength(2)
    store.getState().applyMawSnapshot(envelope(pair.map((id) => ({ id, role: 'executor', status: 'idle' })), { workflow: null }))
    const agents = Object.values(store.getState().agents)
    expect(collisions(agents)).toEqual([])
    for (const agent of agents) expect(inRect(agent.position, ZONE_FLOOR_RECTS.meetingRoom)).toBe(true)
  })

  it('retains work bindings and clearance when a full team loses and gains members', () => {
    const original = members(50)
    store.getState().applyMawSnapshot(envelope(original))
    const retained = original.slice(20)
    const bindings = Object.fromEntries(retained.map((member) => {
      const id = `${member.id}~executor`
      return [id, { ...store.getState().agents[id].maw.workSeat }]
    }))
    const joined = members(20).map((member) => ({ ...member, id: `new-${member.id}` }))
    store.getState().applyMawSnapshot({ ...envelope([...joined, ...retained].reverse()), seq: 2, dashboard_hydration: 2 })
    expect(collisions(Object.values(store.getState().agents))).toEqual([])
    for (const [id, position] of Object.entries(bindings)) expect(store.getState().agents[id].maw.workSeat).toEqual(position)
  })

  it('allocates a mixed 50-member team deterministically without placement randomness', () => {
    const roles = ['executor', 'reviewer', 'decision-maker']
    const team = [{ id: 'manager-one', role: 'manager', status: 'working' },
      ...members(49).map((member, index) => ({ ...member, role: roles[index % roles.length] }))]
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('hydration placement must not use randomness') })
    store.getState().applyMawSnapshot(envelope(team))
    const first = Object.fromEntries(Object.values(store.getState().agents).map((agent) => [agent.id, { ...agent.position }]))
    expect(collisions(Object.values(store.getState().agents))).toEqual([])
    store.setState({ agents: {}, mawMeta: null })
    store.getState().applyMawSnapshot(envelope(team))
    expect(Object.fromEntries(Object.values(store.getState().agents).map((agent) => [agent.id, agent.position]))).toEqual(first)
  })

  it('keeps a full resting team on free meeting-room floor', () => {
    store.getState().applyMawSnapshot(envelope(members(50).map((member) => ({ ...member, status: 'idle' })), { workflow: null }))
    const agents = Object.values(store.getState().agents)
    expect(agents).toHaveLength(50)
    for (const agent of agents) {
      expect(isOnFloor(agent.position.x, agent.position.y)).toBe(true)
      expect(isOnObstacle(agent.position.x, agent.position.y)).toBe(false)
      expect(inRect(agent.position, ZONE_FLOOR_RECTS.meetingRoom)).toBe(true)
      expect(agent.position.y).toBeGreaterThanOrEqual(64)
      expect(agent.position.x).toBeLessThanOrEqual(778)
    }
  })
})
