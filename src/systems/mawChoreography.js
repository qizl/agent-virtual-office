// mawChoreography.js — member walk choreography for the MAW view (plan:
// multi-agent-workflow-office-animation-choreography-2026-10-22).
//
// This is a SYSTEM rule, not a mock feature: it is driven purely by snapshot
// status transitions, so real bridge data and the mock producer animate the
// same way. Movement reuses setAgentGroupEvent (clamp + avoidOverlap +
// calculateJourney with door claims); while inGroupEvent the ambient scheduler
// yields, so nothing fights the choreography. EVERY choreography walk ends with
// a lock release (clearAgentGroupEvent + status presentation) — a walk that
// never releases would pin the transit animation onto the member forever.
//
// Position rules (plan §4.1, multi-agent-workflow-office-animation-choreography):
//   - default rest seats: the meeting room — member-id hash maps to MEETING_CHAIRS,
//     overflow fills the free floor below the meeting table (still inside the
//     meeting-room rect); the bottom rooms are wander scenery, NEVER seats;
//   - manager working seat = the gate booth (100, 80);
//   - other members' working seats = the main-office MAW desks (+ a 56-seat
//     unique overflow pool);
//   - handover: when a member reaches awaiting-approval the member returns to
//     their STABLE work seat immediately (the manager's serial queue coordinates
//     only the manager's visit), the manager walks from the gate to that seat,
//     dwells ~3s, and returns to the gate;
//   - zones: the manager may enter every area; other members may enter the
//     meeting room, the main office and BOTH bottom rooms (lounge, research) —
//     the entrance area (gate room) is forbidden to everyone but the manager,
//     and the store re-clamps final walk targets so avoidOverlap can never
//     push a member back in.

import { MEETING_CHAIRS, HOME_POSITIONS, ZONE_FLOOR_RECTS, clampToFloor } from './movementSystem.js'

export const MANAGER_GATE = { x: 100, y: 80 }
const HANDOVER_DWELL_MS = 3000
const STAGGER_MS = 1500
const WANDER_INTERVAL_MS = 15_000
const LONG_WORK_MS = 90_000 // a member on the same work/rest stretch this long may take a walk
const ARRIVAL_POLL_MS = 400
const ARRIVE_TIMEOUT_MS = 20_000
const ARRIVE_MAX_REISSUES = 3 // a timeout is not success — re-issue, then bail without the chained step
const ARRIVE_EPSILON_PX = 8 // "arrived" = the figure physically reached its published target

// Wander areas (plan §4.1 rest): the meeting room plus the two bottom rooms —
// low-frequency leg-stretch walks sample all three. Rest SEATS are a different
// rule (plan §3.2 non-goal): lounge/research are wander scenery, never seats.
const WANDER_RECTS = [ZONE_FLOOR_RECTS.meetingRoom, ZONE_FLOOR_RECTS.lounge, ZONE_FLOOR_RECTS.research].filter(Boolean)

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

function seatKey(point) {
  return `${point.x},${point.y}`
}

// Rest seats (plan §4.1 rest): the member-id hash maps into the 8 MEETING_CHAIRS
// first; overflow fills a deterministic grid on the free floor BELOW the meeting
// table (the table obstacle ends at y=195, the meeting-room rect runs to y=413),
// so every rest seat — default and overflow — stays inside the meeting room.
const MEETING_OVERFLOW_SEATS = []
for (let row = 0; row < 8; row++) {
  for (let col = 0; col < 7; col++) MEETING_OVERFLOW_SEATS.push({ x: 640 + col * 21, y: 212 + row * 24 })
}
// 8 meeting chairs + 56 in-room overflow = 64 unique seats — a full 50-member
// snapshot always rests without sharing a chair.
export const REST_SEATS = [...MEETING_CHAIRS, ...MEETING_OVERFLOW_SEATS]

/** Stable rest seat for one member id: meeting room first, bottom rooms on overflow. */
export function restSeatFor(memberId, taken = new Set()) {
  const ordered = []
  let index = hashIndex(memberId, REST_SEATS.length)
  while (taken.has(index) && ordered.length < REST_SEATS.length) {
    index = (index + 1) % REST_SEATS.length
    ordered.push(index)
  }
  if (ordered.length >= REST_SEATS.length) index = hashIndex(memberId, REST_SEATS.length) // pool exhausted — unreachable for valid snapshots
  return { index, seat: { ...REST_SEATS[index] } }
}

