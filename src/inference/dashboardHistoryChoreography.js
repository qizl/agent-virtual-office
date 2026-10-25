// Recorded facts and illustrative motion stay separate. This module has no clock,
// store writes, live queues or inferred activity; its caller owns elapsed display time.
import { calculateJourney, calcFacing } from '../systems/movementSystem.js'
import { clampToVisible, MAW_ROLE_WORK_BEHAVIOR } from '../systems/mawChoreography.js'
import { handoffApproachPoint } from '../systems/mawHandoff.js'
import { validateMawHandoff } from './dashboardSnapshot.js'

export const HISTORY_ACTIVITIES = ['ready', 'publication', 'work', 'delivery', 'result', 'rework', 'coordination', 'terminal']
const TASK_TYPES = ['dev', 'plan-review', 'review', 'aggregate-review']
const TASK_REF = /^(decision-maker|executor|reviewer)-[0-9]+\/task-([0-9]{3,})\.json$/
const LABELS = { ready: '就绪确认', publication: '任务派发', work: '执行记录', delivery: '交付记录',
  result: '结果记录', rework: '返修派发', coordination: '流程协调', terminal: '终局记录' }
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v) => Number.isSafeInteger(v) && v >= 1
const point = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
const clamp = (n) => Math.max(0, Math.min(1, n))
const ease = (n) => { const t = clamp(n); return t * t * (3 - 2 * t) }
const fixedRouteRandom = () => 0.5
export const HISTORY_MAX_STEP_MS = 60_000
export const HISTORY_MAX_TOTAL_MS = 12_000_000
export const HISTORY_MAX_STEPS = 200
const HISTORY_WALK_SPEED = 60
const HANDOFF_TALK_MS = 3000

/** Malformed or older cues are neutral, never guessed from prose or snapshot deltas. */
export function historyCue(step) {
  const cue = step?.cue
  if (!object(cue) || Object.keys(cue).some((key) => !['actor_member_id', 'activity', 'task', 'related_member_ids', 'handoff'].includes(key))
    || !HISTORY_ACTIVITIES.includes(cue.activity) || !Array.isArray(cue.related_member_ids)
    || cue.related_member_ids.length > 1) return null
  const ids = new Set(step.snapshot?.members?.map((m) => m.id) || [])
  if (cue.actor_member_id !== null && !ids.has(cue.actor_member_id)) return null
  if (cue.related_member_ids.some((id) => !ids.has(id) || id === cue.actor_member_id)) return null
  const task = cue.task
  if (task !== null && (!object(task)
    || Object.keys(task).some((key) => !['seq', 'round', 'type', 'source_ref', 'ref_task'].includes(key))
    || !integer(task.seq) || !integer(task.round) || !TASK_TYPES.includes(task.type)
    || typeof task.source_ref !== 'string' || task.source_ref.length > 128 || !TASK_REF.test(task.source_ref)
    || Number(task.source_ref.match(TASK_REF)[2]) !== task.seq
    || (task.ref_task !== null && (typeof task.ref_task !== 'string' || task.ref_task.length > 128 || !TASK_REF.test(task.ref_task))))) return null
  const actor = step.snapshot?.members?.find((member) => member.id === cue.actor_member_id)
  if (task && (!actor || task.source_ref.match(TASK_REF)[1] !== actor.role)) return null
  if (['publication', 'work', 'delivery', 'result', 'rework'].includes(cue.activity)) {
    if (!actor || !task || actor.task_kind !== task.type || actor.round !== task.round) return null
    if (cue.activity === 'work' && actor.status !== 'working') return null
    if (cue.activity === 'delivery' && actor.status !== 'awaiting-approval') return null
    if (['publication', 'rework'].includes(cue.activity) && actor.status !== 'planning') return null
    if (cue.activity === 'result' && (!['pass', 'fail'].includes(actor.verdict)
      || actor.status !== (task.type === 'dev' && actor.verdict === 'fail' ? 'blocked' : 'done'))) return null
    if (cue.activity === 'rework' && (task.type !== 'dev' || task.round < 2 || !task.ref_task)) return null
  }
  if (cue.related_member_ids.length) {
    const related = step.snapshot?.members?.find((member) => member.id === cue.related_member_ids[0])
    if (!cue.handoff && (!task?.ref_task || task.ref_task.match(TASK_REF)[1] !== related?.role)) return null
  }
  if (cue.activity === 'ready' && (!actor || actor.status !== 'idle')) return null
  if (cue.activity === 'terminal' && !step.snapshot?.terminal) return null
  if (cue.handoff !== undefined) {
    const handoff = cue.handoff
    if (!validateMawHandoff(handoff, step.snapshot?.members || [])) return null
    if ((handoff.kind === 'submission'
      && !((actor?.id === handoff.sender_member_id && cue.activity === 'delivery' && task?.source_ref === handoff.source_task)
        || (actor?.id === handoff.recipient_member_id && cue.activity === 'publication' && task?.source_ref === handoff.target_task)))
      || (handoff.kind === 'review-result' && (actor?.id !== handoff.sender_member_id || cue.activity !== 'result'
        || task?.source_ref !== handoff.source_task))
      || cue.related_member_ids.some((id) => id !== (actor.id === handoff.sender_member_id ? handoff.recipient_member_id : handoff.sender_member_id))) return null
    if (step.snapshot?.handoff_state === 'unavailable') return null
  }
  return cue
}

