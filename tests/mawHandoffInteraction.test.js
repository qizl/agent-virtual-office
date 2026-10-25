import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOfficeStore } from '../src/systems/store.js'
import { startMawChoreography } from '../src/systems/mawChoreography.js'
import { mawHandoffId } from '../src/inference/dashboardSnapshot.js'

const devTask = { seq: 1, round: 1, type: 'dev', source_ref: 'executor-1/task-001.json', ref_task: null }
const reviewTask = { seq: 2, round: 1, type: 'review', source_ref: 'reviewer-1/task-002.json', ref_task: devTask.source_ref }
const edge = {
  id: mawHandoffId('submission', 'executor-one', 'reviewer-one', devTask.source_ref, reviewTask.source_ref),
  kind: 'submission', sender_member_id: 'executor-one', recipient_member_id: 'reviewer-one',
  source_task: devTask.source_ref, target_task: reviewTask.source_ref,
}

function snapshot({ seq, sourceStatus = 'working', handoffs = [], handoffState = 'complete', reviewerStatus = 'planning' }) {
  return {
    schema: 'avo.maw-snapshot/1', sampled_at: seq * 1000, workflow: 'develop', quality: 'ok', quality_detail: null,
    terminal: null, assignment_state: 'assigned', handoff_state: handoffState, handoffs,
    members: [
      { id: 'executor-one', role: 'executor', status: sourceStatus, label: 'Executor One', detail: null, round: 1,
        task_kind: 'dev', verdict: null, terminate: null, stalled: false, current_task: devTask, handoff_pending: null },
      { id: 'reviewer-one', role: 'reviewer', status: reviewerStatus, label: 'Reviewer One', detail: null, round: 1,
        task_kind: 'review', verdict: null, terminate: null, stalled: false, current_task: reviewTask, handoff_pending: null },
      { id: 'manager-one', role: 'manager', status: 'working', label: 'Manager', detail: null, round: 1,
        task_kind: null, verdict: null, terminate: null, stalled: false, current_task: null, handoff_pending: null },
    ],
  }
}

function apply(seq, options = {}) {
  useOfficeStore.getState().applyMawSnapshot({ server_epoch: 1, seq, dashboard_hydration: 1, dashboard_recovery: 0,
    dashboard_opening: 0, snapshot: snapshot({ seq, ...options }) })
}

const walkerUnsubs = []
function installWalker() {
  const store = useOfficeStore
  const unsubscribe = store.subscribe(() => {
    for (const agent of Object.values(store.getState().agents)) {
      if (!agent?.inGroupEvent || !agent.groupTarget) continue
      if (agent.position?.x === agent.groupTarget.x && agent.position?.y === agent.groupTarget.y) continue
      const id = agent.id
      setTimeout(() => {
        const current = store.getState().agents[id]
        if (store.getState().isPaused || !current?.inGroupEvent || !current.groupTarget) return
        if (current.position?.x === current.groupTarget.x && current.position?.y === current.groupTarget.y) return
        store.setState({ agents: { ...store.getState().agents,
          [id]: { ...current, position: { ...current.groupTarget }, isMoving: false, journeyTarget: null } } })
      }, 500)
    }
  })
  walkerUnsubs.push(unsubscribe)
}

async function travelThroughConversation() {
  await vi.advanceTimersByTimeAsync(1000)
  return useOfficeStore.getState()
}

