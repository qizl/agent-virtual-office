import { validateDashboardSnapshot } from './dashboardSnapshot.js'

const STEP_MS = 4000
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

// Each iframe owns its history request, clock, and fixed binding. Frames contain only
// recorded facts; they never enter live choreography or interpolate unseen activity.
export function createDashboardHistoryController({ config, onStart, onFrame, onState, onPause,
  scope = typeof window === 'undefined' ? null : window }) {
  let torn = false
  let requestGeneration = 0
  let controller = null
  let requestTimer = null
  let timer = null
  let data = null
  let state = 'live'
  let index = -1
  let remaining = STEP_MS
  let startedAt = 0
  let autoAttempted = false
  let inFlight = null
  let current = { state, step: 0, total: 0, complete: true, message: null, code: null, label: null, recorded_at: null }
  const origin = scope?.location?.origin

  function publish(next, code = null) {
    if (torn) return
    state = next
    const step = data?.steps[index]
    current = { state, step: index + 1, total: data?.steps.length || 0, complete: data?.complete ?? true,
      code, label: step?.label || null, recorded_at: step?.recorded_at ?? null,
      message: data ? ['任务记录回顾 · 非实时', step?.label,
        step ? (step.recorded_at || '时间未记录') : null,
        data.complete ? null : '历史不完整', ...(data.warnings || []).map((warning) => WARNING_MESSAGES[warning] || '部分历史记录不可用')]
        .filter(Boolean).join(' · ').slice(0, 2048) : ERROR_MESSAGES[code] || null }
    if (next === 'unavailable' && !data?.steps.length && !data?.warnings?.length) current.message = '没有可播放的已记录里程碑'
    onState(current)
    if (origin && scope?.parent && scope.parent !== scope) {
      scope.parent.postMessage({ schema: 'avo.dashboard.history-state/1', project: config.project, task: config.task, ...current }, origin)
    }
  }
  function animationPause(paused) {
    onPause(paused)
    // pauseAnimations freezes the root SVG document time, including newly mounted SMIL.
    for (const svg of scope?.document?.querySelectorAll?.('svg') || []) {
      if (paused) svg.pauseAnimations?.()
      else svg.unpauseAnimations?.()
    }
  }
  function arm() {
    clearTimeout(timer)
    startedAt = Date.now()
    timer = setTimeout(() => {
      if (torn || state !== 'playing') return
      if (index + 1 < data.steps.length) {
        index += 1
        remaining = STEP_MS
        onFrame(data.steps[index].snapshot)
        publish('playing')
        arm()
      } else {
        onFrame(data.final_snapshot)
        publish('ended')
        animationPause(true)
      }
    }, remaining)
  }
  function restart() {
    if (!data?.eligible || !data.steps.length || torn) return
    clearTimeout(timer)
    index = 0
    remaining = STEP_MS
    onFrame(data.steps[index].snapshot)
    publish('playing')
    animationPause(false)
    arm()
  }
  async function request() {
    if (torn || inFlight) return inFlight
    if (config.error || !config.project?.trim() || !config.task?.trim()) return
    const mine = ++requestGeneration
    controller = new AbortController()
    const activeController = controller
    data = null
    index = -1
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
      remaining = Math.max(0, remaining - (Date.now() - startedAt))
      clearTimeout(timer)
      publish('paused')
      animationPause(true)
    } else if (state === 'paused') {
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
    else if (command.command === 'restart') { if (data?.eligible) restart() }
    else if (command.command === 'status') publish(state, current.code)
  }
  scope?.addEventListener?.('message', receive)
  publish('live')
  return {
    onTerminal(terminal) {
      if (!autoAttempted && COMPLETED.includes(terminal)) { autoAttempted = true; request() }
    },
    toggle, restart,
    isActive: () => ['playing', 'paused', 'ended'].includes(state),
    destroy() {
      torn = true
      requestGeneration += 1
      controller?.abort()
      clearTimeout(requestTimer)
      clearTimeout(timer)
      scope?.removeEventListener?.('message', receive)
      for (const svg of scope?.document?.querySelectorAll?.('svg') || []) svg.unpauseAnimations?.()
    },
  }
}
