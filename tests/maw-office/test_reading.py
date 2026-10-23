"""TEST-MWO-007 — read face, ordering, degradation and consistency (§4.2)."""

import json
import os
import unittest
from unittest import mock

import fixtures
from fixtures import maw_office, RUNTIME_REL


class SelectionTest(unittest.TestCase):
    def test_task_order_is_manifest_mtime_desc_then_id_asc(self):
        import time
        root = fixtures.uuid_tmp()
        runtime = root / RUNTIME_REL
        for name, mtime in (("maw-a-newer", time.time() - 10), ("maw-b-older", time.time() - 100), ("maw-c-newest", time.time())):
            d = runtime / name
            fixtures.write(d / "task.json", fixtures.manifest())
            os.utime(d / "task.json", (mtime, mtime))
        self.assertEqual(maw_office.pick_task(runtime, None), "maw-c-newest")
        os.remove(runtime / "maw-a-newer" / "task.json")
        self.assertEqual(maw_office.pick_task(runtime, None), "maw-c-newest")


class SelectionRegistryTest(unittest.TestCase):
    def test_registry_first_usable_project_is_selected(self):
        import os

        anchor = fixtures.uuid_tmp()
        project = fixtures.uuid_tmp()
        fixtures.build_runtime(project)
        runtime_dir = anchor / RUNTIME_REL
        runtime_dir.mkdir(parents=True)
        fixtures.write(runtime_dir / "dashboard-projects.json", {
            "schema": "maw.dashboard-registry/1",
            "updated_at": "2026-10-22T00:00:00+08:00",
            "projects": [
                {"path": str(anchor / "ghost"), "name": "ghost"},
                {"path": str(project), "name": "synth"},
            ],
        })
        cwd = os.getcwd()
        os.chdir(anchor)
        try:
            args = maw_office.build_parser().parse_args(["--serve"])
            self.assertEqual(maw_office.pick_project(args), project)
        finally:
            os.chdir(cwd)

    def test_missing_registry_is_a_stable_error(self):
        import os

        anchor = fixtures.uuid_tmp()
        cwd = os.getcwd()
        os.chdir(anchor)
        try:
            args = maw_office.build_parser().parse_args(["--serve"])
            with self.assertRaises(maw_office.BridgeError) as ctx:
                maw_office.pick_project(args)
            self.assertEqual(ctx.exception.code, "registry-missing")
        finally:
            os.chdir(cwd)


