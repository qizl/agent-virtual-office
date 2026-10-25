import { describe, expect, it } from 'vitest'
import { buildHistoryPresentation, historyCue, historyStage, prepareHistoryTimeline, sampleHistoryPresentation } from '../src/inference/dashboardHistoryChoreography.js'
import { calculateJourney, isOnFloor, isOnObstacle } from '../src/systems/movementSystem.js'
import { mawHandoffId } from '../src/inference/dashboardSnapshot.js'

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

function handoffStep(kind = 'submission') {
  const devTask = { seq: 1, round: 1, type: 'dev', source_ref: 'executor-1/task-001.json', ref_task: null }
  const reviewTask = { seq: 2, round: 1, type: 'review', source_ref: 'reviewer-1/task-002.json', ref_task: devTask.source_ref }
  const result = kind === 'review-result'
  return { id: 'verified-handoff', snapshot: { handoff_state: 'complete', members: [
    { id: 'dev', role: 'executor', status: 'awaiting-approval', task_kind: 'dev', round: 1, current_task: devTask },
    { id: 'rev', role: 'reviewer', status: result ? 'done' : 'planning', task_kind: 'review', round: 1,
      verdict: result ? 'fail' : null, current_task: reviewTask },
  ] }, cue: { actor_member_id: 'rev', activity: result ? 'result' : 'publication', task: reviewTask,
    related_member_ids: ['dev'], handoff: { id: mawHandoffId(kind, result ? 'rev' : 'dev', result ? 'dev' : 'rev',
      result ? reviewTask.source_ref : devTask.source_ref, result ? devTask.source_ref : reviewTask.source_ref), kind, sender_member_id: result ? 'rev' : 'dev',
      recipient_member_id: result ? 'dev' : 'rev', source_task: result ? reviewTask.source_ref : devTask.source_ref,
      target_task: result ? devTask.source_ref : reviewTask.source_ref } } }
}

