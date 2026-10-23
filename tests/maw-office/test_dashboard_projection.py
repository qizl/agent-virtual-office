"""Shared module contract, strict limits, fixed selection and zero-write import."""
import copy
import json
import stat
import unittest
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


if __name__ == "__main__":
    unittest.main()
