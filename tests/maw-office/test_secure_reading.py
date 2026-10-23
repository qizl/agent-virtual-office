"""Descriptor boundary regressions use only synthetic outside sentinels."""

import json
import os
import unittest
from pathlib import Path
from unittest import mock

import fixtures
from fixtures import RUNTIME_REL

projection = fixtures.maw_office.projection


@unittest.skipIf(os.name == "nt", "POSIX descriptor and FIFO adapter tests")
class DescriptorBoundaryTest(unittest.TestCase):
    def assert_refused(self, action):
        with self.assertRaises(projection.BridgeError) as error:
            action()
        self.assertEqual(error.exception.code, "unsafe-file-type")

    def swapped_open(self, target, outside, action):
        """Replace only across the actual os.open call, then restore immediately."""
        real_open = os.open
        saved = target.with_name(target.name + ".saved")
        opened = []

        def hostile_open(path, flags, *args, **kwargs):
            if os.fspath(path) != target.name:
                return real_open(path, flags, *args, **kwargs)
            opened.append(path)
            target.rename(saved)
            target.symlink_to(outside, target_is_directory=outside.is_dir())
            try:
                return real_open(path, flags, *args, **kwargs)
            finally:
                target.unlink()
                saved.rename(target)

        with mock.patch.object(projection.os, "open", hostile_open):
            self.assert_refused(action)
        self.assertTrue(opened, "the hostile swap must occur at the open boundary")
        self.assertFalse(target.is_symlink())

    def test_manifest_swap_during_open_cannot_enter_accepted_snapshot(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        target = root / RUNTIME_REL / "maw-synth-001" / "task.json"
        outside = fixtures.uuid_tmp() / "outside.json"
        fixtures.write(outside, {**fixtures.manifest(), "status": "completed"})
        self.swapped_open(target, outside,
                          lambda: projection.read_snapshot(root, "maw-synth-001", now=1000))

    def test_directory_swap_during_open_cannot_escape_pinned_parent(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        target = root / RUNTIME_REL / "maw-synth-001" / "executor-1"
        outside = fixtures.uuid_tmp()
        fixtures.write(outside / "ready.json", {"schema": "maw.ready/1", "outside": "sentinel"})
        self.swapped_open(target, outside,
                          lambda: projection.read_snapshot(root, "maw-synth-001", now=1000))

    def test_fingerprint_uses_the_same_non_follow_leaf_open(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        state = projection.read_runtime_state(root, "maw-synth-001")
        target = root / RUNTIME_REL / "maw-synth-001" / "executor-1" / "ready.json"
        outside = fixtures.uuid_tmp() / "outside.json"
        fixtures.write(outside, {"outside": "sentinel"})
        self.swapped_open(target, outside, lambda: projection.fingerprint(state))

    def test_plan_digest_refuses_leaf_swapped_only_during_open(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        target = root / "docs" / "development" / "plan.md"
        outside = fixtures.uuid_tmp() / "outside.md"
        outside.write_text("synthetic outside plan sentinel", encoding="utf-8")
        real_open = os.open

        def swap(path, flags, *args, **kwargs):
            if os.fspath(path) != target.name:
                return real_open(path, flags, *args, **kwargs)
            saved = target.with_suffix(".saved")
            target.rename(saved)
            target.symlink_to(outside)
            try:
                return real_open(path, flags, *args, **kwargs)
            finally:
                target.unlink()
                saved.rename(target)

        with mock.patch.object(projection.os, "open", swap):
            state = projection.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(state["plan_state"], "invalid")
        self.assertIn("plan_ref:invalid", state["degraded"])

    @unittest.skipUnless(hasattr(os, "mkfifo") and hasattr(os, "O_NONBLOCK"), "FIFO requires POSIX")
    def test_fifo_is_opened_nonblocking_and_refused_before_any_read(self):
        fifo = fixtures.uuid_tmp() / "input.json"
        os.mkfifo(fifo)
        real_open = os.open

        def assert_nonblocking(path, flags, *args, **kwargs):
            if os.fspath(path) == fifo.name:
                # Assert before the real open so a regression cannot hang tests.
                self.assertTrue(flags & os.O_NONBLOCK)
                self.assertTrue(flags & os.O_NOFOLLOW)
            return real_open(path, flags, *args, **kwargs)

        with mock.patch.object(projection.os, "open", assert_nonblocking), \
                mock.patch.object(projection.os, "read", side_effect=AssertionError("FIFO must never be read")):
            self.assert_refused(lambda: projection.read_json_capped(fifo))

    def test_symlinked_project_ancestor_is_refused(self):
        parent = fixtures.uuid_tmp()
        actual = parent / "actual"
        actual.mkdir()
        root = fixtures.build_runtime(actual / "project")
        alias = parent / "alias"
        alias.symlink_to(actual, target_is_directory=True)
        self.assert_refused(lambda: projection.read_snapshot(alias / "project", "maw-synth-001"))


class BoundedContentTest(unittest.TestCase):
    def test_oversized_manifest_and_fingerprint_do_not_read_unbounded_bytes(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        target = root / RUNTIME_REL / "maw-synth-001" / "task.json"
        target.write_bytes(b"x" * (projection.MAX_FILE_BYTES + 1))
        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("unbounded read")):
            with mock.patch.object(projection.os, "read", wraps=os.read) as reader:
                state = projection.read_runtime_state(root, "maw-synth-001")
                # Only other small files may be read during the fingerprint;
                # the over-limit manifest is rejected from fstat alone.
                self.assertEqual(reader.call_count, 0)
                projection.fingerprint(state)
                for call in reader.call_args_list:
                    self.assertLessEqual(call.args[1], 65536)
        self.assertIsNone(state["manifest"])
        self.assertIn("task.json:corrupt", state["degraded"])

    def test_oversized_plan_digest_degrades_instead_of_hashing_arbitrary_size(self):
        root = fixtures.build_runtime(fixtures.uuid_tmp())
        target = root / "docs" / "development" / "plan.md"
        target.write_bytes(b"x" * (projection.MAX_FILE_BYTES + 1))
        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("unbounded read")):
            state = projection.read_runtime_state(root, "maw-synth-001")
        self.assertEqual(state["plan_state"], "invalid")
        self.assertIn("plan_ref:invalid", state["degraded"])

    def test_file_growing_after_fstat_is_still_read_with_a_total_bound(self):
        path = fixtures.uuid_tmp() / "growing.json"
        path.write_bytes(b"x")
        real_read = os.read
        requested = []

        def grow(fd, size):
            if not requested:
                path.write_bytes(b"x" * 101)
            requested.append(size)
            return real_read(fd, size)

        with mock.patch.object(projection, "MAX_FILE_BYTES", 100), \
                mock.patch.object(projection.os, "read", grow):
            self.assertEqual(projection.read_json_capped(path), (None, "corrupt"))
        self.assertLessEqual(sum(requested), 101)


if __name__ == "__main__":
    unittest.main()
