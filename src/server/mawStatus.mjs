// mawStatus.mjs — isolated in-memory transport for MAW office snapshots (avo.maw-snapshot/1).
//
// This channel is deliberately SEPARATE from the office-status contract:
//   - it never touches STATUS_PATH, normalizePost, scanAndMerge or the file watcher;
//   - members are dynamic `<opaque-key>~<base-role>` identities validated against the
//     four MAW base roles only (the legacy VALID_ROLES list is not consulted);
//   - a single producer lease serializes submitters (plan multi-agent-workflow-office-animation §4.1.2).
// The server owns server_epoch and the monotonic _seq; client-supplied `_seq`/`_cwd`
// fields are never trusted (they are not even part of the schema).

import { createHash, timingSafeEqual } from 'node:crypto'

export const MAW_BASE_ROLES = ['decision-maker', 'executor', 'manager', 'reviewer']
export const MAW_MEMBER_STATUSES = ['awaiting-approval', 'blocked', 'done', 'idle', 'planning', 'working']
const MAW_TASK_KINDS = ['aggregate-review', 'dev', 'plan-review', 'review']
const MAW_VERDICTS = ['fail', 'pass']
const MAW_TERMINATE = ['confirmed', 'initialized']
const MAW_TERMINALS = ['cancelled', 'completed', 'completed-with-findings']
const MAW_QUALITIES = ['degraded', 'ok', 'stale']

const SCHEMA = 'avo.maw-snapshot/1'
export const MAW_MEMBER_LIMIT = 50
export const MAW_MAX_BODY_BYTES = 16384
export const MAW_LEASE_TTL_MS = 120_000
const MAW_SSE_HEARTBEAT_MS = 15_000
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const PRODUCER_RE = /^[A-Za-z0-9_-]{8,128}$/
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function isSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function capString(value, cap) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  return value.length > cap ? null : value
}

function fail(res, status, code, message) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify({ ok: false, error: { code, message } }))
}

/**
 * Create the isolated MAW snapshot channel.
 * @param {object} [options]
 * @param {string|null} [options.token]  shared write token (OFFICE_API_TOKEN); null disables auth
 * @param {number}   [options.idleTimeoutMs] consumer-idle budget reported to the producer; 0 disables
 * @param {number}   [options.sseClientLimit]
 * @param {() => number} [options.now]
 */
