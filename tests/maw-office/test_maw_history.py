"""Recorded-history contract: bounded evidence, honest frames and zero writes."""

import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock

import fixtures

_spec = importlib.util.spec_from_file_location("maw_history", fixtures.AVO_ROOT / "scripts" / "maw_history.py")
history = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(history)

DIGEST = "sha256:" + "d" * 64
BEFORE = "sha256:" + "a" * 64
AFTER = "sha256:" + "b" * 64
TASK = "maw-synth-001"


def runtime(*, status="completed", executor_tasks=(), reviewer_tasks=()):
    root = fixtures.build_runtime(fixtures.uuid_tmp(), manifest_status=status,
                                  executor_tasks=executor_tasks, reviewer_tasks=reviewer_tasks)
    directory = root / fixtures.RUNTIME_REL / TASK
    workflow = json.loads((directory / "workflow.json").read_text())
    workflow.update(definition_digest=DIGEST, revision=10)
    workflow["finish"]["outcome"] = status if status in history.projection.TERMINAL_MANIFEST else None
    fixtures.write(directory / "workflow.json", workflow)
    manifest = json.loads((directory / "task.json").read_text())
    manifest.update(workflow_definition_digest=DIGEST, terminal_outcome=workflow["finish"]["outcome"])
    fixtures.write(directory / "task.json", manifest)
    return root, directory


def operation(directory, action, revision=1, *, created_at="2026-10-23T12:00:00+08:00", suffix=None):
    kind = action["action"]
    if suffix is None:
        suffix = history._canonical_digest(action)[:10]
    identity = f"op-{revision:06d}-{suffix}"
    writes = {"task.json": {"before": BEFORE, "after": AFTER},
              "workflow.json": {"before": BEFORE, "after": AFTER}}
    if kind in history.PUBLICATIONS:
        owner = action["role"] if kind == "assign-dev" else action["owner"]
        writes[f"{owner}/task-{action['task']['seq']:03d}.json"] = {
            "before": None, "after": history._written_digest(action["task"])}
    op = {"op_id": identity, "stage": "committed", "action": action,
          "expected_revision": revision, "definition_digest": DIGEST, "writes": writes,
          "created_at": created_at}
    fixtures.write(directory / "context" / "operations" / f"{identity}.json", op)
    return op


def close_operation(directory, *, outcome="completed", revision=10):
    workflow = json.loads((directory / "workflow.json").read_text())
    manifest = json.loads((directory / "task.json").read_text())
    workflow.update(revision=revision)
    workflow["finish"]["outcome"] = outcome
    manifest.update(status=outcome, terminal_outcome=outcome)
    kind = "cancel-close" if outcome == "cancelled" else "finish-close"
    action = {"action": kind, "workflow": workflow, "manifest": manifest}
    op = operation(directory, action, revision=revision, suffix=kind)
    op["writes"]["workflow.json"]["after"] = history._written_digest(workflow)
    op["writes"]["task.json"]["after"] = history._written_digest(manifest)
    fixtures.write(directory / "context" / "operations" / f"{op['op_id']}.json", op)
    return op


def read(root, **kwargs):
    return history.read_history(root, TASK, project="fixed-project", now=12345, **kwargs)


def executor(step):
    return next(member for member in step["snapshot"]["members"] if member["role"] == "executor")


