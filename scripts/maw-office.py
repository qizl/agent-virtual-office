#!/usr/bin/env python3
"""maw-office.py — explicit-start read-only bridge from a Multi-Agent-Workflow
runtime into the AVO office animation (plan: docs/development/multi-agent-workflow/
multi-agent-workflow-office-animation-2026-10-22.md, contract avo.maw-snapshot/1).

Lifecycle mirrors the MAW Dashboard: never starts without --serve (exit 2),
loopback-only pushes, read-only over the watched project, idle self-stop.

    python3 scripts/maw-office.py --serve --project-root <project-root> [--task-id <id>]

Development principles (plan §1.1): the driving data is exactly the Dashboard's
.runtime file set — no second data source, no target-project writes, no workflow
locks, no fabricated tool activity.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import random
import re
import secrets
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# A path import keeps the CLI usable when loaded by filename by external tools.
# Bytecode is disabled before loading the shared reader: observing a project
# must not write __pycache__ into either the project or the installed Skill.
sys.dont_write_bytecode = True
import importlib.util
_projection_spec = importlib.util.spec_from_file_location(
    "maw_projection", Path(__file__).with_name("maw_projection.py"))
projection = importlib.util.module_from_spec(_projection_spec)
_projection_spec.loader.exec_module(projection)
for _name in dir(projection):
    if not _name.startswith("_"):
        globals()[_name] = getattr(projection, _name)


# ─── transport (plan §4.4) ───────────────────────────────────────────────────


def assert_loopback(url: str) -> tuple[str, str]:
    """Parse and resolve the office URL; only loopback origins are accepted.
    Returns (base_url, host). base_url is bound to a VALIDATED literal address —
    requests must never re-resolve the hostname, or DNS rebinding could retarget
    the connection (and the OFFICE_API_TOKEN) after validation. `host` is the
    original hostname, echoed back as the Host header. Proxies and redirects are
    never followed."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise BridgeError("host-not-allowed", f"office url must be a bare http(s) origin: {url}", EXIT_REFUSED)
    host = parsed.hostname
    if not host:
        raise BridgeError("host-not-allowed", f"office url has no host: {url}", EXIT_REFUSED)
    infos = []
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise BridgeError("host-not-allowed", f"office host does not resolve: {host}", EXIT_REFUSED)
    literal = None
    for info in infos:
        address = info[4][0]
        try:
            if not ipaddress.ip_address(address).is_loopback:
                raise BridgeError("host-not-allowed", f"office host must be loopback, got {address}", EXIT_REFUSED)
        except ValueError:
            raise BridgeError("host-not-allowed", f"unparseable office address {address}", EXIT_REFUSED)
        literal = literal or address
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    host_for_uri = f"[{literal}]" if ":" in literal else literal
    return f"{parsed.scheme}://{host_for_uri}:{port}", host


def host_header_for(host: str, port: int, scheme: str) -> str:
    """Host header matching the ORIGINAL origin (brackets preserved for IPv6);
    the port is omitted only when it is the scheme's default."""
    host_part = f"[{host}]" if ":" in host else host
    default = 443 if scheme == "https" else 80
    return host_part if port == default else f"{host_part}:{port}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise BridgeError("host-not-allowed", "redirects are disabled", EXIT_REFUSED)


def post_snapshot(base_url: str, payload: dict, token: str | None, host_header: str | None = None):
    """Single POST. Returns the parsed ACK dict. Network/429/5xx raise
    TransportRetry; 4xx protocol failures raise BridgeError. The connection goes
    to the validated literal address in base_url; `host_header` keeps the original
    origin visible to the server's Host allowlist. Proxies are always disabled —
    env proxy config must not redirect the snapshot (or the token)."""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/api/maw/status",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            **({"Host": host_header} if host_header else {}),
            **({"X-Office-Token": token} if token else {}),
        },
    )
    opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=HTTP_TIMEOUT_S) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = ""
        try:
            body = error.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        if error.code in (429,) or error.code >= 500:
            raise TransportRetry(f"HTTP {error.code}: {body}")
        if error.code in (401, 403):
            raise BridgeError("auth-rejected", f"office rejected credentials (HTTP {error.code})", EXIT_REFUSED)
        if error.code == 413:
            raise BridgeError("payload-too-large", "snapshot exceeds the 16384-byte transport budget", EXIT_PROTOCOL)
        if error.code == 409:
            code = "producer-conflict"
            try:
                code = json.loads(body).get("error", {}).get("code", code)
            except Exception:
                pass
            raise BridgeError(code, f"producer/sequence conflict: {body}", EXIT_PROTOCOL)
        raise BridgeError("invalid-snapshot", f"office rejected the snapshot (HTTP {error.code}): {body}", EXIT_PROTOCOL)
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
        raise TransportRetry(str(error))


class TransportRetry(Exception):
    pass


def release_lease(base_url: str, producer_id: str, token: str | None, host_header: str | None = None) -> None:
    """Ctrl+C cleanup DELETE. It reuses the POST transport policy verbatim — the
    validated literal target, proxies disabled, redirects disabled — because the
    request carries the same synthetic X-Office-Token: a configured environment
    proxy must never see it (review 2026-10-23 P1: the cleanup branch used the
    default opener and delivered the token to a local isolation proxy)."""
    request = urllib.request.Request(
        f"{base_url}/api/maw/status",
        data=json.dumps({"producer": producer_id}).encode("utf-8"),
        method="DELETE",
        headers={
            "Content-Type": "application/json",
            **({"Host": host_header} if host_header else {}),
            **({"X-Office-Token": token} if token else {}),
        },
    )
    opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=HTTP_TIMEOUT_S) as response:
        response.read()


