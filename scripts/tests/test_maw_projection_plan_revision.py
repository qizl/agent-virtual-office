"""Focused plan-revision degradation tests for scripts/maw_projection.py.

Covers the Windows R2 visualization defect and its audit findings
(WIN-R2-VISR-001/002): a legitimate plan revision (plan_ref:drifted plus
engine-evidenced, policy-allowed, file-bound rework) must serve a bounded
degraded snapshot instead of rejecting the whole task, while immutable
policies, unbound file identities, cross-node chains, failed revisions and
every other degradation keep the stable rejection. Run: python3 -m unittest
scripts.tests.test_maw_projection_plan_revision (stdlib only, no new deps).
"""

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import maw_projection as mp  # noqa: E402

ROLES = ["manager-1", "decision-maker-1", "executor-1", "executor-2", "reviewer-1"]

WORKFLOW_NODES = [
    {"id": "plan", "type": "plan-review", "depends_on": []},
    {"id": "dev", "type": "development-group", "depends_on": ["plan"]},
    {"id": "shutdown", "type": "shutdown", "depends_on": ["dev"]},
]

MUTABLE_POLICY = {"kind": "reviewed-plan", "source_immutable": False}


def task(seq, round_, type_, status, ref=None, node=None, logical=None):
    return {"schema": "maw.task/3", "seq": seq, "round": round_, "type": type_, "status": status,
            "ref_task": ref, "workflow_node_id": node, "logical_work_id": logical,
            "plan_digest": None, "record_repair": None, "details": None, "agent": None,
            "session": None, "result": None, "review": None}


def attempt(n, task_file, verdict):
    # Shape mirrors the engine's record_attempt_publication / record_verdict.
    disposition = "pending" if verdict is None else ("failed" if verdict == "fail" else "passed")
    return {"attempt": n, "task_file": task_file, "object_fingerprint": "sha256:" + "0" * 16,
            "verdict": verdict, "reviewer": "reviewer-1", "comments": None,
            "disposition": disposition}


def obligation(disposition, attempts=(), internal_attempts=()):
    # Key and object mirror the MAW engine: obligation_key(node, "current-plan").
    return {"node": "plan", "object": "current-plan", "object_kind": "plan",
            "disposition": disposition, "attempts": list(attempts),
            "internal_attempts": list(internal_attempts)}


