// Fixed-selection, same-origin Dashboard transport. Each mounted view owns its requests,
// timers, ordering cursor and choreography; no shared "current task" is consulted.
import { detectIntegrationConfig } from '../systems/platformDetect.js'
import { startMawChoreography, workSeatFor, restSeatFor } from '../systems/mawChoreography.js'
import { createDashboardHistoryController } from './dashboardHistory.js'
import { buildHistoryPresentation, sampleHistoryPresentation, prepareHistoryTimeline } from './dashboardHistoryChoreography.js'
import { validateDashboardEnvelope } from './dashboardSnapshot.js'

export { validateDashboardEnvelope } from './dashboardSnapshot.js'

const POLL_MS = 2000
const REQUEST_TIMEOUT_MS = 10_000
const STALE_MS = 120_000

// Compile from defaults once, independently of the currently visible live scene.
// The roster supplies coordinates only; each frame still exposes its own members.
function historyRosterFor(steps) {
  const roster = {}
  const occupied = new Set(), resting = new Set()
  for (const step of steps) {
    for (const member of step.snapshot.members) {
      const id = `${member.id}~${member.role}`
      if (roster[id]) continue
      let workSeat
      for (let i = 0; i < 50; i += 1) {
        const candidate = workSeatFor(member.role, i)
        if (member.role === 'manager' || !occupied.has(`${candidate.x},${candidate.y}`)) {
          workSeat = candidate
          break
        }
      }
      workSeat ??= workSeatFor(member.role, 49)
      occupied.add(`${workSeat.x},${workSeat.y}`)
      const rest = restSeatFor(id, resting)
      resting.add(rest.index)
      roster[id] = { id, mawMember: true, position: { ...rest.seat },
        maw: { key: member.id, role: member.role, workSeat, restSeat: rest.seat } }
    }
  }
  return roster
}

export function startDashboardIntegration(store, config = detectIntegrationConfig()) {
  // Every mounted binding starts with its own observation baseline, including
  // rapid task replacements that reuse this store.
  store.setState({ agents: {}, mawMeta: null, dashboardHistoryPresentation: null })
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
  let initialized = false
  let observedUnassigned = false
  let opening = 0
  let choreographyCleanup = startMawChoreography(store, { resumeCurrent: true })
  let historyToggleVersion = store.getState().dashboardHistoryToggle
  const originalPause = store.getState().isPaused
  let historyOwnsScene = false
  let historySeq = 0
  let historyPlan = null
  let historyRoster = {}
  const history = createDashboardHistoryController({
    config,
    prepareTimeline(steps, history) {
      historyRoster = historyRosterFor(steps)
      return prepareHistoryTimeline(steps, historyRoster, history.final_snapshot)
    },
    onStart() {
      historyOwnsScene = true
      generation += 1
      controller?.abort()
      clearTimeout(requestTimer)
      clearTimeout(pollTimer)
      clearTimeout(staleTimer)
      choreographyCleanup?.()
      choreographyCleanup = null
      // Only the history clock may animate the illustrative presentation.
      store.setState({ isPaused: true, handoffs: [], activeEvent: null })
    },
    onFrame(snapshot, context) {
      const before = store.getState()
      const positions = Object.fromEntries(Object.entries(before.agents).map(([id, agent]) =>
        [id, before.dashboardHistoryPresentation?.agents[id]?.position || agent.position]))
      store.getState().applyMawSnapshot({ server_epoch: 0, seq: ++historySeq, snapshot, dashboard_history: true })
      const agents = Object.fromEntries(Object.entries(store.getState().agents).map(([id, agent]) => [id,
        historyRoster[id] ? { ...agent, maw: { ...agent.maw,
          workSeat: historyRoster[id].maw.workSeat, restSeat: historyRoster[id].maw.restSeat } } : agent]))
      store.setState({ agents })
      historyPlan = buildHistoryPresentation(context.step, store.getState().agents, positions, context)
    },
    onProgress(progress) {
      if (historyPlan) store.setState({ dashboardHistoryPresentation: sampleHistoryPresentation(historyPlan, progress) })
    },
    onState(value) { store.getState().setDashboardHistory(value) },
    onPause() {},
  })

  function sync(state, code = null) {
    if (torn) return
    if (['error', 'missing', 'stale'].includes(state)) {
      needsRecovery = true
      observedUnassigned = false
    }
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
    const recovering = needsRecovery || isStale
    if (recovering) recovery += 1
    needsRecovery = false
    const snapshot = envelope.snapshot
    const hasMembers = snapshot?.members?.length > 0
    const complete = hasMembers && snapshot.quality === 'ok'
    const firstAssignment = initialized && !recovering && complete
      && observedUnassigned && snapshot.assignment_state === 'assigned'
    if (firstAssignment) opening += 1
    if (hasMembers) initialized = true
    observedUnassigned = complete && snapshot.assignment_state === 'unassigned'
    store.getState().applyMawSnapshot({ ...envelope, dashboard_recovery: recovery,
      dashboard_hydration: initialized ? 1 : 0, dashboard_opening: opening })
    isStale = envelope.snapshot?.quality === 'stale'
    if (isStale) store.getState().freezeMawSnapshot(envelope.snapshot.quality_detail || 'source-stale')
    armStaleTimer()
    sync(isStale ? 'stale' : 'synced')
    history.onTerminal(envelope.snapshot?.terminal)
    return true
  }

  async function request() {
    if (torn || config.error || history.isActive() || inFlight) return inFlight
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
    const state = store.getState()
    if (state.dashboardHistoryToggle !== historyToggleVersion) {
      historyToggleVersion = state.dashboardHistoryToggle
      history.toggle()
    }
    const next = state.dashboardRetry
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
    history.destroy()
    choreographyCleanup?.()
    historyPlan = null
    historyRoster = {}
    if (historyOwnsScene) store.setState({ isPaused: originalPause, dashboardHistory: null, dashboardHistoryPresentation: null })
  }
}
