import { describe, it, expect } from 'vitest'
import { ZONE_FLOOR_RECTS } from '../src/systems/movementSystem.js'
import {
  restSeatFor,
  workSeatFor,
  violatesMemberZone,
  phaseOf,
  behaviorFor,
  wanderPoint,
  planChoreography,
  MANAGER_GATE,
} from '../src/systems/mawChoreography.js'

// Zone rules (owner, 2026-10-22): the manager may enter every area; other
// members may enter the meeting room, the main office and BOTH bottom rooms
// (lounge, research) — never the entrance area where the gate sits.

const ENTRANCE = { x1: 0, y1: 0, x2: 598, y2: 148 }
const MEETING = ZONE_FLOOR_RECTS.meetingRoom
const MAIN = ZONE_FLOOR_RECTS.mainOffice
const LOUNGE = ZONE_FLOOR_RECTS.lounge
const RESEARCH = ZONE_FLOOR_RECTS.research

function member(id, role, status) {
  return { id, role, status }
}

describe('maw choreography planning', () => {
  it('rest seats land inside the meeting room and are stable per member', () => {
    for (const id of ['aaa001', 'bbb002', 'ccc003']) {
      const { seat } = restSeatFor(id)
      expect(inRect(seat, MEETING)).toBe(true)
      expect(restSeatFor(id).seat).toEqual(seat)
    }
  })

  it('work seats land in the main office; extras use overflow seats', () => {
    for (const role of ['manager', 'decision-maker', 'executor', 'reviewer']) {
      const base = workSeatFor(role, 0)
      expect(inRect(base, MAIN)).toBe(true)
    }
    for (let n = 1; n <= 5; n++) {
      const extra = workSeatFor('executor', n)
      expect(inRect(extra, MAIN)).toBe(true)
    }
  })

  it('member targets never violate the entrance zone (gate room)', () => {
    for (let i = 0; i < 40; i++) {
      expect(violatesMemberZone(restSeatFor(`m${i}`).seat)).toBe(false)
    }
    for (const role of ['decision-maker', 'executor', 'reviewer']) {
      expect(violatesMemberZone(workSeatFor(role, 0))).toBe(false)
    }
    // the manager's own working seat is inside the entrance area — allowed for manager only
    expect(violatesMemberZone(MANAGER_GATE)).toBe(true)
  })

  it('wander points stay inside the two bottom rooms', () => {
    for (let i = 0; i < 30; i++) {
      const p = wanderPoint(() => (i % 7) / 7)
      expect(inRect(p, LOUNGE) || inRect(p, RESEARCH)).toBe(true)
      expect(violatesMemberZone(p)).toBe(false)
    }
  })

  it('phase mapping: idle/done rest, everything else is task work', () => {
    expect(phaseOf('idle')).toBe('rest')
    expect(phaseOf('done')).toBe('rest')
    for (const status of ['planning', 'working', 'blocked', 'awaiting-approval']) {
      expect(phaseOf(status)).toBe('task')
    }
  })

  it('transit behavior is neutral; status behavior is honest', () => {
    expect(behaviorFor(member('m', 'executor', 'working'))).toBe('typing')
    expect(behaviorFor(member('m', 'reviewer', 'working'))).toBe('magnifier')
    expect(behaviorFor(member('m', 'manager', 'working'))).toBe('gantt-chart')
    expect(behaviorFor(member('m', 'decision-maker', 'working'))).toBe('whiteboard')
    expect(behaviorFor(member('m', 'executor', 'awaiting-approval'))).toBe('await-approval')
    expect(behaviorFor(member('m', 'executor', 'idle'))).toBe('idle')
  })

  it('delivering members return immediately; group entry stays staggered', () => {
    const prevPhase = {}
    const members = [member('e1xxxx', 'executor', 'awaiting-approval'), member('r1xxxx', 'reviewer', 'working')]
    const actions = planChoreography({ prevPhase, members })
    const deliver = actions.find((a) => a.id === 'e1xxxx')
    expect(deliver.staggerMs).toBe(0)
    expect(deliver.kind).toBe('deliver')
    expect(inRect(deliver.target, MAIN)).toBe(true)
  })

  it('plans staggered enter walks from rest to task, then rest walks back', () => {
    const prevPhase = {}
    const members = [member('e1xxxx', 'executor', 'working'), member('r1xxxx', 'reviewer', 'working'), member('m1xxxx', 'manager', 'working')]
    const actions = planChoreography({ prevPhase, members })
    expect(actions).toHaveLength(3)
    expect(actions.map((a) => a.staggerMs)).toEqual([0, 1500, 3000])
    expect(actions.every((a) => inRect(a.target, MAIN) || a.id === 'm1xxxx')).toBe(true)
    // phases are now recorded — a second plan produces no actions
    expect(planChoreography({ prevPhase, members })).toHaveLength(0)
    // back to rest
    const resting = members.map((m) => ({ ...m, status: 'idle' }))
    const restActions = planChoreography({ prevPhase, members: resting })
    expect(restActions).toHaveLength(3)
    for (const action of restActions) {
      const meeting = inRect(action.target, MEETING)
      const gate = action.target.x === MANAGER_GATE.x && action.target.y === MANAGER_GATE.y
      // manager's rest is also the meeting room per the owner rule (all roles rest there)
      expect(meeting || gate).toBe(true)
    }
  })

  it('manager gate seat is the documented position', () => {
    expect(MANAGER_GATE).toEqual({ x: 100, y: 80 })
  })
})

function inRect(point, rect) {
  return point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2
}
