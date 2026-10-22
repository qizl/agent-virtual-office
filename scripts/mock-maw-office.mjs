#!/usr/bin/env node
/**
 * scripts/mock-maw-office.mjs — feed the MAW channel (avo.maw-snapshot/1) a
 * fictional but contract-valid collaboration so `?mode=maw` animates.
 *
 * Same spirit as scripts/mock-office.mjs, but for the isolated /api/maw/status
 * channel: every submission is the FULL member set, seq increments each time,
 * and the storyline exercises the honest states (working / awaiting-approval /
 * rework / terminal) — never fabricated tool activity.
 *
 * Usage:
 *   node scripts/mock-maw-office.mjs [--office-url=http://127.0.0.1:5173] [--every=5000] [--once]
 *   (space-separated --every 5000 also works)
 */

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.split('=').slice(1).join('=')
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const hasFlag = (name) => args.includes(`--${name}`)

const BASE_URL = argOf('office-url', 'http://127.0.0.1:5173')
const EVERY = Math.max(500, parseInt(argOf('every', '5000'), 10) || 5000)
const ONCE = hasFlag('once')

// Stable opaque member keys — identity persists across rounds (plan §4.1.1).
const M = {
  mgr: 'mgr0001',
  dm: 'dm000001',
  exe1: 'exe00001',
  exe2: 'exe00002',
  rev: 'rev00001',
}

function m(key, role, status, label, extra = {}) {
  return { id: key, role, status, label, detail: null, round: null, task_kind: null, verdict: null, terminate: null, stalled: false, ...extra }
}

