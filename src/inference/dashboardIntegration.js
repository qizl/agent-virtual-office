// Fixed-selection, same-origin Dashboard transport. Each mounted view owns its requests,
// timers, ordering cursor and choreography; no shared "current task" is consulted.
import { detectIntegrationConfig } from '../systems/platformDetect.js'
import { startMawChoreography } from '../systems/mawChoreography.js'

const POLL_MS = 2000
const REQUEST_TIMEOUT_MS = 10_000
const STALE_MS = 120_000
const MAX_SNAPSHOT_BYTES = 16384
const ROLES = ['decision-maker', 'executor', 'manager', 'reviewer']
const STATUSES = ['awaiting-approval', 'blocked', 'done', 'idle', 'planning', 'working']
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v) => Number.isSafeInteger(v) && v >= 0
const nullableString = (v, max) => v == null || (typeof v === 'string' && v.length <= max)
const nullableEnum = (v, allowed) => v == null || allowed.includes(v)

/** Validate before advancing the ordering/freshness cursor; malformed data cannot keep it live. */
export function validateDashboardEnvelope(envelope) {
  if (!object(envelope) || !integer(envelope.server_epoch) || !integer(envelope.seq)) return false
  const s = envelope.snapshot
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

export function startDashboardIntegration(store, config = detectIntegrationConfig()) {
  let torn = false
  let generation = 0
  let controller = null
  let requestTimer = null
  let pollTimer = null
  let staleTimer = null
  let inFlight = null
  let lastKey = null
  let lastContent = null
  let lastValidAt = null
  let isStale = false
  let needsRecovery = false
  let retryVersion = store.getState().dashboardRetry
  let reportedFailure = null
  let recovery = 0
  const choreographyCleanup = startMawChoreography(store, { resumeCurrent: true })

  function sync(state, code = null) {
    if (torn) return
    if (['error', 'missing', 'stale'].includes(state)) needsRecovery = true
    if (['error', 'missing', 'configuration-error', 'stale'].includes(state) && code && code !== reportedFailure) {
      console.warn('[Dashboard] synchronization:', code)
      reportedFailure = code
    } else if (state === 'synced') reportedFailure = null
    store.getState().setDashboardSync({ state, code, lastValidAt, retrying: state === 'loading' })
  }
  function clearTeam() {
    store.getState().applyMawSnapshot({ server_epoch: lastKey?.[0] ?? 0, seq: lastKey?.[1] ?? 0, snapshot: null })
  }
  function armStaleTimer() {
    clearTimeout(staleTimer)
    staleTimer = setTimeout(() => {
      if (torn) return
      isStale = true
      store.getState().freezeMawSnapshot()
      sync('stale', 'client-sync-timeout')
    }, STALE_MS)
  }
  function accept(envelope) {
    if (!validateDashboardEnvelope(envelope)) return false
    const { server_epoch: epoch, seq } = envelope
    const content = JSON.stringify(envelope.snapshot)
    if (lastKey && (epoch < lastKey[0] || (epoch === lastKey[0] && seq < lastKey[1]))) return false
    if (lastKey && epoch === lastKey[0] && seq === lastKey[1] && content !== lastContent) return false
    lastKey = [epoch, seq]
    lastContent = content
    lastValidAt = Date.now()
    // Recovery is a baseline of the currently observed facts, never replay of unobserved work.
    if (needsRecovery || isStale) recovery += 1
    needsRecovery = false
    store.getState().applyMawSnapshot({ ...envelope, dashboard_recovery: recovery })
    isStale = envelope.snapshot?.quality === 'stale'
    if (isStale) store.getState().freezeMawSnapshot(envelope.snapshot.quality_detail || 'source-stale')
    armStaleTimer()
    sync(isStale ? 'stale' : 'synced')
    return true
  }

  async function request() {
    if (torn || config.error || inFlight) return inFlight
    clearTimeout(pollTimer)
    const mine = ++generation
    controller = new AbortController()
    const activeController = controller
    sync('loading')
    inFlight = Promise.resolve().then(async () => {
      if (torn || mine !== generation) return
      try {
        const response = await Promise.race([
          (async () => {
            const res = await fetch(`/api/visualization/state?${new URLSearchParams({ project: config.project, task: config.task })}`, {
              signal: activeController.signal, headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin',
            })
            return { status: res.status, ok: res.ok, body: await res.json() }
          })(),
          new Promise((_, reject) => {
            requestTimer = setTimeout(() => {
              activeController.abort()
              reject(new Error('request-timeout'))
            }, REQUEST_TIMEOUT_MS)
          }),
        ])
        if (torn || mine !== generation || activeController.signal.aborted) return
        if (!response.ok || response.body?.ok !== true) {
          if (response.status === 404 || response.status === 410) {
            clearTeam()
            clearTimeout(staleTimer)
            sync('missing', ['project-not-found', 'project-not-registered'].includes(response.body?.error?.code) ? 'project-not-found' : 'task-not-found')
          } else sync(isStale ? 'stale' : 'error', 'read-failed')
          return
        }
        if (!accept(response.body.data)) sync(isStale ? 'stale' : 'error', 'invalid-snapshot')
      } catch (error) {
        if (torn || mine !== generation) return
        // sync publishes the production UI state and a bounded diagnostic code, never a response body.
        sync(isStale ? 'stale' : 'error', error?.message === 'request-timeout' ? 'request-timeout' : 'read-failed')
      } finally {
        clearTimeout(requestTimer)
        if (mine === generation) {
          inFlight = null
          controller = null
          if (!torn) pollTimer = setTimeout(request, POLL_MS)
        }
      }
    })
    return inFlight
  }

  const unsubscribe = store.subscribe(() => {
    const next = store.getState().dashboardRetry
    if (next === retryVersion) return
    retryVersion = next
    request()
  })
  if (config.error || !config.project?.trim() || !config.task?.trim()) {
    clearTeam()
    sync('configuration-error', config.error || (!config.project?.trim() ? 'missing-project' : 'missing-task'))
  } else {
    armStaleTimer()
    request()
  }
  return () => {
    torn = true
    generation += 1
    controller?.abort()
    clearTimeout(requestTimer)
    clearTimeout(pollTimer)
    clearTimeout(staleTimer)
    unsubscribe()
    choreographyCleanup()
  }
}