export function createMawStatus({
  token = null,
  idleTimeoutMs = 30 * 60 * 1000,
  sseClientLimit = 50,
  now = () => Date.now(),
} = {}) {
  // Boot-unique (wall-clock ms): a client that saw epoch N from a previous server
  // lifetime must never accept a replayed GET as current — epoch 1 would collide
  // with the old server's early envelopes (plan §4.1.2 freshness rules).
  let epoch = Date.now()
  let serverSeq = 0
  let snapshot = null // validated members + meta, or null = no-data
  let producer = null // { id, lastSeq, lastContentSha, startedAt, touchedAt }
  let lastConsumptionAt = null
  // Quality of the LAST published envelope (null = no-data). A quality transition
  // (ok → derived stale, stale → restored ok, any → cleared) consumes a NEW server
  // seq: the derived stale snapshot otherwise shares the accepted POST's seq, so a
  // delayed transport frame carrying the older ok payload would tie on (epoch, seq)
  // and re-activate the office over newer stale state (review 2026-10-23 P1).
  let publishedQuality = null
  const sseClients = new Set()
  let heartbeat = null
  let staleTimer = null

  function touchConsumption() {
    lastConsumptionAt = now()
  }

  function consumerIdleMs() {
    const reference = lastConsumptionAt ?? producer?.startedAt ?? now()
    return Math.max(0, now() - reference)
  }

  function leaseActive() {
    return producer !== null && now() - producer.touchedAt <= MAW_LEASE_TTL_MS
  }

  function ensureHeartbeat() {
    if (heartbeat || sseClients.size === 0) return
    heartbeat = setInterval(() => {
      touchConsumption()
      for (const client of [...sseClients]) {
        try { client.write(': hb\n\n') } catch { sseClients.delete(client) }
      }
      if (sseClients.size === 0) {
        clearInterval(heartbeat)
        heartbeat = null
      }
    }, MAW_SSE_HEARTBEAT_MS)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
  }

  function broadcast() {
    const payload = `event: maw\ndata: ${JSON.stringify(envelope())}\n\n`
    for (const client of [...sseClients]) {
      try { client.write(payload) } catch { sseClients.delete(client) }
    }
  }

  function envelope() {
    const effective = effectiveSnapshot()
    const quality = effective ? effective.quality : null
    if (quality !== publishedQuality) {
      serverSeq += 1
      publishedQuality = quality
    }
    return {
      server_epoch: epoch,
      seq: serverSeq,
      snapshot: effective,
      server_time: now(),
      consumer_count: sseClients.size,
    }
  }

  function clearSnapshot() {
    snapshot = null
    producer = null
    epoch += 1
    serverSeq += 1
    publishedQuality = null
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
  }

  // The last accepted submission stays authoritative for MAW_LEASE_TTL_MS; after
  // that the channel itself publishes quality=stale (plan: "120 秒无有效新提交则
  // 服务端发布 stale"). Derived, not destructive — a fresh POST restores quality.
  function effectiveSnapshot() {
    if (snapshot === null || leaseActive()) return snapshot
    return {
      ...snapshot,
      quality: 'stale',
      quality_detail: snapshot.quality_detail ?? 'producer-lease-expired',
    }
  }

  // SSE clients have no poll loop — schedule one broadcast at lease expiry so the
  // staleness transition actually reaches them (a live SSE stream proves nothing
  // about producer liveness).
  function scheduleStaleBroadcast() {
    if (staleTimer) clearTimeout(staleTimer)
    if (snapshot === null) return
    staleTimer = setTimeout(() => {
      staleTimer = null
      if (snapshot !== null && !leaseActive()) broadcast()
    }, MAW_LEASE_TTL_MS + 50)
    if (typeof staleTimer.unref === 'function') staleTimer.unref()
  }

  function validateMember(raw, index) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `members[${index}] must be an object`
    if (typeof raw.id !== 'string' || !MEMBER_ID_RE.test(raw.id)) return `members[${index}].id must match [A-Za-z0-9_-]{1,64}`
    if (!MAW_BASE_ROLES.includes(raw.role)) return `members[${index}].role must be one of ${MAW_BASE_ROLES.join('/')}`
    if (!MAW_MEMBER_STATUSES.includes(raw.status)) return `members[${index}].status is not a transport status`
    for (const field of ['label', 'detail']) {
      if (raw[field] !== null && raw[field] !== undefined && (typeof raw[field] !== 'string' || raw[field].length > 200)) {
        return `members[${index}].${field} must be a string of at most 200 chars or null`
      }
    }
    for (const field of ['round']) {
      if (raw[field] !== null && raw[field] !== undefined && !isSafeInt(raw[field])) {
        return `members[${index}].${field} must be a safe integer or null`
      }
    }
    if (raw.task_kind !== null && raw.task_kind !== undefined && !MAW_TASK_KINDS.includes(raw.task_kind)) {
      return `members[${index}].task_kind is unknown`
    }
    if (raw.verdict !== null && raw.verdict !== undefined && !MAW_VERDICTS.includes(raw.verdict)) {
      return `members[${index}].verdict is unknown`
    }
    if (raw.terminate !== null && raw.terminate !== undefined && !MAW_TERMINATE.includes(raw.terminate)) {
      return `members[${index}].terminate is unknown`
    }
    if (raw.stalled !== undefined && typeof raw.stalled !== 'boolean') {
      return `members[${index}].stalled must be boolean`
    }
    return null
  }

  function validateSnapshot(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be a JSON object'
    if (body.schema !== SCHEMA) return `schema must be ${SCHEMA}`
    if (typeof body.producer !== 'string' || !PRODUCER_RE.test(body.producer)) return 'producer must be 8..128 chars of [A-Za-z0-9_-]'
    if (!isSafeInt(body.seq) || body.seq < 1) return 'seq must be a safe integer >= 1'
    if (!isSafeInt(body.sampled_at) || body.sampled_at < 0) return 'sampled_at must be a safe integer >= 0'
    if (body.workflow !== null && body.workflow !== undefined && (typeof body.workflow !== 'string' || body.workflow.length > 200)) {
      return 'workflow must be a string of at most 200 chars or null'
    }
    if (!MAW_QUALITIES.includes(body.quality)) return 'quality must be ok/degraded/stale'
    if (body.quality_detail !== null && body.quality_detail !== undefined && (typeof body.quality_detail !== 'string' || body.quality_detail.length > 64)) {
      return 'quality_detail must be a string of at most 64 chars or null'
    }
    if (body.terminal !== null && body.terminal !== undefined && !MAW_TERMINALS.includes(body.terminal)) {
      return 'terminal must be completed/cancelled/completed-with-findings or null'
    }
    if (!Array.isArray(body.members)) return 'members must be an array'
    if (body.members.length > MAW_MEMBER_LIMIT) return `member-limit: at most ${MAW_MEMBER_LIMIT} members`
    const seen = new Set()
    for (let i = 0; i < body.members.length; i++) {
      const problem = validateMember(body.members[i], i)
      if (problem) return problem
      if (seen.has(body.members[i].id)) return `members[${i}].id duplicates an earlier member id`
      seen.add(body.members[i].id)
    }
    return null
  }

  function readBody(req, res, cb) {
    let raw = ''
    let aborted = false
    let bytes = 0
    req.setEncoding('utf-8')
    req.on('data', (chunk) => {
      if (aborted) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAW_MAX_BODY_BYTES) {
        aborted = true
        fail(res, 413, 'payload-too-large', `snapshot must not exceed ${MAW_MAX_BODY_BYTES} bytes`)
        req.resume()
        return
      }
      raw += chunk
    })
    req.on('end', () => { if (!aborted) cb(raw) })
    req.on('error', () => { if (!aborted) { aborted = true; fail(res, 400, 'invalid-snapshot', 'request stream failed') } })
  }

  function authorized(req) {
    if (!token) return true
    const header = req.headers['x-office-token']
    const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null
    const provided = typeof header === 'string' && header.length > 0 ? header : bearer
    return typeof provided === 'string' && constantTimeEqual(provided, token)
  }

  // Bracketed IPv6 (`[::1]:5173`) contains inner colons — only split on the LAST
  // colon, and only outside brackets.
  function hostnameFromHostHeader(host) {
    const value = String(host).toLowerCase()
    if (value.startsWith('[')) {
      const end = value.indexOf(']')
      return end === -1 ? value : value.slice(0, end + 1)
    }
    return value.split(':')[0]
  }

  function hostAllowed(req) {
    const host = req.headers.host
    if (!host) return true
    const hostname = hostnameFromHostHeader(host)
    const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
    return LOOPBACK_HOSTNAMES.has(hostname) || LOOPBACK_HOSTNAMES.has(bare) || authorized(req)
  }

  function originAllowed(req) {
    const origin = req.headers.origin
    if (!origin) return true // the bridge and same-origin GETs send no Origin
    try {
      const url = new URL(origin)
      return LOOPBACK_HOSTNAMES.has(url.hostname)
    } catch {
      return false
    }
  }

  function ack(res, extra = {}) {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify({
      ok: true,
      server_epoch: epoch,
      seq: serverSeq,
      consumer_idle_ms: consumerIdleMs(),
      idle_timeout_reached: idleTimeoutMs > 0 && consumerIdleMs() >= idleTimeoutMs,
      ...extra,
    }))
  }

  function handlePost(req, res) {
    if (!originAllowed(req)) return fail(res, 403, 'origin-not-allowed', 'Origin not allowed')
    if (!authorized(req)) return fail(res, 401, 'auth-rejected', 'Missing or invalid X-Office-Token')
    readBody(req, res, (raw) => {
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return fail(res, 400, 'invalid-snapshot', 'Body is not valid JSON')
      }
      const problem = validateSnapshot(body)
      if (problem) {
        const status = problem.startsWith('member-limit') ? 400 : 400
        return fail(res, status, problem.startsWith('member-limit') ? 'member-limit' : 'invalid-snapshot', problem)
      }
      // Bind the idempotency digest to the FULL snapshot content: a replayed seq
      // with a changed workflow/quality/terminal is a conflict, not a duplicate.
      const contentSha = sha256(JSON.stringify([
        body.schema,
        body.workflow ?? null,
        body.quality,
        body.quality_detail ?? null,
        body.terminal ?? null,
        body.sampled_at,
        body.seq,
        body.members,
      ]))
      if (producer !== null && leaseActive() && producer.id !== body.producer) {
        return fail(res, 409, 'producer-conflict', 'Another producer holds the active lease')
      }
      if (producer !== null && producer.id === body.producer) {
        if (body.seq === producer.lastSeq) {
          if (body.seq === producer.lastSeq && contentSha === producer.lastContentSha) {
            return ack(res, { duplicate: true, producer_seq: body.seq })
          }
          return fail(res, 409, 'sequence-content-conflict', 'Same producer seq with different content')
        }
        if (body.seq < producer.lastSeq) {
          return fail(res, 409, 'stale-sequence', 'Producer seq is older than the accepted submission')
        }
      }
      const takeover = producer === null || producer.id !== body.producer
      if (takeover) {
        producer = { id: body.producer, lastSeq: 0, lastContentSha: null, startedAt: now(), touchedAt: now() }
      }
      producer.lastSeq = body.seq
      producer.lastContentSha = contentSha
      producer.touchedAt = now()
      serverSeq += 1
      publishedQuality = body.quality
      snapshot = {
        schema: SCHEMA,
        workflow: capString(body.workflow, 200),
        quality: body.quality,
        quality_detail: capString(body.quality_detail, 64),
        terminal: body.terminal ?? null,
        sampled_at: body.sampled_at,
        producer_id: body.producer,
        producer_seq: body.seq,
        accepted_at: now(),
        members: body.members.map((m) => ({
          id: m.id,
          role: m.role,
          status: m.status,
          label: capString(m.label, 200),
          detail: capString(m.detail, 200),
          round: m.round ?? null,
          task_kind: m.task_kind ?? null,
          verdict: m.verdict ?? null,
          terminate: m.terminate ?? null,
          stalled: m.stalled === true,
        })),
      }
      broadcast()
      scheduleStaleBroadcast()
      return ack(res, { duplicate: false, producer_seq: body.seq })
    })
  }

  function handleDelete(req, res) {
    if (!authorized(req)) return fail(res, 401, 'auth-rejected', 'Missing or invalid X-Office-Token')
    readBody(req, res, (raw) => {
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { return fail(res, 400, 'invalid-snapshot', 'Body is not valid JSON') }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return fail(res, 400, 'invalid-snapshot', 'DELETE body must be a JSON object when provided')
      }
      if (producer !== null && leaseActive() && body.producer !== producer.id) {
        return fail(res, 409, 'producer-conflict', 'Another producer holds the active lease')
      }
      clearSnapshot()
      broadcast()
      return ack(res)
    })
  }

  function handleStream(req, res) {
    if (sseClients.size >= sseClientLimit) {
      return fail(res, 503, 'sse-limit', 'Too many MAW SSE clients')
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    touchConsumption()
    sseClients.add(res)
    ensureHeartbeat()
    res.write(`event: maw\ndata: ${JSON.stringify(envelope())}\n\n`)
    req.on('close', () => {
      sseClients.delete(res)
      if (sseClients.size === 0 && heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
    })
  }

  /**
   * Connect-style middleware. Mount with `app.use('/api/maw', maw.middleware())` —
   * connect strips the mount prefix, so req.url is '/status', '/status/stream'.
   * A missing `next` (plain http.createServer mount, no connect stack) degrades to
   * a 404 instead of throwing — an unknown path must never crash the process.
   */
  function middleware(req, res, next) {
    const pathname = (req.url || '/').split('?')[0]
    if (pathname !== '/status' && pathname !== '/status/stream') {
      if (typeof next === 'function') { next(); return }
      return fail(res, 404, 'not-found', 'Unknown MAW path')
    }
    if (!hostAllowed(req)) return fail(res, 403, 'host-not-allowed', 'Host not allowed')

    if (pathname === '/status/stream' && req.method === 'GET') return handleStream(req, res)

    if (pathname === '/status') {
      if (req.method === 'GET') {
        touchConsumption()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        return res.end(JSON.stringify({ ok: true, ...envelope() }))
      }
      if (req.method === 'POST') return handlePost(req, res)
      if (req.method === 'DELETE') return handleDelete(req, res)
    }

    res.setHeader('Allow', 'GET, POST, DELETE')
    return fail(res, 405, 'method-not-allowed', 'Method not allowed')
  }

  /** Test/diagnostic view — never exposed over HTTP. */
  function stats() {
    return {
      epoch,
      serverSeq,
      hasSnapshot: snapshot !== null,
      memberCount: snapshot ? snapshot.members.length : 0,
      producerId: producer ? producer.id : null,
      leaseActive: leaseActive(),
      sseClients: sseClients.size,
      consumerIdleMs: consumerIdleMs(),
    }
  }

  function stop() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
    for (const client of [...sseClients]) { try { client.end() } catch { /* already gone */ } }
    sseClients.clear()
  }

  return { middleware, stats, stop, MAW_BASE_ROLES }
}
