// mawIntegration.js — dedicated client channel for ?mode=maw (plan §4.1.2/§4.1.3).
//
// In maw mode this is the ONLY status source: the default SSE/poll/hash/postMessage/
// BroadcastChannel/global channels are never wired (startStatusIntegration gates before
// them). Each server envelope carries { server_epoch, seq, snapshot }; the store's
// applyMawSnapshot treats every snapshot as the FULL member set, so stale deliveries are
// neutralized by comparing the server epoch before applying.

import { detectProjectMode } from '../systems/platformDetect'
import { startMawChoreography } from '../systems/mawChoreography.js'

const POLL_INTERVAL_MS = 2000
const SSE_RETRY_MS = 30_000

export function startMawIntegration(store) {
  let torn = false
  const choreographyCleanup = startMawChoreography(store)
  let source = null // 'sse' | 'poll'
  let eventSource = null
  let pollTimer = null
  let retryTimer = null
  let lastEpoch = null

  function applyEnvelope(envelope) {
    if (torn || !envelope || typeof envelope !== 'object') return
    // An older epoch is a delayed delivery from a cleared channel — never re-activate it.
    if (typeof envelope.server_epoch === 'number' && typeof lastEpoch === 'number' && envelope.server_epoch < lastEpoch) return
    if (typeof envelope.server_epoch === 'number') lastEpoch = envelope.server_epoch
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

/** Mode gate: maw mode never touches the default channels (plan §4.1.3). */
export function startStatusIntegrationForMode(store, mode = detectProjectMode()) {
  if (mode === 'maw') return startMawIntegration(store)
  return null // caller falls back to the default startStatusIntegration
}