describe('live factual handoff choreography', () => {
  beforeEach(() => {
    while (walkerUnsubs.length) walkerUnsubs.shift()()
    vi.useFakeTimers()
    useOfficeStore.setState({ mode: 'maw', integration: 'dashboard', agents: {}, mawMeta: null, isPaused: false })
  })
  afterEach(() => {
    while (walkerUnsubs.length) walkerUnsubs.shift()()
    vi.useRealTimers()
  })

  it('uses the exact submitted developer and reviewer, faces them during a three-second conversation, then returns them', async () => {
    apply(1)
    installWalker()
    const cleanup = startMawChoreography(useOfficeStore, { resumeCurrent: true })
    const before = useOfficeStore.getState().agents['executor-one~executor'].position
    apply(2)
    apply(3, { sourceStatus: 'awaiting-approval', handoffs: [edge] })
    const moving = useOfficeStore.getState().agents
    expect(moving['executor-one~executor'].inGroupEvent).toBe(true)
    expect(moving['reviewer-one~reviewer'].inGroupEvent).toBe(true)
    expect(moving['manager-one~manager'].inGroupEvent).toBe(false)
    expect(moving['executor-one~executor'].groupTarget).not.toEqual(before)

    const chatting = await travelThroughConversation()
    const sender = chatting.agents['executor-one~executor']
    const recipient = chatting.agents['reviewer-one~reviewer']
    expect(sender.behavior).toBe('chat')
    expect(recipient.behavior).toBe('chat')
    expect(sender.facing).not.toBe(recipient.facing)
    expect(sender.position).toEqual(sender.groupTarget)
    expect(recipient.position).toEqual(recipient.groupTarget)

    await vi.advanceTimersByTimeAsync(2200)
    expect(useOfficeStore.getState().agents['executor-one~executor'].behavior).toBe('chat')
    await vi.advanceTimersByTimeAsync(900)
    expect(useOfficeStore.getState().agents['executor-one~executor'].behavior).not.toBe('chat')
    expect(useOfficeStore.getState().agents['reviewer-one~reviewer'].behavior).not.toBe('chat')
    cleanup()
  })

  it('sends review results back from the reviewer to the referenced developer', async () => {
    apply(1)
    installWalker()
    const cleanup = startMawChoreography(useOfficeStore, { resumeCurrent: true })
    apply(2)
    const result = { id: mawHandoffId('review-result', 'reviewer-one', 'executor-one', reviewTask.source_ref, devTask.source_ref),
      kind: 'review-result', sender_member_id: 'reviewer-one',
      recipient_member_id: 'executor-one', source_task: reviewTask.source_ref, target_task: devTask.source_ref }
    apply(3, { handoffs: [result], reviewerStatus: 'done' })
    const agents = useOfficeStore.getState().agents
    expect(agents['reviewer-one~reviewer'].inGroupEvent).toBe(true)
    expect(agents['executor-one~executor'].inGroupEvent).toBe(true)
    expect(agents['manager-one~manager'].inGroupEvent).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(useOfficeStore.getState().agents['reviewer-one~reviewer'].behavior).toBe('chat')
    cleanup()
  })

  it('deduplicates repeated facts and cancels a stale pair without losing a blocked status', async () => {
    apply(1)
    installWalker()
    const cleanup = startMawChoreography(useOfficeStore, { resumeCurrent: true })
    apply(2)
    apply(3, { sourceStatus: 'awaiting-approval', handoffs: [edge] })
    await vi.advanceTimersByTimeAsync(1000)
    apply(4, { sourceStatus: 'awaiting-approval', handoffs: [edge] })
    expect(useOfficeStore.getState().agents['executor-one~executor'].behavior).toBe('chat')

    apply(5, { sourceStatus: 'awaiting-approval', handoffs: [], handoffState: 'unavailable', reviewerStatus: 'blocked' })
    const stopped = useOfficeStore.getState().agents
    expect(stopped['executor-one~executor'].inGroupEvent).toBe(false)
    expect(stopped['reviewer-one~reviewer'].inGroupEvent).toBe(false)
    expect(stopped['reviewer-one~reviewer'].status).toBe('blocked')
    expect(stopped['reviewer-one~reviewer'].behavior).toBe('scratch-head')
    cleanup()
  })

  it('freezes the conversation clock while the office is paused', async () => {
    apply(1)
    installWalker()
    const cleanup = startMawChoreography(useOfficeStore, { resumeCurrent: true })
    apply(2)
    apply(3, { sourceStatus: 'awaiting-approval', handoffs: [edge] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(useOfficeStore.getState().agents['executor-one~executor'].behavior).toBe('chat')

    useOfficeStore.setState({ isPaused: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(useOfficeStore.getState().agents['executor-one~executor'].behavior).toBe('chat')
    useOfficeStore.setState({ isPaused: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(useOfficeStore.getState().agents['executor-one~executor'].behavior).toBe('chat')
    await vi.advanceTimersByTimeAsync(1000)
    expect(useOfficeStore.getState().agents['executor-one~executor'].behavior).not.toBe('chat')
    cleanup()
  })

  it('does not time out a handoff while physical walks are paused', async () => {
    apply(1)
    installWalker()
    const cleanup = startMawChoreography(useOfficeStore, { resumeCurrent: true })
    apply(2)
    useOfficeStore.setState({ isPaused: true })
    apply(3, { sourceStatus: 'awaiting-approval', handoffs: [edge] })
    const initial = useOfficeStore.getState().agents['executor-one~executor'].position
    await vi.advanceTimersByTimeAsync(50_000)
    const held = useOfficeStore.getState().agents['executor-one~executor']
    expect(held.inGroupEvent).toBe(true)
    expect(held.position).toEqual(initial)

    useOfficeStore.setState({ isPaused: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(useOfficeStore.getState().agents['executor-one~executor'].behavior).toBe('chat')
    cleanup()
  })

  it('does not replay existing interactions on Dashboard hydration', () => {
    apply(1, { sourceStatus: 'awaiting-approval', handoffs: [edge] })
    const cleanup = startMawChoreography(useOfficeStore, { resumeCurrent: true })
    apply(2, { sourceStatus: 'awaiting-approval', handoffs: [edge] })
    expect(useOfficeStore.getState().agents['executor-one~executor'].inGroupEvent).toBe(false)
    expect(useOfficeStore.getState().agents['reviewer-one~reviewer'].inGroupEvent).toBe(false)
    cleanup()
  })
})
