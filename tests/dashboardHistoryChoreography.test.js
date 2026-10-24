import { describe, expect, it } from 'vitest'
import { buildHistoryPresentation, historyCue, historyStage, sampleHistoryPresentation } from '../src/inference/dashboardHistoryChoreography.js'
import { calculateJourney, isOnFloor, isOnObstacle } from '../src/systems/movementSystem.js'

const members = [{ id: 'dev', role: 'executor' }, { id: 'rev', role: 'reviewer' }]
const agents = Object.fromEntries(members.map((member, i) => [`${member.id}~${member.role}`, {
  id: `${member.id}~${member.role}`, mawMember: true, status: 'idle', position: { x: 650 + i * 45, y: 300 },
  maw: { key: member.id, role: member.role, workSeat: { x: 340 + i * 120, y: 364 }, verdict: null },
}]))
function step(activity = 'work', actor = 'dev', overrides = {}) {
  const task = { seq: activity === 'rework' ? 2 : 1, round: activity === 'rework' ? 2 : 1,
    type: actor === 'rev' ? 'review' : 'dev',
    source_ref: `${actor === 'rev' ? 'reviewer' : 'executor'}-1/task-${activity === 'rework' ? '002' : '001'}.json`,
    ref_task: activity === 'rework' ? 'executor-1/task-001.json' : null }
  return { id: 'event', snapshot: { members: members.map((member) => member.id === actor ? { ...member,
    status: ({ ready: 'idle', publication: 'planning', work: 'working', delivery: 'awaiting-approval', result: 'done', rework: 'planning', coordination: 'working' })[activity],
    task_kind: task.type, round: task.round, verdict: activity === 'result' ? 'pass' : null } : { ...member, status: 'idle' }) }, cue: { actor_member_id: actor, activity,
    task,
    related_member_ids: [], ...overrides } }
}
const context = (reason = 'step', position_ms = 0) => ({ reason, position_ms, index: 0 })
const progress = (step_elapsed_ms, extras = {}) => ({ step_elapsed_ms, locating: false, ...extras })

describe('Evidence-bound history presentation', () => {
  it('binds only the declared actor and changes role gestures without changing facts', () => {
    const original = JSON.stringify(agents)
    const plan = buildHistoryPresentation(step(), agents, {}, context())
    const scene = sampleHistoryPresentation(plan, progress(2000))
    expect(scene.agents['dev~executor']).toMatchObject({ active: true, behavior: 'typing' })
    expect(scene.agents['rev~reviewer']).toMatchObject({ active: false, behavior: 'idle', expression: 'normal' })
    expect(JSON.stringify(agents)).toBe(original)
    const review = sampleHistoryPresentation(buildHistoryPresentation(step('work', 'rev'), agents, {}, context()), progress(2000))
    expect(review.stage).toBe('评审记录')
    expect(review.agents['rev~reviewer'].behavior).toBe('magnifier')
  })

  it.each([['ready', 'thumbs-up'], ['publication', 'reading-screen'], ['delivery', 'pass-document'],
    ['result', 'thumbs-up'], ['rework', 'writing-notes'], ['coordination', 'gantt-chart']])('%s has a distinct recorded gesture', (activity, behavior) => {
    const scene = sampleHistoryPresentation(buildHistoryPresentation(step(activity), agents, {}, context()), progress(3800))
    expect(scene.agents['dev~executor'].behavior).toBe(behavior)
  })

  it('retains a failed reviewer result as a completed review, not invented developer work', () => {
    const reviewer = { ...agents['rev~reviewer'], status: 'done', maw: { ...agents['rev~reviewer'].maw, verdict: 'fail' } }
    const scene = sampleHistoryPresentation(buildHistoryPresentation(step('result', 'rev'), { ...agents, 'rev~reviewer': reviewer }, {}, context()), progress(2000))
    expect(scene.agents['rev~reviewer']).toMatchObject({ behavior: 'scratch-head', expression: 'confused' })
    expect(reviewer.status).toBe('done')
    expect(scene.agents['dev~executor'].behavior).toBe('idle')
  })

  it('rejects malformed cues into neutral presentation instead of guessing from labels or stale facts', () => {
    for (const cue of [undefined, { ...step().cue, activity: 'invented' }, { ...step().cue, actor_member_id: 'missing' },
      { ...step().cue, related_member_ids: ['dev'] }, { ...step().cue, related_member_ids: ['rev', 'rev'] },
      { ...step().cue, task: { ...step().cue.task, source_ref: '../private.json' } },
      { ...step().cue, task: { ...step().cue.task, ref_task: `executor-1/task-${'1'.repeat(130)}.json` } },
      { ...step().cue, task: { ...step().cue.task, ref_task: undefined } }]) {
      const record = { ...step(), label: 'working pass complete', cue }
      expect(historyCue(record)).toBeNull()
      const scene = sampleHistoryPresentation(buildHistoryPresentation(record, agents, {}, context()), progress(2000))
      expect(Object.values(scene.agents).every((agent) => agent.behavior === 'idle' && !agent.active)).toBe(true)
    }
  })

  it('validates explicit related task identity and keeps terminal a neutral global conclusion', () => {
    const record = step('publication', 'rev', { related_member_ids: ['dev'],
      task: { seq: 2, round: 1, type: 'review', source_ref: 'reviewer-1/task-002.json', ref_task: 'executor-1/task-001.json' } })
    expect(historyCue(record)).not.toBeNull()
    const scene = sampleHistoryPresentation(buildHistoryPresentation(record, agents, {}, context()), progress(2000))
    expect(scene.agents['dev~executor'].related).toBe(true)
    expect(scene.agents['dev~executor'].active).toBe(false)
    expect(historyStage({ ...record, snapshot: { ...record.snapshot, terminal: 'completed' }, cue: { actor_member_id: null, activity: 'terminal', task: null, related_member_ids: [] } })).toBe('终局记录')
  })

  it('does not turn an inconsistent work or result cue into an unrecorded action or positive conclusion', () => {
    const work = step('work')
    work.snapshot.members[0].status = 'idle'
    expect(historyCue(work)).toBeNull()
    const result = step('result')
    result.snapshot.members[0].verdict = null
    expect(historyCue(result)).toBeNull()
  })

  it('rejects reference-role mismatches without decoding opaque member identities or labels', () => {
    const valid = step('rework', 'dev', { related_member_ids: ['rev'] })
    expect(valid.cue.task.ref_task).toBe('executor-1/task-001.json')
    expect(historyCue(valid)).toBeNull()
    const malformedActor = step('coordination', 'dev')
    malformedActor.cue.task.source_ref = 'reviewer-1/task-001.json'
    expect(historyCue(malformedActor)).toBeNull()
    const permitted = step('publication', 'rev', { related_member_ids: ['dev'],
      task: { seq: 2, round: 1, type: 'review', source_ref: 'reviewer-1/task-002.json', ref_task: 'executor-1/task-001.json' } })
    expect(historyCue(permitted)).not.toBeNull()
  })
})

