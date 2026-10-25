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
// Position rules (plan §5.1, multi-agent-workflow-office-animation-choreography):
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

import { MEETING_CHAIRS, HOME_POSITIONS, ZONE_FLOOR_RECTS, clampToFloor, calcFacing } from './movementSystem.js'
import { validateMawHandoff } from '../inference/dashboardSnapshot.js'
import { handoffApproachPoint } from './mawHandoff.js'

export const MANAGER_GATE = { x: 100, y: 80 }
const HANDOVER_DWELL_MS = 3000
// Entrance launch spacing: members start in quick succession and flow through
// the (single-occupant) door passages as a stream — the door early-release
// keeps the queue moving, so launches overlap instead of serializing.
export const STAGGER_MS = 600
const WANDER_INTERVAL_MS = 15_000
const LONG_WORK_MS = 90_000 // a member on the same work/rest stretch this long may take a walk
const ARRIVAL_POLL_MS = 400
const ARRIVE_TIMEOUT_MS = 20_000
const ARRIVE_MAX_REISSUES = 3 // a timeout is not success — re-issue, then bail without the chained step
const ARRIVE_EPSILON_PX = 8 // "arrived" = the figure physically reached its published target

// Wander areas (plan §5.1 rest): the meeting room plus the two bottom rooms —
// low-frequency leg-stretch walks sample all three. Rest SEATS are a different
// rule (plan §4.2 non-goal): lounge/research are wander scenery, never seats.
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

// Rest seats (plan §5.1 rest): the member-id hash maps into the 8 MEETING_CHAIRS
// first; overflow fills a deterministic grid on the free floor BELOW the meeting
// table (the table obstacle ends at y=195, the meeting-room rect runs to y=413),
// so every rest seat — default and overflow — stays inside the meeting room.
// Overflow grid on STAGGERED rows: adjacent-row neighbours sit at (24px, 36px)
// — outside the sprite clearance ellipse SPRITE_CLEAR_RX/RY (32×44: 0.75² +
// 0.82² > 1) — so avoidOverlap has no reason to shove a rest target out of the
// room. Above-table rows stop at y=60: the row at y≈96 would fall inside the
// chair ellipse band (chairs span y 120–205; the first below row starts at
// y=252, 47px clear of the y=205 chair row). This yields 30 overflow seats;
// with the 8 chairs the non-overlapping capacity is EXACTLY 50 — a full
// valid snapshot seats without sharing a chair or stacking, and avoidOverlap
// pushes are folded back by clampToRestZone below.
const MEETING_OVERFLOW_SEATS = []
const OVERFLOW_ROWS = [
  { ys: [60, 96], xs: [634, 682, 730] },
  { ys: [60, 96], xs: [658, 706, 754] },
  { ys: [252, 288, 324, 360, 396], xs: [634, 682, 730] },
  { ys: [252, 288, 324, 360, 396], xs: [658, 706, 754] },
]
for (const { ys, xs } of OVERFLOW_ROWS) {
  for (const y of ys) for (const x of xs) MEETING_OVERFLOW_SEATS.push({ x, y })
}
// 8 meeting chairs + 24 staggered overflow = 32 non-overlapping seats.
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