class PlanRevisionTests(unittest.TestCase):
    def setUp(self):
        # Resolve first: macOS /var/folders ancestors contain symlinks that the
        # projection's per-component link check rightly refuses.
        self.root = Path(tempfile.mkdtemp(prefix="avo-projection-test-")).resolve()
        self.plan_path = self.root / "docs" / "plan.md"
        self.plan_path.parent.mkdir(parents=True)
        self.plan_path.write_text("plan draft v1", encoding="utf-8")
        self.digest = hashlib.sha256(self.plan_path.read_bytes()).hexdigest()
        runtime = self.root / ".agents" / "plugins" / "ai-engineering-kit" / "skills" / "multi-agent-workflow" / ".runtime" / "win-r2"
        self.runtime = runtime
        self.write_manifest()
        self.write_workflow(blocking="plan-revision-in-progress", disposition="awaiting-rework")
        self.write(runtime / "manager-1" / "ready.json", {"schema": "maw.ready/1", "status": "ready"})
        self.write(runtime / "reviewer-1" / "ready.json", {"schema": "maw.ready/1", "status": "confirmed"})
        self.write(runtime / "reviewer-1" / "task-001.json",
                   task(1, 1, "plan-review", "review-failed", node="plan"))
        self.write(runtime / "decision-maker-1" / "ready.json", {"schema": "maw.ready/1", "status": "confirmed"})
        self.write(runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "in-progress", ref="reviewer-1/task-001.json", node="plan",
                        logical="plan-revision"))
        self.write(runtime / "executor-1" / "ready.json", {"schema": "maw.ready/1", "status": "confirmed"})
        self.write(runtime / "executor-1" / "task-003.json",
                   task(3, 1, "dev", "in-progress", logical="impl"))
        self.write(runtime / "executor-2" / "ready.json", {"schema": "maw.ready/1", "status": "confirmed"})

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, path, payload):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def write_manifest(self, status="in-progress", digest=None):
        self.write(self.runtime / "task.json", {
            "schema": "maw.manifest/2", "status": status, "roles": ROLES,
            "plan_ref": "docs/plan.md",
            "plan_digest": f"sha256:{digest or self.digest}"})

    def write_workflow(self, *, blocking="plan-revision-in-progress", disposition="awaiting-rework",
                       policy=MUTABLE_POLICY, node_status="running", attempts=None, internal_attempts=()):
        if attempts is None:
            # The engine's engine-shaped baseline: the root plan review (task-001)
            # was published and failed, which is what opens the rework obligation.
            attempts = (attempt(1, "reviewer-1/task-001.json", "fail"),)
        state = {
            "schema": "maw.workflow/1", "selection": {"title": "win r2"},
            "definition": {"nodes": WORKFLOW_NODES},
            "nodes": {"plan": {"status": node_status, "blocking": blocking}},
            "review_obligations": {"plan:current-plan": obligation(
                disposition, attempts=attempts, internal_attempts=internal_attempts)},
            "finish": {}}
        if policy is not None:
            state["policy"] = policy
        self.write(self.runtime / "workflow.json", state)

    def drift(self, text="plan draft v2"):
        self.plan_path.write_text(text, encoding="utf-8")

    def read(self):
        return mp.read_snapshot(self.root, "win-r2", now=1_000)

    def assert_rejected(self):
        with self.assertRaises(mp.BridgeError) as ctx:
            self.read()
        self.assertEqual(ctx.exception.code, "invalid-input")

    def assert_degraded(self):
        snapshot = self.read()
        self.assertEqual(snapshot["quality"], "degraded")
        self.assertEqual(snapshot["quality_detail"], "plan-revision")
        self.assertEqual(len(snapshot["members"]), len(ROLES))
        self.assertEqual(snapshot["execution_state"], "unknown")
        self.assertEqual(snapshot["assignment_state"], "unknown")
        self.assertEqual(snapshot["handoff_state"], "unavailable")
        self.assertEqual(snapshot["handoffs"], [])
        return snapshot

    # ─── positive boundaries ────────────────────────────────────────────────

    def test_consistent_plan_projects_ok_with_all_roles(self):
        snapshot = self.read()
        self.assertEqual(snapshot["quality"], "ok")
        self.assertIsNone(snapshot["quality_detail"])
        self.assertEqual(len(snapshot["members"]), len(ROLES))
        # Every in-progress member label leads with the working icon, matching
        # the ✅/❌ position in concluded labels.
        for member in snapshot["members"]:
            if member["status"] == "working":
                self.assertTrue(member["label"].startswith("🔄"), member["label"])

    def test_plan_revision_drift_serves_degraded_snapshot(self):
        self.drift()
        self.assert_degraded()

    def test_rebind_restores_full_quality(self):
        self.drift()
        self.assert_degraded()
        self.write_manifest(digest=hashlib.sha256(self.plan_path.read_bytes()).hexdigest())
        snapshot = self.read()
        self.assertEqual(snapshot["quality"], "ok")
        self.assertIsNone(snapshot["quality_detail"])

    def test_second_round_after_internal_review_failure_is_accepted(self):
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 1, "dev", "in-progress", ref="reviewer-1/task-004.json", node="plan"))
        self.write_workflow(internal_attempts=(attempt(1, "reviewer-1/task-004.json", "fail"),))
        self.assert_degraded()

    def test_plan_review_round_two_after_passed_revision_is_accepted(self):
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-passed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "in-progress", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write_workflow(blocking="plan-review-in-progress", disposition="pending",
                            attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-006.json", None)))
        self.assert_degraded()

    # ─── policy boundary (WIN-R2-VISR-001) ──────────────────────────────────

    def test_immutable_source_policy_is_rejected(self):
        self.drift()
        self.write_workflow(blocking="plan-revision-in-progress", disposition="awaiting-rework",
                            policy={"kind": "reviewed-plan", "source_immutable": True})
        self.assert_rejected()

    def test_missing_policy_is_rejected(self):
        self.drift()
        self.write_workflow(blocking="plan-revision-in-progress", disposition="awaiting-rework",
                            policy=None)
        self.assert_rejected()

    # ─── plan-drift-after-pass boundaries (2026-10-30, real-runtime report) ──

    def write_passed_plan_round_two(self):
        self.write(self.runtime / 'reviewer-1' / 'task-006.json',
                   task(6, 2, 'plan-review', 'review-passed', ref='decision-maker-1/task-002.json', node='plan'))
        self.write(self.runtime / 'decision-maker-1' / 'task-002.json',
                   task(2, 1, 'dev', 'review-passed', ref='reviewer-1/task-001.json', node='plan'))

    def test_passed_plan_review_with_drifted_file_serves_labeled_degradation(self):
        # The plan review CONCLUDED (attempt 2 passed) and the plan file drifted
        # afterwards: the team view stays up under quality_detail='plan-drifted'.
        self.drift()
        self.write_passed_plan_round_two()
        self.write_workflow(disposition='passed',
                            attempts=(attempt(1, 'reviewer-1/task-001.json', 'fail'),
                                      attempt(2, 'reviewer-1/task-006.json', 'pass')))
        snapshot = self.read()
        self.assertEqual(snapshot['quality'], 'degraded')
        self.assertEqual(snapshot['quality_detail'], 'plan-drifted')
        self.assertEqual(len(snapshot['members']), len(ROLES))

    def test_released_at_limit_plan_with_drift_serves_labeled_degradation(self):
        self.drift()
        self.write_passed_plan_round_two()
        self.write_workflow(disposition='released-at-limit',
                            attempts=(attempt(1, 'reviewer-1/task-001.json', 'fail'),
                                      attempt(2, 'reviewer-1/task-006.json', 'pass')))
        self.assertEqual(self.read()['quality_detail'], 'plan-drifted')

    def test_pending_plan_obligation_with_drift_is_rejected(self):
        self.drift()
        self.write_workflow(disposition='pending',
                            attempts=(attempt(1, 'reviewer-1/task-001.json', 'fail'),))
        self.assert_rejected()

    def test_passed_obligation_without_pass_anchor_is_rejected(self):
        self.drift()
        self.write_workflow(disposition='passed',
                            attempts=(attempt(1, 'reviewer-1/task-001.json', 'fail'),))
        self.assert_rejected()

    def test_unbound_pass_record_with_drift_is_rejected(self):
        self.drift()
        self.write_workflow(disposition='passed',
                            attempts=(attempt(1, 'reviewer-1/task-001.json', 'fail'),
                                      attempt(2, 'reviewer-1/task-077.json', 'pass')))
        self.assert_rejected()

    # ─── chain boundaries (WIN-R2-VISR-002) ─────────────────────────────────

    def test_blocking_string_without_revision_task_is_rejected(self):
        self.drift()
        (self.runtime / "decision-maker-1" / "task-002.json").unlink()
        self.assert_rejected()

    def test_file_identity_mismatch_is_rejected(self):
        self.drift()
        (self.runtime / "reviewer-1" / "task-001.json").rename(
            self.runtime / "reviewer-1" / "task-099.json")
        self.assert_rejected()

    def test_failed_effective_revision_is_rejected(self):
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.assert_rejected()

    def test_cross_node_failed_review_is_rejected(self):
        self.drift()
        self.write(self.runtime / "reviewer-1" / "task-001.json",
                   task(1, 1, "plan-review", "review-failed", node="other-plan"))
        self.assert_rejected()

    def test_stale_first_round_cannot_shadow_broken_current_chain(self):
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 1, "dev", "in-progress", ref="reviewer-1/task-077.json", node="plan"))
        self.assert_rejected()

    def test_obligation_state_conflict_is_rejected(self):
        self.drift()
        self.write_workflow(blocking="plan-revision-in-progress", disposition="pending")
        self.assert_rejected()

    def test_reference_chain_mismatch_is_rejected(self):
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "in-progress", ref="executor-1/task-003.json", node="plan"))
        self.assert_rejected()

    def test_unbound_legacy_revision_task_is_rejected(self):
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "in-progress", ref="reviewer-1/task-001.json"))
        self.assert_rejected()

    # ─── attempt-binding boundaries (2026-10-29 review P2 hardening) ────────

    def add_second_decision_maker(self):
        manifest = json.loads((self.runtime / "task.json").read_text())
        manifest["roles"].append("decision-maker-2")
        self.write(self.runtime / "task.json", manifest)
        self.write(self.runtime / "decision-maker-2" / "ready.json",
                   {"schema": "maw.ready/1", "status": "confirmed"})

    def test_renamed_newest_revision_file_is_rejected(self):
        # P2: one unbound folder must refuse the exception — skipping it would
        # let the older role's chain stand in for evidence it may hide.
        self.drift()
        self.add_second_decision_maker()
        self.write(self.runtime / "decision-maker-2" / "task-005.json",
                   task(5, 2, "dev", "in-progress", ref="reviewer-1/task-001.json", node="plan"))
        (self.runtime / "decision-maker-2" / "task-005.json").rename(
            self.runtime / "decision-maker-2" / "task-099.json")
        self.assert_rejected()

    def test_bound_newest_revision_in_second_role_is_accepted(self):
        # The identical chain with intact file identity: newest selection spans
        # roles, so the refusal above is identity-driven, not folder-driven.
        self.drift()
        self.add_second_decision_maker()
        self.write(self.runtime / "decision-maker-2" / "task-005.json",
                   task(5, 2, "dev", "in-progress", ref="reviewer-1/task-001.json", node="plan"))
        snapshot = self.read()
        self.assertEqual(snapshot["quality"], "degraded")
        self.assertEqual(snapshot["quality_detail"], "plan-revision")
        self.assertEqual(len(snapshot["members"]), len(ROLES) + 1)

    def test_revision_replaying_an_older_failed_attempt_is_rejected(self):
        # P2: the cited failure must be the engine's LATEST failed attempt; a
        # newer failed attempt (task-007) makes the round-1 record stale.
        self.drift()
        self.write(self.runtime / "reviewer-1" / "task-007.json",
                   task(7, 2, "plan-review", "review-failed", node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 2, "dev", "in-progress", ref="reviewer-1/task-001.json", node="plan"))
        self.write_workflow(attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-007.json", "fail")))
        self.assert_rejected()

    def test_second_attempt_rework_binds_to_latest_failed_review(self):
        # The honest second-attempt chain cites the newest failure record.
        self.drift()
        self.write(self.runtime / "reviewer-1" / "task-007.json",
                   task(7, 2, "plan-review", "review-failed", node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 2, "dev", "in-progress", ref="reviewer-1/task-007.json", node="plan"))
        self.write_workflow(attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-007.json", "fail")))
        self.assert_degraded()

    def test_running_review_must_be_the_current_published_attempt(self):
        # P2: under plan-review-in-progress the running record must be the
        # engine's published attempt file, not an unrelated review on disk.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-passed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "in-progress", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write_workflow(blocking="plan-review-in-progress", disposition="pending",
                            attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-008.json", None)))
        self.assert_rejected()

    def test_orphan_internal_chain_without_root_plan_review_is_rejected(self):
        # P2: an internal-review chain must root at the failed plan review that
        # opened the obligation; no root attempt, no exception.
        self.drift()
        (self.runtime / "reviewer-1" / "task-001.json").unlink()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref=None, node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 2, "dev", "in-progress", ref="reviewer-1/task-004.json", node="plan"))
        self.write_workflow(attempts=(),
                            internal_attempts=(attempt(1, "reviewer-1/task-004.json", "fail"),))
        self.assert_rejected()

    def test_internal_chain_with_deleted_root_record_is_rejected(self):
        # The obligation still names the root attempt, but its record is gone
        # from disk: the chain cannot be proven, so the exception is refused.
        self.drift()
        (self.runtime / "reviewer-1" / "task-001.json").unlink()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 2, "dev", "in-progress", ref="reviewer-1/task-004.json", node="plan"))
        self.write_workflow(internal_attempts=(attempt(1, "reviewer-1/task-004.json", "fail"),))
        self.assert_rejected()

    def test_internal_chain_with_extra_plan_attempt_is_rejected(self):
        # A later failed plan attempt means the next rework must cite THAT
        # record; an internal chain behind it is a stale, contaminated state.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 2, "dev", "in-progress", ref="reviewer-1/task-004.json", node="plan"))
        self.write_workflow(attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-006.json", "fail")),
                            internal_attempts=(attempt(1, "reviewer-1/task-004.json", "fail"),))
        self.assert_rejected()

    def test_second_internal_round_through_checkpointed_attempts_is_accepted(self):
        # Two internal rounds: every hop is a checkpointed failed internal
        # attempt and the walk still roots at the failed plan review.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 1, "dev", "review-failed", ref="reviewer-1/task-004.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-007.json",
                   task(7, 1, "review", "review-failed", ref="decision-maker-1/task-005.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-009.json",
                   task(9, 1, "dev", "in-progress", ref="reviewer-1/task-007.json", node="plan"))
        self.write_workflow(internal_attempts=(attempt(1, "reviewer-1/task-004.json", "fail"),
                                               attempt(2, "reviewer-1/task-007.json", "fail")))
        self.assert_degraded()

    # ─── lifecycle boundaries (2026-10-29 follow-up review P2 hardening) ────

    def test_internal_rework_after_second_plan_failure_is_accepted(self):
        # The rework wave roots at the LATEST failed plan attempt: after plan
        # attempt 2 fails, its internal rework still serves the degradation.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-passed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-008.json",
                   task(8, 2, "dev", "review-failed", ref="reviewer-1/task-006.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-009.json",
                   task(9, 2, "review", "review-failed", ref="decision-maker-1/task-008.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-010.json",
                   task(10, 3, "dev", "in-progress", ref="reviewer-1/task-009.json", node="plan"))
        self.write_workflow(attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-006.json", "fail")),
                            internal_attempts=(attempt(1, "reviewer-1/task-009.json", "fail"),))
        self.assert_degraded()

    def test_open_internal_review_holds_the_revision(self):
        # plan-revision-review: the revision is reviewing and its open internal
        # review (published, pending) audits it; the failed chain is history.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 2, "dev", "reviewing", ref="reviewer-1/task-004.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-007.json",
                   task(7, 2, "review", "in-progress", ref="decision-maker-1/task-005.json",
                        node="plan"))
        self.write_workflow(blocking="plan-revision-review",
                            internal_attempts=(attempt(1, "reviewer-1/task-004.json", "fail"),
                                               attempt(2, "reviewer-1/task-007.json", None)))
        self.assert_degraded()

    def test_internal_pass_then_running_plan_review_is_accepted(self):
        # The internal pass opened the published plan attempt: the newest
        # internal event is that pass, auditing the effective revision.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 2, "dev", "review-passed", ref="reviewer-1/task-004.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-007.json",
                   task(7, 2, "review", "review-passed", ref="decision-maker-1/task-005.json",
                        node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-008.json",
                   task(8, 2, "plan-review", "in-progress", ref="decision-maker-1/task-005.json",
                        node="plan"))
        self.write_workflow(blocking="plan-review-in-progress", disposition="pending",
                            attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-008.json", None)),
                            internal_attempts=(attempt(1, "reviewer-1/task-004.json", "fail"),
                                               attempt(2, "reviewer-1/task-007.json", "pass")))
        self.assert_degraded()

    def test_next_wave_rework_after_passed_wave_is_accepted(self):
        # Wave 1 ended with an internal pass; plan attempt 2 then failed. The
        # round-start rework stands on the latest failed attempt, with the
        # passed wave as admissible history.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-passed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-passed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-008.json",
                   task(8, 2, "dev", "in-progress", ref="reviewer-1/task-006.json", node="plan"))
        self.write_workflow(attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-006.json", "fail")),
                            internal_attempts=(attempt(1, "reviewer-1/task-004.json", "pass"),))
        self.assert_degraded()

    # ─── phase-tail consistency (2026-10-29 third review P2 hardening) ──────

    def test_passed_newest_attempt_with_outstanding_rework_is_rejected(self):
        # P2: a published plan attempt has PASSED while the frozen workflow
        # still declares awaiting-rework — the state contradicts itself, and a
        # backward root search must not resurrect the older failed chain.
        self.drift()
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "review-passed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write_workflow(attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-006.json", "pass")))
        self.assert_rejected()

    def test_passed_attempt_before_running_review_is_rejected(self):
        # A pass ends the obligation; a running attempt after it is an
        # impossible engine shape and keeps the stable rejection.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-passed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "review-passed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-007.json",
                   task(7, 2, "plan-review", "in-progress", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write_workflow(blocking="plan-review-in-progress", disposition="pending",
                            attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(2, "reviewer-1/task-006.json", "pass"),
                                      attempt(3, "reviewer-1/task-007.json", None)))
        self.assert_rejected()

    # ─── attempt numbering boundaries (2026-10-29 fourth review P2) ─────────

    def test_out_of_order_attempt_numbering_is_rejected(self):
        # P2: the owner numbers publications len+1 and appends, so [2, 1] is a
        # history no publish could produce — the tail must not read as phase.
        self.drift()
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "review-passed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write_workflow(attempts=(attempt(2, "reviewer-1/task-006.json", "pass"),
                                      attempt(1, "reviewer-1/task-001.json", "fail")))
        self.assert_rejected()

    def test_duplicate_attempt_numbering_is_rejected(self):
        # Two entries claiming the same publication number never happened.
        self.drift()
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 2, "dev", "in-progress", ref="reviewer-1/task-006.json", node="plan"))
        self.write_workflow(attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),
                                      attempt(1, "reviewer-1/task-006.json", "fail")))
        self.assert_rejected()

    def test_internal_attempt_numbering_must_also_be_sequential(self):
        # The same len+1 contract governs internal attempts: a reordered
        # internal list refuses the chain even with every verdict consistent.
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-failed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-004.json",
                   task(4, 1, "review", "review-failed", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-005.json",
                   task(5, 1, "dev", "review-failed", ref="reviewer-1/task-004.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-007.json",
                   task(7, 1, "review", "review-failed", ref="decision-maker-1/task-005.json",
                        node="plan"))
        self.write(self.runtime / "decision-maker-1" / "task-009.json",
                   task(9, 1, "dev", "in-progress", ref="reviewer-1/task-007.json", node="plan"))
        self.write_workflow(internal_attempts=(attempt(2, "reviewer-1/task-004.json", "fail"),
                                               attempt(1, "reviewer-1/task-007.json", "fail")))
        self.assert_rejected()

    def test_finished_revision_node_is_rejected(self):
        self.drift()
        self.write_workflow(blocking="development-in-progress", node_status="completed",
                            disposition="awaiting-rework")
        self.write(self.runtime / "workflow.json", {
            "schema": "maw.workflow/1", "selection": {"title": "win r2"},
            "definition": {"nodes": WORKFLOW_NODES}, "policy": MUTABLE_POLICY,
            "nodes": {"plan": {"status": "completed"},
                      "dev": {"status": "running", "blocking": "development-in-progress"}},
            "review_obligations": {"plan:current-plan": obligation(
                "awaiting-rework", attempts=(attempt(1, "reviewer-1/task-001.json", "fail"),))},
            "finish": {}})
        self.assert_rejected()

    # ─── stable rejection boundaries ────────────────────────────────────────

    def test_extra_degradation_besides_plan_drift_is_rejected(self):
        self.drift()
        (self.runtime / "executor-1" / "task-003.json").write_text("{broken", encoding="utf-8")
        self.assert_rejected()

    def test_terminal_task_with_drift_is_rejected(self):
        self.drift()
        self.write_manifest(status="completed")
        self.assert_rejected()

    def test_observation_writes_nothing(self):
        def tree():
            return {p.relative_to(self.root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sorted(self.root.rglob("*")) if p.is_file()}
        self.drift()
        before = tree()
        self.read()
        self.read()
        self.assertEqual(tree(), before)


if __name__ == "__main__":
    unittest.main()
