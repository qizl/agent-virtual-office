# MAW History Choreography

Status: Approved for implementation by the user on 2026-10-25.

## 1. Intent

Replay the recorded task process as visible role actions, rather than changing milestone labels over stationary characters. Add continuous transitions and draggable playback progress.

The current canonical external delivery plan is the Kit maintenance document `docs/development/multi-agent-workflow/agent-virtual-office/multi-agent-workflow-dashboard-handoff-entry-2026-10-25/multi-agent-workflow-dashboard-handoff-entry-2026-10-25.md`; its paired records own rolling delivery evidence. This specification owns AVO behavior. Previous acceptance blockers remain open.

## 2. Evidence Boundary

- Read only validated task and committed transaction records. Never read prompt or log bodies or write observed runtime.
- Use explicit member identities, task sequence, type, round and valid ref_task links. Never infer actors from node names or fabricate starts, handoffs, tool actions, durations or later conclusions.
- Keep transaction revision order and deterministic causal ordering for undated task supplements. Mark missing or damaged evidence incomplete.
- Preserve the existing 2 MB file, 200 input/milestone/relationship, 1 MiB response, 50-member and 16 KiB snapshot limits. An interaction group that cannot fit is unavailable as a whole; never guess from a partial group.
- A development submission targets the exact reviewer whose review task references it. A review result returns to the exact referenced task author. A development rework reference is not a next recipient. Missing, conflicting or unavailable relationships remain pending.
- Historical handoffs require both task identities to have appeared in causal order. Final roster readiness or termination must not invent a historical availability fact.

## 3. Presentation Contract

Each step may carry a bounded cue with an actor in its snapshot, one whitelisted activity, optional task identity and at most one explicitly related member. Activities are ready, publication, work, delivery, result, rework, coordination and terminal. A missing or invalid cue produces a neutral presentation, never guessed activity.

The independent history clock samples a deterministic route plan compiled from default positions. Readiness-only records hold causal members at their default seats. The first verified task activity or active task status opens all members visible at that causal step together; later members enter only once they appear. Once active, every nonterminal frame, including individual idle, done, failed and rework states, keeps its members at their work posts. Historical playback never uses random breaks or free-roam. Only verified handoffs may move participants to a recipient post for three seconds and back; only a global terminal frame returns the team to rest. Ordinary steps last at least four seconds. A handoff includes travel at the existing 60 px/s speed, three seconds of mutual conversation at the recipient workstation and travel back to the current-state post. Steps are bounded to 60 seconds and the full timeline to 12,000,000 ms. Exceeding a bound explicitly degrades the interaction rather than truncating or accelerating a route. Motion illustrates a recorded milestone; it does not reproduce actual work duration. Neutral roles must not inherit prior work or future results. Live choreography and ambient timers cannot take ownership.

Live handoffs reserve both concrete participants. Shared participants queue; disjoint pairs may proceed concurrently. Normal walks, desk correction and roaming yield to the interaction. Stable event identities prevent repeated polling from replaying a handoff. Task or round replacement, disappearance, disconnection, termination and unmount cancel ownership and callbacks. Failed verdicts retain their real status.

Live snapshots may include `execution_state=not-started|started|unknown`, independently of handoff availability. A complete read with no concrete tasks, or only `initialized` tasks, is not-started. Any legal concrete task in `in-progress`, `dev-complete`, `reviewing`, `review-passed` or `review-failed` establishes started; inspect all tasks, including earlier rounds. Incomplete observations and legacy snapshots without the field are unknown. Manager activity, assignment existence, clocks and sequence numbers are not execution evidence.

On the first determinate nonterminal Dashboard observation, not-started opens every member from their default meeting-room seat to their stable work post, including the manager at the gate, with 600 ms launch spacing. A first started observation hydrates current-state posts and baselines prior handoffs. Unknown, empty, damaged or failed observations never trigger an opening or consume its determinate decision. An opening already in progress finishes its continuous routes when execution starts; it is not restarted or replaced by instant positioning. Pause freezes both current movement and stagger scheduling while preserving each route and remaining launch delay; a long pause does not spend arrival retries or change later launch offsets. Resume continues the existing route before dispatching the next member. Each mounted task decides once. Before dispatching the first opening, write only a versioned animation-shown bit in sessionStorage, scoped to the fixed project and task. Same-tab re-entry or reload hydrates current-state posts and baselines old handoffs if that bit exists, even if the opening was interrupted or execution is still not-started. A first started observation always hydrates, without reading or writing the bit. Unknown, empty, damaged and failed observations do not read or write it. No localStorage or cross-tab synchronization is used; cross-tab and browser-restart retention is not required. Storage access failures emit one bounded diagnostic per mount and preserve mount-local entry deduplication. No task state, member data, position, execution or readiness fact is persisted. Historical playback and standalone opening do not use this bit and remain compatible.

