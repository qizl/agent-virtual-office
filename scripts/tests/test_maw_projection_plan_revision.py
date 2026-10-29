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


def obligation(disposition):
    # Key and object mirror the MAW engine: obligation_key(node, "current-plan").
    return {"node": "plan", "object": "current-plan", "object_kind": "plan",
            "disposition": disposition, "attempts": [], "internal_attempts": []}


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

    def write_workflow(self, *, blocking, disposition, policy=MUTABLE_POLICY, node_status="running"):
        state = {
            "schema": "maw.workflow/1", "selection": {"title": "win r2"},
            "definition": {"nodes": WORKFLOW_NODES},
            "nodes": {"plan": {"status": node_status, "blocking": blocking}},
            "review_obligations": {"plan:current-plan": obligation(disposition)},
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
        self.assert_degraded()

    def test_plan_review_round_two_after_passed_revision_is_accepted(self):
        self.drift()
        self.write(self.runtime / "decision-maker-1" / "task-002.json",
                   task(2, 1, "dev", "review-passed", ref="reviewer-1/task-001.json", node="plan"))
        self.write(self.runtime / "reviewer-1" / "task-006.json",
                   task(6, 2, "plan-review", "in-progress", ref="decision-maker-1/task-002.json",
                        node="plan"))
        self.write_workflow(blocking="plan-review-in-progress", disposition="pending")
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

    def test_finished_revision_node_is_rejected(self):
        self.drift()
        self.write_workflow(blocking="development-in-progress", node_status="completed",
                            disposition="awaiting-rework")
        self.write(self.runtime / "workflow.json", {
            "schema": "maw.workflow/1", "selection": {"title": "win r2"},
            "definition": {"nodes": WORKFLOW_NODES}, "policy": MUTABLE_POLICY,
            "nodes": {"plan": {"status": "completed"},
                      "dev": {"status": "running", "blocking": "development-in-progress"}},
            "review_obligations": {"plan:current-plan": obligation("awaiting-rework")},
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