// Extra working seats for same-role members beyond the first — all inside the
// main office (the OVERFLOW_POSITIONS hallway is in the entrance area, which is
// forbidden to members). The pool is sized for the worst valid snapshot: 50
// members of ONE role need 49 extras, so 6 hand-placed + 50 generated = 56 seats
// keeps every member on a unique spot without wrap-around collisions.
const HAND_EXTRA_WORK_SEATS = [
  { x: 450, y: 300 }, { x: 520, y: 300 }, { x: 200, y: 330 },
  { x: 270, y: 330 }, { x: 450, y: 360 }, { x: 520, y: 360 },
]
// Deterministic grid inside the member-allowed band (y ≥ 175 keeps it out of the
// entrance rect; x ≤ 585 / y ≤ 380 stays on the floor). Unique against the
// hand-placed seats above by construction (disjoint x/y values).
const GENERATED_EXTRA_WORK_SEATS = []
for (let row = 0; row < 5; row++) {
  for (let col = 0; col < 10; col++) {
    GENERATED_EXTRA_WORK_SEATS.push({ x: 40 + col * 55, y: 200 + row * 45 })
  }
}
export const MAW_EXTRA_WORK_SEATS = [...HAND_EXTRA_WORK_SEATS, ...GENERATED_EXTRA_WORK_SEATS]

/** Working seat in the main office: base chair per role, main-office extras after. */
export function workSeatFor(role, perRoleCount) {
  const base = HOME_POSITIONS[role]
  if (perRoleCount === 0 && base) return { ...base }
  // Clamp only as a defensive bound — a valid snapshot (≤ 50 members, ≤ 49 extras
  // of one role) can never reach it, so no two members ever share a seat.
  const index = Math.min(perRoleCount - 1, MAW_EXTRA_WORK_SEATS.length - 1)
  return { ...MAW_EXTRA_WORK_SEATS[index] }
}

/** True when a walk target would break a member's zone rules. */
export function violatesMemberZone(point) {
  return inRect(point, ENTRANCE_RECT)
}

/**
 * Clamp any point into member-allowed space. avoidOverlap/clampToFloor may snap
 * pushed candidates into the entrance floor rect (it is a floor zone too) — the
 * member rules forbid that, so a violating point is folded back into the main
 * office band.
 */
