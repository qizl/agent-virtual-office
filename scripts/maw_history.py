"""Bounded, read-only review of recorded MAW milestones.

Transactions are partial evidence, not an execution event log. Historical frames
contain only facts already encountered by this reader; undated task records are
shown as a separate supplement after transactions, never assigned guessed times.
"""

from __future__ import annotations

import copy
import datetime as dt
import hashlib
import heapq
import importlib.util
import json
import re
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("maw_history_projection", Path(__file__).with_name("maw_projection.py"))
projection = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(projection)
BridgeError = projection.BridgeError

SCHEMA = "avo.maw-history/1"
MAX_OPERATIONS = 200
MAX_STEPS = 200
MAX_RESPONSE_BYTES = 1_048_576
MAX_JSON_DEPTH = 64
HASH_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
OP_RE = re.compile(r"op-([0-9]{6,})-([A-Za-z0-9-]{1,80})\Z")
TASK_REF_RE = re.compile(r"((?:decision-maker|executor|reviewer)-[0-9]+)/task-([0-9]{3,})(?:\.json)?\Z")
WRITE_RE = re.compile(r"(?:task\.json|workflow\.json|(?:manager|decision-maker|executor|reviewer)-[0-9]+/(?:task-[0-9]{3,}\.json|ready\.json|terminate\.json|prompt\.md))\Z")
ACTION_KINDS = {"assign-dev", "create-plan-review-task", "create-review-task", "create-aggregate-review-task",
                "confirm-ready", "set-node", "complete-node", "release-node", "append-release-association",
                "cancel-request", "cancel-close", "finish-close", "add-role"}
PUBLICATIONS = {"assign-dev", "create-plan-review-task", "create-review-task", "create-aggregate-review-task"}
CLOSE = {"finish-close", "cancel-close"}


_projection_read_json_capped = projection.read_json_capped


def _read_history_json_capped(path):
    """Reject recursion-heavy files before fingerprints or frame copies use them."""
    try:
        data, why = _projection_read_json_capped(path)
    except RecursionError:
        return None, "corrupt"
    if why is not None:
        return data, why
    pending = [(data, 0)]
    while pending:
        value, depth = pending.pop()
        if depth > MAX_JSON_DEPTH:
            return None, "corrupt"
        if isinstance(value, dict):
            pending.extend((child, depth + 1) for child in value.values())
        elif isinstance(value, list):
            pending.extend((child, depth + 1) for child in value)
    return data, None


# This projection module is loaded privately for history. Its per-file boundary
# also covers the consistency reader without changing the live projection API.
projection.read_json_capped = _read_history_json_capped


def _integer(value, minimum=1):
    return type(value) is int and minimum <= value <= projection.MAX_SAFE_INTEGER


def _digest(value):
    return isinstance(value, str) and HASH_RE.fullmatch(value) is not None


