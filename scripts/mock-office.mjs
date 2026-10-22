#!/usr/bin/env node
/**
 * Mock driver for the office status API — plays a fictional but contract-valid
 * workday so the scene has statuses, blocked reasons and CI moments to animate
 * without a live Claude Code session.
 *
 * Uses ONLY the public transport contract (src/utils/statusContract.mjs):
 *   POST /api/status  full format { type:'office-status', agents:[...], mood }
 *   POST /api/event   one-shot CI events (test-failed, deploy-success, ...)
 *
 * Usage:
 *   node scripts/mock-office.mjs                       # loop until Ctrl-C
 *   node scripts/mock-office.mjs --once                # one pass, then exit
 *   node scripts/mock-office.mjs --url http://localhost:5174 --every 6000
 *
 * Rate-limit friendly: one status POST per beat (default dwell 9s), far under
 * the server's 30-POST/10s budget. An optional /api/event rides mid-beat.
 */

function flagValue(name) {
  const argv = process.argv
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.split('=')[1]
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}

const BASE = (flagValue('url') || 'http://localhost:5173').replace(/\/$/, '')
const EVERY = (() => {
  const n = parseInt(flagValue('every'), 10)
  return Number.isFinite(n) && n >= 3000 ? n : 9000
})()
const ONCE = process.argv.includes('--once')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

const FILES = [
  'App.jsx', 'PixelOffice.jsx', 'store.js', 'classify.js', 'api.ts',
  'tokens.css', 'deploy.yml', 'soak-report.md', 'paper.pdf', 'motion.js',
]
const file = () => pick(FILES)

function A(role, status, task, label, extra = {}) {
  return { role, status, task: task ?? null, label: label ?? null, ...extra }
}