// 12-beat workday: standup → develop ×2 → deliver → review → fail → rework →
// pass → evaluate → shutdown → completed → (loop).
const BEATS = [
  {
    workflow: null,
    members: [
      m(M.mgr, 'manager', 'idle', null),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'idle', null),
      m(M.exe2, 'executor', 'idle', null),
      m(M.rev, 'reviewer', 'idle', null),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · team',
    members: [
      m(M.mgr, 'manager', 'working', '晨会 · 团队就绪'),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'planning', 'slice-001 · round 1', { round: 1, task_kind: 'dev' }),
      m(M.exe2, 'executor', 'idle', null),
      m(M.rev, 'reviewer', 'idle', null),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · develop',
    members: [
      m(M.mgr, 'manager', 'working', '节点 develop 进行中'),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'working', '✏️ slice-001 · round 1', { round: 1, task_kind: 'dev' }),
      m(M.exe2, 'executor', 'idle', '待命'),
      m(M.rev, 'reviewer', 'idle', '待命'),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · develop',
    members: [
      m(M.mgr, 'manager', 'working', '节点 develop 进行中'),
      m(M.dm, 'decision-maker', 'working', '权衡 slice-002 范围'),
      m(M.exe1, 'executor', 'working', '✏️ slice-001 · round 1', { round: 1, task_kind: 'dev' }),
      m(M.exe2, 'executor', 'working', '✏️ slice-002 · round 1', { round: 1, task_kind: 'dev' }),
      m(M.rev, 'reviewer', 'idle', '待命'),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · develop',
    members: [
      m(M.mgr, 'manager', 'working', '节点 develop 进行中'),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'awaiting-approval', '已交付待评审 · round 1', { round: 1, task_kind: 'dev' }),
      m(M.exe2, 'executor', 'working', '✏️ slice-002 · round 1', { round: 1, task_kind: 'dev' }),
      m(M.rev, 'reviewer', 'working', '🔍 评审 slice-001', { round: 1, task_kind: 'review' }),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · develop',
    members: [
      m(M.mgr, 'manager', 'working', '节点 develop 进行中'),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'awaiting-approval', '已交付 · 评审中 round 1', { round: 1, task_kind: 'dev' }),
      m(M.exe2, 'executor', 'awaiting-approval', '已交付待评审 · round 1', { round: 1, task_kind: 'dev' }),
      m(M.rev, 'reviewer', 'working', '🔍 评审 slice-001 · attempt', { round: 1, task_kind: 'review' }),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · develop',
    members: [
      m(M.mgr, 'manager', 'working', '节点 develop · 返修调度'),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'blocked', '❌ 需返修 · round 1', { round: 1, task_kind: 'dev', verdict: 'fail' }),
      m(M.exe2, 'executor', 'blocked', '❌ 需返修 · round 1', { round: 1, task_kind: 'dev', verdict: 'fail' }),
      m(M.rev, 'reviewer', 'done', '❌ 评审未通过 · round 1', { round: 1, task_kind: 'review', verdict: 'fail' }),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · develop',
    members: [
      m(M.mgr, 'manager', 'working', '节点 develop 进行中'),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'working', '✏️ slice-001 · round 2', { round: 2, task_kind: 'dev' }),
      m(M.exe2, 'executor', 'working', '✏️ slice-002 · round 2', { round: 2, task_kind: 'dev' }),
      m(M.rev, 'reviewer', 'idle', '待命'),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · develop',
    members: [
      m(M.mgr, 'manager', 'working', '节点 develop 进行中'),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'awaiting-approval', '已交付待评审 · round 2', { round: 2, task_kind: 'dev' }),
      m(M.exe2, 'executor', 'awaiting-approval', '已交付待评审 · round 2', { round: 2, task_kind: 'dev' }),
      m(M.rev, 'reviewer', 'working', '🔍 评审 · round 2', { round: 2, task_kind: 'review' }),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · evaluate',
    members: [
      m(M.mgr, 'manager', 'awaiting-approval', '等待交付评估 · finish-required'),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'done', '✅ round 2 通过', { round: 2, task_kind: 'dev', verdict: 'pass' }),
      m(M.exe2, 'executor', 'done', '✅ round 2 通过', { round: 2, task_kind: 'dev', verdict: 'pass' }),
      m(M.rev, 'reviewer', 'done', '✅ 评审通过 · round 2', { round: 2, task_kind: 'review', verdict: 'pass' }),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · shutdown',
    members: [
      m(M.mgr, 'manager', 'awaiting-approval', '等待成员退出确认'),
      m(M.dm, 'decision-maker', 'done', '已退出 🏁', { terminate: 'confirmed' }),
      m(M.exe1, 'executor', 'awaiting-approval', '收尾确认中', { terminate: 'initialized' }),
      m(M.exe2, 'executor', 'awaiting-approval', '收尾确认中', { terminate: 'initialized' }),
      m(M.rev, 'reviewer', 'done', '已退出 🏁', { terminate: 'confirmed' }),
    ],
  },
  {
    workflow: 'MAW 执行与审核流程 · 已收尾',
    terminal: 'completed',
    members: [
      m(M.mgr, 'manager', 'done', '流程收尾完成'),
      m(M.dm, 'decision-maker', 'done', '已退出 🏁', { terminate: 'confirmed' }),
      m(M.exe1, 'executor', 'done', '🏁 已退出', { terminate: 'confirmed' }),
      m(M.exe2, 'executor', 'done', '🏁 已退出', { terminate: 'confirmed' }),
      m(M.rev, 'reviewer', 'done', '已退出 🏁', { terminate: 'confirmed' }),
    ],
  },
  // calm tail: everything idle before the next loop (no stale terminal marker)
  {
    workflow: null,
    members: [
      m(M.mgr, 'manager', 'idle', null),
      m(M.dm, 'decision-maker', 'idle', null),
      m(M.exe1, 'executor', 'idle', null),
      m(M.exe2, 'executor', 'idle', null),
      m(M.rev, 'reviewer', 'idle', null),
    ],
  },
]

let seq = 0
let beat = 0

async function healthCheck() {
  const res = await fetch(`${BASE_URL}/api/health`)
  if (!res.ok) throw new Error(`health ${res.status}`)
}

async function publish(beatIndex) {
  const beatData = BEATS[beatIndex % BEATS.length]
  seq += 1
  const payload = {
    schema: 'avo.maw-snapshot/1',
    producer: `mock-maw-${process.pid.toString(36)}`,
    seq,
    sampled_at: Date.now(),
    workflow: beatData.workflow,
    quality: 'ok',
    quality_detail: null,
    terminal: beatData.terminal ?? null,
    members: beatData.members,
  }
  let res = await fetch(`${BASE_URL}/api/maw/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.status === 409) {
    // Demo tool: take over an active lease explicitly (GET -> DELETE by its id -> retry).
    const current = await (await fetch(`${BASE_URL}/api/maw/status`)).json()
    const holder = current.snapshot?.producer_id
    if (holder) {
      console.log(`[mock-maw] taking over lease from ${holder}`)
      await fetch(`${BASE_URL}/api/maw/status`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ producer: holder }),
      })
      res = await fetch(`${BASE_URL}/api/maw/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }
  }
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`POST ${res.status}: ${body.slice(0, 200)}`)
  }
  const ack = await res.json()
  const title = beatData.workflow ?? '(calm)'
  console.log(`[${new Date().toLocaleTimeString()}] ▶ beat ${(beatIndex % BEATS.length) + 1}/${BEATS.length} · ${title}`)
  if (ack.idle_timeout_reached) {
    console.log('[mock-maw] office reports no consumer — stopping (idle-timeout)')
    return false
  }
  return true
}

await healthCheck()
console.log(`mock MAW producer → ${BASE_URL}  (beat every ${EVERY}ms, ${ONCE ? 'one pass' : 'looping'})`)

if (ONCE) {
  for (let i = 0; i < BEATS.length; i++) {
    await publish(i)
    await new Promise((r) => setTimeout(r, Math.min(EVERY, 1200)))
  }
  console.log('one pass complete')
  process.exit(0)
}

let alive = true
while (alive) {
  alive = await publish(beat)
  beat += 1
  if (alive) await new Promise((r) => setTimeout(r, EVERY))
}
process.exit(0)