class HistoryTest(unittest.TestCase):
    def test_no_operation_history_does_not_disqualify_recorded_task_results(self):
        root, _directory = runtime(executor_tasks=[fixtures.task(1, status="review-failed")])
        result = read(root)
        self.assertTrue(result["eligible"])
        self.assertFalse(result["complete"])
        self.assertIn("operation-history-unavailable", result["warnings"])
        self.assertEqual([step["kind"] for step in result["steps"]], ["task-record", "final-snapshot"])
        self.assertEqual(executor(result["steps"][0])["verdict"], "fail")
        self.assertEqual(executor(result["steps"][0])["status"], "blocked")
        self.assertIsNone(result["steps"][0]["recorded_at"])
        self.assertIsNone(result["steps"][0]["snapshot"]["terminal"])
        self.assertEqual(result["steps"][-1]["snapshot"]["terminal"], "completed")

    def test_empty_history_retains_final_view_with_reason(self):
        root, _directory = runtime()
        result = read(root)
        self.assertTrue(result["eligible"])
        self.assertEqual(result["steps"], [])
        self.assertEqual(result["final_snapshot"]["terminal"], "completed")
        self.assertIn("playable-history-unavailable", result["warnings"])

    def test_recorded_operations_precede_undated_supplement_without_future_results(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1, status="review-passed")])
        published = fixtures.task(1, status="initialized")
        published["details"] = "PRIVATE PROMPT MUST NEVER ESCAPE"
        op = operation(directory, {"action": "assign-dev", "role": "executor-1", "node": "develop",
                                   "seq": 1, "task": published}, suffix="assign001")
        result = read(root)
        self.assertEqual(result["schema"], "avo.maw-history/1")
        self.assertEqual(result["project"], "fixed-project")
        self.assertEqual(result["task"], TASK)
        first = result["steps"][0]
        self.assertEqual(first["id"], op["op_id"])
        self.assertEqual(first["recorded_at"], "2026-10-23T04:00:00+00:00")
        self.assertEqual(executor(first)["status"], "planning")
        self.assertIsNone(executor(first)["verdict"])
        self.assertIsNone(first["snapshot"]["terminal"])
        self.assertIsNone(next(member for member in first["snapshot"]["members"] if member["role"] == "reviewer")["verdict"])
        self.assertNotIn("PRIVATE PROMPT", json.dumps(result))
        self.assertNotIn('"writes"', json.dumps(result))
        self.assertNotIn('"details"', json.dumps(result))
        for step in result["steps"]:
            history._validate_frame(step["snapshot"])

    def test_older_transaction_after_hashes_are_not_compared_to_current_files(self):
        root, directory = runtime()
        op = operation(directory, {"action": "complete-node", "node": "develop"})
        current = hashlib.sha256((directory / "workflow.json").read_bytes()).hexdigest()
        self.assertNotEqual(op["writes"]["workflow.json"]["after"], "sha256:" + current)
        result = read(root)
        self.assertEqual(result["steps"][0]["id"], op["op_id"])

    def test_stable_revision_order_and_explicit_task_review_rework_chain(self):
        dev1 = fixtures.task(10, status="review-failed", round_=1)
        review1 = fixtures.task(20, type_="review", status="review-failed", ref_task="executor-1/task-010")
        dev2 = fixtures.task(30, status="review-passed", round_=2, ref_task="executor-1/task-010")
        review2 = fixtures.task(40, type_="review", status="review-passed", round_=2, ref_task="executor-1/task-030")
        root, directory = runtime(executor_tasks=[dev2, dev1], reviewer_tasks=[review2, review1])
        late = operation(directory, {"action": "complete-node", "node": "evaluate"}, revision=8)
        early = operation(directory, {"action": "complete-node", "node": "develop"}, revision=2)
        result = read(root)
        self.assertEqual([step["id"] for step in result["steps"][:2]], [early["op_id"], late["op_id"]])
        task_steps = [step for step in result["steps"] if step["kind"] == "task-record"]
        self.assertEqual([step["source_refs"][0] for step in task_steps], ["executor-1/task-010.json", "reviewer-1/task-020.json", "executor-1/task-030.json", "reviewer-1/task-040.json"])
        self.assertEqual(executor(task_steps[0])["verdict"], "fail")
        self.assertEqual(executor(task_steps[2])["verdict"], "pass")
        self.assertEqual(executor(task_steps[2])["round"], 2)

    def test_cancellation_and_terminal_conflicts_disable_replay(self):
        for status, terminal in (("cancelled", "cancelled"), ("completed-with-findings", "completed-with-findings")):
            root, _directory = runtime(status=status, executor_tasks=[fixtures.task(1, status="review-failed")])
            result = read(root)
            self.assertEqual(result["terminal"], terminal)
            self.assertEqual(result["eligible"], status != "cancelled")
            self.assertEqual(executor(result["steps"][0])["verdict"], "fail")
        root, directory = runtime(executor_tasks=[fixtures.task(1)])
        manifest = json.loads((directory / "task.json").read_text())
        manifest["terminal_outcome"] = "cancelled"
        fixtures.write(directory / "task.json", manifest)
        result = read(root)
        self.assertFalse(result["eligible"])
        self.assertEqual(result["steps"], [])
        self.assertIn("terminal-conflict", result["warnings"])

    def test_partial_corruption_is_explicit_and_valid_records_still_play(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1, status="dev-complete")])
        fixtures.write(directory / "context" / "operations" / "op-000001-broken.json", None, raw="{")
        fixtures.write(directory / "executor-1" / "task-002.json", None, raw="broken")
        result = read(root)
        self.assertTrue(result["eligible"])
        self.assertFalse(result["complete"])
        self.assertIn("operation-record-invalid", result["warnings"])
        self.assertIn("task-record-invalid", result["warnings"])
        self.assertEqual(result["steps"][0]["source_refs"], ["executor-1/task-001.json"])

    def test_damaged_review_publication_is_skipped_without_losing_valid_history(self):
        for publication in ("damaged", ["damaged"], 1, True, None, {}):
            with self.subTest(publication=publication):
                root, directory = runtime(executor_tasks=[fixtures.task(1, status="dev-complete")])
                valid = operation(directory, {"action": "complete-node", "node": "develop"})
                damaged = operation(directory, {
                    "action": "create-review-task", "owner": "reviewer-1", "seq": 2,
                    "task": fixtures.task(2, type_="review", status="initialized"),
                    "publication": publication,
                }, revision=2)
                result = read(root)
                self.assertTrue(result["eligible"])
                self.assertFalse(result["complete"])
                self.assertIn("operation-record-invalid", result["warnings"])
                self.assertEqual([step["id"] for step in result["steps"]], [
                    valid["op_id"], "task-result:executor-1/task-001", "final-observation"])
                self.assertNotIn(damaged["op_id"], json.dumps(result))

    def test_damaged_close_finish_is_skipped_without_losing_valid_history(self):
        for finish in ("damaged", ["damaged"], 1, True, None, {}):
            with self.subTest(finish=finish):
                root, directory = runtime(executor_tasks=[fixtures.task(1, status="dev-complete")])
                valid = operation(directory, {"action": "complete-node", "node": "develop"})
                damaged = close_operation(directory)
                damaged["action"]["workflow"]["finish"] = finish
                damaged["writes"]["workflow.json"]["after"] = history._written_digest(damaged["action"]["workflow"])
                fixtures.write(directory / "context" / "operations" / f"{damaged['op_id']}.json", damaged)
                result = read(root)
                self.assertTrue(result["eligible"])
                self.assertFalse(result["complete"])
                self.assertIn("operation-record-invalid", result["warnings"])
                self.assertEqual([step["id"] for step in result["steps"]], [
                    valid["op_id"], "task-result:executor-1/task-001", "final-observation"])
                self.assertNotIn("terminal-conflict", result["warnings"])
                self.assertNotIn(damaged["op_id"], json.dumps(result))

    def test_deeply_nested_inputs_are_skipped_at_each_file_boundary(self):
        for target in ("operation", "task"):
            for depth in (600, 2000):
                with self.subTest(target=target, depth=depth):
                    root, directory = runtime(executor_tasks=[fixtures.task(1, status="dev-complete")])
                    valid = operation(directory, {"action": "complete-node", "node": "develop"})
                    if target == "operation":
                        damaged = operation(directory, {"action": "complete-node", "node": "evaluate"}, revision=2)
                        path = directory / "context" / "operations" / f"{damaged['op_id']}.json"
                    else:
                        damaged = fixtures.task(2)
                        path = directory / "executor-1" / "task-002.json"
                    raw = json.dumps(damaged)[:-1] + ',"nested":' + "[" * depth + "0" + "]" * depth + "}"
                    self.assertLess(len(raw.encode()), history.projection.MAX_FILE_BYTES)
                    fixtures.write(path, None, raw=raw)
                    result = read(root)
                    self.assertTrue(result["eligible"])
                    self.assertFalse(result["complete"])
                    self.assertIn(f"{target}-record-invalid", result["warnings"])
                    self.assertEqual([step["id"] for step in result["steps"]], [
                        valid["op_id"], "task-result:executor-1/task-001", "final-observation"])

    def test_damaged_current_finish_marks_incomplete_without_erasing_valid_history(self):
        for status in ("active", "completed"):
            for finish in ("damaged", ["damaged"], 1, True):
                with self.subTest(status=status, finish=finish):
                    root, directory = runtime(status=status, executor_tasks=[fixtures.task(1, status="dev-complete")])
                    valid = operation(directory, {"action": "complete-node", "node": "develop"})
                    workflow = json.loads((directory / "workflow.json").read_text())
                    workflow["finish"] = finish
                    fixtures.write(directory / "workflow.json", workflow)
                    result = read(root)
                    self.assertEqual(result["eligible"], status == "completed")
                    self.assertFalse(result["complete"])
                    self.assertIn("current-input-incomplete", result["warnings"])
                    self.assertNotIn("terminal-conflict", result["warnings"])
                    self.assertEqual([step["id"] for step in result["steps"]], [
                        valid["op_id"], "task-result:executor-1/task-001", "final-observation"])

    def test_json_decoder_recursion_failure_degrades_only_the_affected_file(self):
        for target in ("operation", "task"):
            with self.subTest(target=target):
                root, directory = runtime(executor_tasks=[fixtures.task(1, status="dev-complete")])
                valid = operation(directory, {"action": "complete-node", "node": "develop"})
                if target == "operation":
                    damaged = operation(directory, {"action": "complete-node", "node": "evaluate"}, revision=2)
                    path = directory / "context" / "operations" / f"{damaged['op_id']}.json"
                else:
                    path = directory / "executor-1" / "task-002.json"
                    fixtures.write(path, fixtures.task(2))
                original = history._projection_read_json_capped

                def recursion_failure(input_path):
                    if input_path == path:
                        raise RecursionError("excessive JSON nesting")
                    return original(input_path)

                with mock.patch.object(history, "_projection_read_json_capped", side_effect=recursion_failure):
                    result = read(root)
                self.assertTrue(result["eligible"])
                self.assertFalse(result["complete"])
                self.assertIn(f"{target}-record-invalid", result["warnings"])
                self.assertEqual([step["id"] for step in result["steps"]], [
                    valid["op_id"], "task-result:executor-1/task-001", "final-observation"])

    def test_schema_shaped_damaged_task_is_omitted_with_warning(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1, status="dev-complete")])
        damaged = fixtures.task(2)
        damaged["round"] = ["invalid"]
        fixtures.write(directory / "executor-1" / "task-002.json", damaged)
        result = read(root)
        self.assertTrue(result["eligible"])
        self.assertIn("task-record-invalid", result["warnings"])
        self.assertEqual(result["steps"][0]["source_refs"], ["executor-1/task-001.json"])
        self.assertNotIn("invalid", json.dumps(result["steps"]))

    def test_invalid_sequence_is_filtered_before_projection_sorting(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1, status="dev-complete")])
        damaged = fixtures.task(2)
        damaged["seq"] = ["invalid"]
        fixtures.write(directory / "executor-1" / "task-002.json", damaged)
        result = read(root)
        self.assertTrue(result["eligible"])
        self.assertFalse(result["complete"])
        self.assertIn("task-record-invalid", result["warnings"])
        self.assertEqual(result["steps"][0]["source_refs"], ["executor-1/task-001.json"])
        self.assertNotIn("invalid", json.dumps(result["steps"]))

    def test_inputs_changing_during_history_enumeration_are_refused(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1, status="dev-complete")])
        actual = history._task_records

        def changed(*args):
            fixtures.write(directory / "executor-1" / "task-001.json", fixtures.task(1, status="review-passed"))
            return actual(*args)

        with mock.patch.object(history, "_task_records", side_effect=changed):
            with self.assertRaises(history.BridgeError) as error:
                read(root)
        self.assertEqual(error.exception.code, "input-inconsistent")

    def test_action_hash_fingerprint_time_and_revision_validation(self):
        for patch in (lambda op: op.update(stage="planned"),
                      lambda op: op.update(definition_digest="sha256:bad"),
                      lambda op: op.update(expected_revision=10),
                      lambda op: op.update(created_at="2026-10-23T12:00:00"),
                      lambda op: op["writes"]["task.json"].update(after=None),
                      lambda op: op["writes"].update({"../outside": {"before": None, "after": AFTER}}),
                      lambda op: op["action"].update(node="evaluate")):
            with self.subTest(patch=patch):
                root, directory = runtime()
                op = operation(directory, {"action": "complete-node", "node": "develop"})
                patch(op)
                fixtures.write(directory / "context" / "operations" / f"{op['op_id']}.json", op)
                result = read(root)
                self.assertEqual(result["steps"], [])
                self.assertIn("operation-record-invalid", result["warnings"])

    def test_missing_time_is_null_and_not_inferred(self):
        root, directory = runtime()
        operation(directory, {"action": "complete-node", "node": "develop"}, created_at=None)
        result = read(root)
        self.assertIsNone(result["steps"][0]["recorded_at"])
        self.assertIn("recorded-time-unavailable", result["warnings"])
        self.assertNotIn("duration", json.dumps(result))

    def test_recorded_time_normalizes_iso_variants_to_the_client_contract(self):
        for recorded, expected in (
                ("2026-10-23 12:00:00+0800", "2026-10-23T04:00:00+00:00"),
                ("20261023T120000+0800", "2026-10-23T04:00:00+00:00"),
                ("2026-10-23T12:00:00.123456+08:00", "2026-10-23T04:00:00.123456+00:00"),
                ("2026-10-23T04:00:00Z", "2026-10-23T04:00:00+00:00")):
            with self.subTest(recorded=recorded):
                root, directory = runtime()
                operation(directory, {"action": "complete-node", "node": "develop"}, created_at=recorded)
                result = read(root)
                self.assertEqual(result["steps"][0]["recorded_at"], expected)
                self.assertRegex(result["steps"][0]["recorded_at"],
                                 r"^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$")

    def test_close_operations_validate_frozen_hashes_without_leaking_final_conclusions_early(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1, status="review-passed")])
        op = close_operation(directory)
        result = read(root)
        self.assertEqual(result["steps"][0]["id"], op["op_id"])
        self.assertEqual(result["steps"][0]["kind"], "terminal-record")
        self.assertIsNone(result["steps"][0]["snapshot"]["terminal"])
        self.assertIsNone(executor(result["steps"][0])["verdict"])
        self.assertEqual(result["steps"][-1]["snapshot"]["terminal"], "completed")
        op["writes"]["workflow.json"]["after"] = BEFORE
        fixtures.write(directory / "context" / "operations" / f"{op['op_id']}.json", op)
        self.assertIn("operation-record-invalid", read(root)["warnings"])

    def test_valid_close_disagreeing_with_current_terminal_disables_playback(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1)])
        close_operation(directory, outcome="completed-with-findings")
        result = read(root)
        self.assertFalse(result["eligible"])
        self.assertEqual(result["steps"], [])
        self.assertIn("terminal-conflict", result["warnings"])

    def test_huge_revision_is_bounded_and_marked_incomplete(self):
        root, directory = runtime()
        workflow = json.loads((directory / "workflow.json").read_text())
        workflow["revision"] = history.projection.MAX_SAFE_INTEGER
        fixtures.write(directory / "workflow.json", workflow)
        operation(directory, {"action": "complete-node", "node": "develop"})
        result = read(root)
        self.assertEqual(len(result["steps"]), 2)
        self.assertIn("operation-history-incomplete", result["warnings"])

    def test_task_file_identity_and_total_input_limit(self):
        root, directory = runtime()
        for index in range(1, 202):
            fixtures.write(directory / "executor-1" / f"task-{index:03d}.json", fixtures.task(index))
        result = read(root)
        self.assertLessEqual(len(result["steps"]), 200)
        self.assertIn("task-input-limit", result["warnings"])
        self.assertIn("milestone-output-limit", result["warnings"])
        fixtures.write(directory / "executor-1" / "task-001.json", fixtures.task(50))
        self.assertIn("task-record-invalid", read(root)["warnings"])

    def test_operation_input_and_milestone_limits(self):
        root, directory = runtime()
        workflow = json.loads((directory / "workflow.json").read_text())
        workflow["revision"] = 1000
        fixtures.write(directory / "workflow.json", workflow)
        for index in range(1, 202):
            operation(directory, {"action": "complete-node", "node": "develop"}, revision=index)
        result = read(root)
        self.assertEqual(len(result["steps"]), 200)
        self.assertEqual(result["steps"][-1]["kind"], "final-snapshot")
        self.assertIn("operation-input-limit", result["warnings"])
        self.assertIn("milestone-output-limit", result["warnings"])

    def test_file_limit_marks_incomplete_and_never_returns_raw_content(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1)])
        fixtures.write(directory / "context" / "operations" / "op-000001-overlimit.json", None,
                       raw="x" * (history.projection.MAX_FILE_BYTES + 1))
        result = read(root)
        self.assertIn("operation-record-invalid", result["warnings"])
        self.assertLess(len(json.dumps(result)), 30000)

    def test_response_envelope_is_bounded_and_final_observation_is_preserved(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1)])
        for index in range(1, 11):
            operation(directory, {"action": "complete-node", "node": "develop"}, revision=index - 1 or 1)
        with mock.patch.object(history, "MAX_RESPONSE_BYTES", 12000):
            result = read(root)
        encoded = json.dumps({"ok": True, "data": result}, ensure_ascii=False).encode()
        self.assertLessEqual(len(encoded), 12000)
        self.assertEqual(result["steps"][-1]["kind"], "final-snapshot")
        self.assertIn("response-size-limit", result["warnings"])

    def test_fixed_task_and_symlink_boundaries_fail_closed(self):
        root, directory = runtime()
        for task_id in ("../escape", "/absolute", "a/b", "a\\b", ".."):
            with self.assertRaises(history.BridgeError):
                history.read_history(root, task_id, project="fixed")
        outside = fixtures.uuid_tmp()
        (directory / "context").mkdir()
        (directory / "context" / "operations").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(history.BridgeError) as error:
            read(root)
        self.assertEqual(error.exception.code, "unsafe-file-type")

    def test_operation_symlink_is_never_followed(self):
        root, directory = runtime()
        outside = fixtures.uuid_tmp() / "private.json"
        fixtures.write(outside, {"private": "not history"})
        operations = directory / "context" / "operations"
        operations.mkdir(parents=True)
        (operations / "op-000001-linked.json").symlink_to(outside)
        with self.assertRaises(history.BridgeError) as error:
            read(root)
        self.assertEqual(error.exception.code, "unsafe-file-type")

    def test_reading_performs_zero_writes_and_keeps_binding_isolated(self):
        root, directory = runtime(executor_tasks=[fixtures.task(1, status="review-passed")])
        operation(directory, {"action": "complete-node", "node": "develop"})

        def tree():
            return {str(path.relative_to(root)): (path.stat().st_mtime_ns, path.stat().st_size,
                    hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None)
                    for path in root.rglob("*")}

        before = tree()
        result = read(root)
        self.assertEqual(before, tree())
        second = history.read_history(root, TASK, project="another-fixed-binding", now=12345)
        self.assertEqual(second["project"], "another-fixed-binding")
        self.assertEqual(result["project"], "fixed-project")
        self.assertFalse(any(path.name == "__pycache__" for path in root.rglob("*")))


if __name__ == "__main__":
    unittest.main()