// CR-3/CR-10 work-seat clusters: geographic desk GROUPS. Roles are assigned to
// groups RANDOMLY on every page load (CR-3 随机分配), and each role's members
// sit ADJACENTLY within its group (同一角色工位相邻) — the group order is
// shuffled, the seats inside a group keep their geographic order.
// Role blocks: GEOGRAPHICALLY CONTIGUOUS desk groups. The executor (largest
// crew) takes the 4-seat right block; decision-maker and reviewer randomly
// split the remaining two blocks on every page load (CR-3 随机分配). Seat order
// inside a block is shuffled too, so member→desk is random while same-role
// seats stay adjacent.
const WORK_BLOCKS = {
  block4: [{ x: 340, y: 364 }, { x: 460, y: 364 }, { x: 400, y: 244 }, { x: 520, y: 244 }],
  row2: [{ x: 260, y: 264 }, { x: 140, y: 264 }],
  corner: [{ x: 140, y: 384 }],
}
const ROLE_WORK_CLUSTERS = (() => {
  const shuffle = (list) => {
    // `list` may be an ARRAY OF ARRAYS (desk groups) — copy deeply; a naive
    // {...group} spread would turn each group into an index-keyed OBJECT.
    const out = list.map((item) => Array.isArray(item) ? item.map((s) => ({ ...s })) : { ...item })
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  const dmAndRev = shuffle([WORK_BLOCKS.row2, WORK_BLOCKS.corner])
  return {
    executor: shuffle(WORK_BLOCKS.block4),
    'decision-maker': dmAndRev[0],
    reviewer: dmAndRev[1],
    manager: [],
  }
})()

/** Working seat: the role's cluster seat (adjacent per role, random group per
 * page load); members beyond the cluster's desks fall back to the overflow
 * pool. CR-2: the manager's working seat is the GATE booth. */
export function workSeatFor(role, perRoleCount) {
  if (role === 'manager') return { ...MANAGER_GATE }
  const cluster = ROLE_WORK_CLUSTERS[role] ?? []
  if (perRoleCount < cluster.length) return { ...cluster[perRoleCount] }
  // Clamp only as a defensive bound — a valid snapshot (≤ 50 members) can never
  // exhaust the cluster + overflow pool, so no two members ever share a seat.
  const index = Math.min(perRoleCount - cluster.length, MAW_EXTRA_WORK_SEATS.length - 1)
  return { ...MAW_EXTRA_WORK_SEATS[Math.max(0, index)] }
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

const MEETING_RECT = ZONE_FLOOR_RECTS.meetingRoom
const REST_AREA_RECTS = [ZONE_FLOOR_RECTS.meetingRoom, ZONE_FLOOR_RECTS.lounge, ZONE_FLOOR_RECTS.research]

/** Fold any point back into the MEETING ROOM — the bound for SEAT-RETURN walks
 * (CR-1: 归座目标必须在会议室, however crowded the room gets). */
export function clampToMeetingZone(point) {
  // CR-9: the fold keeps 64px of headroom — the sprite body extends ~54px above
  // its feet, so 48px still clipped the head (review repro (667,38)).
  return {
    x: Math.min(MEETING_RECT.x2 - 2, Math.max(MEETING_RECT.x1 + 2, point.x)),
    y: Math.min(MEETING_RECT.y2 - 2, Math.max(64, point.y)),
  }
}

/** Fold any point back into the NEAREST rest-area rect — the bound for FREE-ROAM
 * walks (CR-8: lounge/research wander targets must survive) and the middle-office
 * guard for everything else (CR-1: an avoidOverlap shove must not eject a rest
 * walk into the office band). */
export function clampToRestZone(point) {
  // Points inside a rest area still respect the CR-9 visibility floor —
  // avoidOverlap may push a legal y=48 target ABOVE the floor.
  if (REST_AREA_RECTS.some((r) => point.x >= r.x1 && point.x <= r.x2 && point.y >= r.y1 && point.y <= r.y2)) {
    return { x: point.x, y: Math.max(64, point.y) }
  }
  let best = { x: point.x, y: point.y }
  let bestDist = Infinity
  for (const r of REST_AREA_RECTS) {
    const cx = Math.min(r.x2 - 2, Math.max(r.x1 + 2, point.x))
    const cy = Math.min(r.y2 - 2, Math.max(64, r.y1 + 2, point.y))
    const d = (cx - point.x) ** 2 + (cy - point.y) ** 2
    if (d < bestDist) {
      bestDist = d
      best = { x: cx, y: cy }
    }
  }
  return best
}

/** CR-9 visibility-only fold — applies to EVERY role including the manager (whose
 * zone exemption must not reintroduce clipping). */
export function clampToVisible(point) {
  return {
    x: Math.min(778, Math.max(24, point.x)),
    y: Math.min(500, Math.max(64, point.y)),
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
    y: Math.max(48, rect.y1 + 24 + rng() * Math.max(8, rect.y2 - rect.y1 - 48)),
  })
  // CR-9 visibility floor: a sprite's body extends ~32px above its feet —
  // anything closer than 48px to the top wall clips the head (owner screenshot).
  return { x: Math.min(778, Math.max(24, point.x)), y: Math.min(500, Math.max(64, point.y)) }
}

/**
 * Pure picker for the occasional leg-stretch walk. A member may wander when
 * they have sat out their current stretch (LONG_WORK_MS): working/planning
 * members earn a break from WORK, idle/done members may stretch after a long
 * REST. Blocked / awaiting-approval members and the manager (handover duty)
 * never wander; neither does anyone mid-walk.
 */
export function wanderCandidates({ members, workingSince, restingSince, now = Date.now(), freeRoam = false }) {
  const out = []
  for (const agent of members) {
    if (!agent) continue
    // CR-6: a WORKING manager never wanders (gate duty). CR-8: once ALL work is
    // completed (freeRoam) the manager joins the rest-area free-for-all too.
    if (!freeRoam && agent.maw?.role === 'manager') continue
    if (agent.isMoving || agent.journeyTarget || agent.inGroupEvent) continue
    const working = agent.status === 'working' || agent.status === 'planning'
    const resting = agent.status === 'idle' || agent.status === 'done'
    if (!working && !resting) continue
    if (freeRoam) {
      // CR-8 free-roam is for the RESTING team only — a working status past the
      // terminal marker is contradictory data, not someone to send for a walk.
      if (working) continue
    } else {
      const since = working ? workingSince.get(agent.id) : restingSince.get(agent.id)
      if (since === undefined || now - since < LONG_WORK_MS) continue
    }
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
export function startMawChoreography(store, { resumeCurrent = false } = {}) {
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
  const walkBounds = new Map() // agentId -> the zone bound of its CURRENT walk — timeout re-issues must keep it
  const seatTargets = new Map() // agentId -> published target of its last SEAT walk (desk/gate) — the CR-3 audit's compliance spot
  const restTargets = new Map() // agentId -> published target of its last REST walk (meeting room) — informational
  const breakUntil = new Map() // agentId -> timestamp until which a sanctioned CR-6/CR-8 break may keep the figure away
  const walkTargets = new Map() // agentId -> last PUBLISHED walk target (post avoidOverlap/re-clamp) — where the walk actually goes
  let choreoEpoch = 0 // bumped when the channel degrades (stale / terminal): every pending callback dies with its generation
  let lastSeenQuality = null
  let lastSeenTerminal = false
  let lastRecovery = 0 // Dashboard-only observation baseline; standalone replay remains unchanged
  let lastHydration = 0
  let lastOpening = 0
  let prevPostDesk = null // null = not yet observed; true = the team stands by at desks (CR-11)
  let standbySweepSeq = 0 // latest standby sweep — older sweeps' callbacks void themselves
  const pendingRelocation = new Map() // agentId -> { workflowActive } — deferred relocations for mid-walk members
  let pendingSeq = 0
  const pendingEnter = new Map() // agentId -> { seq, from } — rolled back if the generation dies pre-fire
  const seenHandoffs = new Set()
  const queuedHandoffs = new Map()
  const activeHandoffs = new Map()
  const handoffParticipants = new Map() // agentId -> event id; ordinary movement must yield
  let processingHandoffs = false
  let mutatingHandoff = false

  function later(fn, ms) {
    if (torn) return
    const epoch = choreoEpoch
    const t = setTimeout(() => {
      pendingTimers.delete(t)
      if (!torn && choreoEpoch === epoch) fn()
    }, ms)
    pendingTimers.add(t)
  }

  function walk(agentId, target, { behavior, expression = 'normal', bubble = null, zoneBound = 'member' }) {
    const s = store.getState()
    if (!s.agents[agentId]) return
    const token = (walkTokens.get(agentId) || 0) + 1
    walkTokens.set(agentId, token)
    walkBounds.set(agentId, zoneBound)
    const safe = agentId.endsWith('~manager') ? { x: target.x, y: target.y } : clampToMemberZone(target)
    // Seat-intent walks (desk/gate returns) publish the member's COMPLIANCE
    // spot for the CR-3 audit; 'none' marks a TEMPORARY destination (handover
    // chat stop) the audit must not treat as the desk; wander walks ('rest-
    // areas') are CR-6/CR-8 breaks, exempt via breakUntil instead.
    if (zoneBound === 'member' || zoneBound === 'meeting') seatTargets.set(agentId, null)
    s.setAgentGroupEvent(agentId, {
      behavior,
      expression,
      bubble,
      groupTarget: safe,
      zoneBound, // how the store must bound the FINAL published target
    })
    // Record where the store actually published the walk to — the queue's settle
    // check must judge THIS point, never the requested one (avoidOverlap moves it).
    const published = store.getState().agents[agentId]?.groupTarget ?? null
    walkTargets.set(agentId, published)
    if (zoneBound === 'member') seatTargets.set(agentId, published)
    if (zoneBound === 'meeting') restTargets.set(agentId, published)
  }

  /** Release the walk lock and dress the member in their CURRENT status animation. */
  function restorePresentation(agentId, bubble = undefined) {
    const s = store.getState()
    const a = s.agents[agentId]
    if (!a) return
    const pseudo = { id: agentId, role: a.maw?.role, status: a.status }
    s.clearAgentGroupEvent(agentId, {
      behavior: behaviorFor(pseudo),
      expression: a.status === 'done' ? 'happy' : a.status === 'blocked' ? 'confused' : 'normal',
      bubble: bubble === undefined ? a.bubble ?? null : bubble,
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

  const settledAt = (agent, agentId) => {
    if (!agent || agent.isMoving || agent.journeyTarget || agent.inGroupEvent) return false
    const target = walkTargets.get(agentId)
    if (!target) return false
    return Math.hypot((agent.position?.x ?? 1e9) - target.x, (agent.position?.y ?? 1e9) - target.y) <= ARRIVE_EPSILON_PX
  }

  /**
   * Poll until the agent's CURRENT walk physically settles, then run `fn` after an
   * optional dwell. The whole chain dies with its walk token and choreography
   * epoch — INCLUDING the post-arrival dwell: a newer walk (or a new generation)
   * during the dwell must never have its journey clobbered by the stale callback.
   * A timeout is NOT success: the walk is re-issued (door claims expire), and after
   * the final attempt the lock is released WITHOUT running `fn` — but `onCancel`
   * still runs so the caller's queue state never wedges.
   */
  function arriveThen(agentId, afterMs, fn, onCancel = null) {
    const epoch = choreoEpoch
    let reissues = 0
    const awaitWalk = () => {
      const token = walkTokens.get(agentId)
      const startedAt = Date.now()
      const poll = () => {
        if (torn || choreoEpoch !== epoch || walkTokens.get(agentId) !== token) return // superseded — the new walk owns the chain
        const current = store.getState().agents[agentId]
        if (!current || !current.inGroupEvent || !current.groupTarget) return // released elsewhere
        if (arrivedAt(current)) {
          const settledToken = token
          return later(() => {
            if (torn || choreoEpoch !== epoch || walkTokens.get(agentId) !== settledToken) return
            fn()
          }, afterMs)
        }
        if (Date.now() - startedAt >= ARRIVE_TIMEOUT_MS) {
          if (reissues >= ARRIVE_MAX_REISSUES) {
            restorePresentation(agentId)
            onCancel?.()
            return
          }
          reissues += 1
          walk(agentId, current.groupTarget, { behavior: current.behavior, expression: current.expression, bubble: current.bubble, zoneBound: walkBounds.get(agentId) })
          return awaitWalk()
        }
        later(poll, ARRIVAL_POLL_MS)
      }
      later(poll, ARRIVAL_POLL_MS)
    }
    awaitWalk()
  }

  /** Stable work seat for a member: assigned ONCE, never recomputed from live counts.
   * Delegates to workSeatFor (spare-desk mapping included) so the walk target and the
   * CR-10 nameplate share ONE assignment; the binding is written back to the agent's
   * maw.workSeat stamp (PixelOffice reads it). */
  function stableWorkSeat(member) {
    const bound = workSeatsByMember.get(member.id)
    if (bound) return bound
    const role = member.maw?.role ?? member.role
    if (role === 'manager') return MANAGER_GATE // the gate booth is the manager's work seat
    // Scan the role's cluster seats first, then the overflow pool, and take the
    // FIRST seat not claimed by a CURRENT member — count-based indexes collide
    // after departures (a joiner reused the seat of a member still present,
    // collapsing their nameplates). Occupancy scan is churn-safe.
    const claimed = new Set()
    for (const [id, boundSeat] of workSeatsByMember) {
      if (store.getState().agents[id]) claimed.add(seatKey(boundSeat))
    }
    const existingSeat = member.maw?.workSeat
    let seat = existingSeat && !claimed.has(seatKey(existingSeat)) ? { ...existingSeat } : null
    for (const candidate of [...(ROLE_WORK_CLUSTERS[role] ?? []), ...MAW_EXTRA_WORK_SEATS]) {
      if (seat) break
      if (claimed.has(seatKey(candidate))) continue
      seat = { ...candidate }
      break
    }
    if (!seat) seat = { ...MAW_EXTRA_WORK_SEATS[0] } // exhausted — pack (valid snapshots ≤ 50 ≤ seats)
    workSeatsByMember.set(member.id, seat)
    // Write the authoritative binding back so the nameplate follows the walk target.
    const agent = store.getState().agents[member.id]
    if (agent && JSON.stringify(agent.maw?.workSeat ?? {}) !== JSON.stringify(seat)) {
      store.setState({ agents: { ...store.getState().agents, [member.id]: { ...agent, maw: { ...agent.maw, workSeat: { ...seat } } } } })
    }
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

  function mutateHandoff(fn) {
    const previous = mutatingHandoff
    mutatingHandoff = true
    try { fn() } finally { mutatingHandoff = previous }
  }

  function factualHandoffs(state) {
    if (state.mawMeta?.quality === 'stale' || state.mawMeta?.terminal != null
      || state.mawMeta?.handoff_state !== 'complete') return new Map()
    const agents = Object.values(state.agents).filter((a) => a?.mawMember)
    const facts = agents.map((a) => ({ id: a.maw?.key, role: a.maw?.role, current_task: a.maw?.current_task }))
    const resolved = new Map()
    for (const edge of state.mawMeta?.handoffs ?? []) {
      if (!validateMawHandoff(edge, facts)) continue
      const sender = agents.find((a) => a.maw.key === edge.sender_member_id)
      const recipient = agents.find((a) => a.maw.key === edge.recipient_member_id)
      if (!sender || !recipient || sender.maw.terminate || recipient.maw.terminate) continue
      const tasks = [sender.maw.current_task, recipient.maw.current_task]
      const signature = JSON.stringify([edge, ...tasks.map((task) => [task.seq, task.round, task.type, task.source_ref, task.ref_task])])
      resolved.set(edge.id, { edge, senderId: sender.id, recipientId: recipient.id, signature })
    }
    return resolved
  }

  function ownsHandoff(item) {
    return !torn && activeHandoffs.get(item.edge.id) === item
      && handoffParticipants.get(item.senderId) === item.edge.id
      && handoffParticipants.get(item.recipientId) === item.edge.id
  }

  function releaseHandoff(item, { stop = false, rephase = false } = {}) {
    if (activeHandoffs.get(item.edge.id) !== item) return
    activeHandoffs.delete(item.edge.id)
    const ids = [item.senderId, item.recipientId]
    for (const id of ids) {
      if (handoffParticipants.get(id) === item.edge.id) handoffParticipants.delete(id)
      walkTokens.set(id, (walkTokens.get(id) || 0) + 1)
      if (rephase) delete prevPhase[id]
    }
    mutateHandoff(() => {
      for (const id of ids) {
        const state = store.getState()
        const member = state.agents[id]
        if (!member) continue
        if (stop) {
          state.releaseAgentDoorClaims(id)
          store.getState().abortAgentMovement(id, member.position)
        }
        restorePresentation(id, member.name ?? null)
      }
    })
  }

  function clearFactualHandoffs({ stop = false, restore = true } = {}) {
    queuedHandoffs.clear()
    if (restore) {
      for (const item of [...activeHandoffs.values()]) releaseHandoff(item, { stop })
    } else {
      activeHandoffs.clear()
      handoffParticipants.clear()
    }
  }

  // Use active time for both physical-arrival budgets and the conversation.
  // Pausing the office must not expire a door wait or consume the three seconds.
  function waitForHandoff(item, ready, next, limit = ARRIVE_TIMEOUT_MS) {
    let elapsed = 0
    let stamp = Date.now()
    let retries = 0
    const poll = () => {
      if (!ownsHandoff(item)) return
      const state = store.getState()
      const now = Date.now()
      if (!state.isPaused) elapsed += now - stamp
      stamp = now
      const pair = [state.agents[item.senderId], state.agents[item.recipientId]]
      if (pair.some((a) => !a?.inGroupEvent || !a.groupTarget)) {
        releaseHandoff(item, { stop: true, rephase: true })
        runDispatch()
        return
      }
      if (!state.isPaused && ready(pair, elapsed)) return next()
      if (!state.isPaused && elapsed >= limit) {
        if (retries >= ARRIVE_MAX_REISSUES) {
          releaseHandoff(item, { stop: true, rephase: true })
          runDispatch()
          return
        }
        retries += 1
        elapsed = 0
        mutateHandoff(() => {
          for (const agent of pair) {
            if (!arrivedAt(agent)) walk(agent.id, agent.groupTarget, { behavior: 'idle', zoneBound: walkBounds.get(agent.id) })
          }
        })
      }
      later(poll, 100)
    }
    later(poll, 100)
  }

  function beginFactualHandoff(item) {
    const state = store.getState()
    const recipient = state.agents[item.recipientId]
    const seat = stableWorkSeat(recipient)
    const approach = handoffApproachPoint(seat)
    if (!approach) return
    activeHandoffs.set(item.edge.id, item)
    for (const id of [item.senderId, item.recipientId]) {
      handoffParticipants.set(id, item.edge.id)
      pendingEnter.delete(id)
      pendingRelocation.delete(id)
      breakUntil.delete(id)
    }
    mutateHandoff(() => {
      walk(item.recipientId, seat, { behavior: 'idle', zoneBound: 'member' })
      walk(item.senderId, approach, { behavior: 'idle', zoneBound: 'none' })
    })
    waitForHandoff(item, (pair) => pair.every(arrivedAt), () => {
      if (!ownsHandoff(item)) return
      // Both positions are proven arrivals. Publish facing in the same owned
      // transaction: the generic idle-facing action deliberately rejects events.
      mutateHandoff(() => store.setState((current) => {
        const sender = current.agents[item.senderId]
        const receiver = current.agents[item.recipientId]
        const bubble = item.edge.kind === 'submission' ? '任务交接' : '评审回交'
        return { agents: { ...current.agents,
          [sender.id]: { ...sender, behavior: 'chat', expression: 'normal', bubble,
            facing: calcFacing(sender.position.x, sender.position.y, receiver.position.x, receiver.position.y) },
          [receiver.id]: { ...receiver, behavior: 'chat', expression: 'normal', bubble,
            facing: calcFacing(receiver.position.x, receiver.position.y, sender.position.x, sender.position.y) },
        } }
      }))
      waitForHandoff(item, (_pair, elapsed) => elapsed >= HANDOVER_DWELL_MS, () => {
        if (!ownsHandoff(item)) return
        mutateHandoff(() => {
          for (const id of [item.senderId, item.recipientId]) {
            const current = store.getState()
            const member = current.agents[id]
            const desk = phaseOf(member.status) === 'task' || (current.mawMeta?.workflow != null && current.mawMeta?.terminal == null)
            walk(id, desk ? stableWorkSeat(member) : stableRestSeat(member), { behavior: 'idle', zoneBound: desk ? 'member' : 'meeting' })
          }
        })
        waitForHandoff(item, (pair) => pair.every(arrivedAt), () => {
          releaseHandoff(item)
          processFactualHandoffs()
        })
      }, HANDOVER_DWELL_MS + 1000)
    })
  }

  function processFactualHandoffs() {
    if (processingHandoffs || torn) return
    processingHandoffs = true
    try {
      const waiting = new Set()
      for (const [id, item] of queuedHandoffs) {
        const pair = [item.senderId, item.recipientId]
        if (pair.some((memberId) => handoffParticipants.has(memberId) || waiting.has(memberId))) {
          pair.forEach((memberId) => waiting.add(memberId))
          continue
        }
        queuedHandoffs.delete(id)
        beginFactualHandoff(item)
      }
    } finally { processingHandoffs = false }
  }

  function reconcileFactualHandoffs(state) {
    const facts = factualHandoffs(state)
    for (const [id, item] of queuedHandoffs) {
      if (facts.get(id)?.signature !== item.signature) queuedHandoffs.delete(id)
    }
    for (const item of [...activeHandoffs.values()]) {
      if (facts.get(item.edge.id)?.signature !== item.signature) releaseHandoff(item, { stop: true, rephase: true })
    }
    for (const [id, item] of facts) {
      if (seenHandoffs.has(id)) continue
      seenHandoffs.add(id)
      queuedHandoffs.set(id, item)
    }
    processFactualHandoffs()
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
    for (const map of [prevHandover, workingSince, restingSince, walkTokens, walkTargets, pendingEnter, walkBounds, seatTargets, restTargets, breakUntil, pendingRelocation]) {
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
    // Every exit — success, moot, timeout bail — funnels through here, so the
    // queue can never wedge on a busy flag (review P1: the final timeout used to
    // leave managerBusy true forever).
    const finish = () => {
      managerBusy = false
      processHandoverQueue()
    }
    const proceed = () => {
      const current = store.getState()
      const manager = current.agents[managerId]
      if (!manager || manager.status !== 'working') return finish()
      // The handover takes the manager over — cancel its pending launch walk:
      // a late launch callback used to re-walk the manager to the gate MID-
      // handover, superseding the chat walk's token; the handover chain then
      // exited without finish() and the queue wedged forever (review P1).
      pendingEnter.delete(managerId)
      walk(managerId, item.workSeat, { behavior: 'chat', expression: 'normal', bubble: `任务交接 · ${item.label || ''}`, zoneBound: 'none' })
      arriveThen(managerId, HANDOVER_DWELL_MS, () => {
        const live = store.getState()
        const mgr = live.agents[managerId]
        const member = live.agents[item.id]
        restorePresentation(managerId) // dress the manager's CURRENT status — handover or not
        // The handover went moot mid-dwell (member resolved, manager left working):
        // no return leg — the next real transition owns the manager's walk.
        if (!mgr || mgr.status !== 'working' || !member || member.status !== 'awaiting-approval') return finish()
        walk(managerId, MANAGER_GATE, { behavior: 'gantt-chart', expression: 'normal', bubble: null })
        arriveThen(managerId, 0, () => {
          restorePresentation(managerId)
          finish()
        }, finish)
      }, finish)
    }
    // The member walks to the seat on its OWN (trigger path); the manager departs
    // only once the member has settled at the PUBLISHED walk target (avoidOverlap
    // may have moved it off the nominal seat).
    const waitForMember = (ticksLeft) => {
      const current = store.getState()
      const manager = current.agents[managerId]
      if (!manager || manager.status !== 'working') return finish()
      const member = current.agents[item.id]
      if (!member || member.status !== 'awaiting-approval') return finish() // moot
      if (settledAt(member, item.id)) return proceed()
      if (ticksLeft <= 0) return finish() // the walk died — drop, don't chase
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
      // CR-8: after ALL work completes (terminal) the whole team — manager
      // included — free-roams the rest areas on every tick, no 90s threshold.
      const freeRoam = s.mawMeta?.terminal != null
      // CR-11 standby relocation (workflowActive/standbyFlip hoisted above).
      // CR-3 audit runs EVERY tick (before the wander cadence gate): a WORKING
      // member stands at its own desk. Figures displaced by timeout bail-outs /
      // stale holds / supersede remnants are walked back to their stable seat;
      // the CR-6 wander dwell is naturally exempt (its last published target IS
      // where the figure stands). The manager is skipped while a handover owns it.
      if (!freeRoam) {
        for (const agent of Object.values(s.agents)) {
          if (!agent?.mawMember) continue
          if (handoffParticipants.has(agent.id)) continue
          if (agent.isMoving || agent.journeyTarget || agent.inGroupEvent) continue
          if (agent.maw?.role === 'manager' && managerBusy) continue
          if (phaseOf(agent.status) !== 'task') continue
          if (pendingEnter.has(agent.id)) continue // launch still queued — the stagger owns it (review P2: audit broke the entrance order)
          if ((breakUntil.get(agent.id) ?? 0) > Date.now()) continue // sanctioned CR-6/CR-8 break in progress
          const seatTarget = seatTargets.get(agent.id)
          // Compliance = standing where its last SEAT walk published. The last
          // walk target of ANY kind (wander point, handover chat stop) is a
          // TEMPORARY destination, not the desk — compliance is judged against
          // seatTarget ONLY: a settledAt() check would short-circuit with the
          // temp destination and skip a manager parked at a member's desk or an
          // executor stranded in a rest area after going blocked (review P2).
          if (seatTarget && Math.hypot((agent.position?.x ?? 1e9) - seatTarget.x, (agent.position?.y ?? 1e9) - seatTarget.y) <= ARRIVE_EPSILON_PX) continue
          walk(agent.id, stableWorkSeat(agent), { behavior: 'idle', expression: 'normal', bubble: null, zoneBound: 'member' })
          arriveThen(agent.id, 0, () => restorePresentation(agent.id))
        }
      }
      if (!freeRoam && Date.now() - lastWanderAt < WANDER_INTERVAL_MS) return
      const candidates = wanderCandidates({
        members: Object.values(s.agents).filter((a) => a?.mawMember && !handoffParticipants.has(a.id)),
        workingSince,
        restingSince,
        freeRoam,
      })
      if (candidates.length === 0) return
      lastWanderAt = Date.now()
      const agent = candidates[Math.floor(Math.random() * candidates.length)]
      const point = wanderPoint()
      if (!point) return
      const statusAtDeparture = agent.status
      const working = statusAtDeparture === 'working' || statusAtDeparture === 'planning'
      walk(agent.id, point, { behavior: 'idle', expression: 'normal', bubble: null, zoneBound: 'rest-areas' })
      arriveThen(agent.id, 8000 + Math.random() * 8000, () => {
        const current = store.getState().agents[agent.id]
        if (!current) return
        if (handoffParticipants.has(agent.id)) return
        if (current.status !== statusAtDeparture) return restorePresentation(agent.id) // the transition owns the new walk
        // CR-3/CR-1/CR-8/CR-11: the home follows the member's POST — a working
        // member or a standby member returns to its DESK; only an off-duty
        // resting member returns to the meeting-room chair. COMPLETED (terminal)
        // workflows are OFF DUTY: a done member's break always ends at its rest
        // seat (review P2: done members kept returning to their desks).
        const workflowLive = store.getState().mawMeta?.workflow != null
        const terminalLive = store.getState().mawMeta?.terminal != null
        const postIsDesk = working || (workflowLive && !terminalLive)
        const home = postIsDesk ? stableWorkSeat(current) : stableRestSeat(current)
        const back = working
          ? { behavior: MAW_ROLE_WORK_BEHAVIOR[current.maw?.role] || 'typing', expression: 'normal', bubble: null }
          : { behavior: 'idle', expression: current.status === 'done' ? 'happy' : 'normal', bubble: null }
        walk(agent.id, home, { ...back, zoneBound: postIsDesk ? 'member' : 'meeting' })
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
  function runDispatch() {
    if (torn || dispatching) return
    dispatching = true
    try { dispatch() } finally { dispatching = false }
  }
  const unsubscribe = store.subscribe(() => {
    if (torn || dispatching || mutatingHandoff) return
    dispatching = true
    try {
      dispatch()
    } finally {
      dispatching = false
    }
  })

  function dispatch() {
    const s = store.getState()
    if (s.mode !== 'maw') {
      if (activeHandoffs.size || queuedHandoffs.size) clearFactualHandoffs({ stop: true })
      return
    }
    const members = Object.values(s.agents).filter((a) => a?.mawMember)
    const recovery = s.mawMeta?.dashboard_recovery ?? 0
    const hydration = s.mawMeta?.dashboard_hydration ?? 0
    const opening = s.mawMeta?.dashboard_opening ?? 0
    if (resumeCurrent && (recovery !== lastRecovery || hydration !== lastHydration)) {
      lastRecovery = recovery
      lastHydration = hydration
      lastOpening = opening
      // A disconnected Dashboard did not observe intermediate work. Cancel every
      // old callback and baseline the CURRENT facts, without rest/task or handover replay.
      choreoEpoch += 1
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
      clearFactualHandoffs({ restore: false })
      seenHandoffs.clear()
      for (const id of factualHandoffs(s).keys()) seenHandoffs.add(id)
      pendingEnter.clear()
      pendingRelocation.clear()
      handoverQueue.length = 0
      managerBusy = false
      workingSince.clear()
      restingSince.clear()
      pruneGoneMembers(new Set(members.map((m) => m.id)))
      const now = Date.now()
      for (const member of members) {
        prevPhase[member.id] = phaseOf(member.status)
        prevHandover.set(member.id, member.status === 'awaiting-approval')
        stableWorkSeat(member)
        stableRestSeat(member)
        seatTargets.set(member.id, { ...member.position })
        if (phaseOf(member.status) === 'task') workingSince.set(member.id, now)
        else restingSince.set(member.id, now)
      }
      prevPostDesk = s.mawMeta?.workflow != null && s.mawMeta?.terminal == null
      lastSeenQuality = s.mawMeta?.quality ?? null
      lastSeenTerminal = s.mawMeta?.terminal != null
      return
    }
    if (resumeCurrent && opening !== lastOpening) {
      lastOpening = opening
      for (const id of Object.keys(prevPhase)) delete prevPhase[id]
      prevHandover.clear()
    }
    const quality = s.mawMeta?.quality ?? null
    const terminal = s.mawMeta?.terminal != null
    const enteringStale = quality === 'stale' && lastSeenQuality !== 'stale'
    const enteringTerminal = terminal !== lastSeenTerminal
    // CR-11 standby: while a workflow is ACTIVE and not terminal, members with
    // no task stand by at their WORK seats (waiting for assignments) instead of
    // the meeting room. The POST flip is evaluated only on a LIVE channel — a
    // stale arrival (or a stale mid-flip) must NOT launch relocations; the post
    // tracking stays frozen so recovery re-evaluates the flip (review P2).
    const workflowActive = s.mawMeta?.workflow != null
    const postIsDeskNow = workflowActive && !terminal
    const standbyFlip = quality !== 'stale' && prevPostDesk !== null && postIsDeskNow !== prevPostDesk
    if (quality !== 'stale') prevPostDesk = postIsDeskNow
    if (quality !== lastSeenQuality) lastSeenQuality = quality
    lastSeenTerminal = terminal
    if (enteringStale || enteringTerminal) {
      // A generation boundary reaps EVERYTHING the old generation still owned:
      // walk locks, the queue's busy flag and pending items, the handover
      // latches, and the not-yet-fired staggered walks. Presentation differs:
      // stale rests everyone (plan: stop active work animation), a cancellation
      // dresses each figure in its CURRENT status (blocked → scratch-head …).
      clearFactualHandoffs({ stop: true })
      choreoEpoch += 1
      for (const a of members) {
        if (!a.inGroupEvent) continue
        if (enteringStale) s.clearAgentGroupEvent(a.id, { behavior: 'idle', expression: 'normal', bubble: a.bubble ?? null })
        else restorePresentation(a.id)
      }
      managerBusy = false
      handoverQueue.length = 0
      for (const id of [...prevHandover.keys()]) prevHandover.set(id, false)
      // Only the STALE path rolls pending walks back: the channel will hold
      // positions and recovery must replay the swallowed transitions (review P2).
      // A CANCELLATION must NOT roll back — its dispatch re-runs the transition
      // loop immediately, so a rollback would re-arm and instantly re-walk the
      // very moves the cancellation just killed; drop the records instead.
      if (enteringStale) {
        for (const [id, pending] of pendingEnter) prevPhase[id] = pending.from
      }
      pendingEnter.clear()
    }
    if (standbyFlip) {
      // CR-11: the workday started/ended — relocate every RESTING member
      // between its meeting-room seat and its standby work seat. Launches are
      // STAGGERED through pendingRelocation (readyAt slots) and completed by
      // the relocation pass below — a stale interruption cannot kill a queued
      // launch: the entry survives stale and the pass completes it on recovery
      // (review P1/P2). Mid-walk members defer the same way.
      let sweep = 0
      for (const member of members) {
        if (member.maw?.role === 'manager') continue
        if (phaseOf(member.status) !== 'rest') continue
        const agentId = member.id
        const readyAt = Date.now() + sweep * STAGGER_MS
        sweep += 1
        pendingRelocation.set(agentId, { readyAt })
      }
    }

    // Channel stale (producer lease expired): the snapshot already rests the figures
    // (buildMawMember), so no NEW walks — members hold where they are until a fresh
    // snapshot restores quality. prevPhase is intentionally kept: on recovery the
    // accumulated status diffs replay exactly once.
    if (quality === 'stale') return
    pruneGoneMembers(new Set(members.map((m) => m.id)))
    reconcileFactualHandoffs(s)

    // CR-11 deferred relocations: members queued by the standby sweep (staggered
    // readyAt) or caught MID-WALK at a flip are walked to their CURRENT post the
    // moment they are due and no longer moving — stale pauses and walk timeouts
    // delay but never cancel the relocation (review P1/P2).
    for (const [agentId, rel] of pendingRelocation) {
      const live = store.getState().agents[agentId]
      if (!live) { pendingRelocation.delete(agentId); continue }
      if (handoffParticipants.has(agentId)) continue
      if (Date.now() < (rel.readyAt ?? 0)) continue // stagger slot not due yet
      if (live.isMoving || live.journeyTarget || live.inGroupEvent) continue
      pendingRelocation.delete(agentId)
      if (live.maw?.role === 'manager') continue
      if (phaseOf(live.status) !== 'rest') continue // the transition owns the walk
      const postIsDesk = workflowActive && !terminal
      const seat = postIsDesk ? stableWorkSeat(live) : stableRestSeat(live)
      walk(agentId, seat, { behavior: 'idle', expression: 'normal', bubble: null, zoneBound: postIsDesk ? 'member' : 'meeting' })
      arriveThen(agentId, 0, () => restorePresentation(agentId))
    }

    // member transitions — EVERY role launches in the batch sequence (CR-1):
    // the manager takes its slot in member order (working seat = gate; the
    // handover queue still coordinates only the manager's confirmation visits)
    const now = Date.now()
    let batchStagger = 0 // i×0.6s WITHIN one migration batch (plan §5.1) — never cumulative across the session
    for (const member of members) {
      const isManager = member.maw?.role === 'manager'
      if (phaseOf(member.status) === 'task') {
        if (!workingSince.has(member.id)) workingSince.set(member.id, now)
        restingSince.delete(member.id)
      } else {
        if (!restingSince.has(member.id)) restingSince.set(member.id, now)
        workingSince.delete(member.id)
      }
      const phase = phaseOf(member.status)
      const previous = prevPhase[member.id]
      if (handoffParticipants.has(member.id)) continue
      if (phase === previous) continue
      prevPhase[member.id] = phase
      if (isManager && managerBusy) {
        // The manager's own transition killed the handover chain (its callbacks
        // die with the superseded walk). Release the queue here: awaiting
        // deliverers re-latch below in the same dispatch.
        managerBusy = false
        handoverQueue.length = 0
        for (const id of [...prevHandover.keys()]) prevHandover.set(id, false)
      }
      const agentId = member.id
      // Stable seat binding: the seat was assigned when the member FIRST entered
      // this phase; recomputing from live counts would stack same-role members
      // and send the manager to someone else's desk.
      const seat = isManager
        ? (phase === 'task' ? MANAGER_GATE : stableRestSeat(member))
        : phase === 'task' || workflowActive ? stableWorkSeat(member) : stableRestSeat(member)
      // Delivering members hurry back to the work seat and wait for the manager.
      const delay = member.status === 'awaiting-approval' ? 0 : batchStagger * STAGGER_MS
      batchStagger += 1
      // The pending record is owned by ITS callback only: rapid rest/task toggles
      // stack several scheduled walks, and an older callback firing late must
      // never delete a newer pending record — the stale reap could no longer roll
      // that walk back and recovery would swallow it (review P2 regression). Nor
      // may the stale callback keep walking: losing ownership TERMINATES it.
      const seq = ++pendingSeq
      pendingEnter.set(agentId, { seq, from: previous ?? null }) // rolled back if this walk dies pre-fire
      later(() => {
        const mine = pendingEnter.get(agentId)
        if (!mine || mine.seq !== seq) return // ownership lost (a newer pending walk or a prune) — terminate; the owner walks
        pendingEnter.delete(agentId)
        const live = store.getState().agents[agentId]
        if (!live || phaseOf(live.status) !== phase) return // the phase moved on — its own transition owns the walk
        if (handoffParticipants.has(agentId)) return
        walk(agentId, seat, { behavior: 'idle', expression: 'normal', bubble: null, zoneBound: isManager ? undefined : phase === 'rest' && !workflowActive ? 'meeting' : 'member' })
        arriveThen(agentId, 0, () => restorePresentation(agentId))
      }, delay)
    }

    // handover triggers: any member entering awaiting-approval (same-phase or not —
    // the manager handover must fire even when the member never left the task phase).
    // Keyed by the plain agent id — pruneGoneMembers sweeps this map by id, so a
    // decorated key would be pruned every tick and re-enqueue the handover forever.
    const structuredHandoffs = s.integration === 'dashboard' || s.mawMeta?.handoff_state != null
    for (const member of members) {
      if (structuredHandoffs || handoffParticipants.has(member.id)) continue
      if (member.maw?.role === 'manager') continue
      if (member.status === 'awaiting-approval' && prevHandover.get(member.id) !== true) {
        prevHandover.set(member.id, true)
        // The deliverer returns to the stable work seat IMMEDIATELY — the manager's
        // serial queue coordinates only the manager's visit, never the member's walk.
        walk(member.id, stableWorkSeat(member), { behavior: 'idle', expression: 'normal', bubble: null })
        arriveThen(member.id, 0, () => restorePresentation(member.id))
        // `name` (member.label || roster name) is stable — the label BUBBLE is
        // cleared by transit walks and only re-applied by the next snapshot.
        enqueueHandover(member.id, stableWorkSeat(member), member.name ?? member.bubble ?? member.label)
      } else if (member.status !== 'awaiting-approval' && prevHandover.get(member.id) === true) {
        prevHandover.set(member.id, false)
      }
    }
  }

  return function cleanup() {
    torn = true
    unsubscribe()
    clearFactualHandoffs({ stop: true })
    if (wanderTimer) clearInterval(wanderTimer)
    for (const t of pendingTimers) clearTimeout(t)
    pendingTimers.clear()
  }
}
