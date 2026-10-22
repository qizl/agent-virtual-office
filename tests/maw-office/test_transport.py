"""Transport safety (review 2026-10-22): loopback validation binds the actual
connection target, and proxies are never consulted (§4.4)."""

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fixtures
from fixtures import maw_office


class CaptureServer:
    """Minimal local POST capture point."""

    def __init__(self):
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                outer.requests.append({"path": self.path, "host": self.headers.get("Host"), "body": json.loads(body)})
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "duplicate": False, "producer_seq": 1}).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class LoopbackBindingTest(unittest.TestCase):
    def test_literal_origin_round_trips_unchanged(self):
        base, host = maw_office.assert_loopback("http://127.0.0.1:5173")
        self.assertEqual(base, "http://127.0.0.1:5173")
        self.assertEqual(host, "127.0.0.1")

    def test_hostname_origin_binds_a_validated_literal(self):
        base, host = maw_office.assert_loopback("http://localhost:5173")
        self.assertEqual(host, "localhost")
        # The request URL carries the validated loopback literal — never the hostname.
        self.assertIn(base, ("http://127.0.0.1:5173", "http://[::1]:5173"))

    def test_non_loopback_origin_is_refused(self):
        with self.assertRaises(maw_office.BridgeError) as ctx:
            maw_office.assert_loopback("http://10.0.0.1:5173")
        self.assertEqual(ctx.exception.code, "host-not-allowed")


class HostHeaderTest(unittest.TestCase):
    def test_header_matches_the_original_origin(self):
        self.assertEqual(maw_office.host_header_for("localhost", 5173, "http"), "localhost:5173")
        self.assertEqual(maw_office.host_header_for("127.0.0.1", 80, "http"), "127.0.0.1")
        self.assertEqual(maw_office.host_header_for("::1", 5173, "http"), "[::1]:5173")


class NoProxyTest(unittest.TestCase):
    def test_env_proxy_config_is_ignored(self):
        capture = CaptureServer()
        try:
            payload = {
                "schema": "avo.maw-snapshot/1", "producer": "producer-test", "seq": 1,
                "sampled_at": 1000, "workflow": None, "quality": "ok", "quality_detail": None,
                "terminal": None, "members": [],
            }
            # If the opener consulted the environment this request would be sent to
            # the dead proxy port and raise TransportRetry instead of arriving here.
            env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
            os.environ["http_proxy"] = "http://127.0.0.1:9"
            os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
            try:
                ack = maw_office.post_snapshot(
                    f"http://127.0.0.1:{capture.port}", payload, None, host_header=f"127.0.0.1:{capture.port}"
                )
            finally:
                for key in ("http_proxy", "HTTP_PROXY"):
                    if key in env:
                        os.environ[key] = env[key]
                    else:
                        os.environ.pop(key, None)
            self.assertTrue(ack["ok"])
            self.assertEqual(capture.requests[0]["path"], "/api/maw/status")
            self.assertEqual(capture.requests[0]["host"], f"127.0.0.1:{capture.port}")
        finally:
            capture.stop()


if __name__ == "__main__":
    unittest.main()
