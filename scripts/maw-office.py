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

SCHEMA = "avo.maw-snapshot/1"
RUNTIME_REL = ".agents/plugins/ai-engineering-kit/skills/multi-agent-workflow/.runtime"
MANIFEST_SCHEMAS = {"maw.manifest/1", "maw.manifest/2", "maw.manifest/3", "maw.manifest/4"}
WORKFLOW_SCHEMAS = {"maw.workflow/1", "maw.workflow/2"}
TASK_SCHEMAS = {"maw.task/2", "maw.task/3"}
READY_SCHEMA = "maw.ready/1"
TERMINATE_SCHEMA = "maw.terminate/1"
ROLE_TYPES = ("decision-maker", "executor", "manager", "reviewer")
ROLE_FOLDER_RE = re.compile(r"(?:manager|decision-maker|executor|reviewer)-[0-9]+")
MEMBER_ROLES = ("decision-maker", "executor", "reviewer")  # manager has no task files
TASK_STATUSES = {"initialized", "in-progress", "dev-complete", "reviewing", "review-passed", "review-failed"}
TERMINAL_MANIFEST = ("cancelled", "completed", "completed-with-findings")
MAX_FILE_BYTES = 2_000_000
MAX_TASK_FILES = 200
HTTP_TIMEOUT_S = 5
RETRY_DELAYS_S = (1, 2, 4)

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_REFUSED = 3
EXIT_NO_DATA = 4
EXIT_TRANSPORT = 5
EXIT_PROTOCOL = 6
EXIT_INTERRUPTED = 130


class BridgeError(Exception):
    def __init__(self, code: str, message: str, exit_code: int):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def log(message: str) -> None:
    print(f"[MAW-OFFICE] {message}", flush=True)


# ─── path safety (plan §4.2.3) ────────────────────────────────────────────────


def safe_resolve(root: Path, relative: str) -> Path:
    """Resolve `relative` under `root`, refusing absolute paths, traversal and
    non-regular files. Symlinks are rejected per component BEFORE resolving:
    checking after resolve() would inspect the link TARGET (a real file) and let
    a link pointing anywhere inside the project bypass the read boundary."""
    if os.path.isabs(relative):
        raise BridgeError("path-outside-root", f"absolute runtime reference rejected: {relative}", EXIT_REFUSED)
    root_resolved = root.resolve()
    current = root_resolved
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise BridgeError("unsafe-file-type", f"symlink in runtime rejected: {relative}", EXIT_REFUSED)
    candidate = current.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise BridgeError("path-outside-root", f"runtime reference escapes the project root: {relative}", EXIT_REFUSED)
    if candidate.exists() and not (candidate.is_file() or candidate.is_dir()):
        raise BridgeError("unsafe-file-type", f"non-regular file in runtime: {relative}", EXIT_REFUSED)
    return candidate


def checked_path(base: Path, *parts: str) -> Path:
    """Compose base/parts and refuse symlink components or non-regular final
    files BEFORE reading. safe_resolve only guards root-relative task refs —
    every sub-read (task.json, workflow.json, role dirs, role files, listener
    state) composes BELOW it and must hold the same boundary: a symlinked
    sub-file or role directory must not turn into an out-of-project read."""
    current = base
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise BridgeError("unsafe-file-type", f"symlink in runtime rejected: {current}", EXIT_REFUSED)
    if current.exists() and not (current.is_file() or current.is_dir()):
        raise BridgeError("unsafe-file-type", f"non-regular file in runtime: {current}", EXIT_REFUSED)
    return current