class DegradationTest(unittest.TestCase):
    def test_corrupt_manifest_degrades_to_no_manifest(self):
        root = fixtures.uuid_tmp()
        fixtures.build_runtime(root)
        (root / RUNTIME_REL / "maw-synth-001" / "task.json").write_text("{broken", encoding="utf-8")
        state = maw_office.read_runtime_state(root, "maw-synth-001")
        self.assertIsNone(state["manifest"])
        self.assertTrue(any(d.startswith("task.json:corrupt") for d in state["degraded"]))

    def test_unknown_schema_degrades_and_missing_ready_is_normal(self):
        root = fixtures.build_runtime(
            fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")],
            executor_ready=None)
        (root / RUNTIME_REL / "maw-synth-001" / "workflow.json").write_text(
            json.dumps({"schema": "maw.workflow/9", "nodes": {}}), encoding="utf-8")
        state = maw_office.read_runtime_state(root, "maw-synth-001")
        self.assertTrue(any(d.startswith("workflow.json:unknown-schema") for d in state["degraded"]))
        self.assertEqual(state["roles"]["executor-1"]["ready"], None)
        self.assertFalse(any("ready.json" in d for d in state["degraded"]))

    def test_handoff_is_existence_only_and_content_never_enters_the_fingerprint(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        handoff = root / RUNTIME_REL / "maw-synth-001" / "context" / "handoff.md"
        self.assertFalse(state_handoff(root))
        handoff.parent.mkdir(parents=True, exist_ok=True)
        handoff.write_text("v1", encoding="utf-8")
        self.assertTrue(state_handoff(root))
        fp1 = maw_office.fingerprint(maw_office.read_runtime_state(root, "maw-synth-001"))
        handoff.write_text("v2 — completely different body", encoding="utf-8")
        fp2 = maw_office.fingerprint(maw_office.read_runtime_state(root, "maw-synth-001"))
        self.assertEqual(fp1, fp2)  # existence/attributes only, never the body


def state_handoff(root):
    return maw_office.read_runtime_state(root, "maw-synth-001")["handoff_present"]


class PathSafetyTest(unittest.TestCase):
    def test_symlinked_task_dir_is_rejected(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        real = fixtures.uuid_tmp() / "elsewhere"
        real.mkdir(parents=True)
        link = root / RUNTIME_REL / "maw-synth-002"
        os.symlink(real, link)
        with self.assertRaises(maw_office.BridgeError) as ctx:
            maw_office.read_runtime_state(root, "maw-synth-002")
        # Symlinks are rejected per component BEFORE resolving — wherever they point.
        self.assertEqual(ctx.exception.code, "unsafe-file-type")

    def test_intra_root_symlink_is_rejected_too(self):
        # A link to a task dir INSIDE the project used to pass the containment
        # check (resolve() followed it first); the per-component check refuses it.
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        real = root / RUNTIME_REL / "maw-synth-001"
        link = root / RUNTIME_REL / "maw-synth-003"
        os.symlink(real, link)
        with self.assertRaises(maw_office.BridgeError) as ctx:
            maw_office.read_runtime_state(root, "maw-synth-003")
        self.assertEqual(ctx.exception.code, "unsafe-file-type")

    def test_absolute_plan_ref_is_refused(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        manifest_path = root / RUNTIME_REL / "maw-synth-001" / "task.json"
        data = json.loads(manifest_path.read_text())
        data["plan_ref"] = "/etc/hostname"
        manifest_path.write_text(json.dumps(data), encoding="utf-8")
        state = maw_office.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(state["plan_state"], "invalid")

    def test_traversal_plan_ref_is_refused(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        manifest_path = root / RUNTIME_REL / "maw-synth-001" / "task.json"
        data = json.loads(manifest_path.read_text())
        data["plan_ref"] = "../../../../etc/hostname"
        manifest_path.write_text(json.dumps(data), encoding="utf-8")
        state = maw_office.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(state["plan_state"], "invalid")


class ConsistencyTest(unittest.TestCase):
    def test_moving_tree_publishes_concurrent_update_degradation(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")])
        task_file = root / RUNTIME_REL / "maw-synth-001" / "executor-1" / "task-001.json"
        calls = {"n": 0}

        real_read = maw_office.read_runtime_state

        def alternating(project_root, task_id):
            # A writer keeps landing: between pass 1/2 and again between 2/3, so a
            # single reread cannot catch up and the sample must publish degraded.
            calls["n"] += 1
            if calls["n"] in (2, 3):
                fixtures.write(task_file, fixtures.task(1, "dev", "review-passed" if calls["n"] == 2 else "in-progress"))
            return real_read(project_root, task_id)

        with mock.patch.object(maw_office.projection, "read_runtime_state", alternating):
            state = maw_office.read_with_consistency(root, "maw-synth-001", 30)
        self.assertTrue(state.get("_inconsistent"))
        snapshot = maw_office.build_snapshot(state, "p", 1, 1000)
        self.assertEqual(snapshot["quality"], "degraded")
        self.assertEqual(snapshot["quality_detail"], "concurrent-update")

    def test_stable_tree_is_consistent(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")])
        state = maw_office.read_with_consistency(root, "maw-synth-001", 30)
        self.assertFalse(state.get("_inconsistent"))

class SubFileBoundaryTest(unittest.TestCase):
    """The read boundary holds for EVERY composed path, not just the task dir
    (review 2026-10-23 P2: symlinked sub-files and role dirs were read directly)."""

    def test_symlinked_manifest_is_rejected(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        outside = fixtures.uuid_tmp() / "secret.json"
        outside.write_text("{}", encoding="utf-8")
        task_json = root / RUNTIME_REL / "maw-synth-001" / "task.json"
        task_json.unlink()
        os.symlink(outside, task_json)
        with self.assertRaises(maw_office.BridgeError) as ctx:
            maw_office.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(ctx.exception.code, "unsafe-file-type")

    def test_symlinked_role_dir_is_rejected(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        outside = fixtures.uuid_tmp() / "outside-role"
        outside.mkdir(parents=True)
        link = root / RUNTIME_REL / "maw-synth-001" / "executor-9"
        os.symlink(outside, link)
        with self.assertRaises(maw_office.BridgeError) as ctx:
            maw_office.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(ctx.exception.code, "unsafe-file-type")

    def test_symlinked_role_file_is_rejected(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        outside = fixtures.uuid_tmp() / "ready.json"
        outside.write_text("{}", encoding="utf-8")
        ready = root / RUNTIME_REL / "maw-synth-001" / "executor-1" / "ready.json"
        ready.unlink()
        os.symlink(outside, ready)
        with self.assertRaises(maw_office.BridgeError) as ctx:
            maw_office.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(ctx.exception.code, "unsafe-file-type")

    def test_symlinked_listener_state_is_rejected(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        outside = fixtures.uuid_tmp() / "listener.json"
        outside.write_text("{}", encoding="utf-8")
        context_dir = root / RUNTIME_REL / "maw-synth-001" / "context"
        context_dir.mkdir()
        os.symlink(outside, context_dir / "listener-state.json")
        with self.assertRaises(maw_office.BridgeError) as ctx:
            maw_office.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(ctx.exception.code, "unsafe-file-type")

    def test_consistency_read_refuses_a_symlink_swapped_after_the_first_read(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        outside = fixtures.uuid_tmp() / "swapped.json"
        outside.write_text("{}", encoding="utf-8")
        workflow = root / RUNTIME_REL / "maw-synth-001" / "workflow.json"
        original = workflow.read_text()
        workflow.unlink()
        os.symlink(outside, workflow)
        workflow.unlink()
        workflow.write_text(original, encoding="utf-8")
        calls = {"n": 0}
        real_read = maw_office.read_runtime_state

        def swap_mid_read(project_root, task_id):
            calls["n"] += 1
            if calls["n"] == 2:  # the fingerprint re-read sees the hostile swap
                workflow.unlink()
                os.symlink(outside, workflow)
            return real_read(project_root, task_id)

        with mock.patch.object(maw_office.projection, "read_runtime_state", swap_mid_read):
            with self.assertRaises(maw_office.BridgeError) as ctx:
                maw_office.read_with_consistency(root, "maw-synth-001", 30)
        self.assertEqual(ctx.exception.code, "unsafe-file-type")

    def test_fingerprint_pass_refuses_a_task_dir_swapped_outside(self):
        # checked_path only guards the parts BELOW the task dir — the fingerprint
        # pass must re-validate the base itself (review 2026-10-23 P2: the swapped
        # base leaked one outside read before the second read refused).
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        real_dir = root / RUNTIME_REL / "maw-synth-001"
        outside = fixtures.uuid_tmp()
        calls = {"n": 0}
        real_read = maw_office.read_runtime_state

        def swap_after_first_read(project_root, task_id):
            state = real_read(project_root, task_id)
            calls["n"] += 1
            if calls["n"] == 1:  # before the fingerprint pass runs
                real_dir.rename(outside / "maw-synth-001")
                os.symlink(outside / "maw-synth-001", real_dir)
            return state

        with mock.patch.object(maw_office.projection, "read_runtime_state", swap_after_first_read):
            with self.assertRaises(maw_office.BridgeError) as ctx:
                maw_office.read_with_consistency(root, "maw-synth-001", 30)
        self.assertEqual(ctx.exception.code, "unsafe-file-type")


if __name__ == "__main__":
    unittest.main()
