import { validateDashboardSnapshot } from './dashboardSnapshot.js'

export const HISTORY_STEP_MS = 4000
export const HISTORY_SEEK_MS = 500
const STEP_MS = HISTORY_STEP_MS
const TICK_MS = 50
const REQUEST_TIMEOUT_MS = 10_000
const MAX_HISTORY_BYTES = 1024 * 1024
const TERMINALS = ['cancelled', 'completed', 'completed-with-findings']
const COMPLETED = ['completed', 'completed-with-findings']
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max
const time = (v) => v === null || (text(v, 64) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)))
const WARNING_MESSAGES = {
  'terminal-conflict': '终局记录冲突，已禁用历史播放',
  'playable-history-unavailable': '没有可播放的已记录里程碑',
  'recorded-time-unavailable': '部分记录的时间未记录',
  'operation-history-unavailable': '事务历史未记录，仅回顾已有任务结果',
  'operation-history-incomplete': '事务历史不完整',
  'operation-record-invalid': '部分事务记录损坏或不可校验，已跳过',
  'task-record-invalid': '部分任务记录损坏，已跳过',
  'task-reference-cycle': '任务关联形成循环，已保留可校验记录',
  'task-reference-missing': '部分任务关联缺失',
  'current-input-incomplete': '当前记录读取不完整',
  'operation-input-limit': '事务记录超出读取上限',
  'task-input-limit': '任务记录超出读取上限',
  'milestone-output-limit': '里程碑超出显示上限',
  'response-size-limit': '历史内容超出响应上限',
}
const ERROR_MESSAGES = {
  'history-too-large': '历史响应超出大小上限',
  'history-timeout': '历史读取超时，请重试',
  'invalid-history': '历史数据无法校验，已停止播放',
  'history-read-failed': '历史读取失败，请重试',
}

async function readHistoryBody(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_HISTORY_BYTES) throw new Error('history-too-large')
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_HISTORY_BYTES) {
        await reader.cancel()
        throw new Error('history-too-large')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(bytes)
  }
  const body = await response.text()
  if (new TextEncoder().encode(body).byteLength > MAX_HISTORY_BYTES) throw new Error('history-too-large')
  return body
}

export function validateDashboardHistory(data, binding) {
  if (!object(data) || data.schema !== 'avo.maw-history/1'
    || data.project !== binding.project || data.task !== binding.task
    || (data.terminal !== null && !TERMINALS.includes(data.terminal))
    || typeof data.eligible !== 'boolean' || typeof data.complete !== 'boolean'
    || !Array.isArray(data.warnings) || data.warnings.length > 200 || data.warnings.some((v) => !text(v, 1000))
    || !Array.isArray(data.steps) || data.steps.length > 200
    || !validateDashboardSnapshot(data.final_snapshot)) return false
  const seen = new Set()
  for (const step of data.steps) {
    if (!object(step) || !text(step.id, 200) || seen.has(step.id) || !text(step.kind, 64)
      || !text(step.label, 200) || !time(step.recorded_at)
      || !Array.isArray(step.source_refs) || step.source_refs.length > 200 || step.source_refs.some((v) => !text(v, 1000))
      || !step.snapshot || !validateDashboardSnapshot(step.snapshot)) return false
    seen.add(step.id)
  }
  return (!data.eligible || (COMPLETED.includes(data.terminal)
    && data.final_snapshot?.terminal === data.terminal))
    && new TextEncoder().encode(JSON.stringify(data)).byteLength <= MAX_HISTORY_BYTES
}

