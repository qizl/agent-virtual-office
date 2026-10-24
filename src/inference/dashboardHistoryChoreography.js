// Recorded facts and illustrative motion stay separate. This module has no clock,
// store writes, live queues or inferred activity; its caller owns elapsed display time.
import { calculateJourney, calcFacing } from '../systems/movementSystem.js'
import { clampToVisible, MAW_ROLE_WORK_BEHAVIOR } from '../systems/mawChoreography.js'

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

/** Malformed or older cues are neutral, never guessed from prose or snapshot deltas. */
export function historyCue(step) {
  const cue = step?.cue
  if (!object(cue) || Object.keys(cue).some((key) => !['actor_member_id', 'activity', 'task', 'related_member_ids'].includes(key))
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
    if (!task?.ref_task || task.ref_task.match(TASK_REF)[1] !== related?.role) return null
  }
  if (cue.activity === 'ready' && (!actor || actor.status !== 'idle')) return null
  if (cue.activity === 'terminal' && !step.snapshot?.terminal) return null
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

export function buildHistoryPresentation(step, agents, previous = {}, context = {}) {
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