# ─── orchestration ───────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="maw-office.py", description="Drive the AVO office from a MAW runtime (explicit start only).")
    parser.add_argument("--serve", action="store_true", help="required to start (the bridge never starts on its own)")
    parser.add_argument("--project-root", help="project containing the MAW .runtime (default: dashboard registry order)")
    parser.add_argument("--task-id", help="pin a task (default: dashboard mtime order, then fixed)")
    parser.add_argument("--office-url", default="http://127.0.0.1:5173", help="loopback office origin (default http://127.0.0.1:5173)")
    parser.add_argument("--poll-seconds", type=int, default=2, help="runtime polling cadence, 1..300 (default 2)")
    parser.add_argument("--refresh-seconds", type=int, default=60, help="channel freshness heartbeat, 1..60 (default 60)")
    parser.add_argument("--idle-timeout-minutes", type=int, default=30, help="stop after N minutes without an office consumer; 0 disables (default 30)")
    parser.add_argument("--stall-minutes", type=int, default=30, help="mark non-terminal tasks stalled after N minutes (default 30)")
    parser.add_argument("--state-file", help="existing dashboard-projects.json to read instead of the default location")
    parser.add_argument("--once", action="store_true", help="publish one sample and exit (requires --serve)")
    return parser


def run(args) -> int:
    if not args.serve:
        log("serve-required: pass --serve to start the bridge (it never starts automatically)")
        return EXIT_USAGE
    if not (1 <= args.poll_seconds <= 300):
        raise BridgeError("invalid-argument", "--poll-seconds must be 1..300", EXIT_USAGE)
    if not (1 <= args.refresh_seconds <= 60):
        raise BridgeError("invalid-argument", "--refresh-seconds must be 1..60", EXIT_USAGE)
    if args.idle_timeout_minutes < 0:
        raise BridgeError("invalid-argument", "--idle-timeout-minutes must be >= 0", EXIT_USAGE)
    base_url, office_host = assert_loopback(args.office_url)
    _parsed = urllib.parse.urlparse(args.office_url)
    office_host_header = host_header_for(office_host, _parsed.port or (443 if _parsed.scheme == "https" else 80), _parsed.scheme)
    token = os.environ.get("OFFICE_API_TOKEN", "").strip() or None

    project_root = pick_project(args)
    task_id = pick_task(project_root / RUNTIME_REL, args.task_id)
    log(f"project {project_root} task {task_id} -> {base_url}")

    producer_id = f"maw-office-{secrets.token_hex(6)}"
    seq = 0
    last_fingerprint = None
    last_publish = 0.0
    poll_started = time.monotonic()
    idle_budget_ms = args.idle_timeout_minutes * 60 * 1000

    def publish(force_new_sample: bool) -> bool:
        """Sample (or re-publish the current sample on a new seq for freshness).
        Returns False when the producer must stop."""
        nonlocal seq, last_fingerprint, last_publish
        current = read_with_consistency(project_root, task_id, args.stall_minutes)
        current_fingerprint = fingerprint(current)
        changed = current_fingerprint != last_fingerprint
        if not changed and not force_new_sample and time.monotonic() - last_publish < args.refresh_seconds:
            return True  # unchanged inside the freshness window — skip this tick
        # A changed tree is a new sample; an unchanged tree past the window is a
        # freshness heartbeat re-publishing the SAME sample on a new seq.
        sampled_at = int(time.time() * 1000) if changed else (current.get("_sampled_at") or int(time.time() * 1000))
        payload = build_snapshot(current, producer_id, seq + 1, sampled_at)
        if payload is None:
            log("no-data: manifest unreadable; publishing empty state")
            payload = {"schema": SCHEMA, "producer": producer_id, "seq": seq + 1, "sampled_at": sampled_at,
                       "workflow": None, "quality": "degraded", "quality_detail": "no-data",
                       "terminal": None, "members": []}
        for attempt, delay in enumerate((0,) + RETRY_DELAYS_S):
            if delay:
                time.sleep(delay)
            try:
                ack = post_snapshot(base_url, payload, token, host_header=office_host_header)
                break
            except TransportRetry as error:
                log(f"transport retry {attempt + 1}/3: {error}")
                if attempt == len(RETRY_DELAYS_S):
                    raise BridgeError("retry-exhausted", f"office unreachable after 4 attempts: {error}", EXIT_TRANSPORT)
        seq += 1
        last_fingerprint = current_fingerprint
        last_publish = time.monotonic()
        manifest_status = (current.get("manifest") or {}).get("status")
        quality = payload["quality"]
        log(f"published seq={payload['seq']} members={len(payload['members'])} quality={quality} manifest={manifest_status}")
        if ack.get("idle_timeout_reached"):
            log(f"idle-timeout: no office consumer for {args.idle_timeout_minutes} minutes; stopping")
            return False
        return True

    if args.once:
        publish(force_new_sample=True)
        log("once-complete")
        return EXIT_OK

    try:
        while True:
            ok = publish(force_new_sample=False)
            if not ok:
                return EXIT_OK
            time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        log("interrupted")
        try:
            release_lease(base_url, producer_id, token, host_header=office_host_header)
            log("lease released")
        except Exception:
            pass
        return EXIT_INTERRUPTED


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except BridgeError as error:
        log(f"{error.code}: {error}")
        return error.exit_code


if __name__ == "__main__":
    sys.exit(main())