describe('Continuous display positions', () => {
  it('rebuilds identical cross-room plans without borrowing live random jitter', () => {
    const from = { 'dev~executor': { x: 700, y: 300 }, 'rev~reviewer': { x: 710, y: 350 } }
    const record = step('publication')
    expect(buildHistoryPresentation(record, agents, from, context())).toEqual(buildHistoryPresentation(record, agents, from, context()))
    expect(buildHistoryPresentation(record, agents, from, context('seek', 2000)))
      .toEqual(buildHistoryPresentation(record, agents, from, context('seek', 2000)))
  })

  it('keeps the two-argument live journey API and its door/floor geometry compatible', () => {
    const from = { x: 700, y: 300 }, to = { x: 340, y: 364 }
    const live = calculateJourney(from, to)
    let calls = 0
    const stable = calculateJourney(from, to, { random: () => { calls += 1; return 0.5 } })
    expect(calls).toBeGreaterThan(0)
    expect(live.doorIds).toEqual(stable.doorIds)
    expect(live.doorClear).toEqual(stable.doorClear)
    expect(live.waypoints.at(-1)).toEqual(to)
    expect(stable.waypoints.at(-1)).toEqual(to)
    for (const p of [...live.waypoints, ...stable.waypoints]) {
      expect(isOnFloor(p.x, p.y)).toBe(true)
      expect(isOnObstacle(p.x, p.y)).toBe(false)
    }
  })

  it('starts exactly at the prior visible point, moves continuously and reaches its seat', () => {
    const from = { 'dev~executor': { x: 700, y: 300 }, 'rev~reviewer': { x: 710, y: 350 } }
    const plan = buildHistoryPresentation(step(), agents, from, context())
    const sample = (t) => sampleHistoryPresentation(plan, progress(t)).agents['dev~executor'].position
    expect(sample(0)).toMatchObject(from['dev~executor'])
    expect(sample(600)).not.toMatchObject(from['dev~executor'])
    expect(sample(1200)).toMatchObject(agents['dev~executor'].maw.workSeat)
    expect(Math.hypot(sample(601).x - sample(600).x, sample(601).y - sample(600).y)).toBeLessThan(2)
    expect(sampleHistoryPresentation(plan, progress(600))).toEqual(sampleHistoryPresentation(plan, progress(600)))
  })

  it('seeks from the current visible position and converges without a boundary jump', () => {
    const from = { 'dev~executor': { x: 650, y: 300 } }
    const plan = buildHistoryPresentation(step('delivery'), agents, from, context('seek', 2000))
    const sample = (t, locating = true) => sampleHistoryPresentation(plan, progress(2000, { locating, transition_elapsed_ms: t })).agents['dev~executor'].position
    expect(sample(0)).toMatchObject(from['dev~executor'])
    expect(sample(250)).not.toMatchObject(from['dev~executor'])
    expect(sample(500).x).toBeCloseTo(sample(500, false).x, 8)
    expect(sample(500).y).toBeCloseTo(sample(500, false).y, 8)
    const before = sample(499), after = sample(500, false)
    expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(1)
  })

  it('holds last visible coordinates at natural end instead of snapping into rebuilt final seats', () => {
    const final = step('work')
    final.snapshot.terminal = 'completed'
    final.cue = { actor_member_id: null, activity: 'terminal', task: null, related_member_ids: [] }
    const from = { 'dev~executor': { x: 333.3, y: 322.2 } }
    const plan = buildHistoryPresentation(final, agents, from, context('end', 4000))
    const scene = sampleHistoryPresentation(plan, progress(4000))
    expect(scene.agents['dev~executor'].position).toMatchObject(from['dev~executor'])
    expect(scene.agents['dev~executor'].behavior).toBe('idle')
  })
})