describe('Compiled handoff timeline', () => {
  it('uses exact task owners, walks to the recipient, converses for three seconds and returns without teleporting', () => {
    const record = handoffStep()
    expect(historyCue(record)).not.toBeNull()
    const timeline = prepareHistoryTimeline([record], agents)
    const plan = timeline.plans[0]
    expect(timeline.starts).toEqual([0])
    expect(timeline.duration_ms).toBeGreaterThan(4000)
    expect(timeline.duration_ms).toBeLessThanOrEqual(60000)
    expect(plan.handoff).toMatchObject({ sender: 'dev~executor', recipient: 'rev~reviewer' })
    expect(plan.handoff.talk_end_ms - plan.handoff.talk_start_ms).toBe(3000)
    const sample = (t) => sampleHistoryPresentation(plan, progress(t))
    const approach = sample(plan.handoff.talk_start_ms)
    expect(approach.agents['dev~executor']).toMatchObject({ behavior: 'chat', isMoving: false })
    expect(approach.agents['rev~reviewer']).toMatchObject({ behavior: 'chat', isMoving: false })
    expect(approach.agents['rev~reviewer'].position).toMatchObject(agents['rev~reviewer'].maw.workSeat)
    expect(Math.hypot(approach.agents['dev~executor'].position.x - approach.agents['rev~reviewer'].position.x,
      approach.agents['dev~executor'].position.y - approach.agents['rev~reviewer'].position.y)).toBeGreaterThanOrEqual(32)
    expect(approach.agents['dev~executor'].facing).not.toBe(approach.agents['rev~reviewer'].facing)
    for (const t of [1, plan.handoff.talk_start_ms, plan.handoff.talk_end_ms, plan.duration_ms]) {
      for (const id of Object.keys(agents)) {
        const before = sample(Math.max(0, t - 1)).agents[id].position, after = sample(t).agents[id].position
        expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(1)
      }
    }
    expect(sample(plan.duration_ms).agents['dev~executor'].position).toMatchObject(agents['dev~executor'].maw.workSeat)
    expect(plan.entries['dev~executor'].segments[0].end_ms).toBeCloseTo(plan.entries['dev~executor'].segments[0].distance / 60 * 1000, -1)
  })

  it('samples one causal plan for normal playback, reverse seeks and repeat compilation', () => {
    const early = step('work')
    early.snapshot.members = [early.snapshot.members[0]]
    const records = [early, handoffStep(), handoffStep('review-result')]
    records[2].id = 'review-failed'
    const timeline = prepareHistoryTimeline(records, agents)
    expect(prepareHistoryTimeline(records, agents)).toEqual(timeline)
    expect(timeline.plans[0].entries['rev~reviewer']).toBeUndefined()
    const plan = timeline.plans[1], t = plan.handoff.talk_start_ms + 1500
    const target = sampleHistoryPresentation(plan, progress(t))
    const prior = Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, a.position]))
    const seek = buildHistoryPresentation(records[1], agents, prior, { reason: 'seek', index: 1,
      position_ms: timeline.starts[1] + t, step_start_ms: timeline.starts[1], step_duration_ms: plan.duration_ms, plan })
    expect(sampleHistoryPresentation(seek, progress(t, { locating: true, transition_elapsed_ms: 0 })).agents['dev~executor'].position).toMatchObject(prior['dev~executor'])
    const located = sampleHistoryPresentation(seek, progress(t, { locating: true, transition_elapsed_ms: 500 }))
    expect(located.agents['dev~executor'].position.x).toBeCloseTo(target.agents['dev~executor'].position.x)
    expect(located.agents['dev~executor'].position.y).toBeCloseTo(target.agents['dev~executor'].position.y)
    expect(sampleHistoryPresentation(seek, progress(t))).toEqual(target)
    const restart = buildHistoryPresentation(early, agents, prior, { reason: 'restart', index: 0, position_ms: 0,
      step_start_ms: 0, plan: timeline.plans[0] })
    expect(sampleHistoryPresentation(restart, progress(0))).toEqual(sampleHistoryPresentation(timeline.plans[0], progress(0)))
    const failed = sampleHistoryPresentation(timeline.plans[2], progress(timeline.plans[2].duration_ms))
    expect(failed.agents['rev~reviewer']).toMatchObject({ behavior: 'scratch-head', expression: 'confused' })
  })

  it('includes terminal return home in the last recorded step and seeks along that same route', () => {
    const office = structuredClone(agents)
    office['dev~executor'].maw.restSeat = { x: 650, y: 300 }
    office['rev~reviewer'].maw.restSeat = { x: 695, y: 300 }
    const record = step('work')
    const finalSnapshot = { terminal: 'completed', members: [
      { id: 'dev', status: 'done' }, { id: 'rev', status: 'idle' },
    ] }
    const timeline = prepareHistoryTimeline([record], office, finalSnapshot)
    const plan = timeline.plans[0]
    expect(plan.terminal_start_ms).toBeGreaterThan(0)
    expect(plan.duration_ms).toBeGreaterThan(plan.terminal_start_ms)
    expect(plan.duration_ms).toBeLessThanOrEqual(60_000)

    const terminalStep = { ...record, snapshot: finalSnapshot,
      cue: { actor_member_id: null, activity: 'terminal', task: null, related_member_ids: [] } }
    const visible = { 'dev~executor': { x: 490, y: 300 }, 'rev~reviewer': { x: 520, y: 300 } }
    const seek = buildHistoryPresentation(terminalStep, office, visible, { reason: 'seek', index: 0,
      position_ms: timeline.duration_ms, step_start_ms: 0, step_duration_ms: plan.duration_ms, plan })
    const sample = (transition_elapsed_ms, locating = true) => sampleHistoryPresentation(seek,
      progress(plan.duration_ms, { locating, transition_elapsed_ms }))
    expect(sample(0).agents['dev~executor']).toMatchObject({ position: visible['dev~executor'], isMoving: true })
    const arrived = sample(500)
    expect(arrived.agents['dev~executor'].position).toMatchObject(office['dev~executor'].maw.restSeat)
    expect(arrived.agents['dev~executor'].behavior).toBe('idle')
    expect(arrived.agents['dev~executor'].isMoving).toBe(false)
    expect(sample(500, false).agents['dev~executor'].position).toEqual(arrived.agents['dev~executor'].position)
  })

  it('degrades terminal return routes that exceed the per-step budget', () => {
    const office = structuredClone(agents)
    office['dev~executor'].position = { x: 340, y: 364 }
    office['dev~executor'].maw.workSeat = { x: 340, y: 364 }
    office['dev~executor'].maw.restSeat = { x: 10_000, y: 10_000 }
    const finalSnapshot = { terminal: 'completed', members: [{ id: 'dev', status: 'done' }] }

    const timeline = prepareHistoryTimeline([step('work')], office, finalSnapshot)
    const plan = timeline.plans[0]

    expect(timeline.warnings).toContain('history-animation-incomplete')
    expect(timeline.duration_ms).toBe(4000)
    expect(plan.duration_ms).toBe(4000)
    expect(plan.terminal_start_ms).toBeUndefined()
    expect(plan.finalSnapshot).toBeUndefined()
    expect(plan.stage).toBe('记录回顾 · 动画时轴不完整')
    expect(plan.entries['dev~executor'].segments).toHaveLength(1)
  })

  it('rejects a timeline that exceeds the validated input limit', () => {
    const records = Array.from({ length: 201 }, (_, index) => {
      const record = step(index % 2 === 0 ? 'result' : 'work')
      record.id = `event-${index}`
      return record
    })

    expect(() => prepareHistoryTimeline(records, agents)).toThrowError('history-timeline-invalid')
  })

  it('accepts the validated maximum of 200 timeline steps within the duration bound', () => {
    const records = Array.from({ length: 200 }, (_, index) => {
      const record = step(index % 2 === 0 ? 'result' : 'work')
      record.id = `near-limit-${index}`
      return record
    })

    const timeline = prepareHistoryTimeline(records, agents)

    expect(timeline.plans).toHaveLength(200)
    expect(timeline.duration_ms).toBeLessThanOrEqual(12_000_000)
    expect(timeline.starts.at(-1) + timeline.plans.at(-1).duration_ms).toBe(timeline.duration_ms)
    expect(timeline.plans.every((plan) => plan.duration_ms >= 4000 && plan.duration_ms <= 60_000)).toBe(true)
    for (let index = 1; index < timeline.plans.length; index += 1) {
      const previous = timeline.plans[index - 1], next = timeline.plans[index]
      for (const id of Object.keys(previous.entries)) {
        const end = sampleHistoryPresentation(previous, progress(previous.duration_ms)).agents[id].position
        const start = sampleHistoryPresentation(next, progress(0)).agents[id].position
        expect(start.x).toBeCloseTo(end.x, 10)
        expect(start.y).toBeCloseTo(end.y, 10)
      }
    }
  })

  it('keeps a 200-step timeline continuous when its final terminal return must degrade', () => {
    const office = structuredClone(agents)
    office['dev~executor'].position = { ...office['dev~executor'].maw.workSeat }
    office['dev~executor'].maw.restSeat = { x: 10_000, y: 10_000 }
    const records = Array.from({ length: 200 }, (_, index) => ({ ...step('work'), id: `terminal-limit-${index}` }))
    const finalSnapshot = { terminal: 'completed', members: [{ id: 'dev', status: 'done' }] }

    const timeline = prepareHistoryTimeline(records, office, finalSnapshot)
    const previous = timeline.plans.at(-2), last = timeline.plans.at(-1)

    expect(timeline.warnings).toContain('history-animation-incomplete')
    expect(timeline.duration_ms).toBe(800_000)
    expect(timeline.plans.slice(0, -1).every((plan) => plan.stage === '执行记录')).toBe(true)
    expect(last).toMatchObject({ duration_ms: 4000, stage: '记录回顾 · 动画时轴不完整', cue: null, handoff: null })
    expect(last.terminal_start_ms).toBeUndefined()
    expect(last.finalSnapshot).toBeUndefined()
    const end = sampleHistoryPresentation(previous, progress(previous.duration_ms)).agents['dev~executor'].position
    expect(sampleHistoryPresentation(last, progress(0)).agents['dev~executor'].position).toEqual(end)
    expect(sampleHistoryPresentation(last, progress(4000)).agents['dev~executor'].position).toEqual(end)
  })

  it('rejects corrupt, cross-task, future or unavailable handoffs and degrades over-budget paths honestly', () => {
    for (const mutate of [
      (r) => { r.cue.handoff.recipient_member_id = 'missing' },
      (r) => { r.cue.handoff.source_task = '../task.json' },
      (r) => { r.cue.handoff.id = 'unsafe/id' },
      (r) => { r.cue.handoff.target_task = 'reviewer-2/task-002.json' },
      (r) => { r.snapshot.members[1].current_task.ref_task = 'executor-2/task-001.json' },
      (r) => { r.snapshot.members.pop() },
      (r) => { r.snapshot.handoff_state = 'unavailable' },
    ]) {
      const record = handoffStep(); mutate(record)
      const timeline = prepareHistoryTimeline([record], agents)
      expect(timeline.plans[0].handoff).toBeNull()
    }
    const distant = structuredClone(agents)
    distant['dev~executor'].position = { x: 10_000, y: 10_000 }
    const limited = prepareHistoryTimeline([handoffStep()], distant)
    expect(limited.warnings).toContain('history-animation-incomplete')
    expect(limited.plans[0].handoff).toBeNull()
    expect(limited.plans[0].duration_ms).toBe(4000)
    const stationary = structuredClone(agents)
    for (const agent of Object.values(stationary)) agent.position = { ...agent.maw.workSeat }
    expect(prepareHistoryTimeline([step(), step()], stationary).duration_ms).toBe(8000)
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
