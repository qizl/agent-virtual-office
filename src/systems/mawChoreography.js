// mawChoreography.js — member walk choreography for the MAW view (plan:
// multi-agent-workflow-office-animation-choreography-2026-10-22).
//
// This is a SYSTEM rule, not a mock feature: it is driven purely by snapshot
// status transitions, so real bridge data and the mock producer animate the
// same way. Movement reuses setAgentGroupEvent (clamp + avoidOverlap +
// calculateJourney with door claims); while inGroupEvent the ambient scheduler
// yields, so nothing fights the choreography.
//
// Position rules (owner, 2026-10-22):
//   - default rest area = the meeting room above research; every member has a
//     stable chair there;
//   - manager working seat = the gate booth (100, 80);
//   - other members' working seats = the main-office MAW desks (+ overflow);
//   - handover: when a member reaches awaiting-approval the manager walks from
//     the gate to that member, dwells ~3s, and returns to the gate;
//   - zones: the manager may enter every area; other members may enter the
//     meeting room, the main office and BOTH bottom rooms (lounge, research) —
//     the entrance area (gate room) is forbidden to everyone but the manager.

import { MEETING_CHAIRS, HOME_POSITIONS, OVERFLOW_POSITIONS, ZONE_FLOOR_RECTS, clampToFloor } from './movementSystem.js'

export const MANAGER_GATE = { x: 100, y: 80 }
const HANDOVER_DWELL_MS = 3000
const STAGGER_MS = 1500
const WANDER_INTERVAL_MS = 60_000
const ARRIVAL_POLL_MS = 400
const ARRIVE_TIMEOUT_MS = 20_000

// Members' walkable rects for idle wander: the two bottom rooms only.
const WANDER_RECTS = [ZONE_FLOOR_RECTS.lounge, ZONE_FLOOR_RECTS.research].filter(Boolean)

export const MAW_ROLE_WORK_BEHAVIOR = { manager: 'gantt-chart', 'decision-maker': 'whiteboard', executor: 'typing', reviewer: 'magnifier' }

const ENTRANCE_RECT = { x1: 0, y1: 0, x2: 598, y2: 148 }

function hashIndex(text, mod) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  return h % mod
}

function inRect(point, rect) {
  return point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2
}

/** Stable chair in the meeting room for one member id. */
export function restSeatFor(memberId, taken = new Set()) {
  const ordered = []
  let index = hashIndex(memberId, MEETING_CHAIRS.length)
  while (taken.has(index) && ordered.length < MEETING_CHAIRS.length) {
    index = (index + 1) % MEETING_CHAIRS.length
    ordered.push(index)
  }
  return { index, seat: { ...MEETING_CHAIRS[index] } }
}

// Extra working seats for same-role members beyond the first — all inside the
// main office (the OVERFLOW_POSITIONS hallway is in the entrance area, which is
// forbidden to members).
export const MAW_EXTRA_WORK_SEATS = [
  { x: 450, y: 300 }, { x: 520, y: 300 }, { x: 200, y: 330 },
  { x: 270, y: 330 }, { x: 450, y: 360 }, { x: 520, y: 360 },
]

/** Working seat in the main office: base chair per role, main-office extras after. */
export function workSeatFor(role, perRoleCount) {
  const base = HOME_POSITIONS[role]
  if (perRoleCount === 0 && base) return { ...base }
  return { ...MAW_EXTRA_WORK_SEATS[(perRoleCount - 1) % MAW_EXTRA_WORK_SEATS.length] }
}

/** True when a walk target would break a member's zone rules. */
export function violatesMemberZone(point) {
  return inRect(point, ENTRANCE_RECT)
}

export function phaseOf(status) {
  return status === 'idle' || status === 'done' ? 'rest' : 'task'
}

