// mawIntegration.js — dedicated client channel for ?mode=maw (plan §4.1.2/§4.1.3).
//
// In maw mode this is the ONLY status source: the default SSE/poll/hash/postMessage/
// BroadcastChannel/global channels are never wired (startStatusIntegration gates before
// them). Each server envelope carries { server_epoch, seq, snapshot }; stale deliveries
// are neutralized by the (epoch, seq) order in envelopeIsNewer, and the store's
// applyMawSnapshot treats every accepted snapshot as the FULL member set.

import { detectIntegrationConfig } from '../systems/platformDetect'
import { startDashboardIntegration } from './dashboardIntegration.js'
import { startMawChoreography } from '../systems/mawChoreography.js'
import { loadWorkSeatCache, saveWorkSeatCache } from '../systems/mawWorkSeatCache.js'

const POLL_INTERVAL_MS = 2000
const SSE_RETRY_MS = 30_000

/**
 * Total order on (server_epoch, seq): the server epoch is boot-unique, so a delayed
 * bootstrap GET (or a poll response racing SSE) with a lower seq can never overwrite
 * newer state, and envelopes from a previous server lifetime can never re-activate
 * the view. Equal keys re-apply harmlessly — every snapshot is the full member set.
 */
export function envelopeIsNewer(envelope, lastKey) {
  if (!envelope || typeof envelope !== 'object') return false
  const epoch = envelope.server_epoch
  const seq = envelope.seq
  if (typeof epoch !== 'number' || typeof seq !== 'number') return true // malformed — let the validator handle it
  if (!lastKey) return true
  return epoch > lastKey[0] || (epoch === lastKey[0] && seq >= lastKey[1])
}

export function startMawIntegration(store) {
  const config = detectIntegrationConfig()
  if (config.integration === 'dashboard') return startDashboardIntegration(store, config)
  let torn = false
  // CR-15: standalone ?mode=maw keys the seat-association cache by the workflow
  // title — the only stable task identity this mode sees. The title arrives
  // with the first beat, so the cache is (re)injected into the store BEFORE the
  // members are built, and every choreographer binding is persisted back under
  // the same title.
  let seatCacheWorkflow = null
  let seatBindings = new Map()
  let seatSaveTimer = null
  const persistSeatBindings = () => {
    if (!seatCacheWorkflow) return
    clearTimeout(seatSaveTimer)
    seatSaveTimer = setTimeout(() => saveWorkSeatCache('maw', seatCacheWorkflow, Object.fromEntries(seatBindings)), 300)
  }
  const choreographyCleanup = startMawChoreography(store, {
    onWorkSeatBound(memberKey, seat) {
      seatBindings.set(memberKey, { ...seat })
      persistSeatBindings()
    },
  })
  let source = null // 'sse' | 'poll'
  let eventSource = null
  let pollTimer = null
  let retryTimer = null
  let lastKey = null // [server_epoch, seq] of the last applied envelope

  function applyEnvelope(envelope) {
    if (torn) return
    if (!envelopeIsNewer(envelope, lastKey)) return
    if (typeof envelope?.server_epoch === 'number' && typeof envelope?.seq === 'number') {
      lastKey = [envelope.server_epoch, envelope.seq]
    }
    const title = typeof envelope?.snapshot?.workflow === 'string' ? envelope.snapshot.workflow : null
    if (title && title !== seatCacheWorkflow) {
      seatCacheWorkflow = title
      const cached = loadWorkSeatCache('maw', title)
      seatBindings = new Map(cached || [])
      store.getState().setMawWorkSeatCache?.(cached)
    }
    store.getState().applyMawSnapshot(envelope)
  }

  function startPolling() {
    if (torn || source === 'poll') return
    source = 'poll'
    const poll = async () => {
      if (torn) return
      try {
        const res = await fetch('/api/maw/status', { headers: { Accept: 'application/json' } })
        if (res.ok) applyEnvelope(await res.json())
      } catch { /* unreachable office — keep the empty/stale state, retry on the next tick */ }
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
    }
    poll()
  }

  function startSse() {
    if (torn || typeof window === 'undefined' || typeof EventSource === 'undefined') return startPolling()
    source = 'sse'
    eventSource = new EventSource('/api/maw/status/stream')
    eventSource.addEventListener('maw', (event) => {
      try {
        applyEnvelope(JSON.parse(event.data))
      } catch { /* malformed frame — the next snapshot corrects it */ }
    })
    eventSource.onerror = () => {
      teardownSource()
      // HTTP fallback keeps the view alive; retry SSE after a cool-down.
      startPolling()
      retryTimer = setTimeout(() => {
        if (torn) return
        teardownPoll()
        startSse()
      }, SSE_RETRY_MS)
    }
  }

  function teardownSource() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
  }

  function teardownPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  // Bootstrap with one GET so the first paint has data even before SSE connects…
  ;(async () => {
    if (torn) return
    try {
      const res = await fetch('/api/maw/status', { headers: { Accept: 'application/json' } })
      if (res.ok) applyEnvelope(await res.json())
    } catch { /* server may not be up yet; SSE/poll retries cover it */ }
  })()
  startSse()

  return function cleanup() {
    torn = true
    choreographyCleanup()
    teardownSource()
    teardownPoll()
    if (retryTimer) clearTimeout(retryTimer)
  }
}
