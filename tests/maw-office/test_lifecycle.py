"""TEST-MWO-003 / TEST-MWO-008 — explicit start, lifecycle and transport failure
handling (plan §4.2.1/§4.4)."""

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fixtures
from fixtures import maw_office


class CaptureServer:
    """Local HTTP capture point with scriptable responses."""

    def __init__(self, respond=None):
        self.requests = []
        self.respond = respond or (lambda method, body: (200, json.dumps({"ok": True, "server_epoch": 1, "seq": 1, "consumer_idle_ms": 0, "idle_timeout_reached": False, "duplicate": False})))
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                outer.requests.append({"path": self.path, "body": json.loads(body) if body else None, "token": self.headers.get("X-Office-Token")})
                status, payload = outer.respond("POST", outer.requests[-1])
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload.encode())

            def do_DELETE(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                outer.requests.append({"path": self.path, "body": json.loads(body) if body else None})
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.project = fixtures.build_runtime(fixtures.uuid_tmp(), executor_tasks=[fixtures.task(1, "dev", "in-progress")])

    def test_serve_required_exit_2(self):
        self.assertEqual(maw_office.main([]), 2)
        self.assertEqual(maw_office.main(["--once", "--project-root", str(self.project)]), 2)

    def test_invalid_arguments_exit_2(self):
        for extra in (["--poll-seconds", "0"], ["--poll-seconds", "301"], ["--refresh-seconds", "61"], ["--idle-timeout-minutes", "-1"]):
            self.assertEqual(maw_office.main(["--serve", "--project-root", str(self.project), "--office-url", "http://127.0.0.1:1", *extra]), 2)

    def test_non_loopback_office_url_is_refused_exit_3(self):
        code = maw_office.main(["--serve", "--project-root", str(self.project), "--office-url", "http://10.255.255.1:5173", "--once"])
        self.assertEqual(code, 3)

    def test_missing_runtime_is_no_data_exit_4(self):
        empty = fixtures.uuid_tmp()
        self.assertEqual(maw_office.main(["--serve", "--project-root", str(empty), "--office-url", "http://127.0.0.1:1", "--once"]), 4)

    def test_registry_missing_is_no_data_exit_4(self):
        cwd = os.getcwd()
        anchor = fixtures.uuid_tmp()
        os.chdir(anchor)
        try:
            code = maw_office.main(["--serve", "--office-url", "http://127.0.0.1:1", "--once"])
            self.assertEqual(code, 4)
        finally:
            os.chdir(cwd)

    def test_once_publishes_full_snapshot_and_exits_zero(self):
        capture = CaptureServer()
        try:
            code = maw_office.main(["--serve", "--once", "--project-root", str(self.project), "--office-url", capture.url])
            self.assertEqual(code, 0)
            self.assertEqual(len(capture.requests), 1)
            body = capture.requests[0]["body"]
            self.assertEqual(body["schema"], "avo.maw-snapshot/1")
            self.assertEqual(len(body["members"]), 4)
            self.assertEqual({m["role"] for m in body["members"]}, {"manager", "decision-maker", "executor", "reviewer"})
            self.assertLessEqual(len(json.dumps(body).encode()), 16384)
        finally:
            capture.close()

    def test_token_is_sent_from_environment_only(self):
        received = {}
        capture = CaptureServer(respond=lambda method, req: received.update(token=req["token"]) or (200, json.dumps({"ok": True, "server_epoch": 1, "seq": 1, "consumer_idle_ms": 0, "idle_timeout_reached": False, "duplicate": False})))
        try:
            os.environ["OFFICE_API_TOKEN"] = "env-secret"
            try:
                code = maw_office.main(["--serve", "--once", "--project-root", str(self.project), "--office-url", capture.url])
            finally:
                del os.environ["OFFICE_API_TOKEN"]
            self.assertEqual(code, 0)
            self.assertEqual(received["token"], "env-secret")
        finally:
            capture.close()

    def test_auth_rejection_exits_3_without_retry(self):
        capture = CaptureServer(respond=lambda method, req: (401, json.dumps({"ok": False, "error": {"code": "auth-rejected", "message": "no"}})))
        try:
            code = maw_office.main(["--serve", "--once", "--project-root", str(self.project), "--office-url", capture.url])
            self.assertEqual(code, 3)
            self.assertEqual(len(capture.requests), 1)  # no blind retries
        finally:
            capture.close()

    def test_producer_conflict_exits_6(self):
        capture = CaptureServer(respond=lambda method, req: (409, json.dumps({"ok": False, "error": {"code": "producer-conflict", "message": "held"}})))
        try:
            code = maw_office.main(["--serve", "--once", "--project-root", str(self.project), "--office-url", capture.url])
            self.assertEqual(code, 6)
        finally:
            capture.close()

    def test_payload_too_large_exits_6(self):
        capture = CaptureServer(respond=lambda method, req: (413, json.dumps({"ok": False, "error": {"code": "payload-too-large", "message": "big"}})))
        try:
            code = maw_office.main(["--serve", "--once", "--project-root", str(self.project), "--office-url", capture.url])
            self.assertEqual(code, 6)
        finally:
            capture.close()

    def test_retry_exhausted_exits_5(self):
        attempts = {"n": 0}

        def respond(method, req):
            attempts["n"] += 1
            return (503, json.dumps({"ok": False}))

        capture = CaptureServer(respond=respond)
        original = maw_office.RETRY_DELAYS_S
        maw_office.RETRY_DELAYS_S = (0, 0, 0)
        try:
            code = maw_office.main(["--serve", "--once", "--project-root", str(self.project), "--office-url", capture.url])
            self.assertEqual(code, 5)
            self.assertEqual(attempts["n"], 4)  # first + 3 bounded retries
        finally:
            maw_office.RETRY_DELAYS_S = original
            capture.close()

    def test_idle_timeout_ack_stops_the_loop_with_exit_zero(self):
        capture = CaptureServer(respond=lambda method, req: (200, json.dumps({"ok": True, "server_epoch": 1, "seq": 1, "consumer_idle_ms": 999_999_999, "idle_timeout_reached": True, "duplicate": False})))
        try:
            code = maw_office.main(["--serve", "--project-root", str(self.project), "--office-url", capture.url, "--poll-seconds", "1"])
            self.assertEqual(code, 0)
            self.assertEqual(len(capture.requests), 1)
        finally:
            capture.close()

    def test_task_disappearance_publishes_no_data_then_stops_on_idle(self):
        task_json = self.project / fixtures.RUNTIME_REL / "maw-synth-001" / "task.json"

        state = {"n": 0}

        def respond(method, req):
            state["n"] += 1
            if state["n"] == 2:
                task_json.unlink()  # the selected task disappears mid-run
            if state["n"] <= 2:
                return (200, json.dumps({"ok": True, "server_epoch": 1, "seq": 1, "consumer_idle_ms": 0, "idle_timeout_reached": False, "duplicate": False}))
            return (200, json.dumps({"ok": True, "server_epoch": 2, "seq": 9, "consumer_idle_ms": 999_999_999, "idle_timeout_reached": True, "duplicate": False}))

        capture = CaptureServer(respond=respond)
        try:
            code = maw_office.main(["--serve", "--project-root", str(self.project), "--office-url", capture.url, "--poll-seconds", "1", "--refresh-seconds", "1"])
            self.assertEqual(code, 0)
            kinds = [r["body"]["quality"] for r in capture.requests]
            self.assertEqual(kinds[-1], "degraded")  # no-data is published, never a fake state
        finally:
            capture.close()


if __name__ == "__main__":
    unittest.main()