export function historyStage(step) {
  const cue = historyCue(step)
  if (!cue) return '记录回顾 · 未提供可校验动作'
  if (cue.activity === 'work' && cue.task?.type !== 'dev') return '评审记录'
  if (cue.activity === 'result' && cue.task?.type !== 'dev') return '评审结果'
  return LABELS[cue.activity]
}

function gesture(cue, agent) {
  if (!cue) return { behavior: 'idle', expression: 'normal' }
  const verdict = agent.maw?.verdict
  switch (cue.activity) {
    case 'ready': return { behavior: 'thumbs-up', expression: 'happy' }
    case 'publication': return { behavior: 'reading-screen', expression: 'normal' }
    case 'work': return { behavior: MAW_ROLE_WORK_BEHAVIOR[agent.maw?.role] || 'typing', expression: 'focused' }
    case 'delivery': return { behavior: 'pass-document', expression: 'normal' }
    case 'result': return { behavior: verdict === 'fail' ? 'scratch-head' : 'thumbs-up', expression: verdict === 'fail' ? 'confused' : 'happy' }
    case 'rework': return { behavior: 'writing-notes', expression: 'normal' }
    case 'coordination': return { behavior: 'gantt-chart', expression: 'normal' }
    default: return { behavior: 'idle', expression: 'normal' }
  }
}

function route(from, target) {
  if (Math.hypot(from.x - target.x, from.y - target.y) < 0.01) return [from, target]
  return [from, ...calculateJourney(from, target, { random: fixedRouteRandom }).waypoints, target]
}

export function sampleHistoryRoute(points, ratio) {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y))
  const total = lengths.reduce((a, b) => a + b, 0)
  let distance = clamp(ratio) * total
  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i]
    if (distance <= length || i === lengths.length - 1) {
      const t = length ? distance / length : 1
      const a = points[i], b = points[i + 1]
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
        facing: calcFacing(a.x, a.y, b.x, b.y) }
    }
    distance -= length
  }
  return { ...points.at(-1), facing: 'down' }
}

function actionPosition(base, cue, elapsed, active) {
  if (!active || !cue || !['delivery', 'publication', 'rework'].includes(cue.activity)) return base
  // A short illustrative approach-and-return beat; it is not a physical event fact.
  const beat = Math.sin(clamp((elapsed - 1200) / 2400) * Math.PI)
  return clampToVisible({ x: base.x + beat * (cue.activity === 'delivery' ? 18 : -10), y: base.y + beat * 8 })
}

function routeLength(path) {
  return path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0)
}

function segment(from, to, start_ms = 0, duration_ms = null) {
  const path = route(from, to)
  const distance = routeLength(path)
  return { path, distance, start_ms, end_ms: start_ms + (duration_ms ?? Math.ceil(distance / HISTORY_WALK_SPEED * 1000)),
    ease: duration_ms !== null }
}