// One iframe clock owns both the recorded timeline and its illustrative presentation.
// Position is presentation time, never a claim about the duration of recorded work.
export function createDashboardHistoryController({ config, onStart, onFrame, onState, onPause,
  onProgress = () => {},
  scope = typeof window === 'undefined' ? null : window }) {
  let torn = false
  let requestGeneration = 0
  let controller = null
  let requestTimer = null
  let timer = null
  let data = null
  let state = 'live'
  let index = -1
  let position = 0
  let lastTick = 0
  let locating = false
  let locatingElapsed = 0
  let allowPausedLocation = false
  let lastPublishedAt = -Infinity
  let autoAttempted = false
  let inFlight = null
  let current = { state, step: 0, total: 0, position_ms: 0, duration_ms: 0, complete: true, message: null, code: null, label: null, recorded_at: null }
  const origin = scope?.location?.origin
  const rafClock = typeof scope?.requestAnimationFrame === 'function'
  const pausedAnimations = new Set()
  const duration = () => (data?.steps.length || 0) * STEP_MS

  function publish(next, code = null, force = true) {
    if (torn) return
    state = next
    const step = data?.steps[index]
    current = { state, step: index + 1, total: data?.steps.length || 0,
      position_ms: position, duration_ms: duration(), locating,
      complete: data?.complete ?? true,
      code, label: step?.label || null, recorded_at: step?.recorded_at ?? null,
      message: data ? ['任务记录回顾 · 非实时', locating && state === 'paused' ? '暂停定位中' : null, step?.label,
        step ? (step.recorded_at || '时间未记录') : null,
        data.complete ? null : '历史不完整', ...(data.warnings || []).map((warning) => WARNING_MESSAGES[warning] || '部分历史记录不可用')]
        .filter(Boolean).join(' · ').slice(0, 2048) : ERROR_MESSAGES[code] || null }
    if (next === 'unavailable' && !data?.steps.length && !data?.warnings?.length) current.message = '没有可播放的已记录里程碑'
    onProgress({ ...current, step_index: index,
      step_elapsed_ms: index < 0 ? 0 : Math.min(STEP_MS, position - index * STEP_MS),
      transition_elapsed_ms: locatingElapsed, transition_duration_ms: locating ? HISTORY_SEEK_MS : 0 })
    // Presentation samples every animation frame; parent controls and announcements
    // are throttled to 20Hz from that same clock, never a second timing source.
    if (force || Date.now() - lastPublishedAt >= TICK_MS || state === 'ended') {
      lastPublishedAt = Date.now()
      onState(current)
      if (origin && scope?.parent && scope.parent !== scope) {
        scope.parent.postMessage({ schema: 'avo.dashboard.history-state/1', project: config.project, task: config.task, ...current }, origin)
      }
    }
  }
  function stopClock() {
    if (rafClock) scope.cancelAnimationFrame?.(timer)
    else clearTimeout(timer)
    timer = null
  }
  function animationPause(paused) {
    onPause?.(paused)
    // pauseAnimations freezes the root SVG document time, including newly mounted SMIL.
    for (const svg of scope?.document?.querySelectorAll?.('svg') || []) {
      if (paused) svg.pauseAnimations?.()
      else svg.unpauseAnimations?.()
    }
    if (paused) {
      for (const animation of scope?.document?.getAnimations?.() || []) {
        if (animation.playState !== 'running') continue
        animation.pause?.()
        pausedAnimations.add(animation)
      }
    } else {
      for (const animation of pausedAnimations) animation.play?.()
      pausedAnimations.clear()
    }
  }
  function frame(reason) {
    index = Math.min(data.steps.length - 1, Math.floor(position / STEP_MS))
    const step = position === duration() ? { ...data.steps[index], snapshot: data.final_snapshot,
      cue: { actor_member_id: null, activity: 'terminal', task: null, related_member_ids: [] } } : data.steps[index]
    onFrame(position === duration() ? data.final_snapshot : step.snapshot,
      { step, index, position_ms: position, reason })
  }
  function advance(now) {
    let elapsed = Math.max(0, now - lastTick)
    lastTick = now
    if (locating && (state === 'playing' || allowPausedLocation)) {
      const consumed = Math.min(elapsed, HISTORY_SEEK_MS - locatingElapsed)
      locatingElapsed += consumed
      elapsed -= consumed
      if (locatingElapsed === HISTORY_SEEK_MS) {
        locating = false
        allowPausedLocation = false
      }
    }
    if (state === 'playing' && !locating) {
      const previous = index
      position = Math.min(duration(), position + elapsed)
      const next = Math.min(data.steps.length - 1, Math.floor(position / STEP_MS))
      if (next !== previous) frame('step')
      if (position === duration()) {
        frame('end')
        state = 'ended'
        animationPause(true)
      }
    }
  }
  function arm() {
    stopClock()
    if (torn || (state !== 'playing' && !(locating && allowPausedLocation))) return
    const tick = () => {
      if (torn) return
      const wasLocating = locating
      advance(Date.now())
      publish(state, null, wasLocating && !locating)
      arm()
    }
    timer = rafClock ? scope.requestAnimationFrame(tick) : setTimeout(tick, TICK_MS)
  }
  function restart() {
    if (!data?.eligible || !data.steps.length || torn) return
    stopClock()
    position = 0
    locating = false
    locatingElapsed = 0
    allowPausedLocation = false
    lastTick = Date.now()
    frame('restart')
    publish('playing')
    animationPause(false)
    arm()
  }
  function seek(nextPosition) {
    if (torn || !data?.eligible || !data.steps.length || !Number.isSafeInteger(nextPosition)
      || nextPosition < 0 || nextPosition > duration() || !['playing', 'paused', 'ended'].includes(state)) return false
    stopClock()
    const wasPlaying = state === 'playing'
    if (wasPlaying) advance(Date.now())
    position = nextPosition
    state = wasPlaying ? (position === duration() ? 'ended' : 'playing') : 'paused'
    locating = true
    locatingElapsed = 0
    allowPausedLocation = state !== 'playing'
    lastTick = Date.now()
    frame('seek')
    publish(state)
    animationPause(state !== 'playing')
    arm()
    return true
  }
  async function request() {
    if (torn || inFlight) return inFlight
    if (config.error || !config.project?.trim() || !config.task?.trim()) return
    const mine = ++requestGeneration
    controller = new AbortController()
    const activeController = controller
    data = null
    index = -1
    position = 0
    publish('loading')
    inFlight = (async () => {
      try {
        const result = await Promise.race([
          (async () => {
            const response = await fetch(`/api/visualization/history?${new URLSearchParams({ project: config.project, task: config.task })}`, {
              signal: activeController.signal, headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin',
            })
            const body = await readHistoryBody(response)
            return { ok: response.ok, body: JSON.parse(body) }
          })(),
          new Promise((_, reject) => {
            requestTimer = setTimeout(() => { activeController.abort(); reject(new Error('history-timeout')) }, REQUEST_TIMEOUT_MS)
          }),
        ])
        if (torn || mine !== requestGeneration || activeController.signal.aborted) return
        if (!result.ok || result.body?.ok !== true) throw new Error('history-read-failed')
        if (!validateDashboardHistory(result.body.data, config)) throw new Error('invalid-history')
        const history = result.body.data
        if (!history.eligible || !history.steps.length) {
          data = history
          publish('unavailable', 'history-unavailable')
          return
        }
        data = history
        onStart()
        restart()
      } catch (error) {
        activeController.abort()
        if (!torn && mine === requestGeneration) {
          const code = ['history-too-large', 'history-timeout', 'invalid-history'].includes(error?.message) ? error.message : 'history-read-failed'
          publish('error', code)
        }
      } finally {
        clearTimeout(requestTimer)
        if (mine === requestGeneration) { controller = null; inFlight = null }
      }
    })()
    return inFlight
  }
  function toggle() {
    if (torn) return
    if (state === 'playing') {
      advance(Date.now())
      stopClock()
      if (state === 'ended') { publish('ended'); return }
      allowPausedLocation = false // ordinary pause never continues a positioning motion
      publish('paused')
      animationPause(true)
    } else if (state === 'paused') {
      lastTick = Date.now()
      publish('playing')
      animationPause(false)
      arm()
    } else if (state === 'ended') restart()
    else if (state !== 'loading') request()
  }
  function receive(event) {
    if (!origin || event.origin !== origin || event.source !== scope.parent || event.source === scope) return
    const command = event.data
    if (!object(command) || command.schema !== 'avo.dashboard.history-command/1'
      || command.project !== config.project || command.task !== config.task) return
    if (command.command === 'toggle') toggle()
    else if (command.command === 'seek') seek(command.position_ms)
    else if (command.command === 'restart') { if (data?.eligible) restart() }
    else if (command.command === 'status') publish(state, current.code)
  }
  scope?.addEventListener?.('message', receive)
  publish('live')
  return {
    onTerminal(terminal) {
      if (!autoAttempted && COMPLETED.includes(terminal)) { autoAttempted = true; request() }
    },
    toggle, restart, seek,
    isActive: () => ['playing', 'paused', 'ended'].includes(state),
    destroy() {
      torn = true
      requestGeneration += 1
      controller?.abort()
      clearTimeout(requestTimer)
      stopClock()
      scope?.removeEventListener?.('message', receive)
      for (const svg of scope?.document?.querySelectorAll?.('svg') || []) svg.unpauseAnimations?.()
      for (const animation of pausedAnimations) animation.play?.()
      pausedAnimations.clear()
    },
  }
}
