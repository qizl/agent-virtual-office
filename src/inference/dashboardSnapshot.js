// Shared boundary validation for live observations and recorded history frames.
const MAX_SNAPSHOT_BYTES = 16384
const ROLES = ['decision-maker', 'executor', 'manager', 'reviewer']
const STATUSES = ['awaiting-approval', 'blocked', 'done', 'idle', 'planning', 'working']
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v) => Number.isSafeInteger(v) && v >= 0
const nullableString = (v, max) => v == null || (typeof v === 'string' && v.length <= max)
const nullableEnum = (v, allowed) => v == null || allowed.includes(v)

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
  return new TextEncoder().encode(JSON.stringify(s)).byteLength <= MAX_SNAPSHOT_BYTES
}

/** Validate before advancing the ordering/freshness cursor. */
export function validateDashboardEnvelope(envelope) {
  return object(envelope) && integer(envelope.server_epoch) && integer(envelope.seq)
    && validateDashboardSnapshot(envelope.snapshot)
}
