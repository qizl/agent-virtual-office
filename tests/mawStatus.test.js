import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createMawStatus, MAW_MEMBER_LIMIT, MAW_MAX_BODY_BYTES } from '../src/server/mawStatus.mjs'

// Drive the connect-style middleware through a real HTTP server so POST/GET/SSE
// semantics (lease, epoch/seq, consumer idle) are exercised end to end.

function startServer(maw, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = (req.url || '/').split('?')[0]
      if (pathname.startsWith('/api/maw/')) {
        req.url = pathname.slice('/api/maw'.length)
        // Deliberately NO next — the raw-http mount shape; unknown paths must
        // 404 from the middleware guard itself, never throw.
        return maw.middleware(req, res)
      }
      res.statusCode = 404
      res.end()
    })
    server.listen(0, host, () => resolve({ server, base: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}` }))
  })
}

function snapshot(overrides = {}) {
  return {
    schema: 'avo.maw-snapshot/1',
    producer: 'producer-aaaa',
    seq: 1,
    sampled_at: 1000,
    workflow: 'MAW 执行与审核流程 · evaluate',
    quality: 'ok',
    quality_detail: null,
    terminal: null,
    members: [
      { id: 'task01x', role: 'manager', status: 'awaiting-approval', label: '等待交付评估', detail: null, round: null, task_kind: null, verdict: null, terminate: null, stalled: false },
      { id: 'task02y', role: 'executor', status: 'working', label: 'slice-001 · round 1', detail: null, round: 1, task_kind: 'dev', verdict: null, terminate: null, stalled: false },
      { id: 'task03z', role: 'executor', status: 'planning', label: 'slice-002 · round 1', detail: null, round: 1, task_kind: 'dev', verdict: null, terminate: null, stalled: false },
      { id: 'task04w', role: 'reviewer', status: 'idle', label: null, detail: null, round: null, task_kind: null, verdict: null, terminate: 'confirmed', stalled: false },
    ],
    ...overrides,
  }
}

let clock = 1_000_000
let cleanup = []

async function makeChannel(options = {}) {
  const maw = createMawStatus({ now: () => clock, idleTimeoutMs: 0, ...options })
  const { server, base } = await startServer(maw)
  cleanup.push(() => new Promise((done) => { maw.stop(); server.close(done) }))
  return { maw, base }
}

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()))
  cleanup = []
})

describe('MAW snapshot transport', () => {
  it('GET with no data returns ok with a null snapshot and a boot-unique epoch', async () => {
    const { base } = await makeChannel()
    const res = await fetch(`${base}/api/maw/status`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    // Boot-unique (wall-clock ms), never 1: a client that saw a previous server
    // lifetime's epoch must not confuse a replayed GET with current state.
    expect(Number.isInteger(body.server_epoch)).toBe(true)
    expect(body.server_epoch).toBeGreaterThan(0)
    expect(body.snapshot).toBeNull()
  })

  it('POST replaces the full member set and GET returns it with server epoch/seq', async () => {
    const { base } = await makeChannel()
    const post = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    const ack = await post.json()
    expect(post.status).toBe(200)
    expect(ack.ok).toBe(true)
    expect(ack.duplicate).toBe(false)
    expect(ack.seq).toBe(1)

    const get = await fetch(`${base}/api/maw/status`)
    const body = await get.json()
    expect(body.snapshot.members).toHaveLength(4)
    expect(body.snapshot.members.map((m) => m.id)).toEqual(['task01x', 'task02y', 'task03z', 'task04w'])
    expect(body.snapshot.workflow).toBe('MAW 执行与审核流程 · evaluate')
    expect(body.server_epoch).toBe(ack.server_epoch)
  })

  it('same seq + same content is an idempotent duplicate; same seq + new content is a 409', async () => {
    const { base } = await makeChannel()
    await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    const dup = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    const dupAck = await dup.json()
    expect(dup.status).toBe(200)
    expect(dupAck.duplicate).toBe(true)

    const conflict = await fetch(`${base}/api/maw/status`, {
      method: 'POST',
      body: JSON.stringify(snapshot({ sampled_at: 2000, members: snapshot().members.slice(0, 1) })),
    })
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error.code).toBe('sequence-content-conflict')
  })

  it('older producer seq is rejected without overwriting', async () => {
    const { base } = await makeChannel()
    await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot({ seq: 5 })) })
    const stale = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot({ seq: 4 })) })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error.code).toBe('stale-sequence')
  })

  it('a second producer gets 409 while the lease is live and may take over after the TTL', async () => {
    const { base, maw } = await makeChannel()
    await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    const other = snapshot({ producer: 'producer-bbbb', seq: 1 })
    const rejected = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(other) })
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('producer-conflict')

    clock += 121_000 // lease TTL elapsed
    const takeover = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(other) })
    expect(takeover.status).toBe(200)
    expect(maw.stats().producerId).toBe('producer-bbbb')
  })

  it('member-limit and body-size limits are explicit rejections', async () => {
    const { base } = await makeChannel()
    const many = snapshot({ members: Array.from({ length: MAW_MEMBER_LIMIT + 1 }, (_, i) => ({ id: `m${i}xxx`, role: 'executor', status: 'idle' })) })
    const limited = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(many) })
    expect(limited.status).toBe(400)
    expect((await limited.json()).error.code).toBe('member-limit')

    const big = 'x'.repeat(MAW_MAX_BODY_BYTES + 1)
    const oversized = await fetch(`${base}/api/maw/status`, { method: 'POST', body: big })
    expect(oversized.status).toBe(413)
    expect((await oversized.json()).error.code).toBe('payload-too-large')
  })

  it('unknown roles, statuses and schemas are invalid-snapshot rejections', async () => {
    const { base } = await makeChannel()
    for (const bad of [
      snapshot({ schema: 'office-status' }),
      snapshot({ members: [{ id: 'bad1xxx', role: 'dev', status: 'working' }] }),
      snapshot({ members: [{ id: 'bad2xxx', role: 'executor', status: 'thinking' }] }),
      snapshot({ members: [{ id: 'bad~role', role: 'executor', status: 'idle' }] }),
      snapshot({ members: [{ id: 'dup1xxxx', role: 'executor', status: 'idle' }, { id: 'dup1xxxx', role: 'reviewer', status: 'idle' }] }),
    ]) {
      const res = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(bad) })
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('invalid-snapshot')
    }
  })

  it('foreign Origins are rejected; the bridge (no Origin) is accepted', async () => {
    const { base } = await makeChannel()
    const foreign = await fetch(`${base}/api/maw/status`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: JSON.stringify(snapshot()),
    })
    expect(foreign.status).toBe(403)
    expect((await foreign.json()).error.code).toBe('origin-not-allowed')

    const bridge = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    expect(bridge.status).toBe(200)
  })

  it('token auth applies to POST and DELETE when configured', async () => {
    const { base } = await makeChannel({ token: 'sekrit' })
    const missing = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    expect(missing.status).toBe(401)
    const wrong = await fetch(`${base}/api/maw/status`, { method: 'POST', headers: { 'X-Office-Token': 'nope' }, body: JSON.stringify(snapshot()) })
    expect(wrong.status).toBe(401)
    const good = await fetch(`${base}/api/maw/status`, { method: 'POST', headers: { 'X-Office-Token': 'sekrit' }, body: JSON.stringify(snapshot()) })
    expect(good.status).toBe(200)
  })

  it('DELETE by the lease holder clears to no-data and bumps the epoch', async () => {
    const { base } = await makeChannel()
    await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    const before = (await (await fetch(`${base}/api/maw/status`)).json()).server_epoch
    const del = await fetch(`${base}/api/maw/status`, { method: 'DELETE', body: JSON.stringify({ producer: 'producer-aaaa' }) })
    expect(del.status).toBe(200)
    const get = await fetch(`${base}/api/maw/status`)
    const body = await get.json()
    expect(body.snapshot).toBeNull()
    expect(body.server_epoch).toBe(before + 1)

    const other = await fetch(`${base}/api/maw/status`, { method: 'DELETE', body: JSON.stringify({ producer: 'someone-else' }) })
    expect(other.status).toBe(200) // no active lease after release — harmless
  })

  it('SSE streams the same snapshot and counts as consumption', async () => {
    const { base } = await makeChannel({ idleTimeoutMs: 60_000 })
    const events = []
    const controller = new AbortController()
    const stream = fetch(`${base}/api/maw/status/stream`, { signal: controller.signal })
    const reader = (await stream).body.getReader()
    const decoder = new TextDecoder()
    const readUntil = async (needle) => {
      let buf = ''
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
      return buf
    }
    await readUntil('event: maw')

    await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot({ seq: 2 })) })
    const chunk = await readUntil('task03z')
    expect(chunk).toContain('event: maw')
    const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '))
    const envelope = JSON.parse(dataLine.slice(6))
    expect(envelope.snapshot.members).toHaveLength(4)
    expect(envelope.server_epoch).toBeGreaterThan(0)
    events.push(envelope)

    // An SSE connection counts as a live consumer.
    const post = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot({ seq: 3 })) })
    const ack = await post.json()
    expect(ack.consumer_idle_ms).toBeLessThan(60_000)
    expect(ack.idle_timeout_reached).toBe(false)
    controller.abort()
  })

  it('consumer idle is measured from producer start when no consumer ever appeared', async () => {
    const { base, maw } = await makeChannel({ idleTimeoutMs: 30 * 60 * 1000 })
    const ack = await (await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })).json()
    expect(ack.consumer_idle_ms).toBe(0)
    clock += 31 * 60 * 1000
    const later = await (await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot({ seq: 2 })) })).json()
    expect(later.consumer_idle_ms).toBeGreaterThanOrEqual(30 * 60 * 1000)
    expect(later.idle_timeout_reached).toBe(true)
    expect(maw.stats().hasSnapshot).toBe(true) // the server reports; the bridge decides to stop
  })
})

describe('MAW transport hardening (review 2026-10-22)', () => {
  it('an unknown /api/maw path 404s instead of crashing the process', async () => {
    const { base } = await makeChannel()
    const res = await fetch(`${base}/api/maw/unknown`)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not-found')
    // the channel still serves after the rejected probe
    const ok = await fetch(`${base}/api/maw/status`)
    expect(ok.status).toBe(200)
  })

  it('a lease-expired snapshot is served as derived stale; a fresh POST restores quality', async () => {
    const { base } = await makeChannel()
    await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    clock += 121_000 // beyond MAW_LEASE_TTL_MS
    const stale = await (await fetch(`${base}/api/maw/status`)).json()
    expect(stale.snapshot.quality).toBe('stale')
    expect(stale.snapshot.quality_detail).toBe('producer-lease-expired')
    expect(stale.snapshot.members).toHaveLength(4) // last valid content is preserved, not cleared

    const fresh = snapshot({ seq: 2, sampled_at: 2000 }) // same producer, seq advanced — resumes after expiry
    const ack = await (await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(fresh) })).json()
    expect(ack.ok).toBe(true)
    const good = await (await fetch(`${base}/api/maw/status`)).json()
    expect(good.snapshot.quality).toBe('ok')
  })

  it('the idempotent duplicate digest binds the full snapshot, not just members', async () => {
    const { base } = await makeChannel()
    await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) })
    for (const drift of [
      snapshot({ workflow: 'MAW 执行与审核流程 · review' }), // workflow changed
      snapshot({ quality: 'degraded' }), // quality changed
      snapshot({ terminal: 'completed' }), // terminal changed
    ]) {
      const res = await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(drift) })
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe('sequence-content-conflict')
    }
  })

  it('malformed DELETE bodies are explicit 400s, not crashes', async () => {
    const { base } = await makeChannel()
    await fetch(`${base}/api/maw/status`, { method: 'POST', body: JSON.stringify(snapshot()) }) // lease active
    for (const body of ['null', '[1,2]', '"producer-aaaa"']) {
      const res = await fetch(`${base}/api/maw/status`, { method: 'DELETE', body })
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('invalid-snapshot')
    }
    const stillThere = await (await fetch(`${base}/api/maw/status`)).json()
    expect(stillThere.snapshot).not.toBeNull()

    const noBody = await fetch(`${base}/api/maw/status`, { method: 'DELETE' })
    expect(noBody.status).toBe(409) // body-less DELETE cannot name the lease holder
  })

  it('a bracketed IPv6 loopback Host is accepted', async () => {
    const maw = createMawStatus({ now: () => clock, idleTimeoutMs: 0 })
    const { server, base } = await startServer(maw, '::1')
    cleanup.push(() => new Promise((done) => { maw.stop(); server.close(done) }))
    const res = await fetch(`${base}/api/maw/status`) // Host: [::1]:<port>
    expect(res.status).toBe(200)
  })
})