export function behaviorFor(member) {
  if (member.status === 'awaiting-approval') return 'await-approval'
  if (member.status === 'blocked') return 'scratch-head'
  if (member.status === 'planning') return 'gantt-chart'
  if (member.status === 'working') return MAW_ROLE_WORK_BEHAVIOR[member.role] || 'typing'
  return 'idle'
}

export function wanderPoint(rng = Math.random) {
  const rect = WANDER_RECTS[Math.floor(rng() * WANDER_RECTS.length)]
  if (!rect) return null
  const point = clampToFloor({
    x: rect.x1 + 24 + rng() * Math.max(8, rect.x2 - rect.x1 - 48),
    y: rect.y1 + 24 + rng() * Math.max(8, rect.y2 - rect.y1 - 48),
  })
  return point
}

/**
 * Pure planner: given the previous phase map and the current member list,
 * return the ordered walk actions. Pure — the caller applies them via
 * setAgentGroupEvent with its own stagger/timers.
 */
export function planChoreography({ prevPhase, members, workSeatsTaken }) {
  const actions = []
  const counts = {}
  let staggerIndex = 0
  for (const member of members) {
    const phase = phaseOf(member.status)
    const previous = prevPhase[member.id]
    const roleCount = counts[member.role] || 0
    counts[member.role] = roleCount + 1
    if (phase === previous) continue
    if (phase === 'task') {
      const seat = workSeatFor(member.role, roleCount + (workSeatsTaken?.[member.role] || 0))
      // Delivering members (awaiting-approval) return IMMEDIATELY and wait at the
      // work seat for the manager's handover; planning/working enter staggered.
      const immediate = member.status === 'awaiting-approval'
      actions.push({
        id: member.id,
        agentId: `${member.id}~${member.role}`,
        target: seat,
        behavior: 'idle', // transit; restored to the status animation on arrival
        staggerMs: immediate ? 0 : staggerIndex * STAGGER_MS,
        kind: immediate ? 'deliver' : 'enter',
      })
    } else {
      const { seat } = restSeatFor(member.id)
      actions.push({
        id: member.id,
        agentId: `${member.id}~${member.role}`,
        target: seat,
        behavior: 'idle',
        staggerMs: staggerIndex * STAGGER_MS,
        kind: 'rest',
      })
    }
    staggerIndex += 1
    prevPhase[member.id] = phase
  }
  return actions
}

/**
 * Create the running choreography controller. Returns a cleanup function.
 * `store` is the zustand office store.
 */