export function clampToMemberZone(point) {
  if (!violatesMemberZone(point)) return { x: point.x, y: point.y }
  return {
    x: Math.min(585, Math.max(25, point.x)),
    y: Math.min(388, Math.max(175, point.y)),
  }
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
 * Pure picker for the occasional leg-stretch walk. A member may wander when
 * they have sat out their current stretch (LONG_WORK_MS): working/planning
 * members earn a break from WORK, idle/done members may stretch after a long
 * REST. Blocked / awaiting-approval members and the manager (handover duty)
 * never wander; neither does anyone mid-walk.
 */
export function wanderCandidates({ members, workingSince, restingSince, now = Date.now() }) {
  const out = []
  for (const agent of members) {
    if (!agent || agent.maw?.role === 'manager') continue
    if (agent.isMoving || agent.journeyTarget || agent.inGroupEvent) continue
    const working = agent.status === 'working' || agent.status === 'planning'
    const resting = agent.status === 'idle' || agent.status === 'done'
    if (!working && !resting) continue
    const since = working ? workingSince.get(agent.id) : restingSince.get(agent.id)
    if (since === undefined || now - since < LONG_WORK_MS) continue
    out.push(agent)
  }
  return out
}

/**
 * Pure planner: given the previous phase map and the current member list,
 * return the ordered walk actions. Seat maps are caller-owned and mutated in
 * place (like prevPhase) so the SAME member keeps the SAME seat across calls.
 * Pure — the caller applies them via setAgentGroupEvent with its own
 * stagger/timers.
 */
export function planChoreography({ prevPhase, members, workSeatsByMember = new Map(), occupiedWorkSeats = new Set(), restSeatsByMember = new Map(), restSeatsTaken = new Set() }) {
  const actions = []
  let staggerIndex = 0
  const assignWork = (member) => {
    const bound = workSeatsByMember.get(member.id)
    if (bound) return bound
    let seat = null
    const base = HOME_POSITIONS[member.role]
    if (base && !occupiedWorkSeats.has(seatKey(base))) seat = { ...base }
    else {
      for (const candidate of MAW_EXTRA_WORK_SEATS) {
        if (!occupiedWorkSeats.has(seatKey(candidate))) { seat = { ...candidate }; break }
      }
    }
    if (!seat) seat = { ...MAW_EXTRA_WORK_SEATS[0] } // unreachable for valid snapshots
    occupiedWorkSeats.add(seatKey(seat))
    workSeatsByMember.set(member.id, seat)
    return seat
  }
  const assignRest = (member) => {
    const bound = restSeatsByMember.get(member.id)
    if (bound) return bound
    const assigned = restSeatFor(member.id, restSeatsTaken)
    restSeatsTaken.add(assigned.index)
    restSeatsByMember.set(member.id, assigned)
    return assigned
  }
  for (const member of members) {
    const phase = phaseOf(member.status)
    const previous = prevPhase[member.id]
    if (phase === previous) continue
    if (phase === 'task') {
      const seat = assignWork(member)
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
      const { seat } = assignRest(member)
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
  const prevHandover = new Map()
  const restSeatsByMember = new Map() // memberId -> { index, seat }
  const restSeatsTaken = new Set()
  const workSeatsByMember = new Map() // memberId -> seat — STABLE binding, never recomputed from live counts
  const occupiedWorkSeats = new Set()
  const pendingTimers = new Set()
  let managerBusy = false
  const workingSince = new Map() // memberId -> start of the current working stretch
  const restingSince = new Map() // memberId -> start of the current resting stretch
  let lastWanderAt = 0
  const walkTokens = new Map() // agentId -> latest walk token — a superseding walk invalidates the old chain
  let choreoEpoch = 0 // bumped when the channel degrades (stale / terminal): every pending callback dies with its generation
  let lastSeenQuality = null

  function later(fn, ms) {
    if (torn) return
    const epoch = choreoEpoch
    const t = setTimeout(() => {
      pendingTimers.delete(t)
      if (!torn && choreoEpoch === epoch) fn()
    }, ms)
    pendingTimers.add(t)
  }

  function walk(agentId, target, { behavior, expression = 'normal', bubble = null }) {
    const s = store.getState()
    if (!s.agents[agentId]) return
    const token = (walkTokens.get(agentId) || 0) + 1
    walkTokens.set(agentId, token)
    const safe = agentId.endsWith('~manager') ? { x: target.x, y: target.y } : clampToMemberZone(target)
    s.setAgentGroupEvent(agentId, {
      behavior,
      expression,
      bubble,
      groupTarget: safe,
    })
  }

  /** Release the walk lock and dress the member in their CURRENT status animation. */
  function restorePresentation(agentId) {
    const s = store.getState()
    const a = s.agents[agentId]
    if (!a) return
    const pseudo = { id: agentId, role: a.maw?.role, status: a.status }
    s.clearAgentGroupEvent(agentId, {
      behavior: behaviorFor(pseudo),
      expression: a.status === 'done' ? 'happy' : a.status === 'blocked' ? 'confused' : 'normal',
      bubble: a.bubble ?? null,
    })
  }

  // Physical arrival: the figure reached its PUBLISHED walk target. Journeys
  // waiting for a physical-door grant keep isMoving/journeyTarget falsy, so
  // "not moving" is NOT arrival — only the position proves it (review P1: the
  // gate queue was misread as arrival, which released the lock and cancelled
  // the pending door request).
  function arrivedAt(agent) {
    return Boolean(agent && agent.groupTarget &&
      Math.hypot((agent.position?.x ?? 1e9) - agent.groupTarget.x, (agent.position?.y ?? 1e9) - agent.groupTarget.y) <= ARRIVE_EPSILON_PX)
  }

  const settledAt = (agent, seat) => Boolean(agent && !agent.isMoving && !agent.journeyTarget && !agent.inGroupEvent &&
    Math.hypot((agent.position?.x ?? 1e9) - seat.x, (agent.position?.y ?? 1e9) - seat.y) <= ARRIVE_EPSILON_PX)

  /**
   * Poll until the agent's CURRENT walk physically settles, then run `fn` after an
   * optional dwell. The whole chain dies with its walk token and choreography
   * epoch: a superseding walk, or a stale/terminal transition, invalidates it. A
   * timeout is NOT success — the walk is re-issued (door claims expire); after the
   * final attempt the lock is released WITHOUT running the chained step.
   */
  function arriveThen(agentId, afterMs, fn) {
    const epoch = choreoEpoch
    let reissues = 0
    const awaitWalk = () => {
      const token = walkTokens.get(agentId)
      const startedAt = Date.now()
      const poll = () => {
        if (torn || choreoEpoch !== epoch || walkTokens.get(agentId) !== token) return
        const current = store.getState().agents[agentId]
        if (!current || !current.inGroupEvent || !current.groupTarget) return // superseded or released elsewhere
        if (arrivedAt(current)) return later(fn, afterMs)
        if (Date.now() - startedAt >= ARRIVE_TIMEOUT_MS) {
          if (reissues >= ARRIVE_MAX_REISSUES) return restorePresentation(agentId)
          reissues += 1
          walk(agentId, current.groupTarget, { behavior: current.behavior, expression: current.expression, bubble: current.bubble })
          return awaitWalk()
        }
        setTimeout(poll, ARRIVAL_POLL_MS)
      }
      setTimeout(poll, ARRIVAL_POLL_MS)
    }
    awaitWalk()
  }

  /** Stable work seat for a member: assigned ONCE, never recomputed from live counts. */
  function stableWorkSeat(member) {
    const bound = workSeatsByMember.get(member.id)
    if (bound) return bound
    const role = member.maw?.role
    if (role === 'manager') return MANAGER_GATE // the gate booth is the manager's work seat
    let seat = null
    const base = HOME_POSITIONS[role]
    if (base && !occupiedWorkSeats.has(seatKey(base))) seat = { ...base }
    else {
      for (const candidate of MAW_EXTRA_WORK_SEATS) {
        if (!occupiedWorkSeats.has(seatKey(candidate))) { seat = { ...candidate }; break }
      }
    }
    if (!seat) seat = { ...MAW_EXTRA_WORK_SEATS[0] } // unreachable for valid snapshots (56+4 seats ≥ 50)
    occupiedWorkSeats.add(seatKey(seat))
    workSeatsByMember.set(member.id, seat)
    return seat
  }

  /** Stable rest seat for a member: assigned ONCE. */
  function stableRestSeat(member) {
    const bound = restSeatsByMember.get(member.id)
    if (bound) return bound.seat
    const assigned = restSeatFor(member.id, restSeatsTaken)
    restSeatsTaken.add(assigned.index)
    restSeatsByMember.set(member.id, assigned)
    return assigned.seat
  }

  /** Drop every per-member trace of members that left the snapshot. */
  function pruneGoneMembers(memberIds) {
    for (const id of [...workSeatsByMember.keys()]) {
      if (!memberIds.has(id)) {
        occupiedWorkSeats.delete(seatKey(workSeatsByMember.get(id)))
        workSeatsByMember.delete(id)
      }
    }
    for (const id of [...restSeatsByMember.keys()]) {
      if (!memberIds.has(id)) {
        restSeatsTaken.delete(restSeatsByMember.get(id).index)
        restSeatsByMember.delete(id)
      }
    }
    for (const map of [prevHandover, workingSince, restingSince, walkTokens]) {
      for (const id of [...map.keys()]) {
        if (!memberIds.has(id)) map.delete(id)
      }
    }
    for (const id of Object.keys(prevPhase)) {
      if (!memberIds.has(id)) delete prevPhase[id]
    }
  }

  function enqueueHandover(memberId, workSeat, label) {
    handoverQueue.push({ id: memberId, workSeat, label })
    processHandoverQueue()
  }

  const handoverQueue = []

  function processHandoverQueue() {
    if (torn || managerBusy || handoverQueue.length === 0) return
    const s = store.getState()
    const managerId = Object.keys(s.agents).find((k) => k.endsWith('~manager'))
    if (!managerId) { handoverQueue.length = 0; return }
    const item = handoverQueue.shift()
    if (!item) return
    managerBusy = true
    const proceed = () => {
      const current = store.getState()
      const manager = current.agents[managerId]
      if (!manager || manager.status !== 'working') { managerBusy = false; return processHandoverQueue() }
      walk(managerId, item.workSeat, { behavior: 'chat', expression: 'normal', bubble: `任务交接 · ${item.label || ''}` })
      arriveThen(managerId, HANDOVER_DWELL_MS, () => {
        const live = store.getState()
        const mgr = live.agents[managerId]
        const member = live.agents[item.id]
        restorePresentation(managerId) // dress the manager's CURRENT status — handover or not
        // The handover went moot mid-dwell (member resolved, manager left working):
        // no return leg — the next real transition owns the manager's walk.
        if (!mgr || mgr.status !== 'working' || !member || member.status !== 'awaiting-approval') {
          managerBusy = false
          return processHandoverQueue()
        }
        walk(managerId, MANAGER_GATE, { behavior: 'gantt-chart', expression: 'normal', bubble: null })
        arriveThen(managerId, 0, () => {
          restorePresentation(managerId)
          managerBusy = false
          processHandoverQueue()
        })
      })
    }
    // The member walks to the seat on its OWN (trigger path); the manager departs
    // only once the member has physically settled there.
    const waitForMember = (ticksLeft) => {
      const current = store.getState()
      const manager = current.agents[managerId]
      if (!manager || manager.status !== 'working') { managerBusy = false; return processHandoverQueue() }
      const member = current.agents[item.id]
      if (!member || member.status !== 'awaiting-approval') { managerBusy = false; return processHandoverQueue() } // moot
      if (settledAt(member, item.workSeat)) return proceed()
      if (ticksLeft <= 0) { managerBusy = false; return processHandoverQueue() } // the walk died — drop, don't chase
      later(() => waitForMember(ticksLeft - 1), 500)
    }
    waitForMember(40) // ~20s — the member walk budget (timeout + re-issues)
  }

  let wanderTimer = null
  if (typeof setInterval === 'function') {
    wanderTimer = setInterval(() => {
      if (torn) return
      const s = store.getState()
      if (s.mawMeta?.quality === 'stale') return // channel stale — hold positions
      if (Date.now() - lastWanderAt < WANDER_INTERVAL_MS) return
      const candidates = wanderCandidates({
        members: Object.values(s.agents).filter((a) => a?.mawMember),
        workingSince,
        restingSince,
      })
      if (candidates.length === 0) return
      lastWanderAt = Date.now()
      const agent = candidates[Math.floor(Math.random() * candidates.length)]
      const point = wanderPoint()
      if (!point) return
      const statusAtDeparture = agent.status
      const working = statusAtDeparture === 'working' || statusAtDeparture === 'planning'
      walk(agent.id, point, { behavior: 'idle', expression: 'normal', bubble: null })
      arriveThen(agent.id, 8000 + Math.random() * 8000, () => {
        const current = store.getState().agents[agent.id]
        if (!current) return
        if (current.status !== statusAtDeparture) return restorePresentation(agent.id) // the transition owns the new walk
        const home = working ? stableWorkSeat(current) : stableRestSeat(current)
        const back = working
          ? { behavior: MAW_ROLE_WORK_BEHAVIOR[current.maw?.role] || 'typing', expression: 'normal', bubble: null }
          : { behavior: 'idle', expression: current.status === 'done' ? 'happy' : 'normal', bubble: null }
        walk(agent.id, home, back)
        arriveThen(agent.id, 0, () => restorePresentation(agent.id))
        if (working) workingSince.set(agent.id, Date.now())
        else restingSince.set(agent.id, Date.now())
      })
    }, 5_000)
    if (typeof wanderTimer.unref === 'function') wanderTimer.unref()
  }

  // Re-entrancy guard: our own walk sets re-enter this listener SYNCHRONOUSLY
  // (setAgentGroupEvent notifies mid-iteration). A nested pass sees half-processed
  // latch state and reorders handover triggers (a later member enqueued before an
  // earlier one) — one dispatch runs to completion; the walk sets change no member
  // facts, so nothing needs reprocessing.
  let dispatching = false
  const unsubscribe = store.subscribe(() => {
    if (torn || dispatching) return
    dispatching = true
    try {
      dispatch()
    } finally {
      dispatching = false
    }
  })

  function dispatch() {
    const s = store.getState()
    if (s.mode !== 'maw') return
    // Channel degradation (producer lease expired / terminal workflow): every
    // pending callback dies with its generation — a delayed enter, a dwell, a
    // walk-home must never fire over degraded state (review P1: old callbacks
    // overrode stale). prevPhase is intentionally kept: on recovery the
    // accumulated status diffs replay exactly once.
    const quality = s.mawMeta?.quality ?? null
    if (quality !== lastSeenQuality) {
      lastSeenQuality = quality
      if (quality === 'stale' || s.mawMeta?.terminal != null) choreoEpoch += 1
    }
    if (quality === 'stale') return
    const members = Object.values(s.agents).filter((a) => a?.mawMember)
    const manager = members.find((a) => a.maw?.role === 'manager')
    pruneGoneMembers(new Set(members.map((m) => m.id)))

    // member transitions (manager handled by the handover queue only)
    const now = Date.now()
    let batchStagger = 0 // i×1.5s WITHIN one migration batch (plan §4.1) — never cumulative across the session
    for (const member of members) {
      if (member.maw?.role === 'manager') continue
      if (phaseOf(member.status) === 'task') {
        if (!workingSince.has(member.id)) workingSince.set(member.id, now)
        restingSince.delete(member.id)
      } else {
        if (!restingSince.has(member.id)) restingSince.set(member.id, now)
        workingSince.delete(member.id)
      }
      const phase = phaseOf(member.status)
      const previous = prevPhase[member.id]
      if (phase === previous) continue
      prevPhase[member.id] = phase
      const agentId = member.id
      // Stable seat binding: the seat was assigned when the member FIRST entered
      // this phase; recomputing from live counts would stack same-role members
      // and send the manager to someone else's desk.
      const seat = phase === 'task' ? stableWorkSeat(member) : stableRestSeat(member)
      // Delivering members hurry back to the work seat and wait for the manager.
      const delay = member.status === 'awaiting-approval' ? 0 : batchStagger * STAGGER_MS
      batchStagger += 1
      later(() => {
        const live = store.getState().agents[agentId]
        if (!live || phaseOf(live.status) !== phase) return // the phase moved on — its own transition owns the walk
        walk(agentId, seat, { behavior: 'idle', expression: 'normal', bubble: null })
        arriveThen(agentId, 0, () => restorePresentation(agentId))
      }, delay)
    }

    // manager: working seat = gate; rest seat = stable meeting-room chair
    if (manager) {
      const mphase = phaseOf(manager.status)
      if (prevPhase[manager.id] !== mphase) {
        prevPhase[manager.id] = mphase
        if (mphase === 'task') {
          walk(manager.id, MANAGER_GATE, { behavior: 'gantt-chart', expression: 'normal', bubble: null })
          // Any valid manager status releases the lock here (an initially
          // awaiting-approval manager used to keep the work animation forever).
          arriveThen(manager.id, 0, () => restorePresentation(manager.id))
        } else {
          const seat = stableRestSeat(manager)
          walk(manager.id, seat, { behavior: 'idle', expression: 'normal', bubble: null })
          arriveThen(manager.id, 0, () => restorePresentation(manager.id))
        }
      }
    }

    // handover triggers: any member entering awaiting-approval (same-phase or not —
    // the manager handover must fire even when the member never left the task phase).
    // Keyed by the plain agent id — pruneGoneMembers sweeps this map by id, so a
    // decorated key would be pruned every tick and re-enqueue the handover forever.
    for (const member of members) {
      if (member.maw?.role === 'manager') continue
      if (member.status === 'awaiting-approval' && prevHandover.get(member.id) !== true) {
        prevHandover.set(member.id, true)
        // The deliverer returns to the stable work seat IMMEDIATELY — the manager's
        // serial queue coordinates only the manager's visit, never the member's walk.
        walk(member.id, stableWorkSeat(member), { behavior: 'idle', expression: 'normal', bubble: null })
        arriveThen(member.id, 0, () => restorePresentation(member.id))
        enqueueHandover(member.id, stableWorkSeat(member), member.bubble ?? member.label)
      } else if (member.status !== 'awaiting-approval' && prevHandover.get(member.id) === true) {
        prevHandover.set(member.id, false)
      }
    }
  }

  return function cleanup() {
    torn = true
    unsubscribe()
    if (wanderTimer) clearInterval(wanderTimer)
    for (const t of pendingTimers) clearTimeout(t)
    pendingTimers.clear()
  }
}