function plannedEntryPosition(entry, elapsed) {
  let position = { ...entry.from, facing: 'down' }
  let moving = false
  for (const leg of entry.segments) {
    if (elapsed < leg.start_ms) break
    const ratio = leg.end_ms === leg.start_ms ? 1 : clamp((elapsed - leg.start_ms) / (leg.end_ms - leg.start_ms))
    position = sampleHistoryRoute(leg.path, leg.ease ? ease(ratio) : ratio)
    moving = elapsed < leg.end_ms && leg.distance > 1
    if (elapsed < leg.end_ms) break
  }
  return { position, moving }
}

function degradeHistoryPlan(plan, warnings) {
  warnings.add('history-animation-incomplete')
  plan.duration_ms = 4000
  plan.cue = null
  plan.handoff = null
  delete plan.terminal_start_ms
  delete plan.finalSnapshot
  plan.stage = '记录回顾 · 动画时轴不完整'
  for (const entry of Object.values(plan.entries)) {
    entry.active = false
    entry.related = false
    entry.gesture = { behavior: 'idle', expression: 'normal' }
    entry.base = { ...entry.from }
    delete entry.terminalBase
    entry.segments = [segment(entry.from, entry.from, 0, 4000)]
  }
}

/** Compile once from the default roster; playback and seeking sample this same plan. */
export function prepareHistoryTimeline(steps, agents, finalSnapshot = null) {
  if (!Array.isArray(steps) || steps.length > HISTORY_MAX_STEPS) throw new Error('history-timeline-invalid')
  const positions = {}
  const plans = [], starts = [], warnings = new Set()
  let duration_ms = 0
  for (const step of steps) {
    const cue = historyCue(step)
    const entries = {}
    const members = new Map((step.snapshot?.members || []).map((member) => [member.id, member]))
    for (const [id, agent] of Object.entries(agents)) {
      const member = members.get(agent.maw?.key)
      if (!agent.mawMember || !member) continue
      const from = point(positions[id]) ? positions[id] : agent.position
      const resting = ['idle', 'done'].includes(member.status) || !!step.snapshot?.terminal
      const base = resting ? (agent.maw?.restSeat || agent.position) : (agent.maw?.workSeat || agent.position)
      const active = cue?.actor_member_id === member.id
      entries[id] = { from: { ...from }, base: { ...base }, active,
        related: cue?.related_member_ids.includes(member.id) || false,
        gesture: gesture(active ? cue : null, { ...agent, maw: { ...agent.maw, verdict: member.verdict } }),
        segments: [segment(from, base)] }
    }
    const plan = { step_id: step.id, stage: historyStage(step), cue, entries, compiled: true,
      duration_ms: Math.max(4000, ...Object.values(entries).map((entry) => entry.segments[0].end_ms)), handoff: null }
    if (step.cue?.handoff && !cue) warnings.add('history-animation-incomplete')
    if (cue?.handoff) {
      const sender = Object.keys(entries).find((id) => agents[id].maw.key === cue.handoff.sender_member_id)
      const recipient = Object.keys(entries).find((id) => agents[id].maw.key === cue.handoff.recipient_member_id)
      const receiverSeat = agents[recipient]?.maw?.workSeat
      const approach = handoffApproachPoint(receiverSeat)
      if (sender && recipient && point(approach)) {
        const senderOut = segment(entries[sender].from, approach)
        const recipientOut = segment(entries[recipient].from, receiverSeat)
        const talk_start_ms = Math.max(senderOut.end_ms, recipientOut.end_ms)
        const talk_end_ms = talk_start_ms + HANDOFF_TALK_MS
        const senderBack = segment(approach, entries[sender].base, talk_end_ms)
        const recipientBack = segment(receiverSeat, entries[recipient].base, talk_end_ms)
        const plannedDuration = Math.max(4000, senderBack.end_ms, recipientBack.end_ms,
          ...Object.entries(entries).filter(([id]) => id !== sender && id !== recipient).map(([, entry]) => entry.segments[0].end_ms))
        if (Number.isSafeInteger(plannedDuration) && plannedDuration <= HISTORY_MAX_STEP_MS
          && duration_ms + plannedDuration <= HISTORY_MAX_TOTAL_MS) {
          entries[sender].segments = [senderOut, senderBack]
          entries[recipient].segments = [recipientOut, recipientBack]
          plan.duration_ms = plannedDuration
          plan.handoff = { sender, recipient, talk_start_ms, talk_end_ms }
        } else warnings.add('history-animation-incomplete')
      } else warnings.add('history-animation-incomplete')
      if (!plan.handoff) {
        // A route that cannot be represented within the budget stays neutral.
        // No truncated path or accelerated conversation implies a false handoff.
        plan.stage = '记录回顾 · 交接动画不可用'
        plan.cue = null
        plan.duration_ms = 4000
        for (const entry of Object.values(entries)) {
          entry.active = false; entry.related = false
          entry.gesture = { behavior: 'idle', expression: 'normal' }
          entry.base = { ...entry.from }
          entry.segments = [segment(entry.from, entry.from, 0, 4000)]
        }
      }
    }
    if (plan.duration_ms > HISTORY_MAX_STEP_MS || duration_ms + plan.duration_ms > HISTORY_MAX_TOTAL_MS) {
      degradeHistoryPlan(plan, warnings)
    }
    if (step === steps.at(-1) && finalSnapshot?.terminal) {
      const terminal_start_ms = plan.duration_ms
      let terminal_end_ms = terminal_start_ms
      const finalMembers = new Map((finalSnapshot.members || []).map((member) => [member.id, member]))
      for (const [id, entry] of Object.entries(entries)) {
        if (!finalMembers.has(agents[id].maw.key)) continue
        const target = agents[id].maw?.restSeat || agents[id].position
        const lastTarget = entry.segments.at(-1)?.path.at(-1) || entry.base
        const returnHome = segment(lastTarget, target, terminal_start_ms)
        entry.segments.push(returnHome)
        terminal_end_ms = Math.max(terminal_end_ms, returnHome.end_ms)
        entry.terminalBase = { ...target }
      }
      plan.terminal_start_ms = terminal_start_ms
      plan.duration_ms = terminal_end_ms
      plan.finalSnapshot = finalSnapshot
    }
    if (plan.duration_ms > HISTORY_MAX_STEP_MS || duration_ms + plan.duration_ms > HISTORY_MAX_TOTAL_MS) {
      degradeHistoryPlan(plan, warnings)
    }
    starts.push(duration_ms)
    duration_ms += plan.duration_ms
    plans.push(plan)
    for (const [id, entry] of Object.entries(entries)) positions[id] = { ...(entry.terminalBase || entry.base) }
  }
  return { plans, starts, duration_ms, warnings: [...warnings] }
}