export function startMawChoreography(store) {
  let torn = false
  const prevPhase = {}
  const restSeatTaken = new Set()
  const restSeatByMember = new Map()
  const handoverQueue = []
  const pendingTimers = new Set()
  let managerBusy = false
  let lastWanderAt = Date.now()

  function later(fn, ms) {
    if (torn) return
    const t = setTimeout(() => {
      pendingTimers.delete(t)
      if (!torn) fn()
    }, ms)
    pendingTimers.add(t)
  }

  function walk(agentId, target, { behavior, expression = 'normal', bubble = null }) {
    const s = store.getState()
    if (!s.agents[agentId]) return
    s.setAgentGroupEvent(agentId, {
      behavior,
      expression,
      bubble,
      groupTarget: { x: target.x, y: target.y },
    })
  }

  /** Poll until the agent's walk settles, then run `fn` (after an optional dwell). */
  function arriveThen(agentId, afterMs, fn) {
    const startedAt = Date.now()
    const poll = () => {
      if (torn) return
      const current = store.getState().agents[agentId]
      const gone = !current
      const arrived = gone || (!current.isMoving && !current.journeyTarget)
      if (arrived && Date.now() - startedAt > ARRIVAL_POLL_MS) return later(fn, afterMs)
      if (Date.now() - startedAt > ARRIVE_TIMEOUT_MS) return later(fn, afterMs)
      setTimeout(poll, ARRIVAL_POLL_MS)
    }
    setTimeout(poll, ARRIVAL_POLL_MS)
  }

  function restoreWorkAnimation(memberId) {
    const s = store.getState()
    const id = Object.keys(s.agents).find((k) => k.startsWith(`${memberId}~`))
    if (!id) return
    const a = s.agents[id]
    const pseudo = { id, role: a.maw?.role, status: a.status }
    s.setAgentGroupEvent(id, {
      behavior: behaviorFor(pseudo),
      expression: a.status === 'done' ? 'happy' : a.status === 'blocked' ? 'confused' : 'normal',
      bubble: a.label || null,
      groupTarget: a.groupTarget ? { ...a.groupTarget } : undefined,
    })
  }

  function enqueueHandover(memberAgent) {
    handoverQueue.push(memberAgent)
    processHandoverQueue()
  }

  function processHandoverQueue() {
    if (torn || managerBusy || handoverQueue.length === 0) return
    const s = store.getState()
    const managerId = Object.keys(s.agents).find((k) => k.endsWith('~manager'))
    if (!managerId) { handoverQueue.length = 0; return }
    const item = handoverQueue.shift()
    if (!item) return
    managerBusy = true
    const memberAgent = s.agents[item.id]
    // The member walks straight back to the work seat and waits there; the
    // manager departs once the member has settled at the seat.
    const at = item.workSeat || (memberAgent ? { x: memberAgent.position?.x ?? MANAGER_GATE.x, y: memberAgent.position?.y ?? MANAGER_GATE.y } : null)
    if (!at) { managerBusy = false; return later(processHandoverQueue, 200) }
    const proceed = () => {
      const current = store.getState()
      const manager = current.agents[managerId]
      if (!manager || manager.status !== 'working') { managerBusy = false; return }
      walk(managerId, at, { behavior: 'chat', expression: 'normal', bubble: `任务交接 · ${item.label || ''}` })
      arriveThen(managerId, HANDOVER_DWELL_MS, () => {
        walk(managerId, MANAGER_GATE, { behavior: 'gantt-chart', expression: 'normal', bubble: null })
        arriveThen(managerId, 0, () => {
          managerBusy = false
          processHandoverQueue()
        })
      })
    }
    if (memberAgent && (memberAgent.isMoving || memberAgent.journeyTarget)) {
      arriveThen(item.id, 0, proceed) // wait for the member to settle at the seat
    } else {
      proceed()
    }
  }

  function restoreWorkAnimationIfIdleAtGate(managerId) {
    const a = store.getState().agents[managerId]
    if (a && a.status === 'working') {
      store.getState().setAgentGroupEvent(managerId, { behavior: 'gantt-chart', expression: 'normal', bubble: null, groupTarget: { ...MANAGER_GATE } })
    }
  }

  function maybeWander() {
    if (torn) return
    const s = store.getState()
    if (s.mode !== 'maw') return
    const candidates = Object.values(s.agents).filter((a) => a?.mawMember && a.maw?.role !== 'manager' && (a.status === 'working' || a.status === 'idle' || a.status === 'done'))
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    if (!pick) return
    const point = wanderPoint()
    if (!point) return
    const returnSeat = { ...pick.position }
    walk(pick.id, point, { behavior: 'idle', expression: 'normal', bubble: null })
    arriveThen(pick.id, 6000 + Math.random() * 6000, () => {
      const current = store.getState().agents[pick.id]
      if (!current || current.status !== pick.status) return
      const back = pick.status === 'working'
        ? { behavior: MAW_ROLE_WORK_BEHAVIOR[current.maw?.role] || 'typing', expression: 'normal', bubble: null }
        : { behavior: 'idle', expression: current.status === 'done' ? 'happy' : 'normal', bubble: null }
      walk(pick.id, returnSeat, back)
    })
  }

  let wanderTimer = null
  if (typeof setInterval === 'function') {
    wanderTimer = setInterval(() => {
      if (Date.now() - lastWanderAt >= WANDER_INTERVAL_MS) {
        lastWanderAt = Date.now()
        maybeWander()
      }
    }, 15_000)
    if (typeof wanderTimer.unref === 'function') wanderTimer.unref()
  }

  const unsubscribe = store.subscribe(() => {
    if (torn) return
    const s = store.getState()
    if (s.mode !== 'maw') return
    const members = Object.values(s.agents).filter((a) => a?.mawMember)
    const manager = members.find((a) => a.maw?.role === 'manager')

    // member transitions (manager handled by the handover queue only)
    for (const member of members) {
      if (member.maw?.role === 'manager') continue
      const phase = phaseOf(member.status)
      const previous = prevPhase[member.id]
      if (phase === previous) continue
      prevPhase[member.id] = phase
      const agentId = member.id
      if (phase === 'task') {
        const taken = {}
        for (const other of members) {
          if (other.id === member.id) continue
          if (phaseOf(other.status) === 'task') taken[other.maw?.role] = (taken[other.maw?.role] || 0) + 1
        }
        const seat = workSeatFor(member.maw?.role, taken[member.maw?.role] || 0)
        // Delivering members hurry back to the work seat and wait for the manager.
        const delay = member.status === 'awaiting-approval' ? 0 : staggerCount() * STAGGER_MS
        later(() => {
          walk(agentId, seat, { behavior: 'idle', expression: 'normal', bubble: null })
          arriveThen(agentId, 0, () => restoreWorkAnimation(member.id))
        }, delay)
        bumpStagger()
      } else {
        let seat = restSeatByMember.get(member.id)
        if (!seat) {
          const assigned = restSeatFor(member.id, restSeatTaken)
          restSeatTaken.add(assigned.index)
          restSeatByMember.set(member.id, assigned.seat)
          seat = assigned.seat
        }
        later(() => {
          walk(agentId, seat, { behavior: 'idle', expression: 'normal', bubble: null })
        }, staggerCount() * STAGGER_MS)
        bumpStagger()
      }
    }

    // manager: working seat = gate; handovers driven by awaiting-approval transitions
    if (manager) {
      const mphase = phaseOf(manager.status)
      if (prevPhase[manager.id] !== mphase) {
        prevPhase[manager.id] = mphase
        if (mphase === 'task') {
          walk(manager.id, MANAGER_GATE, { behavior: 'gantt-chart', expression: 'normal', bubble: null })
        } else {
          let seat = restSeatByMember.get(manager.id)
          if (!seat) {
            const assigned = restSeatFor(manager.id, restSeatTaken)
            restSeatTaken.add(assigned.index)
            restSeatByMember.set(manager.id, assigned.seat)
            seat = assigned.seat
          }
          walk(manager.id, seat, { behavior: 'idle', expression: 'normal', bubble: null })
        }
      }
    }

    // handover triggers: any member entering awaiting-approval
    for (const member of members) {
      if (member.maw?.role === 'manager') continue
      const key = `${member.id}:handover`
      if (member.status === 'awaiting-approval' && prevHandover.get(key) !== true) {
        prevHandover.set(key, true)
        const taken = {}
        for (const other of members) {
          if (other.id === member.id) continue
          if (phaseOf(other.status) === 'task') taken[other.maw?.role] = (taken[other.maw?.role] || 0) + 1
        }
        handoverQueue.push({
          id: member.id,
          workSeat: workSeatFor(member.maw?.role, taken[member.maw?.role] || 0),
          label: member.label,
        })
        processHandoverQueue()
      } else if (member.status !== 'awaiting-approval' && prevHandover.get(key) === true) {
        prevHandover.set(key, false)
      }
    }
  })

  const prevHandover = new Map()
  let staggerCounter = 0
  const staggerCount = () => staggerCounter
  const bumpStagger = () => { staggerCounter += 1 }

  return function cleanup() {
    torn = true
    unsubscribe()
    if (wanderTimer) clearInterval(wanderTimer)
    for (const t of pendingTimers) clearTimeout(t)
    pendingTimers.clear()
  }
}