def _canonical_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _written_digest(value):
    raw = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False, allow_nan=False) + "\n").encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _recorded_time(value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("invalid recorded time")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("recorded time needs an offset")
    return parsed.astimezone(dt.timezone.utc).isoformat()


def _warning(warnings, code):
    if code not in warnings:
        warnings.append(code)


def _terminal(state):
    manifest = state["manifest"]
    status = manifest.get("status")
    terminal = status if status in projection.TERMINAL_MANIFEST else None
    finish = (state.get("workflow") or {}).get("finish")
    finish = finish if isinstance(finish, dict) else {}
    declared = [value for value in (manifest.get("terminal_outcome"), finish.get("outcome")) if value is not None]
    conflict = any(value not in projection.TERMINAL_MANIFEST or value != terminal for value in declared)
    return terminal, conflict


def _dashboard_snapshot(state, sampled_at):
    producer = "history-" + hashlib.sha256(f"{state['project_root'].resolve()}|{state['task_id']}".encode()).hexdigest()[:24]
    snapshot_state = copy.deepcopy(state)
    workflow = snapshot_state.get("workflow")
    if isinstance(workflow, dict) and not isinstance(workflow.get("finish"), (dict, type(None))):
        workflow["finish"] = None
    raw = projection.validate_snapshot(projection.build_snapshot(snapshot_state, producer, 1, sampled_at))
    return {"schema": raw["schema"], "workflow": raw["workflow"], "quality": raw["quality"],
            "quality_detail": raw["quality_detail"], "terminal": raw["terminal"], "sampled_at": sampled_at,
            "producer_id": producer, "producer_seq": 1, "accepted_at": sampled_at, "members": raw["members"]}


def _current_signature(state):
    """Compare stored inputs, excluding clocks and transient projection fields."""
    return _canonical_digest({key: state.get(key) for key in (
        "manifest", "workflow", "roles", "degraded", "listener_fresh", "handoff_present", "plan_state")})


def _validate_frame(snapshot):
    raw = {"schema": snapshot["schema"], "producer": snapshot["producer_id"], "seq": snapshot["producer_seq"],
           "sampled_at": snapshot["sampled_at"], "workflow": snapshot["workflow"], "quality": snapshot["quality"],
           "quality_detail": snapshot["quality_detail"], "terminal": snapshot["terminal"], "members": snapshot["members"]}
    projection.validate_snapshot(raw)
    if len(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()) > projection.MAX_SNAPSHOT_BYTES:
        raise BridgeError("payload-too-large", "history frame exceeds the snapshot limit", projection.EXIT_PROTOCOL)


def _bounded_names(directory, pattern, limit):
    """Bound memory while selecting a deterministic capped set of input names."""
    try:
        names = heapq.nsmallest(limit + 1, (entry.name for entry in directory.iterdir() if pattern(entry.name)))
    except FileNotFoundError:
        return [], False
    return names[:limit], len(names) > limit


def _task_shape(task):
    if (not isinstance(task, dict) or task.get("schema") not in tuple(projection.TASK_SCHEMAS)
            or not _integer(task.get("seq")) or not _integer(task.get("round"))
            or task.get("type") not in tuple(projection.TASK_KINDS) or task.get("status") not in tuple(projection.TASK_STATUSES)):
        return False
    ref = task.get("ref_task")
    return ref is None or (isinstance(ref, str) and TASK_REF_RE.fullmatch(ref) is not None)


def _task_records(state, task_dir, warnings):
    records = {}
    remaining = projection.MAX_TASK_FILES
    for folder in sorted(state["roles"]):
        role_dir = projection.checked_path(task_dir, folder)
        names, limited = _bounded_names(role_dir, lambda name: name.startswith("task-") and name.endswith(".json"), remaining)
        if limited:
            _warning(warnings, "task-input-limit")
        for name in names:
            task, why = projection.read_json_capped(projection.checked_path(role_dir, name))
            if why or not _task_shape(task) or name != f"task-{task['seq']:03d}.json":
                _warning(warnings, "task-record-invalid")
                continue
            records[f"{folder}/{name[:-5]}"] = task
        remaining -= len(names)
    sequences = [task["seq"] for task in records.values()]
    if len(sequences) != len(set(sequences)):
        _warning(warnings, "task-sequence-conflict")
    # Topological ordering respects explicit ref_task before stable sequence order.
    ordered, visiting, done = [], set(), set()

    def visit(ref):
        if ref in done:
            return
        if ref in visiting:
            _warning(warnings, "task-reference-cycle")
            return
        visiting.add(ref)
        parent = records[ref].get("ref_task")
        parent = parent[:-5] if isinstance(parent, str) and parent.endswith(".json") else parent
        if parent in records:
            visit(parent)
        elif parent:
            _warning(warnings, "task-reference-missing")
        visiting.remove(ref)
        done.add(ref)
        ordered.append((ref, records[ref]))

    for ref in sorted(records, key=lambda key: (records[key]["seq"], key)):
        visit(ref)
    return ordered


def _validate_operation(op, name, state):
    """Validate historical binding without comparing old after-hashes to today."""
    if not isinstance(op, dict) or op.get("stage") != "committed":
        raise ValueError("not a committed operation")
    identity = op.get("op_id")
    match = OP_RE.fullmatch(identity) if isinstance(identity, str) else None
    expected = op.get("expected_revision")
    workflow = state.get("workflow") or {}
    digest = op.get("definition_digest")
    if (not match or name != identity + ".json" or not _integer(expected)
            or int(match[1]) != expected or not _digest(digest) or digest != workflow.get("definition_digest")):
        raise ValueError("operation binding is invalid")
    action = op.get("action")
    if not isinstance(action, dict) or action.get("action") not in ACTION_KINDS:
        raise ValueError("unsupported action")
    kind = action["action"]
    effective = expected if kind in CLOSE else expected + 1
    if not _integer(workflow.get("revision")) or effective > workflow["revision"]:
        raise ValueError("operation revision is ahead of the workflow")
    writes = op.get("writes")
    if (not isinstance(writes, dict) or not 2 <= len(writes) <= 2 * projection.MAX_TASK_FILES + 2
            or not {"task.json", "workflow.json"}.issubset(writes)):
        raise ValueError("operation write set is invalid")
    for path, fingerprint in writes.items():
        if (not isinstance(path, str) or not WRITE_RE.fullmatch(path) or not isinstance(fingerprint, dict)
                or not _digest(fingerprint.get("after"))
                or (fingerprint.get("before") is not None and not _digest(fingerprint["before"]))):
            raise ValueError("operation fingerprints are invalid")
    _recorded_time(op.get("created_at"))
    if kind in PUBLICATIONS:
        task = action.get("task")
        owner = action.get("role") if kind == "assign-dev" else action.get("owner")
        if not _task_shape(task) or task["status"] != "initialized" or owner not in state["roles"]:
            raise ValueError("publication task is invalid")
        path = f"{owner}/task-{task['seq']:03d}.json"
        if (action.get("seq") != task["seq"] or path not in writes
                or writes[path]["after"] != _written_digest(task)):
            raise ValueError("publication fingerprint is invalid")
        if kind != "assign-dev":
            publication = action.get("publication")
            if not isinstance(publication, dict) or publication.get("task_file") != path:
                raise ValueError("publication path is invalid")
        if kind == "assign-dev" and task["type"] != "dev":
            raise ValueError("development task type is invalid")
        if kind != "assign-dev" and task["type"] != {"create-plan-review-task": "plan-review", "create-review-task": "review", "create-aggregate-review-task": "aggregate-review"}[kind]:
            raise ValueError("review task type is invalid")
    if kind in CLOSE:
        final_workflow, final_manifest = action.get("workflow"), action.get("manifest")
        if (not isinstance(final_workflow, dict) or not isinstance(final_manifest, dict)
                or final_workflow.get("definition_digest") != digest or final_workflow.get("revision") != expected
                or final_manifest.get("workflow_definition_digest") != digest
                or writes["workflow.json"]["after"] != _written_digest(final_workflow)
                or writes["task.json"]["after"] != _written_digest(final_manifest)):
            raise ValueError("close record binding is invalid")
        terminal = final_manifest.get("status")
        finish = final_workflow.get("finish")
        if (not isinstance(finish, dict) or terminal not in projection.TERMINAL_MANIFEST
                or final_manifest.get("terminal_outcome") != terminal or finish.get("outcome") != terminal
                or (kind == "cancel-close" and terminal != "cancelled")
                or (kind == "finish-close" and terminal not in ("completed", "completed-with-findings"))):
            raise ValueError("close outcome is invalid")
    if kind in ("confirm-ready", "add-role") and action.get("role") not in state["roles"]:
        raise ValueError("operation role is invalid")
    if kind == "confirm-ready" and f"{action['role']}/ready.json" not in writes:
        raise ValueError("ready confirmation write is missing")
    if kind == "add-role":
        final_workflow, final_manifest = action.get("workflow"), action.get("manifest")
        role = action["role"]
        prompt = action.get("prompt")
        if (not isinstance(final_workflow, dict) or not isinstance(final_manifest, dict)
                or final_workflow.get("definition_digest") != digest
                or final_workflow.get("revision") != effective
                or final_manifest.get("workflow_definition_digest") != digest
                or role not in (final_manifest.get("roles") or []) or not isinstance(prompt, str)
                or writes["workflow.json"]["after"] != _written_digest(final_workflow)
                or writes["task.json"]["after"] != _written_digest(final_manifest)
                or (writes.get(f"{role}/prompt.md") or {}).get("after") != "sha256:" + hashlib.sha256(prompt.encode()).hexdigest()):
            raise ValueError("member registration binding is invalid")
    if kind == "cancel-request":
        terminations = action.get("terminations")
        if not isinstance(terminations, dict):
            raise ValueError("cancellation binding is invalid")
        for role, terminate in terminations.items():
            if (role not in state["roles"] or not isinstance(terminate, dict)
                    or terminate.get("schema") != projection.TERMINATE_SCHEMA
                    or terminate.get("status") != "initialized"
                    or (writes.get(f"{role}/terminate.json") or {}).get("after") != _written_digest(terminate)):
                raise ValueError("cancellation write is invalid")
    if kind in ("set-node", "complete-node", "release-node", "append-release-association"):
        if action.get("node") not in {node[0] for node in projection.workflow_nodes(workflow)}:
            raise ValueError("operation node is invalid")
    suffix = match[2]
    if kind in CLOSE:
        expected_suffix = kind
    elif kind == "assign-dev" and suffix.startswith("assign"):
        expected_suffix = f"assign{action['task']['seq']:03d}"
    elif kind == "add-role":
        unhashed_workflow = {key: value for key, value in action.items() if key != "workflow"}
        expected_suffix = "add" + _canonical_digest(unhashed_workflow)[:10]
    elif kind == "cancel-request":
        expected_suffix = "cancel" + _canonical_digest(action)[:10]
    else:
        expected_suffix = _canonical_digest(action)[:10]
    if suffix != expected_suffix:
        raise ValueError("operation action identity is invalid")
    return effective, action


def _operation_records(state, task_dir, warnings):
    directory = projection.checked_path(task_dir, "context", "operations")
    names, limited = _bounded_names(directory, lambda name: name.endswith(".json"), MAX_OPERATIONS)
    if limited:
        _warning(warnings, "operation-input-limit")
    records, seen = [], set()
    for name in names:
        op, why = projection.read_json_capped(projection.checked_path(directory, name))
        try:
            if why:
                raise ValueError("unreadable operation")
            effective, action = _validate_operation(op, name, state)
            if op["op_id"] in seen:
                continue
            seen.add(op["op_id"])
            records.append((effective, op["op_id"], op, action))
        except (ValueError, TypeError, KeyError, OverflowError):
            _warning(warnings, "operation-record-invalid")
    revisions = [record[0] for record in records]
    conflicting = {revision for revision in revisions if revisions.count(revision) > 1}
    if conflicting:
        _warning(warnings, "operation-revision-conflict")
        records = [record for record in records if record[0] not in conflicting]
    if not records:
        _warning(warnings, "operation-history-unavailable")
    else:
        revisions = sorted({record[0] for record in records})
        current_revision = (state.get("workflow") or {}).get("revision", 1)
        if (len(revisions) != current_revision - 1 or revisions[0] != 2 or revisions[-1] != current_revision
                or any(right != left + 1 for left, right in zip(revisions, revisions[1:]))):
            _warning(warnings, "operation-history-incomplete")
    return sorted(records, key=lambda record: (record[0], record[1]))


def _member_for(frame, state, folder):
    identity = hashlib.sha256(f"{state['project_root'].resolve()}|{state['task_id']}|{folder}".encode()).hexdigest()[:12]
    return next((member for member in frame["members"] if member["id"] == identity), None)


def _task_fact(frame, state, folder, task, *, publication=False):
    member = _member_for(frame, state, folder)
    if member is None:
        return
    status = task["status"]
    kind = task["type"]
    verdict = "fail" if status == "review-failed" else "pass" if status == "review-passed" else None
    status_map = {"initialized": "planning", "in-progress": "working", "dev-complete": "awaiting-approval",
                  "reviewing": "awaiting-approval", "review-passed": "done", "review-failed": "blocked"}
    label = "任务派发已记录" if publication else {"initialized": "记录状态：已派发", "in-progress": "记录状态：进行中",
            "dev-complete": "记录结果：开发交付", "reviewing": "记录状态：待评审", "review-passed": "记录结果：通过",
            "review-failed": "记录结果：失败 · 需返修"}[status]
    member.update(status=status_map[status], label=f"{label} · round {task['round']}", round=task["round"],
                  task_kind=kind, verdict=verdict, terminate=None, stalled=False)


def _operation_fact(frame, state, action):
    kind = action["action"]
    if kind in PUBLICATIONS:
        owner = action.get("role") if kind == "assign-dev" else action["owner"]
        _task_fact(frame, state, owner, action["task"], publication=True)
        return "task-publication", "开发任务派发记录" if kind == "assign-dev" else "评审任务派发记录"
    if kind == "confirm-ready":
        member = _member_for(frame, state, action["role"])
        if member:
            member.update(status="idle", label="就绪确认已记录")
        return "ready-confirmed", "成员就绪确认记录"
    if kind == "add-role":
        return "role-added", "成员加入记录"
    if kind in CLOSE:
        return "terminal-record", "流程终局记录"
    if kind == "cancel-request":
        return "cancellation-record", "取消请求记录"
    label = {"set-node": "节点状态变更记录", "complete-node": "节点完成记录", "release-node": "节点带问题释放记录",
             "append-release-association": "返修关联记录"}[kind]
    for member in frame["members"]:
        if member["role"] == "manager":
            member.update(status="working", label=label)
    return "workflow-record", label


def read_history(project_root: Path, task_id: str, *, project: str, now=None) -> dict:
    """Return safe milestone summaries for the caller's already-fixed binding."""
    if not isinstance(task_id, str) or not projection.TASK_ID_RE.fullmatch(task_id) or task_id in (".", ".."):
        raise BridgeError("invalid-task", "task identity is invalid", projection.EXIT_USAGE)
    if not isinstance(project, str) or not project or len(project) > 4096:
        raise BridgeError("invalid-project", "project identity is invalid", projection.EXIT_USAGE)
    try:
        state = projection.read_with_consistency(Path(project_root), task_id, 30, task_validator=_task_shape)
        if state.get("manifest") is None:
            missing = "task.json:missing" in state["degraded"]
            raise BridgeError("task-not-found" if missing else "invalid-input", "task is unavailable", projection.EXIT_NO_DATA)
        if state.get("_inconsistent"):
            raise BridgeError("input-inconsistent", "task inputs changed during observation", projection.EXIT_NO_DATA)
        baseline = _current_signature(state)
        warnings = []
        workflow = state.get("workflow")
        if isinstance(workflow, dict) and not isinstance(workflow.get("finish"), (dict, type(None))):
            _warning(warnings, "current-input-incomplete")
        # Damaged member records are omitted from the final projection as well
        # as from replay, while their incompleteness remains visible.
        for role in state["roles"].values():
            valid_tasks = [task for task in role["tasks"] if _task_shape(task)]
            if len(valid_tasks) != len(role["tasks"]):
                _warning(warnings, "task-record-invalid")
                role["tasks"] = valid_tasks
                state["degraded"].append("task-record:invalid")
        sampled_at = int((now() if callable(now) else now) if now is not None else time.time() * 1000)
        final_snapshot = _dashboard_snapshot(state, sampled_at)
        _validate_frame(final_snapshot)
        if state["degraded"]:
            _warning(warnings, "current-input-incomplete")
        terminal, conflict = _terminal(state)
        task_dir = projection.safe_resolve(Path(project_root), f"{projection.RUNTIME_REL}/{task_id}")
        operations = _operation_records(state, task_dir, warnings)
        tasks = _task_records(state, task_dir, warnings)
        for _revision, _identity, _op, action in operations:
            if action["action"] in CLOSE and action["manifest"]["status"] != terminal:
                conflict = True
        if conflict:
            _warning(warnings, "terminal-conflict")
        frame = copy.deepcopy(final_snapshot)
        frame.update(terminal=None, workflow="MAW · 任务记录回顾", quality="ok", quality_detail=None)
        for member in frame["members"]:
            member.update(status="idle", label="尚未回顾的角色记录", detail=None, round=None,
                          task_kind=None, verdict=None, terminate=None, stalled=False)
        steps = []

        def append(identity, kind, label, recorded_at, refs, snapshot=None):
            if len(steps) >= MAX_STEPS - 1:
                _warning(warnings, "milestone-output-limit")
                return
            if recorded_at is None:
                _warning(warnings, "recorded-time-unavailable")
            current = copy.deepcopy(snapshot or frame)
            current["producer_seq"] = len(steps) + 1
            _validate_frame(current)
            steps.append({"id": identity, "kind": kind, "label": label, "recorded_at": recorded_at,
                          "source_refs": refs, "snapshot": current})

        if not conflict:
            for _revision, identity, op, action in operations:
                kind, label = _operation_fact(frame, state, action)
                # Terminal conclusions belong to their actual final snapshot only.
                append(identity, kind, label, _recorded_time(op.get("created_at")), [f"context/operations/{identity}.json"])
            for ref, task in tasks:
                _task_fact(frame, state, ref.split("/", 1)[0], task)
                append("task-result:" + ref, "task-record", "任务记录补充 · 时间未记录", None, [ref + ".json"])
            if steps:
                final = copy.deepcopy(final_snapshot)
                final["producer_seq"] = len(steps) + 1
                steps.append({"id": "final-observation", "kind": "final-snapshot", "label": "当前终局记录",
                              "recorded_at": None, "source_refs": ["task.json", "workflow.json"], "snapshot": final})
        if not steps:
            _warning(warnings, "playable-history-unavailable")
        result = {"schema": SCHEMA, "project": project, "task": task_id, "terminal": terminal,
                  "eligible": not conflict and terminal in ("completed", "completed-with-findings"),
                  "complete": not warnings, "warnings": warnings, "steps": steps, "final_snapshot": final_snapshot}
        # Account for the Dashboard success envelope as well as the history body.
        while len(json.dumps({"ok": True, "data": result}, ensure_ascii=False, allow_nan=False).encode()) > MAX_RESPONSE_BYTES:
            if len(steps) <= 1:
                raise BridgeError("payload-too-large", "history exceeds the response limit", projection.EXIT_PROTOCOL)
            del steps[-2]
            _warning(warnings, "response-size-limit")
            result["complete"] = False
        for index, step in enumerate(steps, 1):
            step["snapshot"]["producer_seq"] = index
        # Enumeration reads a separate bounded input set. Refuse a response if
        # the current workflow or role files changed while history was read.
        after = projection.read_with_consistency(Path(project_root), task_id, 30, task_validator=_task_shape)
        if after.get("_inconsistent") or _current_signature(after) != baseline:
            raise BridgeError("input-inconsistent", "task inputs changed during history observation", projection.EXIT_NO_DATA)
        return result
    except BridgeError:
        raise
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
        raise BridgeError("read-failed", "task history could not be read", projection.EXIT_NO_DATA) from exc
