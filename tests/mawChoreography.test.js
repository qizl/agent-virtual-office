import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ZONE_FLOOR_RECTS } from '../src/systems/movementSystem.js'
import { useOfficeStore } from '../src/systems/store.js'
import {
  restSeatFor,
  workSeatFor,
  violatesMemberZone,
  phaseOf,
  behaviorFor,
  wanderPoint,
  planChoreography,
  startMawChoreography,
  MANAGER_GATE,
  clampToMemberZone,
} from '../src/systems/mawChoreography.js'

// Zone rules (plan §5.1): the manager may enter every area; other members may
// enter the meeting room, the main office and BOTH bottom rooms (lounge,
// research) — never the entrance area where the gate sits. Rest SEATS live in
// the meeting room only (§4.2: the bottom rooms are wander scenery).

const ENTRANCE = { x1: 0, y1: 0, x2: 598, y2: 148 }
const MEETING = ZONE_FLOOR_RECTS.meetingRoom
const MAIN = ZONE_FLOOR_RECTS.mainOffice
const LOUNGE = ZONE_FLOOR_RECTS.lounge
const RESEARCH = ZONE_FLOOR_RECTS.research

function member(id, role, status) {
  return { id, role, status }
}

describe('maw choreography planning', () => {
  it('rest seats land inside the meeting room, stay stable and seat everyone uniquely', () => {
    for (const id of ['aaa001', 'bbb002', 'ccc003']) {
      const { seat } = restSeatFor(id)
      expect(inRect(seat, MEETING)).toBe(true)
      expect(violatesMemberZone(seat)).toBe(false)
      expect(restSeatFor(id).seat).toEqual(seat) // stable per member
    }
    // the pool seats a full 50-member snapshot without sharing a chair
    const taken = new Set()
    const seen = new Set()
    for (let i = 0; i < 50; i++) {
      const assigned = restSeatFor(`m${i}`, taken)
      taken.add(assigned.index)
      seen.add(`${assigned.seat.x},${assigned.seat.y}`)
    }
    expect(seen.size).toBe(50)
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

  it('the extra-seat pool seats a whole 50-member role uniquely and zone-safe', () => {
    const seats = []
    for (let n = 1; n <= 49; n++) seats.push(workSeatFor('executor', n)) // 49 extras = worst valid snapshot
    const keys = seats.map((s) => `${s.x},${s.y}`)
    expect(new Set(keys).size).toBe(seats.length) // no wrap-around collisions
    for (const seat of seats) {
      expect(violatesMemberZone(seat)).toBe(false) // never in the entrance area
      expect(inRect(seat, MAIN)).toBe(true)
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

  it('wander points stay inside the rest areas (meeting room, lounge, research)', () => {
    for (let i = 0; i < 40; i++) {
      const p = wanderPoint(() => (i % 7) / 7)
      const inRest = inRect(p, MEETING) || inRect(p, LOUNGE) || inRect(p, RESEARCH)
      expect(inRest).toBe(true)
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
      // all rest seats are meeting-room seats per the plan; nobody rests at the gate
      expect(inRect(action.target, MEETING)).toBe(true)
      expect(violatesMemberZone(action.target)).toBe(false)
    }
  })

  it('clampToMemberZone folds entrance points back into the main office band', () => {
    for (const bad of [{ x: 120, y: 110 }, { x: 300, y: 50 }, { x: 540, y: 60 }]) {
      const fixed = clampToMemberZone(bad)
      expect(violatesMemberZone(fixed)).toBe(false)
      expect(fixed.y).toBeGreaterThanOrEqual(175)
    }
    expect(clampToMemberZone({ x: 340, y: 364 })).toEqual({ x: 340, y: 364 })
  })

  it('manager gate seat is the documented position', () => {
    expect(MANAGER_GATE).toEqual({ x: 100, y: 80 })
  })
})

// Controller-level regressions (codex reviews 2026-10-22/23): the earlier review
// batches failed the implementation because every P1 lived in the RUNNING
// controller — the pure-function tests above could not catch them. The walker
// below stands in for the React journey engine (groupTarget → position), which
// headless tests must simulate for "physical arrival" to mean anything.

function envelope(members, seq = 1) {
  return {
    server_epoch: 1,
    seq,
    snapshot: {
      workflow: 'MAW 执行与审核流程 · develop',
      quality: 'ok',
      quality_detail: null,
      terminal: null,
      sampled_at: 1000,
      members,
    },
  }
}

function mawMember(id, role, status = 'working') {
  return { id, role, status, label: `${id} · label`, detail: null, round: 1, task_kind: 'dev', verdict: null, terminate: null, stalled: false }
}

function installWalker(store) {
  // Emulates the journey engine: a published groupTarget is walked — position
  // converges to it after ~500ms. Without this, the controller's arrival polls
  // would (correctly) never declare arrival in a headless store.
  return store.subscribe(() => {
    for (const a of Object.values(store.getState().agents)) {
      if (!a?.inGroupEvent || !a.groupTarget) continue
      if (a.position?.x === a.groupTarget.x && a.position?.y === a.groupTarget.y) continue
      setTimeout(() => {
        const cur = store.getState().agents[a.id]
        if (!cur?.inGroupEvent || !cur.groupTarget) return
        if (cur.position?.x === cur.groupTarget.x && cur.position?.y === cur.groupTarget.y) return
        store.setState({ agents: { ...store.getState().agents, [a.id]: { ...cur, position: { x: cur.groupTarget.x, y: cur.groupTarget.y } } } })
      }, 500)
    }
  })
}

const near = (gt, seat, eps = 60) => Boolean(gt) && Math.hypot(gt.x - seat.x, gt.y - seat.y) < eps

describe('startMawChoreography (controller)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useOfficeStore.setState({ mode: 'maw', agents: {}, mawMeta: null })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the store publishes member walk targets OUTSIDE the entrance after avoidOverlap; the manager keeps the gate', () => {
    useOfficeStore.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor')]))
    const s = useOfficeStore.getState()
    s.setAgentGroupEvent('exe01~executor', { behavior: 'idle', expression: 'normal', bubble: null, groupTarget: { x: 300, y: 100 } })
    const memberGt = useOfficeStore.getState().agents['exe01~executor'].groupTarget
    expect(violatesMemberZone(memberGt)).toBe(false) // final result, post avoidOverlap
    expect(memberGt.y).toBeGreaterThanOrEqual(175)

    s.setAgentGroupEvent('mgr01~manager', { behavior: 'gantt-chart', expression: 'normal', bubble: null, groupTarget: { ...MANAGER_GATE } })
    expect(useOfficeStore.getState().agents['mgr01~manager'].groupTarget).toEqual(MANAGER_GATE)
  })

  it('a long-working member takes a zone-safe wander and returns to the stable work seat', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'working')]))
      vi.advanceTimersByTime(95_000) // past LONG_WORK_MS, through 5s wander ticks
      const walking = store.getState().agents['exe01~executor']
      expect(walking.inGroupEvent).toBe(true) // wander walk started (no ReferenceError)
      expect(violatesMemberZone(walking.groupTarget)).toBe(false)
      vi.advanceTimersByTime(120_000) // arrival dwell (8–16s) + walk home + restore
      const back = store.getState().agents['exe01~executor']
      expect(back.inGroupEvent).toBe(false)
      expect(back.groupTarget).toBeNull()
      expect(back.behavior).toBe('typing') // status animation restored after the walk
    } finally {
      cleanup()
    }
  })

  it('entering awaiting-approval hands over at the member\'s stable seat; the lock releases after every leg', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor')]))
      vi.advanceTimersByTime(2_000) // settle the enter walks
      const stableSeat = useOfficeStore.getState().agents['exe01~executor'].position

      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'awaiting-approval')], 2))
      vi.advanceTimersByTime(1_000)
      const manager = useOfficeStore.getState().agents['mgr01~manager']
      expect(near(manager.groupTarget, stableSeat)).toBe(true) // handover walks to THAT member's desk
      expect(manager.bubble).toContain('任务交接')
      expect(useOfficeStore.getState().agents['exe01~executor'].behavior).toBe('await-approval')

      vi.advanceTimersByTime(30_000) // dwell 3s + walk back to the gate — and NO re-trigger
      const done = useOfficeStore.getState().agents['mgr01~manager']
      expect(done.groupTarget).toBeNull() // the return leg completed and released
      expect(done.inGroupEvent).toBe(false) // every leg releases the lock
      expect(done.behavior).toBe('gantt-chart')
      expect(done.bubble).toBeNull() // the handover fired exactly once, not in a loop
    } finally {
      cleanup()
    }
  })

  it('queued handovers are serialized: the manager visits members one at a time in order', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor'), mawMember('exe02', 'executor')]))
      vi.advanceTimersByTime(2_000)
      const seat1 = useOfficeStore.getState().agents['exe01~executor'].position
      const seat2 = useOfficeStore.getState().agents['exe02~executor'].position
      expect(`${seat1.x},${seat1.y}`).not.toBe(`${seat2.x},${seat2.y}`) // unique stable seats

      const handoverBubbles = []
      const visits = []
      let lastBubble = null
      let lastTarget = null
      const unsubscribe = store.subscribe(() => {
        const m = store.getState().agents['mgr01~manager']
        // The chat bubble names the member being visited — order is read from it
        // (groupTarget alone is ambiguous: avoidOverlap pushes the manager off the
        // occupied desk, sometimes closer to the OTHER member's seat).
        const b = m?.behavior === 'chat' && m.inGroupEvent ? m.bubble : null
        if (b && b !== lastBubble) {
          lastBubble = b
          handoverBubbles.push(b)
        }
        const t = m?.groupTarget ? `${m.groupTarget.x},${m.groupTarget.y}` : null
        if (t !== lastTarget) {
          lastTarget = t
          if (t) visits.push(t)
        }
      })

      store.getState().applyMawSnapshot(envelope([
        mawMember('mgr01', 'manager'),
        mawMember('exe01', 'executor', 'awaiting-approval'),
        mawMember('exe02', 'executor', 'awaiting-approval'),
      ], 2))
      vi.advanceTimersByTime(60_000)
      unsubscribe()

      expect(handoverBubbles).toHaveLength(2) // each handover dwelled exactly once
      expect(handoverBubbles[0]).toContain('exe01')
      expect(handoverBubbles[1]).toContain('exe02') // strict order — no interleaved handovers
      expect(visits[visits.length - 1]).toBe(`${MANAGER_GATE.x},${MANAGER_GATE.y}`) // ends at the gate
      expect(useOfficeStore.getState().agents['mgr01~manager'].inGroupEvent).toBe(false)
      for (const id of ['exe01~executor', 'exe02~executor']) {
        const a = useOfficeStore.getState().agents[id]
        expect(a.behavior).toBe('await-approval')
        expect(a.inGroupEvent).toBe(false)
      }
    } finally {
      cleanup()
    }
  })

  it('a second deliverer returns to the seat immediately while the manager is busy on the first handover', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor'), mawMember('exe02', 'executor')]))
      vi.advanceTimersByTime(2_000)
      const seat1 = useOfficeStore.getState().agents['exe01~executor'].position

      store.getState().applyMawSnapshot(envelope([
        mawMember('mgr01', 'manager'),
        mawMember('exe01', 'executor', 'awaiting-approval'),
        mawMember('exe02', 'executor'),
      ], 2))
      vi.advanceTimersByTime(600) // the manager is now on the FIRST handover leg
      expect(near(useOfficeStore.getState().agents['mgr01~manager'].groupTarget, seat1)).toBe(true)

      store.getState().applyMawSnapshot(envelope([
        mawMember('mgr01', 'manager'),
        mawMember('exe01', 'executor', 'awaiting-approval'),
        mawMember('exe02', 'executor', 'awaiting-approval'),
      ], 3))
      vi.advanceTimersByTime(50)
      // exe02's return walk starts WITHOUT waiting behind the manager's queue
      expect(useOfficeStore.getState().agents['exe02~executor'].inGroupEvent).toBe(true)

      vi.advanceTimersByTime(60_000) // everything settles; nothing loops
      const manager = useOfficeStore.getState().agents['mgr01~manager']
      expect(manager.inGroupEvent).toBe(false)
      expect(manager.bubble).toBeNull()
      for (const id of ['exe01~executor', 'exe02~executor']) {
        const a = useOfficeStore.getState().agents[id]
        expect(a.behavior).toBe('await-approval')
        expect(a.inGroupEvent).toBe(false)
      }
    } finally {
      cleanup()
    }
  })

  it('a manager whose first status is awaiting-approval still releases the walk lock at the gate', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager', 'awaiting-approval')]))
      vi.advanceTimersByTime(30_000)
      const m = useOfficeStore.getState().agents['mgr01~manager']
      expect(m.inGroupEvent).toBe(false) // the lock is NOT held forever
      expect(m.groupTarget).toBeNull()
      expect(m.behavior).toBe('await-approval') // the honest status animation, restored
    } finally {
      cleanup()
    }
  })

  it('a stale transition invalidates every pending delayed callback', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'idle'), mawMember('rev01', 'reviewer', 'idle')]))
      vi.advanceTimersByTime(100)
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'working'), mawMember('rev01', 'reviewer', 'working')], 2))
      vi.advanceTimersByTime(100) // exe01 walked (delay 0); rev01's enter is still pending (delay 1500)
      expect(store.getState().agents['exe01~executor'].inGroupEvent).toBe(true)
      const frozen = store.getState().agents['rev01~reviewer']
      expect(frozen.inGroupEvent).toBe(false)

      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, quality: 'stale' } })
      vi.advanceTimersByTime(5_000)
      const after = store.getState().agents['rev01~reviewer']
      expect(after.inGroupEvent).toBe(false) // the stale enter never walked
      expect(after.groupTarget).toBeNull()
      expect(after.position).toEqual(frozen.position)

      // recovery: the swallowed enter RE-dispatches (its recorded phase was rolled
      // back when the generation died) — the reviewer does not stay stranded
      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, quality: 'ok' } })
      vi.advanceTimersByTime(100) // mid-flight: the re-dispatched walk owns the lock again
      expect(store.getState().agents['rev01~reviewer'].inGroupEvent).toBe(true)
      vi.advanceTimersByTime(30_000)
      const settled = store.getState().agents['rev01~reviewer']
      expect(settled.inGroupEvent).toBe(false)
      expect(settled.behavior).toBe('magnifier') // honest working animation restored
    } finally {
      cleanup()
    }
  })

  it('a terminal snapshot invalidates pending delayed callbacks too', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'idle'), mawMember('rev01', 'reviewer', 'idle')]))
      vi.advanceTimersByTime(100)
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'working'), mawMember('rev01', 'reviewer', 'working')], 2))
      vi.advanceTimersByTime(100)
      const frozen = store.getState().agents['rev01~reviewer']

      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, terminal: { status: 'completed' } } })
      vi.advanceTimersByTime(5_000)
      const after = store.getState().agents['rev01~reviewer']
      expect(after.inGroupEvent).toBe(false)
      expect(after.position).toEqual(frozen.position)
    } finally {
      cleanup()
    }
  })

  it('stagger delays are per migration batch, never cumulative across the session', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([
        mawMember('m1x', 'executor', 'idle'),
        mawMember('m2x', 'reviewer', 'idle'),
        mawMember('m3x', 'decision-maker', 'idle'),
        mawMember('m4x', 'reviewer', 'idle'),
      ]))
      vi.advanceTimersByTime(100)
      // batch 1: m1x enters at 0ms, m2x at 1500ms
      store.getState().applyMawSnapshot(envelope([
        mawMember('m1x', 'executor', 'working'),
        mawMember('m2x', 'reviewer', 'working'),
        mawMember('m3x', 'decision-maker', 'idle'),
        mawMember('m4x', 'reviewer', 'idle'),
      ], 2))
      vi.advanceTimersByTime(100)
      expect(store.getState().agents['m1x~executor'].inGroupEvent).toBe(true)
      expect(store.getState().agents['m2x~reviewer'].inGroupEvent).toBe(false) // still waiting on 1500ms

      // batch 2 at t=200ms: with cumulative stagger m3x would owe 2×1500ms —
      // per-batch it walks at 0ms.
      store.getState().applyMawSnapshot(envelope([
        mawMember('m1x', 'executor', 'working'),
        mawMember('m2x', 'reviewer', 'working'),
        mawMember('m3x', 'decision-maker', 'working'),
        mawMember('m4x', 'reviewer', 'working'),
      ], 3))
      vi.advanceTimersByTime(50)
      expect(store.getState().agents['m3x~decision-maker'].inGroupEvent).toBe(true) // walked without the batch-1 debt
      expect(store.getState().agents['m4x~reviewer'].inGroupEvent).toBe(false) // its own batch slot is 1500ms
      expect(store.getState().agents['m2x~reviewer'].inGroupEvent).toBe(false) // fires at t≈1600ms, unchanged

      vi.advanceTimersByTime(1_600)
      expect(store.getState().agents['m2x~reviewer'].inGroupEvent).toBe(true)
      expect(store.getState().agents['m4x~reviewer'].inGroupEvent).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('a cancellation snapshot reaps an in-flight walk: the lock drops and the animation is status-honest', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'idle')]))
      vi.advanceTimersByTime(100)
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'working')], 2))
      vi.advanceTimersByTime(100)
      expect(store.getState().agents['exe01~executor'].inGroupEvent).toBe(true) // enter walk in flight

      // cancellation: terminal + blocked in the SAME task phase — no new walk is
      // scheduled, so the old generation's walk must be reaped right here
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'blocked')], 3))
      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, terminal: { status: 'cancelled' } } })
      vi.advanceTimersByTime(25_000)
      const a = store.getState().agents['exe01~executor']
      expect(a.inGroupEvent).toBe(false) // the walk lock did NOT outlive the cancellation
      expect(a.groupTarget).toBeNull()
      expect(a.behavior).toBe('scratch-head') // blocked is honest, not the walk's transit/typing
      expect(a.expression).toBe('confused')
    } finally {
      cleanup()
    }
  })

  it('a stale-died enter re-dispatches even when older delayed callbacks interleave', () => {
    // Rapid rest/task toggles stack several pendingEnter records for ONE member.
    // An older callback firing late used to delete the NEWER record (unconditional
    // delete), so the stale reap could not roll that walk back and recovery
    // stranded the member at the work seat (review P2 regression).
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([
        mawMember('m1x', 'executor', 'working'),
        mawMember('m2x', 'executor', 'working'),
        mawMember('m3x', 'executor', 'working'),
        mawMember('rev01', 'reviewer', 'working'),
      ]))
      vi.advanceTimersByTime(2_000) // rev01's old enter is pending at +4500ms
      store.getState().applyMawSnapshot(envelope([
        mawMember('m1x', 'executor', 'working'),
        mawMember('m2x', 'executor', 'idle'),
        mawMember('m3x', 'executor', 'idle'),
        mawMember('rev01', 'reviewer', 'idle'),
      ], 2)) // newer pending walk (back to rest) at +3000ms — created BEFORE the old fires
      vi.advanceTimersByTime(2_700) // t≈4700: the OLD callback (4500ms) fired ACROSS the newer record (callback at 5000ms)
      expect(store.getState().agents['rev01~reviewer'].inGroupEvent).toBe(false)

      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, quality: 'stale' } })
      vi.advanceTimersByTime(100) // stale cancels the pending rest walk
      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, quality: 'ok' } })
      vi.advanceTimersByTime(30_000)

      const settled = store.getState().agents['rev01~reviewer']
      const restSeat = restSeatFor('rev01~reviewer').seat
      expect(settled.inGroupEvent).toBe(false)
      expect(settled.position).toEqual(restSeat) // recovery re-dispatched the swallowed rest walk
      expect(settled.behavior).toBe('idle')
    } finally {
      cleanup()
    }
  })

  it('a member who finishes walks to their stable rest seat and the rest animation is honest', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'working')]))
      vi.advanceTimersByTime(2_000)

      store.getState().applyMawSnapshot(envelope([mawMember('exe01', 'executor', 'done')], 2))
      vi.advanceTimersByTime(20_000)
      const resting = useOfficeStore.getState().agents['exe01~executor']
      expect(resting.inGroupEvent).toBe(false) // the rest walk released the lock
      expect(resting.behavior).toBe('idle')
      expect(resting.expression).toBe('happy') // done rests happy
    } finally {
      cleanup()
    }
  })

  it('a stale interruption leaves nothing behind: locks released, queue reset, handover resumes on recovery', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor')]))
      vi.advanceTimersByTime(2_000)
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'awaiting-approval')], 2))
      vi.advanceTimersByTime(1_000)
      expect(useOfficeStore.getState().agents['mgr01~manager'].inGroupEvent).toBe(true) // mid-handover

      // stale hits MID-handover: the interrupted generation must not leave the
      // manager chat/locked/busy
      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, quality: 'stale' } })
      vi.advanceTimersByTime(100)
      const mgr = useOfficeStore.getState().agents['mgr01~manager']
      expect(mgr.inGroupEvent).toBe(false) // walk lock released
      expect(mgr.groupTarget).toBeNull()
      expect(mgr.behavior).toBe('idle') // honest rest, no chat animation residue

      // recovery: a fresh delivery re-dispatches (busy flag was reset, latch cleared)
      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, quality: 'ok' } })
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'working')], 3))
      vi.advanceTimersByTime(100)
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'awaiting-approval')], 4))
      vi.advanceTimersByTime(30_000)
      const done = useOfficeStore.getState().agents['mgr01~manager']
      expect(done.inGroupEvent).toBe(false) // the recovered handover completed
      expect(done.groupTarget).toBeNull()
      for (const id of ['mgr01~manager']) {
        expect(useOfficeStore.getState().agents[id].behavior).toBe('gantt-chart')
      }
    } finally {
      cleanup()
    }
  })

  it('the manager walking away mid-dwell cannot have the new journey clobbered by the old dwell callback', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor')]))
      vi.advanceTimersByTime(2_000)
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'awaiting-approval')], 2))
      vi.advanceTimersByTime(4_000) // arrival + INTO the 3s dwell
      expect(useOfficeStore.getState().agents['mgr01~manager'].behavior).toBe('chat')

      // terminal + manager done: the manager starts its own walk home — a NEW
      // journey superseding the dwell
      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, terminal: { status: 'completed' } } })
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager', 'done'), mawMember('exe01', 'executor', 'done')], 3))
      vi.advanceTimersByTime(30_000)
      const mgr = useOfficeStore.getState().agents['mgr01~manager']
      expect(mgr.inGroupEvent).toBe(false) // the rest walk completed and released — not clobbered mid-flight
      expect(mgr.behavior).toBe('idle')
      expect(mgr.expression).toBe('happy')

      // and the queue did not wedge: a later cycle still dispatches handovers
      useOfficeStore.setState({ mawMeta: { ...useOfficeStore.getState().mawMeta, terminal: null } })
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'working')], 4))
      vi.advanceTimersByTime(2_000)
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'awaiting-approval')], 5))
      vi.advanceTimersByTime(30_000)
      expect(useOfficeStore.getState().agents['mgr01~manager'].inGroupEvent).toBe(false)
      expect(useOfficeStore.getState().agents['mgr01~manager'].behavior).toBe('gantt-chart')
    } finally {
      cleanup()
    }
  })

  it('the final walk timeout releases the queue instead of wedging managerBusy', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    // NO walker: the manager's handover walk can never physically complete
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor')]))
      vi.advanceTimersByTime(2_000)
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'awaiting-approval')], 2))
      vi.advanceTimersByTime(90_000) // timeout + 3 re-issues, all fruitless
      const bailed = useOfficeStore.getState().agents['mgr01~manager']
      expect(bailed.inGroupEvent).toBe(false) // the bail released the lock (no chained leg)

      // the queue must NOT be wedged: a later delivery still dispatches the manager
      installWalker(store) // now walks complete
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'working')], 3))
      vi.advanceTimersByTime(100)
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'awaiting-approval')], 4))
      vi.advanceTimersByTime(30_000)
      const done = useOfficeStore.getState().agents['mgr01~manager']
      expect(done.inGroupEvent).toBe(false) // the recovered handover ran to completion
      expect(done.behavior).toBe('gantt-chart')
    } finally {
      cleanup()
    }
  })

  it('the settle check follows the PUBLISHED walk target when avoidOverlap moves it', () => {
    const store = useOfficeStore
    const cleanup = startMawChoreography(store)
    installWalker(store)
    try {
      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor'), mawMember('exe02', 'executor')]))
      vi.advanceTimersByTime(2_000)
      const seat1 = useOfficeStore.getState().agents['exe01~executor'].position
      // exe02 parks right next to exe01's seat: the deliverer's walk target gets
      // side-stepped by avoidOverlap — the OLD check (8px around the nominal seat)
      // would never see the member settled and drop the handover after 20s.
      useOfficeStore.setState({ agents: { ...useOfficeStore.getState().agents, 'exe02~executor': { ...useOfficeStore.getState().agents['exe02~executor'], position: { x: seat1.x + 34, y: seat1.y } } } })

      store.getState().applyMawSnapshot(envelope([mawMember('mgr01', 'manager'), mawMember('exe01', 'executor', 'awaiting-approval'), mawMember('exe02', 'executor')], 2))
      vi.advanceTimersByTime(25_000) // member walk + settle + manager visit + dwell + return
      const mgr = useOfficeStore.getState().agents['mgr01~manager']
      expect(mgr.inGroupEvent).toBe(false) // the handover was NOT dropped — it completed
      expect(useOfficeStore.getState().agents['exe01~executor'].behavior).toBe('await-approval')
      expect(useOfficeStore.getState().agents['exe02~executor'].behavior).toBe('typing') // untouched, honest
    } finally {
      cleanup()
    }
  })
})

function inRect(point, rect) {
  return point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2
}
