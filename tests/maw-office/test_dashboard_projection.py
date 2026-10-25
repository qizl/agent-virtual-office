"""Shared module contract, strict limits, fixed selection and zero-write import."""
import copy
import json
import stat
import unittest
from pathlib import Path
from unittest import mock

import fixtures
from fixtures import maw_office, RUNTIME_REL

projection = maw_office.projection


def sample():
    return {"schema": projection.SCHEMA, "producer": "producer-123", "seq": 1,
            "sampled_at": 1000, "workflow": None, "quality": "ok",
            "quality_detail": None, "terminal": None, "members": []}


def member(index=1):
    return {"id": f"member-{index}", "role": "executor", "status": "working"}


class SnapshotValidationTest(unittest.TestCase):
    def assert_invalid(self, value, code="invalid-snapshot"):
        with self.assertRaises(projection.BridgeError) as error:
            projection.validate_snapshot(value)
        self.assertEqual(error.exception.code, code)

    def test_accepts_all_50_members_and_never_trims(self):
        value = sample()
        value["members"] = [member(i) for i in range(50)]
        self.assertIs(projection.validate_snapshot(value), value)
        value["members"].append(member(50))
        self.assert_invalid(value, "member-limit")
        self.assertEqual(len(value["members"]), 51)

    def test_serialized_utf8_size_boundary_is_exact(self):
        value = sample()
        # Unknown fields count toward the same complete serialized body limit.
        value["padding"] = ""
        size = len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())
        value["padding"] = "a" * (16384 - size)
        projection.validate_snapshot(value)
        value["padding"] += "a"
        self.assert_invalid(value, "payload-too-large")

    def test_utf8_multibyte_size_is_not_character_count(self):
        value = sample()
        value["padding"] = "测" * 6000
        self.assert_invalid(value, "payload-too-large")

    def test_schema_identity_required_numbers_and_enums(self):
        for key, invalid in (("schema", "wrong"), ("producer", "x"), ("seq", 0),
                             ("seq", True), ("seq", float("nan")), ("seq", 2**10000),
                             ("sampled_at", -1), ("quality", []), ("terminal", "unknown")):
            value = sample()
            value[key] = invalid
            self.assert_invalid(value)

    def test_member_identity_and_enums(self):
        for patch in ({"id": "bad~id"}, {"role": []}, {"status": []},
                      {"task_kind": []}, {"verdict": "unknown"}, {"terminate": "unknown"},
                      {"stalled": 1}, {"round": True}, {"round": 2**53}):
            value = sample()
            value["members"] = [{**member(), **patch}]
            self.assert_invalid(value)
        value = sample()
        value["members"] = [member(), member()]
        self.assert_invalid(value)

    def test_javascript_utf16_text_length_is_preserved(self):
        value = sample()
        value["members"] = [{**member(), "label": "😀" * 100}]
        projection.validate_snapshot(value)
        value["members"][0]["label"] += "😀"
        self.assert_invalid(value)

    def test_optional_member_fields_are_accepted(self):
        value = sample()
        value["members"] = [{**member(), "detail": None, "round": -1,
                             "task_kind": "aggregate-review", "verdict": "fail",
                             "terminate": "initialized", "stalled": True}]
        projection.validate_snapshot(value)

    def test_execution_state_is_optional_and_strictly_validated(self):
        projection.validate_snapshot(sample())
        for state in ("not-started", "started", "unknown"):
            projection.validate_snapshot({**sample(), "execution_state": state})
        for state in (None, "assigned", True, 1, [], {}):
            with self.subTest(state=state):
                self.assert_invalid({**sample(), "execution_state": state})


