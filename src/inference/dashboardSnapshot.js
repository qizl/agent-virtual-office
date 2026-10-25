// Shared boundary validation for live observations and recorded history frames.
const MAX_SNAPSHOT_BYTES = 16384
const ROLES = ['decision-maker', 'executor', 'manager', 'reviewer']
const STATUSES = ['awaiting-approval', 'blocked', 'done', 'idle', 'planning', 'working']
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v) => Number.isSafeInteger(v) && v >= 0
const nullableString = (v, max) => v == null || (typeof v === 'string' && v.length <= max)
const nullableEnum = (v, allowed) => v == null || allowed.includes(v)
const TASK_KINDS = ['aggregate-review', 'dev', 'plan-review', 'review']
const TASK_REF = /^(decision-maker|executor|reviewer)-[0-9]+\/task-([0-9]{3,})\.json$/
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const taskRef = (value) => typeof value === 'string' && value.length <= 128 && TASK_REF.test(value)

function fnv64(value) {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

export function mawHandoffId(kind, sender, recipient, source, target) {
  const signature = `${kind}|${sender}|${recipient}|${source}|${target}`
  return `${fnv64(signature)}${fnv64(`handoff:${signature}`)}`
}

export function validateMawTaskIdentity(task, role) {
  if (!exactKeys(task, ['seq', 'round', 'type', 'source_ref', 'ref_task'])
    || !integer(task.seq) || task.seq < 1 || !integer(task.round) || task.round < 1
    || !TASK_KINDS.includes(task.type) || !taskRef(task.source_ref) || (task.ref_task !== null && !taskRef(task.ref_task))) return false
  const source = task.source_ref.match(TASK_REF)
  return (!role || source[1] === role) && source[2] === String(task.seq).padStart(3, '0')
}

export function validateMawHandoff(handoff, members) {
  if (!exactKeys(handoff, ['id', 'kind', 'sender_member_id', 'recipient_member_id', 'source_task', 'target_task'])
    || typeof handoff.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(handoff.id)
    || !['submission', 'review-result'].includes(handoff.kind)) return false
  const sender = members.find((member) => member.id === handoff.sender_member_id)
  const recipient = members.find((member) => member.id === handoff.recipient_member_id)
  if (!sender || !recipient || sender === recipient || !validateMawTaskIdentity(sender.current_task, sender.role)
    || !validateMawTaskIdentity(recipient.current_task, recipient.role)) return false
  const source = sender.current_task
  const target = recipient.current_task
  if (source.source_ref !== handoff.source_task || target.source_ref !== handoff.target_task || source.round !== target.round) return false
  if (handoff.id !== mawHandoffId(handoff.kind, sender.id, recipient.id, source.source_ref, target.source_ref)) return false
  return handoff.kind === 'submission'
    ? ['executor', 'decision-maker'].includes(sender.role) && recipient.role === 'reviewer'
      && source.type === 'dev' && target.type === 'review' && target.ref_task === source.source_ref
    : sender.role === 'reviewer' && ['executor', 'decision-maker'].includes(recipient.role)
      && source.type === 'review' && target.type === 'dev' && source.ref_task === target.source_ref
}

export function validateMawInteractionFields(snapshot) {
  if (snapshot.assignment_state !== undefined && !['unassigned', 'assigned', 'unknown'].includes(snapshot.assignment_state)) return false
  if (snapshot.handoff_state !== undefined && !['complete', 'unavailable'].includes(snapshot.handoff_state)) return false
  for (const member of snapshot.members) {
    if (member.current_task !== undefined && member.current_task !== null && !validateMawTaskIdentity(member.current_task, member.role)) return false
    if (!nullableEnum(member.handoff_pending, ['missing', 'conflict', 'not-ready', 'incomplete'])) return false
  }
  if (snapshot.handoffs !== undefined && (!Array.isArray(snapshot.handoffs) || snapshot.handoffs.length > 200
    || snapshot.handoffs.some((edge) => !validateMawHandoff(edge, snapshot.members))
    || new Set(snapshot.handoffs.map((edge) => edge.id)).size !== snapshot.handoffs.length
    || new Set(snapshot.handoffs.map((edge) => `${edge.kind}|${edge.source_task}|${edge.target_task}`)).size !== snapshot.handoffs.length
    || (snapshot.handoffs.length > 0 && snapshot.handoff_state !== 'complete'))) return false
  return true
}

export function validateDashboardSnapshot(s) {
  if (s === null) return true
  if (!object(s) || s.schema !== 'avo.maw-snapshot/1' || !integer(s.sampled_at)) return false
  if (!['ok', 'degraded', 'stale'].includes(s.quality) || !nullableString(s.workflow, 200)
    || !nullableString(s.quality_detail, 64) || !nullableEnum(s.terminal, ['cancelled', 'completed', 'completed-with-findings'])) return false
  if (!Array.isArray(s.members) || s.members.length > 50) return false
  const seen = new Set()
  for (const m of s.members) {
    if (!object(m) || typeof m.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(m.id)
      || seen.has(m.id) || !ROLES.includes(m.role) || !STATUSES.includes(m.status)
      || !nullableString(m.label, 200) || !nullableString(m.detail, 200)
      || (m.round != null && !Number.isSafeInteger(m.round))
      || !nullableEnum(m.task_kind, ['aggregate-review', 'dev', 'plan-review', 'review'])
      || !nullableEnum(m.verdict, ['fail', 'pass']) || !nullableEnum(m.terminate, ['confirmed', 'initialized'])
      || (m.stalled !== undefined && typeof m.stalled !== 'boolean')) return false
    seen.add(m.id)
  }
  return validateMawInteractionFields(s) && new TextEncoder().encode(JSON.stringify(s)).byteLength <= MAX_SNAPSHOT_BYTES
}

/** Validate before advancing the ordering/freshness cursor. */
export function validateDashboardEnvelope(envelope) {
  return object(envelope) && integer(envelope.server_epoch) && integer(envelope.seq)
    && validateDashboardSnapshot(envelope.snapshot)
}
