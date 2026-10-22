"""TEST-MWO-002 — Dashboard-consistent state projection (source plan §4.3).

Terminal priority, effective rounds, verdict return-projection, the er5-shaped
cancelled-overrides-running combination, released-at-limit honesty and the
findings state.
"""

import json
import unittest

import fixtures
from fixtures import maw_office, member_by_role


class ProjectionTest(unittest.TestCase):
    def test_cancelled_overrides_running_finish_required_and_pass(self):
        """F8 combination: manifest cancelled while evaluate is running with
        finish-required and the review already passed — the office must show the
        cancellation, never 'waiting for evaluation' or all-green success."""
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            manifest_status="cancelled",
            nodes_states={"team": {"status": "completed"}, "develop": {"status": "completed"},
                          "evaluate": {"status": "running", "blocking": "finish-required"},
                          "shutdown": {"status": "pending"}},
            finish={"requested": True, "cancel_requested": False, "evaluation": {"verdict": "pass"},
                    "terminations_published": True, "await_state": None, "outcome": None, "unresolved": []},
            executor_tasks=[fixtures.task(1, "dev", "review-passed", verdict=None)],
            reviewer_tasks=[fixtures.task(2, "review", "review-passed", ref_task="executor-1/task-001")],
            executor_terminate="confirmed",
            reviewer_terminate="confirmed",
        )
        state = maw_office.read_runtime_state(root, "maw-synth-001")
        snapshot = maw_office.build_snapshot(state, "producer-test", 1, 1000)
        self.assertEqual(snapshot["terminal"], "cancelled")
        executor = member_by_role(snapshot["members"], "executor")
        reviewer = member_by_role(snapshot["members"], "reviewer")
        manager = member_by_role(snapshot["members"], "manager")
        self.assertEqual(executor["status"], "blocked")  # stopped, not awaiting-approval
        self.assertIn("已取消", executor["label"])
        self.assertEqual(reviewer["status"], "blocked")
        self.assertEqual(manager["status"], "done")  # manager shows the global terminal
        self.assertIn("取消", manager["label"])

    def test_active_flow_projects_working_and_review_cycle(self):
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            nodes_states={"team": {"status": "completed"},
                          "develop": {"status": "running"},
                          "evaluate": {"status": "pending"},
                          "shutdown": {"status": "pending"}},
            executor_tasks=[fixtures.task(1, "dev", "in-progress")],
            reviewer_tasks=[fixtures.task(2, "review", "in-progress", ref_task="executor-1/task-001")],
        )
        state = maw_office.read_runtime_state(root, "maw-synth-001")
        snapshot = maw_office.build_snapshot(state, "p", 1, 1000)
        executor = member_by_role(snapshot["members"], "executor")
        reviewer = member_by_role(snapshot["members"], "reviewer")
        manager = member_by_role(snapshot["members"], "manager")
        self.assertEqual(executor["status"], "working")
        self.assertIn("slice-001", executor["label"])
        self.assertEqual(executor["task_kind"], "dev")
        self.assertEqual(reviewer["status"], "working")
        self.assertEqual(reviewer["task_kind"], "review")
        self.assertEqual(manager["status"], "working")
        self.assertIn("develop", manager["label"])

    def test_finish_required_maps_to_awaiting_approval_for_manager(self):
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            nodes_states={"team": {"status": "completed"}, "develop": {"status": "completed"},
                          "evaluate": {"status": "running", "blocking": "finish-required"},
                          "shutdown": {"status": "pending"}},
            finish={"requested": True, "cancel_requested": False, "evaluation": None,
                    "terminations_published": False, "await_state": None, "outcome": None, "unresolved": []},
            executor_tasks=[fixtures.task(1, "dev", "review-passed")],
            reviewer_tasks=[fixtures.task(2, "review", "review-passed", ref_task="executor-1/task-001")],
        )
        snapshot = maw_office.build_snapshot(maw_office.read_runtime_state(root, "maw-synth-001"), "p", 1, 1000)
        manager = member_by_role(snapshot["members"], "manager")
        self.assertEqual(manager["status"], "awaiting-approval")

    def test_fail_verdict_sends_executor_to_rework_and_reviewer_to_done(self):
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            nodes_states={"team": {"status": "completed"}, "develop": {"status": "running"},
                          "evaluate": {"status": "pending"}, "shutdown": {"status": "pending"}},
            executor_tasks=[fixtures.task(1, "dev", "review-failed")],
            reviewer_tasks=[fixtures.task(2, "review", "review-failed", ref_task="executor-1/task-001", verdict="fail")],
        )
        snapshot = maw_office.build_snapshot(maw_office.read_runtime_state(root, "maw-synth-001"), "p", 1, 1000)
        executor = member_by_role(snapshot["members"], "executor")
        reviewer = member_by_role(snapshot["members"], "reviewer")
        self.assertEqual(executor["status"], "blocked")
        self.assertIn("返修", executor["label"])
        self.assertEqual(reviewer["status"], "done")
        self.assertEqual(reviewer["verdict"], "fail")

    def test_new_rework_round_supersedes_an_old_fail(self):
        """Old fail must not permanently block a newer round (plan §4.3.1)."""
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            nodes_states={"team": {"status": "completed"}, "develop": {"status": "running"},
                          "evaluate": {"status": "pending"}, "shutdown": {"status": "pending"}},
            executor_tasks=[fixtures.task(1, "dev", "review-failed", round_=1),
                            fixtures.task(2, "dev", "in-progress", round_=2)],
        )
        snapshot = maw_office.build_snapshot(maw_office.read_runtime_state(root, "maw-synth-001"), "p", 1, 1000)
        executor = member_by_role(snapshot["members"], "executor")
        self.assertEqual(executor["status"], "working")
        self.assertIn("round 2", executor["label"])

    def test_dev_complete_awaits_review_and_pass_shows_done(self):
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            nodes_states={"team": {"status": "completed"}, "develop": {"status": "running"},
                          "evaluate": {"status": "pending"}, "shutdown": {"status": "pending"}},
            executor_tasks=[fixtures.task(1, "dev", "dev-complete")],
        )
        snapshot = maw_office.build_snapshot(maw_office.read_runtime_state(root, "maw-synth-001"), "p", 1, 1000)
        self.assertEqual(member_by_role(snapshot["members"], "executor")["status"], "awaiting-approval")

        root2 = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            nodes_states={"team": {"status": "completed"}, "develop": {"status": "running"},
                          "evaluate": {"status": "pending"}, "shutdown": {"status": "pending"}},
            executor_tasks=[fixtures.task(1, "dev", "review-passed")],
            reviewer_tasks=[fixtures.task(2, "review", "review-passed", ref_task="executor-1/task-001")],
        )
        snapshot2 = maw_office.build_snapshot(maw_office.read_runtime_state(root2, "maw-synth-001"), "p", 1, 1000)
        self.assertEqual(member_by_role(snapshot2["members"], "executor")["status"], "done")

    def test_completed_with_findings_is_not_all_green(self):
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            manifest_status="completed-with-findings",
            executor_tasks=[fixtures.task(1, "dev", "review-passed")],
        )
        snapshot = maw_office.build_snapshot(maw_office.read_runtime_state(root, "maw-synth-001"), "p", 1, 1000)
        self.assertEqual(snapshot["terminal"], "completed-with-findings")
        manager = member_by_role(snapshot["members"], "manager")
        self.assertIn("带问题", manager["label"])

    def test_released_at_limit_is_reported_not_celebrated(self):
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(),
            nodes_states={"team": {"status": "completed"},
                          "develop": {"status": "released-at-limit"},
                          "evaluate": {"status": "pending"}, "shutdown": {"status": "pending"}},
            executor_tasks=[fixtures.task(1, "dev", "review-failed")],
        )
        state = maw_office.read_runtime_state(root, "maw-synth-001")
        snapshot = maw_office.build_snapshot(state, "p", 1, 1000)
        executor = member_by_role(snapshot["members"], "executor")
        self.assertEqual(executor["status"], "blocked")  # never mapped to pass/success

    def test_member_ids_are_stable_opaque_hashes_without_raw_paths(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")])
        s1 = maw_office.build_snapshot(maw_office.read_runtime_state(root, "maw-synth-001"), "p", 1, 1000)
        s2 = maw_office.build_snapshot(maw_office.read_runtime_state(root, "maw-synth-001"), "p", 2, 2000)
        self.assertEqual(s1["members"][0]["id"], s2["members"][0]["id"])
        self.assertRegex(s1["members"][0]["id"], r"^[A-Za-z0-9_-]{12}$")
        for m in s1["members"]:
            self.assertNotIn(str(root), json.dumps(m))

    def test_missing_workflow_definition_is_stated_not_invented(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")])
        (root / fixtures.RUNTIME_REL / "maw-synth-001" / "workflow.json").write_text(
            json.dumps({"schema": "maw.workflow/1", "nodes": {}}), encoding="utf-8")
        state = maw_office.read_runtime_state(root, "maw-synth-001")
        snapshot = maw_office.build_snapshot(state, "p", 1, 1000)
        self.assertIn("未提供工作流定义", snapshot["workflow"])


if __name__ == "__main__":
    unittest.main()