// One full-cast snapshot per beat. Scenes read as a day: standup → grind →
// failing tests → fix → green → ship → incident → calm, then it loops.
const SCENES = [
  () => ({
    note: 'morning standup',
    workflow: 'Sprint 42 · standup',
    agents: [
      A('pm', 'planning', 'Read', '📋 Sprint board'),
      A('arch', 'working', 'Read', '📐 system sketch'),
      A('dev', 'working', 'Edit', `✏️ ${file()}`),
      A('qa', 'idle'), A('ops', 'idle'), A('res', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'deep work',
    workflow: 'Sprint 42 · feature work',
    agents: [
      A('dev', 'working', 'Edit', `✏️ ${file()}`),
      A('designer', 'working', 'Edit', `🎨 ${file()}`),
      A('res', 'working', 'Read', `📚 ${file()}`),
      A('pm', 'working', 'WebSearch', '🔎 competitive scan'),
      A('qa', 'working', 'Glob', '🗂️ picking test cases'),
      A('arch', 'idle'), A('ops', 'idle'), A('gate', 'idle'),
    ],
  }),
  () => ({
    note: 'QA kicks off the test suite',
    workflow: 'Sprint 42 · verification',
    agents: [
      A('qa', 'working', 'Bash', '🧪 npm test'),
      A('dev', 'working', 'Write', `✏️ ${file()}`),
      A('ops', 'working', 'Bash', '🏗️ staging build'),
      A('res', 'idle'), A('pm', 'idle'), A('arch', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'tests are red',
    workflow: 'Sprint 42 · verification',
    mood: 'frustrated',
    moodDuration: 120000,
    event: 'test-failed',
    agents: [
      A('qa', 'blocked', 'Bash', '❌ 3 failing', { reasonCode: 'test-run-failed' }),
      A('dev', 'working', 'Read', '🔍 reading the traceback'),
      A('arch', 'idle'), A('ops', 'idle'), A('pm', 'idle'),
      A('res', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'dev repros while QA waits on a rerun',
    workflow: 'Sprint 42 · verification',
    agents: [
      A('dev', 'working', 'Bash', '🔁 repro on :5173'),
      A('qa', 'blocked', 'Bash', '↻ rerun #2', { reasonCode: 'test-run-failed' }),
      A('arch', 'working', 'Grep', '🔎 where is this called?'),
      A('pm', 'idle'), A('ops', 'idle'), A('res', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'the fix lands, gate still wants its prerequisites',
    workflow: 'Sprint 42 · verification',
    agents: [
      A('dev', 'working', 'Edit', `✏️ ${file()}`),
      A('gate', 'blocked', 'Task', '🛡️ prerequisites not met', { reasonCode: 'deps-failed' }),
      A('qa', 'working', 'Bash', '🧪 npm test'),
      A('designer', 'working', 'WebSearch', '💡 padding references'),
      A('pm', 'idle'), A('arch', 'idle'), A('ops', 'idle'), A('res', 'idle'),
    ],
  }),
  () => ({
    note: 'green — QA signs off',
    workflow: 'Sprint 42 · review',
    event: 'test-passed',
    agents: [
      A('qa', 'done', 'Bash', '✅ Tests passed!'),
      A('dev', 'done', 'Edit', '✅ fixed'),
      A('gate', 'done', 'Task', '✅ prerequisites met'),
      A('pm', 'idle'), A('arch', 'idle'), A('ops', 'idle'), A('res', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'PR is up, QA reviews',
    workflow: 'Sprint 42 · review',
    event: 'pr-opened',
    agents: [
      A('dev', 'done', 'Task', '📋 PR opened'),
      A('qa', 'working', 'Read', '🔎 line-by-line review'),
      A('arch', 'working', 'Read', '📐 design check'),
      A('pm', 'idle'), A('ops', 'idle'), A('res', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'review approved, cutting the release',
    workflow: 'Sprint 42 · release',
    event: 'release-cut',
    agents: [
      A('qa', 'done', 'Read', '✅ Review approved'),
      A('ops', 'working', 'Bash', '📦 cutting release...'),
      A('dev', 'idle'), A('pm', 'idle'), A('arch', 'idle'),
      A('res', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'deploy rolls out',
    workflow: 'Sprint 42 · release',
    event: 'deploy-start',
    agents: [
      A('ops', 'working', 'Bash', '🚀 Deploying...'),
      A('pm', 'working', 'Read', '👀 watching the dashboard'),
      A('dev', 'idle'), A('qa', 'idle'), A('arch', 'idle'),
      A('res', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'shipped! the room loses it',
    workflow: 'Sprint 42 · shipped',
    mood: 'smooth',
    moodDuration: 180000,
    event: 'deploy-success',
    agents: [
      A('ops', 'done', 'Bash', '🎉 Deployed!'),
      A('dev', 'done', null, '🎉 Ship it!'),
      A('qa', 'done', null, '✅ Quality approved'),
      A('pm', 'done', null, '📈 chart goes up'),
      A('arch', 'done', null, '🏗️ architecture held'),
      A('res', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'a wild incident appears',
    workflow: 'hotfix · incident',
    mood: 'intense',
    moodDuration: 120000,
    event: 'incident-start',
    agents: [
      A('ops', 'blocked', 'Bash', '🚨 incident started', { reasonCode: 'build-failed' }),
      A('dev', 'working', 'Bash', '🔥 investigating...'),
      A('pm', 'planning', 'Read', '📉 status page'),
      A('qa', 'idle'), A('arch', 'idle'), A('res', 'idle'), A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
  () => ({
    note: 'rolled forward, all quiet again',
    workflow: 'hotfix · resolved',
    event: 'incident-resolved',
    agents: [
      A('ops', 'done', 'Bash', '✅ Incident resolved'),
      A('dev', 'done', null, '✅ patch up'),
      A('pm', 'idle'), A('qa', 'idle'), A('arch', 'idle'),
      A('res', 'working', 'Read', '📚 postmortem reading'),
      A('gate', 'idle'), A('designer', 'idle'),
    ],
  }),
]

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

const ts = () => new Date().toTimeString().slice(0, 8)

async function playScene(scene) {
  const beat = scene()
  await post('/api/status', {
    type: 'office-status',
    agents: beat.agents,
    workflow: beat.workflow,
    mood: beat.mood ?? null,
    moodDuration: beat.moodDuration,
    source: 'mock',
  })
  console.log(`[${ts()}] ▶ ${beat.note}${beat.event ? `  (+event: ${beat.event})` : ''}`)
  if (beat.event) {
    await sleep(Math.min(4000, Math.floor(EVERY / 2)))
    await post('/api/event', { event: beat.event, workflow: beat.workflow })
  }
}

async function main() {
  console.log(`Mock office driver → ${BASE}  (beat every ${EVERY}ms${ONCE ? ', one pass' : ', looping'})`)
  try {
    await fetch(BASE + '/api/health')
  } catch {
    console.error(`Office is not reachable at ${BASE} — start it first with "npm run dev".`)
    process.exit(1)
  }
  do {
    for (const scene of SCENES) {
      await playScene(scene)
      await sleep(EVERY)
    }
  } while (!ONCE)
  console.log('One pass done. Statuses expire on their own (5 min TTL).')
}

main().catch((err) => {
  console.error(`mock driver failed: ${err.message}`)
  process.exit(1)
})