During a live nonterminal workflow, CR-6 keeps the existing 90-second eligibility threshold and checks one global activity decision every 15 seconds. A random draw strictly below 0.10 permits choosing at most one eligible member; all other draws launch nobody. Failed draws and empty candidate sets consume the opportunity, so the five-second audit tick cannot retry early. Team size does not multiply the probability. Preserve existing eligibility exclusions, dwell, return paths and counter-reset timing. CR-8 terminal roaming bypasses this probability gate; historical routes never use the live random scheduler.

## 4. Controls And Lifecycle

- Pause freezes playback and presentation motion. Resume preserves the remaining step time.
- Restart cancels previous work and starts the recorded timeline from its beginning. End holds the final frame without looping.
- An accessible draggable progress bar seeks within presentation time and preserves the prior playing or paused state. Seeking backward restores only facts known at that target frame. Rapid seeks cancel obsolete transitions. An explicit seek while paused may perform one short positioning transition and then freeze; an ordinary pause never moves characters.
- Parent commands and status retain same-origin, exact iframe identity and fixed project/task checks. Seek positions and durations are finite bounded integers: position_ms is within 0..duration_ms; duration_ms is the cumulative bounded step time, between total steps times 4000 and total steps times 60000, never exceeding 12,000,000. The seek command carries position_ms; state carries position_ms and duration_ms.
- Fullscreen retains the same iframe, playback and task binding. Task changes and page exit cancel old timers and responses.
- A live task that reaches a completed terminal state while this visualization remains mounted stays in live mode and keeps CR-8 free roaming; automatic history playback is eligible only when the first valid snapshot observed for the mount is already completed. Re-entering the visualization creates a new mount and may autoplay that completed history.

## 5. Acceptance

- A recorded assignment, work, submission, review result and explicit rework chain visibly identify their recorded actors with appropriate actions. Missing intermediate evidence remains missing.
- Position samples are continuous during step transitions and seeking; pause samples do not move; no cached later verdict appears after backward seeking.
- Mouse/touch and keyboard progress changes select the expected timeline position without changing the bound task or mode.
- Malformed cues, foreign messages, excessive input, damaged records and missing references fail safely without observed-runtime writes.
- Focused and full AVO/Python/Dashboard tests, browser playback/geometry and guarded committed-source packaging provide real evidence. Formal quality and review blockers remain explicit.
- Cover exact-member handoffs with multiple executors/reviewers, delayed review assignment, rework/failure, missing/conflicting references, unavailable recipients and repeated polling. Verify conversation facing and continuous approach/return.
- Verify no-task and initialized-only entry launches every member with stable posts and staggered continuous routes; execution already started, refresh and reconnect hydrate directly. Starting execution during entry must preserve the current routes. Unknown observations cannot launch or consume the determinate entry decision; task changes cancel prior work. The first eligible opening marks before motion; same-tab return/reload and interrupted entry skip, project/task keys stay isolated, and a new tab session can open again. Storage read/write failures must not break entry or log raw input. MAW task/member state must be absent from browser persistence; only the tab-session animation-shown bit is allowed.
- Pause an opening for at least 85 seconds and verify current positions and stagger ownership remain frozen, then resume each original route and launch offset without consuming wall-clock arrival retries or replaying an already-started member.
- Cover probability boundaries below and at 0.10, consumed failed/empty rounds, no retry at five/ten seconds, and the next opportunity at 15 seconds. Multiple eligible members still yield one global draw and at most one departure. Manager/interaction exclusions, return paths and CR-8 remain intact. Pause and seek during historical travel, conversation and return must sample the same timeline without revealing later facts.

## 6. Rollback

Revert the focused source and complete Kit package commits together. Preserve project runtimes, registry state, user changes and previous evidence. No installation, release or remote push is authorized.