function sampleCompiledPresentation(plan, progress) {
  const elapsed = Math.max(0, Math.min(plan.duration_ms, progress.step_elapsed_ms || 0))
  const agents = {}
  const talking = !plan.terminal && plan.handoff && elapsed >= plan.handoff.talk_start_ms && elapsed < plan.handoff.talk_end_ms
  for (const [id, entry] of Object.entries(plan.entries)) {
    const sample = plannedEntryPosition(entry, elapsed)
    let position = sample.position
    const locating = plan.seek && progress.locating
    if (locating) position = sampleHistoryRoute(entry.seekPath, ease(progress.transition_elapsed_ms / 500))
    const participant = plan.handoff && [plan.handoff.sender, plan.handoff.recipient].includes(id)
    let facing = position.facing || 'down'
    if (talking && participant && !locating) {
      const partner = plan.handoff.sender === id ? plan.handoff.recipient : plan.handoff.sender
      const other = plannedEntryPosition(plan.entries[partner], elapsed).position
      facing = calcFacing(position.x, position.y, other.x, other.y)
    }
    const isMoving = locating
      ? progress.transition_elapsed_ms < 500 && routeLength(entry.seekPath) > 1
      : !plan.terminal && sample.moving
    const returningToTerminal = Number.isFinite(plan.terminal_start_ms) && elapsed >= plan.terminal_start_ms
    const gesture = plan.terminal || returningToTerminal ? { behavior: 'idle', expression: 'normal' }
      : talking && participant && !locating ? { behavior: 'chat', expression: entry.gesture.expression } : entry.gesture
    agents[id] = { ...gesture, position, active: !plan.terminal && entry.active, related: !plan.terminal && entry.related,
      isMoving, facing, frame: Math.floor(elapsed / 150) % 4,
      walkFrame: Math.floor((locating ? progress.transition_elapsed_ms : elapsed) / 150) % 4 }
  }
  const links = talking && !progress.locating ? [{ from: agents[plan.handoff.sender].position, to: agents[plan.handoff.recipient].position }] : []
  return { step_id: plan.step_id, stage: plan.stage, agents, links }
}