def read_json_capped(path: Path):
    """Return (data, degraded_reason). degraded_reason is None, 'missing',
    'corrupt' or 'unknown-schema' (schema_family, expected passed separately)."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None, "missing"
    except OSError:
        return None, "corrupt"
    if len(raw) > MAX_FILE_BYTES:
        return None, "corrupt"
    try:
        return json.loads(raw.decode("utf-8")), None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "corrupt"


def read_json_schema(path: Path, allowed: set[str]):
    """Read a JSON object and verify its declared schema; unknown schemas degrade."""
    data, degraded = read_json_capped(path)
    if data is None:
        return None, degraded
    if not isinstance(data, dict) or data.get("schema") not in allowed:
        return None, "unknown-schema"
    return data, None


# ─── discovery & selection (plan §4.2.2) ─────────────────────────────────────


def registry_candidates(anchor: Path, state_file: Path | None):
    """Read-only reuse of the Dashboard registry (maw.dashboard-registry/1).
    Most-recent-first; never written."""
    path = state_file or (anchor / RUNTIME_REL / "dashboard-projects.json")
    data, _ = read_json_capped(path)
    if not isinstance(data, dict) or data.get("schema") != "maw.dashboard-registry/1":
        return []
    projects = data.get("projects") or []
    ordered = []
    for entry in projects:
        p = entry.get("path") if isinstance(entry, dict) else None
        if isinstance(p, str) and p:
            ordered.append(p)
    return ordered


def pick_project(args) -> Path:
    if args.project_root:
        root = Path(args.project_root).expanduser()
        if not (root / RUNTIME_REL).is_dir():
            raise BridgeError("no-data", f"no MAW runtime under {args.project_root}", EXIT_NO_DATA)
        return root
    for candidate in registry_candidates(Path.cwd(), args.state_file):
        root = Path(candidate).expanduser()
        if (root / RUNTIME_REL).is_dir():
            return root
    raise BridgeError("registry-missing", "no usable project: pass --project-root or register with the MAW dashboard", EXIT_NO_DATA)


def task_sort_key(task_dir: Path):
    """Dashboard ordering: manifest mtime descending, task_id ascending, missing last."""
    manifest = task_dir / "task.json"
    try:
        mtime = manifest.stat().st_mtime
    except OSError:
        mtime = float("-inf")
    return (0 if mtime != float("-inf") else 1, -mtime, task_dir.name)


def pick_task(runtime: Path, wanted: str | None) -> str:
    if wanted:
        if not (runtime / wanted / "task.json").is_file():
            raise BridgeError("no-data", f"task not found: {wanted}", EXIT_NO_DATA)
        return wanted
    tasks = sorted((d for d in runtime.iterdir() if d.is_dir() and not d.name.startswith(".")), key=task_sort_key)
    for candidate in tasks:
        if (candidate / "task.json").is_file():
            return candidate.name
    raise BridgeError("no-data", "no MAW task directories with a manifest", EXIT_NO_DATA)


# ─── reading (plan §4.2.3) ───────────────────────────────────────────────────


def read_runtime_state(project_root: Path, task_id: str) -> dict:
    """Read the Dashboard-identical file set for one task. Returns the raw state
    plus per-input degradation markers; never writes anything."""
    task_dir = safe_resolve(project_root, f"{RUNTIME_REL}/{task_id}")
    degraded: list[str] = []

    manifest, why = read_json_schema(checked_path(task_dir, "task.json"), MANIFEST_SCHEMAS)
    if manifest is None:
        degraded.append(f"task.json:{why}")
        return {"degraded": degraded, "manifest": None, "project_root": project_root, "task_id": task_id,
                "workflow": None, "roles": {}, "listener_fresh": None, "handoff_present": False,
                "plan_state": "unknown"}

    workflow, why = read_json_schema(checked_path(task_dir, "workflow.json"), WORKFLOW_SCHEMAS)
    if workflow is None and why != "missing":
        degraded.append(f"workflow.json:{why}")

    roles: dict[str, dict] = {}
    try:
        entries = sorted(task_dir.iterdir())
    except OSError:
        entries = []
    scanned = 0
    for entry in entries:
        if entry.name.startswith((".", "context")):
            continue
        if not ROLE_FOLDER_RE.fullmatch(entry.name):
            continue
        folder = entry.name
        checked_path(task_dir, folder)  # a symlinked role dir must not leak outside reads
        if not entry.is_dir():
            continue
        scanned += 1
        if scanned > MAX_TASK_FILES:
            degraded.append("role-folders:limit")
            break
        ready, why = read_json_schema(checked_path(entry, "ready.json"), {READY_SCHEMA})
        if ready is None and why != "missing":
            degraded.append(f"{folder}/ready.json:{why}")
        terminate, why = read_json_schema(checked_path(entry, "terminate.json"), {TERMINATE_SCHEMA})
        if terminate is None and why != "missing":
            degraded.append(f"{folder}/terminate.json:{why}")
        tasks = []
        try:
            children = sorted(entry.glob("task-*.json"))
        except OSError:
            children = []
        if len(children) > MAX_TASK_FILES:
            degraded.append(f"{folder}/tasks:limit")
            children = children[:MAX_TASK_FILES]
        for child in children:
            task, why = read_json_schema(checked_path(entry, child.name), TASK_SCHEMAS)
            if task is None:
                if why != "missing":
                    degraded.append(f"{folder}/{child.name}:{why}")
                continue
            tasks.append(task)
        roles[folder] = {
            "ready": ready,
            "terminate": terminate,
            "tasks": sorted(tasks, key=lambda t: t.get("seq") or 0),
        }

    listener_fresh = None
    listener, why = read_json_capped(checked_path(task_dir, "context", "listener-state.json"))
    if isinstance(listener, dict):
        listener_fresh = bool(listener.get("updated_at"))
    elif why not in (None, "missing"):
        degraded.append(f"listener-state.json:{why}")

    handoff_present = False
    try:
        handoff = checked_path(task_dir, "context", "handoff.md")
        if handoff.exists() and handoff.is_file():
            handoff_present = True  # existence only — the body is never read
    except OSError:
        pass

    plan_state = "unknown"
    plan_ref = manifest.get("plan_ref")
    if isinstance(plan_ref, str) and plan_ref:
        try:
            safe_resolve(project_root, plan_ref)  # containment + traversal validation
            plan_path = checked_path(project_root, *Path(plan_ref).parts)  # symlink re-walked at read time
            if plan_path.is_file():
                digest = hashlib.sha256(plan_path.read_bytes()).hexdigest()
                expected = manifest.get("plan_digest")
                expected = expected.split(":", 1)[1] if isinstance(expected, str) and ":" in expected else expected
                plan_state = "current" if (expected is None or digest == expected) else "drifted"
                if plan_state == "drifted":
                    degraded.append("plan_ref:drifted")
        except BridgeError:
            plan_state = "invalid"
            degraded.append("plan_ref:invalid")

    return {
        "project_root": project_root,
        "task_id": task_id,
        "degraded": degraded,
        "manifest": manifest,
        "workflow": workflow,
        "roles": roles,
        "listener_fresh": listener_fresh,
        "handoff_present": handoff_present,
        "plan_state": plan_state,
    }


def fingerprint(state: dict) -> str:
    """Content fingerprint over the declared inputs (plan §4.2.4: stronger than the
    Dashboard's core three — includes ready/terminate/task files)."""
    hasher = hashlib.sha256()
    # Re-validate the FULL base path at read time: checked_path only guards the
    # parts appended BELOW the task dir, so a task dir swapped to an outside
    # symlink between the first read and this pass must not leak one read.
    task_dir = safe_resolve(state["project_root"], f"{RUNTIME_REL}/{state['task_id']}")
    for relative in ["task.json", "workflow.json"]:
        try:
            hasher.update(relative.encode())
            hasher.update(checked_path(task_dir, relative).read_bytes())
        except OSError:
            hasher.update(f"{relative}:absent".encode())
    for folder in sorted(state["roles"]):
        for name in ("ready.json", "terminate.json"):
            try:
                hasher.update(f"{folder}/{name}".encode())
                hasher.update(checked_path(task_dir, folder, name).read_bytes())
            except OSError:
                hasher.update(f"{folder}/{name}:absent".encode())
        for task in state["roles"][folder]["tasks"]:
            hasher.update(f"{folder}/task-{task.get('seq')}".encode())
            hasher.update(json.dumps(task, sort_keys=True, ensure_ascii=False).encode())
    for key in ("listener_fresh", "handoff_present", "plan_state"):
        hasher.update(f"{key}={state.get(key)}".encode())
    return hasher.hexdigest()


# ─── projection (plan §4.3) ──────────────────────────────────────────────────


def workflow_nodes(workflow: dict | None):
    """Frozen definition nodes in declaration order: [(id, type, depends_on)]."""
    if not isinstance(workflow, dict):
        return []
    definition = workflow.get("definition") or {}
    nodes = definition.get("nodes") or []
    return [(n.get("id"), n.get("type"), n.get("depends_on") or []) for n in nodes if isinstance(n, dict) and n.get("id")]


def node_states(workflow: dict | None) -> dict:
    if not isinstance(workflow, dict):
        return {}
    return workflow.get("nodes") or {}


def first_open_node(workflow: dict | None) -> tuple[str, str] | None:
    """First node not completed/released, in definition order; returns (id, status)."""
    states = node_states(workflow)
    for node_id, _node_type, _deps in workflow_nodes(workflow):
        status = (states.get(node_id) or {}).get("status")
        if status not in ("completed", "released-at-limit"):
            return node_id, status or "pending"
    return None


def effective_dev_task(tasks: list[dict]) -> dict | None:
    """Newest dev task that no later dev task supersedes (rework rounds bind by
    ref_task/logical id; a later round always wins — plan §4.3.1)."""
    dev = [t for t in tasks if t.get("type") == "dev"]
    return dev[-1] if dev else None


def effective_review_for(tasks: list[dict], dev_task: dict | None) -> dict | None:
    """Newest review task reviewing the effective dev task (exact ref_task binding;
    aggregate reviews are not broadcast across objects — plan §4.3.1)."""
    if dev_task is None:
        reviews = [t for t in tasks if t.get("type") in ("review", "aggregate-review", "plan-review")]
        return reviews[-1] if reviews else None
    dev_ref = f"{dev_task.get('_folder')}/task-{dev_task.get('seq'):03d}" if dev_task.get("_folder") else None
    reviews = []
    for t in tasks:
        if t.get("type") not in ("review", "plan-review", "aggregate-review"):
            continue
        if t.get("ref_task") in (dev_ref, None) or t.get("review_object") is not None:
            reviews.append(t)
    bound = [t for t in reviews if t.get("ref_task") == dev_ref]
    return (bound or reviews or [None])[-1]


def project_member_status(role_folder: str, role: dict, manifest_terminal: str | None, workflow: dict | None, stall_cutoff: float) -> dict:
    """Project one member's office status per the §4.3.2 mapping table."""
    tasks = role["tasks"]
    terminate = role["terminate"]
    terminate_state = (terminate or {}).get("status")
    now = time.time()

    def make(status, label, round_=None, task_kind=None, verdict=None):
        return {"status": status, "label": label, "round": round_, "task_kind": task_kind, "verdict": verdict}

    if manifest_terminal == "cancelled":
        base = make("blocked", "已取消 · 停止工作")
    elif manifest_terminal in ("completed", "completed-with-findings"):
        base = make("done", "带问题收尾" if manifest_terminal == "completed-with-findings" else "流程完成")
    else:
        base = None

    if terminate_state == "initialized":
        current = make("awaiting-approval", "等待退出确认")
    elif terminate_state == "confirmed":
        current = make("done", "已退出 🏁")
    else:
        current = None

    latest = tasks[-1] if tasks else None
    stalled = bool(latest and latest.get("status") not in ("review-passed", "review-failed")
                   and latest.get("_mtime") is not None and now - latest["_mtime"] > stall_cutoff * 60)

    if current is None and latest is not None:
        task_type = latest.get("type")
        status_value = latest.get("status")
        round_ = latest.get("round")
        kind = "review" if task_type in ("review", "plan-review", "aggregate-review") else "dev"
        if task_type == "dev":
            dev = effective_dev_task(tasks)
            if dev is not None:
                review = effective_review_for(tasks, dev)
                verdict = (review or {}).get("review") or {}
                dev_status = dev.get("status")
                if dev_status == "initialized":
                    current = make("planning", f"{dev.get('logical_work_id') or '任务'} · round {dev.get('round')}", dev.get("round"), "dev")
                elif dev_status in ("dev-complete", "reviewing"):
                    current = make("awaiting-approval", f"已交付待评审 · round {dev.get('round')}", dev.get("round"), "dev")
                elif dev_status == "review-passed":
                    current = make("done", f"✅ round {dev.get('round')} 通过", dev.get("round"), "dev", "pass")
                elif dev_status == "review-failed":
                    current = make("blocked", f"需返修 · round {dev.get('round')}", dev.get("round"), "dev", "fail")
                elif verdict.get("verdict") == "fail" and dev is not latest:
                    current = make("blocked", f"历史返修 · round {dev.get('round')}", dev.get("round"), "dev", "fail")
                else:
                    current = make("working", f"{dev.get('logical_work_id') or '实现中'} · round {dev.get('round')}", dev.get("round"), "dev")
        else:
            if status_value == "initialized":
                current = make("planning", "评审任务已派发", round_, kind)
            elif status_value == "in-progress":
                current = make("working", f"🔍 评审进行中 · attempt", round_, kind)
            elif status_value in ("review-passed", "review-failed"):
                verdict = "pass" if status_value == "review-passed" else "fail"
                mark = "✅" if verdict == "pass" else "❌ 需返修"
                current = make("done", f"{mark} 评审结束 · round {round_}", round_, kind, verdict)
            else:
                current = make("working", "评审中", round_, kind)
        if stalled and current and current["status"] in ("working", "planning"):
            current = dict(current)
            current["stalled"] = True

    if base is not None:
        final = dict(base)
        if current and manifest_terminal in ("completed", "completed-with-findings"):
            # Keep the member's own exit/review outcome on top of the global terminal.
            if terminate_state == "confirmed" or (current["status"] == "done"):
                final = dict(current)
        final["round"] = current["round"] if current else None
        return final
    if current is not None:
        return current
    ready = role["ready"]
    if (ready or {}).get("status") == "confirmed":
        return make("idle", "待命")
    if (ready or {}).get("status") == "ready":
        return make("idle", "已就绪 · 待确认")
    return make("idle", None)


def project_manager(workflow: dict | None, manifest: dict, role: dict, manifest_terminal: str | None) -> dict:
    """Manager has no task files; derive from nodes + finish (plan §4.3.2)."""
    terminate = role["terminate"]
    terminate_state = (terminate or {}).get("status")

    def make(status, label):
        return {"status": status, "label": label, "round": None, "task_kind": None, "verdict": None}

    if manifest_terminal == "cancelled":
        return make("done", "流程已取消")
    if manifest_terminal == "completed-with-findings":
        return make("done", "带问题收尾")
    if manifest_terminal == "completed":
        return make("done", "流程收尾完成")
    if terminate_state == "confirmed":
        return make("done", "已退出 🏁")
    finish = (workflow or {}).get("finish") or {}
    if finish.get("terminations_published"):
        return make("awaiting-approval", "等待成员退出确认")
    if finish.get("requested") and not finish.get("evaluation"):
        return make("awaiting-approval", "等待交付评估")
    nodes = workflow_nodes(workflow)
    if not nodes:
        if workflow is None:
            return make("planning", "未提供工作流定义")
        return make("working", "推进中")
    for node_id, _type, _deps in nodes:
        state = (node_states(workflow).get(node_id) or {})
        status = state.get("status")
        if status == "running":
            blocking = state.get("blocking")
            if blocking == "finish-required":
                return make("awaiting-approval", "等待交付评估 · finish-required")
            return make("working", f"节点 {node_id} 进行中")
        if status not in ("completed", "released-at-limit"):
            return make("working", f"推进节点 {node_id}")
    if finish.get("requested"):
        return make("awaiting-approval", "等待交付评估")
    return make("working", "复核工作流")


def build_snapshot(state: dict, producer_id: str, seq: int, sampled_at: int) -> dict | None:
    manifest = state.get("manifest")
    if manifest is None:
        return None
    manifest_status = manifest.get("status")
    terminal = manifest_status if manifest_status in TERMINAL_MANIFEST else None
    workflow = state.get("workflow")
    selection = (workflow or {}).get("selection") or {}
    title = selection.get("title") or ((workflow or {}).get("definition") or {}).get("id") or ""
    active = first_open_node(workflow)
    if workflow is None or not workflow_nodes(workflow):
        # Old schemas without a frozen definition: state it, never invent a graph.
        workflow_text = "MAW（未提供工作流定义）"
    else:
        workflow_text = f"MAW {title} · {active[0] if active else '已收尾'}"
    stall_cutoff = state.get("_stall_minutes", 30)

    members = []
    role_map = {}
    for folder, role in state["roles"].items():
        for task in role["tasks"]:
            task["_folder"] = folder
            try:
                task["_mtime"] = (state["project_root"] / RUNTIME_REL / state["task_id"] / folder / f"task-{task.get('seq'):03d}.json").stat().st_mtime
            except OSError:
                task["_mtime"] = None
        role_map[folder] = role
    for folder in sorted(role_map):
        role_type = folder.rsplit("-", 1)[0]
        member_key = hashlib.sha256(f"{state['project_root'].resolve()}|{state['task_id']}|{folder}".encode()).hexdigest()[:12]
        if role_type == "manager":
            projected = project_manager(workflow, manifest, role_map[folder], terminal)
        else:
            projected = project_member_status(folder, role_map[folder], terminal, workflow, stall_cutoff)
        members.append({
            "id": member_key,
            "role": role_type,
            "status": projected["status"],
            "label": projected["label"],
            "detail": None,
            "round": projected["round"],
            "task_kind": projected["task_kind"],
            "verdict": projected["verdict"],
            "terminate": ((role_map[folder].get("terminate") or {}).get("status")),
            "stalled": bool(projected.get("stalled")),
        })

    quality = "degraded" if state["degraded"] else "ok"
    quality_detail = state["degraded"][0].split(":")[0] if state["degraded"] else None
    if state.get("_inconsistent"):
        quality = "degraded"
        quality_detail = "concurrent-update"
    return {
        "schema": SCHEMA,
        "producer": producer_id,
        "seq": seq,
        "sampled_at": sampled_at,
        "workflow": workflow_text,
        "quality": quality,
        "quality_detail": quality_detail,
        "terminal": terminal,
        "members": members,
    }


def read_with_consistency(project_root: Path, task_id: str, stall_minutes: int) -> dict:
    """Read, fingerprint, re-read; a still-moving tree publishes concurrent-update
    degraded instead of pretending the mix is valid (plan §4.2.4)."""
    state = read_runtime_state(project_root, task_id)
    state["_stall_minutes"] = stall_minutes
    before = fingerprint(state)
    after_state = read_runtime_state(project_root, task_id)
    after_state["_stall_minutes"] = stall_minutes
    after = fingerprint(after_state)
    if before != after:
        third = fingerprint(read_runtime_state(project_root, task_id))
        if third != after:
            after_state["_inconsistent"] = True
    return after_state


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