class DashboardReadTest(unittest.TestCase):
    def test_read_api_matches_shared_cli_projection(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1)])
        before = sorted(str(p.relative_to(root)) for p in root.rglob("*"))
        actual = projection.read_snapshot(root, "maw-synth-001", now=lambda: 1000)
        raw = maw_office.build_snapshot(maw_office.read_with_consistency(root, "maw-synth-001", 30), actual["producer_id"], 1, 1000)
        self.assertEqual(actual["members"], raw["members"])
        self.assertEqual(actual["workflow"], raw["workflow"])
        self.assertEqual(actual["sampled_at"], 1000)
        self.assertEqual(before, sorted(str(p.relative_to(root)) for p in root.rglob("*")))
        self.assertFalse(any(p.name == "__pycache__" for p in root.rglob("*")))

    def test_fixed_selection_does_not_fall_back(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        with self.assertRaises(projection.BridgeError) as error:
            projection.read_snapshot(root, "missing")
        self.assertEqual(error.exception.code, "task-not-found")
        for task in ("../maw-synth-001", "/absolute", "a/b", "a\\b", ".."):
            with self.assertRaises(projection.BridgeError):
                projection.read_snapshot(root, task)

    def test_corrupt_inputs_and_moving_inputs_fail_explicitly(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        path = root / RUNTIME_REL / "maw-synth-001" / "workflow.json"
        path.write_text("broken", encoding="utf-8")
        with self.assertRaises(projection.BridgeError) as error:
            projection.read_snapshot(root, "maw-synth-001")
        self.assertEqual(error.exception.code, "invalid-input")
        state = projection.read_runtime_state(root, "maw-synth-001")
        state["_inconsistent"] = True
        with mock.patch.object(projection, "read_with_consistency", return_value=state):
            with self.assertRaises(projection.BridgeError) as error:
                projection.read_snapshot(root, "maw-synth-001")
        self.assertEqual(error.exception.code, "input-inconsistent")

    def test_windows_reparse_guard_does_not_follow_targets(self):
        info = mock.Mock(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        with mock.patch("pathlib.Path.lstat", return_value=info):
            self.assertTrue(projection.unsafe_component(fixtures.uuid_tmp()))


class InteractionProjectionTest(unittest.TestCase):
    def snapshot(self, **kwargs):
        root = fixtures.build_runtime(fixtures.uuid_tmp(), **kwargs)
        return root, projection.read_snapshot(root, "maw-synth-001", now=1000)

    def test_assignment_requires_complete_observation(self):
        root, value = self.snapshot()
        self.assertEqual(value["assignment_state"], "unassigned")
        state = projection.read_runtime_state(root, "maw-synth-001")
        state["degraded"].append("executor-1/tasks:corrupt")
        raw = projection.build_snapshot(state, "producer-test", 1, 1000)
        self.assertEqual((raw["assignment_state"], raw["handoff_state"]), ("unknown", "unavailable"))
        state["degraded"].clear()
        del state["roles"]["reviewer-1"]
        self.assertEqual(projection.build_snapshot(state, "producer-test", 1, 1000)["assignment_state"], "unknown")

    def test_delayed_exact_reviewer_publishes_one_stable_submission(self):
        root, first = self.snapshot(executor_tasks=[fixtures.task(1, status="dev-complete")])
        actor = fixtures.member_by_role(first["members"], "executor")
        self.assertEqual(actor["current_task"]["source_ref"], "executor-1/task-001.json")
        self.assertEqual(actor["handoff_pending"], "missing")
        self.assertEqual(first["handoffs"], [])
        directory = root / RUNTIME_REL / "maw-synth-001"
        manifest = json.loads((directory / "task.json").read_text())
        manifest["roles"].append("reviewer-2")
        fixtures.write(directory / "task.json", manifest)
        fixtures.write(directory / "reviewer-2" / "ready.json", {"schema": "maw.ready/1", "status": "confirmed"})
        fixtures.write(directory / "reviewer-2" / "task-002.json",
                       fixtures.task(2, type_="review", status="initialized", ref_task="executor-1/task-001"))
        value = projection.read_snapshot(root, "maw-synth-001", now=2000)
        self.assertEqual(value["assignment_state"], "assigned")
        self.assertEqual(len(value["handoffs"]), 1)
        edge = value["handoffs"][0]
        self.assertEqual(projection.handoff_fact("submission", "exec-1", "rev-1", "executor-1/task-001.json",
                                                  "reviewer-1/task-002.json")["id"], "4534b921036473945a2e397f0428183c")
        exact_reviewer = next(member for member in value["members"] if (member.get("current_task") or {}).get("source_ref") == "reviewer-2/task-002.json")
        self.assertEqual((edge["kind"], edge["sender_member_id"], edge["recipient_member_id"]),
                         ("submission", actor["id"], exact_reviewer["id"]))
        self.assertEqual(value["handoffs"], projection.read_snapshot(root, "maw-synth-001", now=3000)["handoffs"])

    def test_conflict_not_ready_and_stale_target_never_guess_a_recipient(self):
        dev = fixtures.task(1, status="dev-complete")
        review = fixtures.task(2, type_="review", status="initialized", ref_task="executor-1/task-001")
        root, value = self.snapshot(executor_tasks=[dev], reviewer_tasks=[review], reviewer_ready=None)
        self.assertEqual(value["handoffs"], [])
        self.assertEqual(fixtures.member_by_role(value["members"], "executor")["handoff_pending"], "not-ready")
        directory = root / RUNTIME_REL / "maw-synth-001"
        fixtures.write(directory / "reviewer-1" / "ready.json", {"schema": "maw.ready/1", "status": "confirmed"})
        fixtures.write(directory / "reviewer-1" / "task-003.json", fixtures.task(3, type_="review", ref_task="executor-1/task-001"))
        value = projection.read_snapshot(root, "maw-synth-001", now=1000)
        self.assertEqual(value["handoffs"], [])
        self.assertEqual(fixtures.member_by_role(value["members"], "executor")["handoff_pending"], "conflict")
        # A reviewer reassigned to an unrelated current task is unavailable.
        fixtures.write(directory / "reviewer-1" / "task-003.json", fixtures.task(3, type_="review", ref_task=None))
        value = projection.read_snapshot(root, "maw-synth-001", now=1000)
        self.assertEqual(value["handoffs"], [])
        self.assertEqual(fixtures.member_by_role(value["members"], "executor")["handoff_pending"], "not-ready")

    def test_review_failure_returns_only_to_exact_author_and_not_rework_successor(self):
        dev = fixtures.task(1, status="review-failed")
        review = fixtures.task(2, type_="review", status="review-failed", ref_task="executor-1/task-001")
        root, value = self.snapshot(executor_tasks=[dev], reviewer_tasks=[review])
        self.assertEqual([edge["kind"] for edge in value["handoffs"]], ["review-result"])
        self.assertEqual(value["handoffs"][0]["target_task"], "executor-1/task-001.json")
        self.assertEqual(fixtures.member_by_role(value["members"], "executor")["status"], "blocked")
        self.assertEqual(fixtures.member_by_role(value["members"], "reviewer")["verdict"], "fail")
        directory = root / RUNTIME_REL / "maw-synth-001"
        fixtures.write(directory / "executor-1" / "task-003.json",
                       fixtures.task(3, status="dev-complete", round_=2, ref_task="executor-1/task-001"))
        value = projection.read_snapshot(root, "maw-synth-001", now=1000)
        self.assertEqual(value["handoffs"], [])
        self.assertEqual(fixtures.member_by_role(value["members"], "executor")["handoff_pending"], "missing")
        self.assertEqual(fixtures.member_by_role(value["members"], "reviewer")["handoff_pending"], "not-ready")

    def test_interaction_input_limit_disables_whole_group(self):
        root, _value = self.snapshot(executor_tasks=[fixtures.task(1)])
        state = projection.read_runtime_state(root, "maw-synth-001")
        state["roles"]["executor-1"]["tasks"] = [fixtures.task(index) for index in range(1, 201)]
        state["roles"]["reviewer-1"]["tasks"] = [fixtures.task(201, type_="review", ref_task="executor-1/task-200")]
        value = projection.build_snapshot(state, "producer-test", 1, 1000)
        self.assertEqual(value["handoffs"], [])
        self.assertEqual(value["handoff_state"], "unavailable")
        self.assertEqual(value["assignment_state"], "unknown")

    def test_new_snapshot_fields_reject_malformed_or_cross_task_relationships(self):
        _root, value = self.snapshot(executor_tasks=[fixtures.task(1, status="dev-complete")],
                                    reviewer_tasks=[fixtures.task(2, type_="review", status="initialized", ref_task="executor-1/task-001")])
        raw = {**value, "producer": value["producer_id"], "seq": 1}
        projection.validate_snapshot(raw)
        mutations = [lambda v: v.update(assignment_state=None), lambda v: v.update(handoff_state="guessed"),
                     lambda v: v["handoffs"][0].update(recipient_member_id="foreign"),
                     lambda v: v["handoffs"][0].update(source_task="executor-1/task-999.json"),
                     lambda v: v["handoffs"][0].update(kind="handover"),
                     lambda v: v["handoffs"][0].update(extra=True),
                     lambda v: v["handoffs"].append(copy.deepcopy(v["handoffs"][0])),
                     lambda v: v.update(handoffs=[None] * 201),
                     lambda v: fixtures.member_by_role(v["members"], "executor")["current_task"].update(source_ref="../private.json"),
                     lambda v: fixtures.member_by_role(v["members"], "executor")["current_task"].update(seq=True),
                     lambda v: fixtures.member_by_role(v["members"], "reviewer")["current_task"].update(round=2)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                invalid = copy.deepcopy(raw)
                mutate(invalid)
                with self.assertRaises(projection.BridgeError):
                    projection.validate_snapshot(invalid)


class ExecutionProjectionTest(unittest.TestCase):
    def snapshot(self, **kwargs):
        root = fixtures.build_runtime(fixtures.uuid_tmp(), **kwargs)
        return root, projection.read_snapshot(root, "maw-synth-001", now=1000)

    def test_no_tasks_or_only_initialized_tasks_do_not_prove_execution(self):
        for status in ("active", "completed", "cancelled"):
            for tasks in ([], [fixtures.task(1, status="initialized")]):
                with self.subTest(status=status, tasks=bool(tasks)):
                    _root, value = self.snapshot(manifest_status=status, executor_tasks=tasks)
                    self.assertEqual(value["execution_state"], "not-started")

    def test_every_supported_post_assignment_status_proves_execution(self):
        for status in ("in-progress", "dev-complete", "reviewing", "review-passed", "review-failed"):
            for kind in ("dev", "review", "plan-review", "aggregate-review"):
                with self.subTest(status=status, kind=kind):
                    field = "executor_tasks" if kind == "dev" else "reviewer_tasks"
                    _root, value = self.snapshot(**{field: [fixtures.task(1, type_=kind, status=status)]})
                    self.assertEqual(value["execution_state"], "started")

    def test_earlier_execution_is_not_hidden_by_an_initialized_rework(self):
        _root, value = self.snapshot(executor_tasks=[
            fixtures.task(1, status="review-failed"),
            fixtures.task(3, status="initialized", round_=2, ref_task="executor-1/task-001"),
        ])
        self.assertEqual(fixtures.member_by_role(value["members"], "executor")["status"], "planning")
        self.assertEqual(value["execution_state"], "started")

    def test_only_manifest_bound_concrete_member_tasks_count(self):
        root, _value = self.snapshot(decision_tasks=[fixtures.task(1)])
        directory = root / RUNTIME_REL / "maw-synth-001"
        fixtures.write(directory / "manager-1" / "task-002.json", fixtures.task(2))
        self.assertEqual(projection.read_snapshot(root, "maw-synth-001", now=1000)["execution_state"], "not-started")
        manifest = json.loads((directory / "task.json").read_text())
        manifest["roles"].append("decision-maker-1")
        fixtures.write(directory / "task.json", manifest)
        self.assertEqual(projection.read_snapshot(root, "maw-synth-001", now=1000)["execution_state"], "started")

    def test_execution_is_independent_of_recipient_readiness_and_pending_links(self):
        _root, value = self.snapshot(executor_tasks=[fixtures.task(1, status="dev-complete")],
                                    reviewer_tasks=[fixtures.task(2, type_="review", status="initialized",
                                                                  ref_task="executor-1/task-001")],
                                    executor_ready=None, reviewer_ready=None)
        self.assertEqual(value["handoffs"], [])
        self.assertEqual(fixtures.member_by_role(value["members"], "executor")["handoff_pending"], "not-ready")
        self.assertEqual(value["execution_state"], "started")

    def test_incomplete_or_invalid_task_observation_is_unknown(self):
        root, _value = self.snapshot(executor_tasks=[fixtures.task(1)])
        original = projection.read_runtime_state(root, "maw-synth-001")
        variants = []
        state = copy.deepcopy(original)
        state["degraded"].append("executor-1/tasks:limit")
        variants.append(state)
        state = copy.deepcopy(original)
        state["_inconsistent"] = True
        variants.append(state)
        state = copy.deepcopy(original)
        del state["roles"]["reviewer-1"]
        variants.append(state)
        state = copy.deepcopy(original)
        state["manifest"]["roles"].append("executor-1")
        variants.append(state)
        for state in variants:
            self.assertEqual(projection.build_snapshot(state, "producer-test", 1, 1000)["execution_state"], "unknown")
        directory = root / RUNTIME_REL / "maw-synth-001" / "executor-1"
        (directory / "task-001.json").rename(directory / "task-002.json")
        self.assertEqual(projection.read_snapshot(root, "maw-synth-001", now=1000)["execution_state"], "unknown")
        fixtures.write(directory / "task-002.json", fixtures.task(2, status="unsupported"))
        self.assertEqual(projection.read_snapshot(root, "maw-synth-001", now=1000)["execution_state"], "unknown")

    def test_a_task_disappearing_during_read_does_not_prove_absence(self):
        root, _value = self.snapshot(executor_tasks=[fixtures.task(1)])
        real_read = projection.read_json_schema

        def missing_task(path, allowed):
            return (None, "missing") if path.name == "task-001.json" else real_read(path, allowed)

        with mock.patch.object(projection, "read_json_schema", side_effect=missing_task):
            state = projection.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(projection.build_snapshot(state, "producer-test", 1, 1000)["execution_state"], "unknown")

    def test_a_failed_task_listing_does_not_prove_absence(self):
        root, _value = self.snapshot(executor_tasks=[fixtures.task(1)])
        real_glob = Path.glob

        def failed_listing(path, pattern):
            if path.name == "executor-1":
                raise OSError("task listing unavailable")
            return real_glob(path, pattern)

        with mock.patch.object(Path, "glob", autospec=True, side_effect=failed_listing):
            state = projection.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(projection.build_snapshot(state, "producer-test", 1, 1000)["execution_state"], "unknown")

    def test_total_task_limit_prevents_inference_from_an_incomplete_group(self):
        for count, expected in ((200, "started"), (201, "unknown")):
            with self.subTest(count=count):
                _root, value = self.snapshot(executor_tasks=[fixtures.task(index) for index in range(1, count)],
                                            reviewer_tasks=[fixtures.task(count, type_="review", status="initialized")])
                self.assertEqual(value["execution_state"], expected)

    def test_interaction_size_fallback_keeps_the_execution_fact(self):
        root, _value = self.snapshot()
        directory = root / RUNTIME_REL / "maw-synth-001"
        manifest = json.loads((directory / "task.json").read_text())
        for index in range(1, 25):
            executor, reviewer = f"executor-{index}", f"reviewer-{index}"
            for folder in (executor, reviewer):
                if folder not in manifest["roles"]:
                    manifest["roles"].append(folder)
                fixtures.write(directory / folder / "ready.json", {"schema": "maw.ready/1", "status": "confirmed"})
            fixtures.write(directory / executor / f"task-{index:03d}.json", fixtures.task(index, status="dev-complete"))
            seq = index + 24
            fixtures.write(directory / reviewer / f"task-{seq:03d}.json",
                           fixtures.task(seq, type_="review", status="initialized", ref_task=f"{executor}/task-{index:03d}"))
        fixtures.write(directory / "task.json", manifest)
        value = projection.read_snapshot(root, "maw-synth-001", now=1000)
        self.assertEqual(value["handoff_state"], "unavailable")
        self.assertEqual(value["execution_state"], "started")
        self.assertLessEqual(len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()), 16384)


if __name__ == "__main__":
    unittest.main()