export function buildHistoryPresentation(step, agents, previous = {}, context = {}) {
  if (context.plan?.compiled) {
    const terminal = context.reason === 'end' || step.cue?.activity === 'terminal'
    const plan = { ...context.plan, terminal, stage: terminal ? '终局记录' : context.plan.stage,
      entries: Object.fromEntries(Object.entries(context.plan.entries).map(([id, entry]) => [id, { ...entry }])), seek: context.reason === 'seek' }
    if (plan.seek) {
      const elapsed = context.position_ms - context.step_start_ms
      for (const [id, entry] of Object.entries(plan.entries)) {
        const target = plannedEntryPosition(entry, elapsed).position
        entry.from = point(previous[id]) ? previous[id] : target
        entry.seekPath = route(entry.from, target)
      }
    }
    return plan
  }
  const cue = historyCue(step)
  const entries = {}
  const elapsed = Math.min(4000, Math.max(0, context.position_ms - context.index * 4000)) || 0
  for (const [id, agent] of Object.entries(agents)) {
    if (!agent.mawMember) continue
    const active = cue?.actor_member_id === agent.maw?.key
    const related = cue?.related_member_ids.includes(agent.maw?.key) || false
    const from = point(previous[id]) ? previous[id] : agent.position
    // Natural end holds the exact last visible coordinates, including legacy histories
    // without an explicit final milestone. It must never snap into a newly built seat.
    const base = context.reason === 'end' ? from
      : cue && cue.activity !== 'terminal' && point(agent.maw?.workSeat) ? agent.maw.workSeat : agent.position
    const seekTarget = actionPosition(base, cue, elapsed, active)
    entries[id] = { from, base, active, related, gesture: gesture(active ? cue : null, agent),
      path: route(from, base), seekPath: context.reason === 'seek' ? route(from, seekTarget) : null }
  }
  return { step_id: step?.id || 'final', stage: historyStage(step), cue, entries, seek: context.reason === 'seek' }
}

export function sampleHistoryPresentation(plan, progress) {
  if (plan.compiled) return sampleCompiledPresentation(plan, progress)
  const elapsed = Math.max(0, Math.min(4000, progress.step_elapsed_ms || 0))
  const agents = {}
  for (const [id, entry] of Object.entries(plan.entries)) {
    const action = actionPosition(entry.base, plan.cue, elapsed, entry.active)
    let position
    if (plan.seek && progress.locating) position = sampleHistoryRoute(entry.seekPath, ease(progress.transition_elapsed_ms / 500))
    else if (!plan.seek && elapsed < 1200) position = sampleHistoryRoute(entry.path, ease(elapsed / 1200))
    else position = { ...action, facing: 'down' }
    const moving = (plan.seek && progress.locating && progress.transition_elapsed_ms < 500
      && Math.hypot(entry.from.x - action.x, entry.from.y - action.y) > 1)
      || (!plan.seek && elapsed < 1200 && Math.hypot(entry.from.x - entry.base.x, entry.from.y - entry.base.y) > 1)
      || (entry.active && ['delivery', 'publication', 'rework'].includes(plan.cue?.activity) && elapsed > 1200 && elapsed < 3600)
    agents[id] = { ...entry.gesture, position, active: entry.active, related: entry.related,
      isMoving: moving, facing: position.facing || 'down', frame: Math.floor(elapsed / 150) % 4,
      walkFrame: Math.floor((progress.locating ? progress.transition_elapsed_ms : elapsed) / 150) % 4 }
  }
  const active = Object.entries(agents).find(([, agent]) => agent.active)
  const related = Object.entries(agents).find(([, agent]) => agent.related)
  const links = active && related ? [{ from: active[1].position, to: related[1].position }] : []
  return { step_id: plan.step_id, stage: plan.stage, agents, links }
}
