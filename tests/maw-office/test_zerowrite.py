"""TEST-MWO-009 — zero-write guarantee over the watched project (POSIX/macOS).

Windows/Linux real-machine runs are environment-blocked (no machines); the path
logic under test here is platform-neutral standard library.
"""

import hashlib
import json
import os
import unittest

import fixtures
from fixtures import maw_office
from test_lifecycle import CaptureServer


def tree_snapshot(root):
    """Relative paths + content hashes for every file under root."""
    entries = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            relative = os.path.relpath(path, root)
            with open(path, "rb") as handle:
                entries[relative] = hashlib.sha256(handle.read()).hexdigest()
    return entries


class ZeroWriteTest(unittest.TestCase):
    def test_once_run_leaves_the_target_tree_byte_identical(self):
        project = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")])
        registry = project / fixtures.RUNTIME_REL / "dashboard-projects.json"
        registry.write_text(json.dumps({"schema": "maw.dashboard-registry/1", "updated_at": "x", "projects": []}), encoding="utf-8")
        before = tree_snapshot(project)

        capture = CaptureServer()
        try:
            code = maw_office.main(["--serve", "--once", "--project-root", str(project), "--office-url", capture.url])
            self.assertEqual(code, 0)
        finally:
            capture.close()
        self.assertEqual(tree_snapshot(project), before)
        self.assertTrue(registry.exists())  # registry never deleted or rewritten

    def test_pycache_is_never_written(self):
        project = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")])
        capture = CaptureServer()
        try:
            maw_office.main(["--serve", "--once", "--project-root", str(project), "--office-url", capture.url])
        finally:
            capture.close()
        for base, dirs, _files in os.walk(project):
            self.assertNotIn("__pycache__", dirs, f"pycache appeared under {base}")

    def test_loop_mode_does_not_write_either(self):
        project = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")])
        before = tree_snapshot(project)
        capture = CaptureServer(respond=lambda method, req: (200, json.dumps(
            {"ok": True, "server_epoch": 1, "seq": 1, "consumer_idle_ms": 999_999_999,
             "idle_timeout_reached": True, "duplicate": False})))
        try:
            code = maw_office.main(["--serve", "--project-root", str(project), "--office-url", capture.url, "--poll-seconds", "1"])
            self.assertEqual(code, 0)
        finally:
            capture.close()
        self.assertEqual(tree_snapshot(project), before)


if __name__ == "__main__":
    unittest.main()
