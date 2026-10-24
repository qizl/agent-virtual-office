# MAW History Choreography

Status: Approved for implementation by the user on 2026-10-24.

## 1. Intent

Replay the recorded task process as visible role actions, rather than changing milestone labels over stationary characters. Add continuous transitions and draggable playback progress.

The canonical external delivery plan is the Kit maintenance document `docs/development/multi-agent-workflow/agent-virtual-office/multi-agent-workflow-dashboard-history-choreography-2026-10-24/multi-agent-workflow-dashboard-history-choreography-2026-10-24.md`; its paired records own rolling delivery evidence. This specification owns AVO behavior. Previous acceptance blockers remain open.

## 2. Evidence Boundary

- Read only validated task and committed transaction records. Never read prompt or log bodies or write observed runtime.
- Use explicit member identities, task sequence, type, round and valid ref_task links. Never infer actors from node names or fabricate starts, handoffs, tool actions, durations or later conclusions.
- Keep transaction revision order and deterministic causal ordering for undated task supplements. Mark missing or damaged evidence incomplete.
- Preserve the existing 2 MB file, 200 input/milestone, 1 MiB response and 16 KiB snapshot limits.

## 3. Presentation Contract

Each step may carry a bounded cue with an actor in its snapshot, one whitelisted activity, optional task identity and at most one explicitly related member. Activities are ready, publication, work, delivery, result, rework, coordination and terminal. A missing or invalid cue produces a neutral presentation, never guessed activity.

The independent history clock provides four seconds per step. Motion represents the recorded milestone for presentation; it does not reproduce actual physical positions or elapsed work. Actor positions transition continuously across steps and seeks. Neutral roles must not inherit prior work or future results. Live choreography and ambient timers cannot take ownership.

## 4. Controls And Lifecycle

- Pause freezes playback and presentation motion. Resume preserves the remaining step time.
- Restart cancels previous work and starts the recorded timeline from its beginning. End holds the final frame without looping.
- An accessible draggable progress bar seeks within presentation time and preserves the prior playing or paused state. Seeking backward restores only facts known at that target frame. Rapid seeks cancel obsolete transitions. An explicit seek while paused may perform one short positioning transition and then freeze; an ordinary pause never moves characters.
- Parent commands and status retain same-origin, exact iframe identity and fixed project/task checks. Seek positions and durations are finite bounded integers: position_ms is within 0..duration_ms, duration_ms equals total steps times 4000 and never exceeds 800000. The seek command carries position_ms; state carries position_ms and duration_ms.
- Fullscreen retains the same iframe, playback and task binding. Task changes and page exit cancel old timers and responses.

## 5. Acceptance

- A recorded assignment, work, submission, review result and explicit rework chain visibly identify their recorded actors with appropriate actions. Missing intermediate evidence remains missing.
- Position samples are continuous during step transitions and seeking; pause samples do not move; no cached later verdict appears after backward seeking.
- Mouse/touch and keyboard progress changes select the expected timeline position without changing the bound task or mode.
- Malformed cues, foreign messages, excessive input, damaged records and missing references fail safely without observed-runtime writes.
- Focused and full AVO/Python/Dashboard tests, browser playback/geometry and guarded committed-source packaging provide real evidence. Formal quality and review blockers remain explicit.

## 6. Rollback

Revert the focused source and complete Kit package commits together. Preserve project runtimes, registry state, user changes and previous evidence. No installation, release or remote push is authorized.
