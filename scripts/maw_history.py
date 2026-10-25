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
import stat
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
ACTIVITIES = {"ready", "publication", "work", "delivery", "result", "rework", "coordination", "terminal"}
MAX_TASK_REF_LENGTH = 128


def _decode_history_json(raw):
    """Reject recursion-heavy files before fingerprints or frame copies use them."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        return None, "corrupt"
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


def _read_history_input(path):
    """Read one capped input and retain its exact byte identity when readable."""
    try:
        raw = projection.read_bytes_capped(path)
    except FileNotFoundError:
        return None, "missing", None
    except OSError:
        return None, "corrupt", None
    try:
        data, why = _decode_history_json(raw)
    except RecursionError:
        return None, "corrupt", hashlib.sha256(raw).hexdigest()
    return data, why, hashlib.sha256(raw).hexdigest()


def _read_history_json_capped(path):
    data, why, _digest = _read_history_input(path)
    return data, why


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
            "producer_id": producer, "producer_seq": 1, "accepted_at": sampled_at, "members": raw["members"],
            "assignment_state": raw["assignment_state"], "handoff_state": raw["handoff_state"], "handoffs": raw["handoffs"]}


def _current_signature(state):
    """Compare stored inputs, excluding clocks and transient projection fields."""
    return _canonical_digest({key: state.get(key) for key in (
        "manifest", "workflow", "roles", "degraded", "listener_fresh", "handoff_present", "plan_state")})


def _validate_frame(snapshot):
    raw = {"schema": snapshot["schema"], "producer": snapshot["producer_id"], "seq": snapshot["producer_seq"],
           "sampled_at": snapshot["sampled_at"], "workflow": snapshot["workflow"], "quality": snapshot["quality"],
           "quality_detail": snapshot["quality_detail"], "terminal": snapshot["terminal"], "members": snapshot["members"]}
    raw.update({field: snapshot[field] for field in ("assignment_state", "handoff_state", "handoffs") if field in snapshot})
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
    directory_before = _path_identity(directory, directory=True)
    names, limited = _bounded_names(directory, lambda name: name.endswith(".json"), MAX_OPERATIONS)
    directory_after_names = _path_identity(directory, directory=True)
    if directory_before != directory_after_names:
        raise BridgeError("input-inconsistent", "operation directory changed during history observation", projection.EXIT_NO_DATA)
    if limited:
        _warning(warnings, "operation-input-limit")
    records, seen, identities = [], set(), []
    for name in names:
        path = projection.checked_path(directory, name)
        before = _path_identity(path, directory=False)
        op, why, digest = _read_history_input(path)
        after = _path_identity(path, directory=False)
        if before != after:
            raise BridgeError("input-inconsistent", "operation file changed during history observation", projection.EXIT_NO_DATA)
        identities.append((name, before, digest))
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
    directory_after_reads = _path_identity(directory, directory=True)
    if directory_before != directory_after_reads:
        raise BridgeError("input-inconsistent", "operation directory changed during history observation", projection.EXIT_NO_DATA)
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
    fingerprint = (directory_before, tuple(names), limited, tuple(identities))
    return sorted(records, key=lambda record: (record[0], record[1])), fingerprint


def _path_identity(path, *, directory):
    """Return bounded filesystem identity without following a substituted link."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not expected:
        raise BridgeError("unsafe-file-type", "operation history contains an unsafe file type", projection.EXIT_REFUSED)
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _operation_input_fingerprint(task_dir):
    """Re-read the same bounded operation set to detect replacement or mutation."""
    directory = projection.checked_path(task_dir, "context", "operations")
    directory_before = _path_identity(directory, directory=True)
    names, limited = _bounded_names(directory, lambda name: name.endswith(".json"), MAX_OPERATIONS)
    directory_after_names = _path_identity(directory, directory=True)
    if directory_before != directory_after_names:
        raise BridgeError("input-inconsistent", "operation directory changed during history observation", projection.EXIT_NO_DATA)
    identities = []
    for name in names:
        path = projection.checked_path(directory, name)
        before = _path_identity(path, directory=False)
        _data, _why, digest = _read_history_input(path)
        after = _path_identity(path, directory=False)
        if before != after:
            raise BridgeError("input-inconsistent", "operation file changed during history observation", projection.EXIT_NO_DATA)
        identities.append((name, before, digest))
    directory_after_reads = _path_identity(directory, directory=True)
    if directory_before != directory_after_reads:
        raise BridgeError("input-inconsistent", "operation directory changed during history observation", projection.EXIT_NO_DATA)
    return (directory_before, tuple(names), limited, tuple(identities))


def _member_for(frame, state, folder):
    identity = hashlib.sha256(f"{state['project_root'].resolve()}|{state['task_id']}|{folder}".encode()).hexdigest()[:12]
    return next((member for member in frame["members"] if member["id"] == identity), None)


def _task_ref(value):
    if not isinstance(value, str) or len(value) > MAX_TASK_REF_LENGTH or not TASK_REF_RE.fullmatch(value):
        return None
    normalized = value if value.endswith(".json") else value + ".json"
    return normalized if len(normalized) <= MAX_TASK_REF_LENGTH else None


def _neutral_frame(template):
    frame = copy.deepcopy(template)
    frame.update(terminal=None, workflow="MAW · 任务记录回顾", quality="ok", quality_detail=None,
                 assignment_state="unknown", handoff_state="complete", handoffs=[])
    for member in frame["members"]:
        member.update(status="idle", label="此步无活动记录", detail=None, round=None,
                      task_kind=None, verdict=None, terminate=None, stalled=False, current_task=None, handoff_pending=None)
    return frame


def _validate_cue(cue, snapshot):
    """Keep presentation hints as bounded references to this frame's own facts."""
    if cue is None:
        return
    member_ids = {member["id"] for member in snapshot["members"]}
    required = {"actor_member_id", "activity", "task", "related_member_ids"}
    if (not isinstance(cue, dict) or not required.issubset(cue) or set(cue) - required - {"handoff"}
            or not isinstance(cue["activity"], str) or cue["activity"] not in ACTIVITIES
            or (cue["actor_member_id"] is not None and (not isinstance(cue["actor_member_id"], str)
                                                       or cue["actor_member_id"] not in member_ids))):
        raise ValueError("invalid history cue")
    related = cue["related_member_ids"]
    if (not isinstance(related, list) or len(related) > 1
            or any(not isinstance(identity, str) or identity not in member_ids
                   or identity == cue["actor_member_id"] for identity in related)):
        raise ValueError("invalid related history member")
    task = cue["task"]
    if task is not None:
        if (not isinstance(task, dict) or set(task) != {"seq", "round", "type", "source_ref", "ref_task"}
                or cue["actor_member_id"] is None or not _integer(task["seq"]) or not _integer(task["round"])
                or not isinstance(task["type"], str) or task["type"] not in projection.TASK_KINDS
                or not isinstance(task["source_ref"], str) or _task_ref(task["source_ref"]) != task["source_ref"]
                or (task["ref_task"] is not None and _task_ref(task["ref_task"]) != task["ref_task"])):
            raise ValueError("invalid history cue task")
    handoff = cue.get("handoff")
    if handoff is not None:
        if (not projection.valid_handoff(handoff, snapshot["members"]) or task is None
                or handoff not in snapshot.get("handoffs", [])
                or task["source_ref"] not in (handoff["source_task"], handoff["target_task"])
                or cue["actor_member_id"] not in (handoff["sender_member_id"], handoff["recipient_member_id"])):
            raise ValueError("invalid history handoff")


def _cue(actor, activity, task=None, related=()):
    return {"actor_member_id": actor["id"] if actor else None, "activity": activity,
            "task": task, "related_member_ids": list(related)}


def _task_cue(frame, state, folder, task, known_tasks):
    actor = _member_for(frame, state, folder)
    source = _task_ref(f"{folder}/task-{task['seq']:03d}.json")
    if actor is None or source is None:
        return None
    parent = _task_ref(task.get("ref_task"))
    previous = known_tasks.get(parent[:-5]) if parent else None
    counterpart = _member_for(frame, state, parent.split("/", 1)[0]) if previous is not None else None
    related = [counterpart["id"]] if counterpart and counterpart["id"] != actor["id"] else []
    status, kind = task["status"], task["type"]
    if status == "initialized":
        activity = "rework" if (kind == "dev" and previous and previous["type"] == "dev"
                                and task["round"] > previous["round"]) else "publication"
    elif status == "in-progress" or (status == "reviewing" and kind != "dev"):
        activity = "work"
    elif status in ("dev-complete", "reviewing"):
        activity = "delivery"
    else:
        activity = "result"
    cue = _cue(actor, activity, {"seq": task["seq"], "round": task["round"], "type": kind,
                                "source_ref": source, "ref_task": parent}, related)
    # Only identities already encountered at this causal step may be exposed.
    latest = {}
    for ref, record in known_tasks.items():
        owner = ref.split("/", 1)[0]
        if owner not in latest or record["seq"] > latest[owner]["seq"]:
            latest[owner] = record
    for owner, record in latest.items():
        member = _member_for(frame, state, owner)
        if member:
            member["current_task"] = projection.task_identity(owner, record)
    frame["assignment_state"] = "assigned" if known_tasks else "unknown"

    def edge(direction, sender_folder, recipient_folder, source_ref, target_ref):
        sender, recipient = _member_for(frame, state, sender_folder), _member_for(frame, state, recipient_folder)
        if sender is None or recipient is None:
            return None
        fact = projection.handoff_fact(direction, sender["id"], recipient["id"], source_ref, target_ref)
        return fact if projection.valid_handoff(fact, frame["members"]) else None

    handoff = None
    if kind == "dev" and activity == "delivery":
        matches = [(ref, record) for ref, record in known_tasks.items() if record["type"] == "review"
                   and record["round"] == task["round"] and _task_ref(record.get("ref_task")) == source]
        if len(matches) == 1:
            ref, review = matches[0]
            if review["status"] not in ("review-passed", "review-failed"):
                handoff = edge("submission", folder, ref.split("/", 1)[0], source, _task_ref(ref))
        else:
            actor["handoff_pending"] = "conflict" if matches else "missing"
    elif kind == "review" and previous and previous["type"] == "dev" and previous["round"] == task["round"]:
        if activity == "result":
            handoff = edge("review-result", folder, parent.split("/", 1)[0], source, parent)
        elif activity == "publication" and previous["status"] in ("dev-complete", "reviewing"):
            matches = [record for record in known_tasks.values() if record["type"] == "review"
                       and record["round"] == task["round"] and _task_ref(record.get("ref_task")) == parent]
            if len(matches) == 1:
                handoff = edge("submission", parent.split("/", 1)[0], folder, parent, source)
            else:
                actor["handoff_pending"] = "conflict"
    elif kind == "review" and activity in ("publication", "result"):
        actor["handoff_pending"] = "missing" if previous is None else "conflict"
    if handoff:
        frame["handoffs"] = [handoff]
        cue["handoff"] = handoff
    return cue


def _manager(frame):
    managers = [member for member in frame["members"] if member["role"] == "manager"]
    return managers[0] if len(managers) == 1 else None


def _delivery_predecessor(op, action, state, warnings):
    """A frozen source state is evidence at the transaction, not a guessed time."""
    if action["action"] != "create-review-task":
        return None
    if not any(key in action for key in ("dev_task_before", "dev_task_after")):
        return None
    before, after = action.get("dev_task_before"), action.get("dev_task_after")
    source = _task_ref(action.get("dev_task"))
    fingerprint = (op.get("writes") or {}).get(source) or {}
    publication = action["publication"]["task_file"]
    if (not _task_shape(before) or not _task_shape(after) or source is None
            or before["type"] != "dev" or after["type"] != "dev"
            or before["status"] != "dev-complete" or after["status"] != "reviewing"
            or before["seq"] != after["seq"] or before["round"] != after["round"]
            or _task_ref(before.get("ref_task")) != _task_ref(after.get("ref_task"))
            or source != f"{source.split('/', 1)[0]}/task-{before['seq']:03d}.json"
            or source.split("/", 1)[0] not in state["roles"]
            or _task_ref(action["task"].get("ref_task")) != source
            or not isinstance(after.get("review"), dict) or after["review"].get("review_task_file") != publication
            or fingerprint.get("before") != _written_digest(before)
            or fingerprint.get("after") != _written_digest(after)):
        _warning(warnings, "task-transition-invalid")
        return None
    return source.split("/", 1)[0], before


def _task_fact(frame, state, folder, task, *, publication=False):
    member = _member_for(frame, state, folder)
    if member is None:
        return
    status = task["status"]
    kind = task["type"]
    verdict = "fail" if status == "review-failed" else "pass" if status == "review-passed" else None
    status_map = {"initialized": "planning", "in-progress": "working", "dev-complete": "awaiting-approval",
                  "reviewing": "awaiting-approval", "review-passed": "done", "review-failed": "blocked"}
    if kind != "dev":
        status_map.update(reviewing="working", **{"review-failed": "done"})
    label = "任务派发已记录" if publication else {"initialized": "记录状态：已派发", "in-progress": "记录状态：进行中",
            "dev-complete": "记录结果：任务交付", "reviewing": "记录状态：待评审" if kind == "dev" else "记录状态：评审中",
            "review-passed": "记录结果：通过", "review-failed": "记录结果：失败 · 需返修" if kind == "dev" else "记录结果：评审不通过"}[status]
    member.update(status=status_map[status], label=f"{label} · round {task['round']}", round=task["round"],
                  task_kind=kind, verdict=verdict, terminate=None, stalled=False)


def _operation_fact(frame, state, action, known_tasks):
    kind = action["action"]
    if kind in PUBLICATIONS:
        owner = action.get("role") if kind == "assign-dev" else action["owner"]
        _task_fact(frame, state, owner, action["task"], publication=True)
        return ("task-publication", "开发任务派发记录" if kind == "assign-dev" else "评审任务派发记录",
                _task_cue(frame, state, owner, action["task"], known_tasks))
    if kind == "confirm-ready":
        member = _member_for(frame, state, action["role"])
        if member:
            member.update(status="idle", label="就绪确认已记录")
        return "ready-confirmed", "成员就绪确认记录", _cue(member, "ready")
    if kind == "add-role":
        return "role-added", "成员加入记录", _cue(_member_for(frame, state, action["role"]), "coordination")
    if kind in CLOSE:
        return "terminal-record", "流程终局事务记录", _cue(_manager(frame), "coordination")
    if kind == "cancel-request":
        return "cancellation-record", "取消请求记录", _cue(_manager(frame), "coordination")
    label = {"set-node": "节点状态变更记录", "complete-node": "节点完成记录", "release-node": "节点带问题释放记录",
             "append-release-association": "返修关联记录"}[kind]
    member = _manager(frame)
    if member:
        member.update(status="working", label=label)
    return "workflow-record", label, _cue(member, "coordination")


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
        operations, operation_fingerprint = _operation_records(state, task_dir, warnings)
        tasks = _task_records(state, task_dir, warnings)
        for _revision, _identity, _op, action in operations:
            if action["action"] in CLOSE and action["manifest"]["status"] != terminal:
                conflict = True
        if conflict:
            _warning(warnings, "terminal-conflict")
        known_tasks = {}
        steps = []

        def append(identity, kind, label, recorded_at, refs, snapshot, cue):
            if len(steps) >= MAX_STEPS - 1:
                _warning(warnings, "milestone-output-limit")
                return
            if recorded_at is None:
                _warning(warnings, "recorded-time-unavailable")
            current = copy.deepcopy(snapshot)
            current["producer_seq"] = len(steps) + 1
            _validate_frame(current)
            _validate_cue(cue, current)
            steps.append({"id": identity, "kind": kind, "label": label, "recorded_at": recorded_at,
                          "source_refs": refs, "snapshot": current, "cue": cue})

        if not conflict:
            for _revision, identity, op, action in operations:
                recorded_at = _recorded_time(op.get("created_at"))
                refs = [f"context/operations/{identity}.json"]
                predecessor = _delivery_predecessor(op, action, state, warnings)
                if predecessor:
                    folder, task = predecessor
                    known_tasks[f"{folder}/task-{task['seq']:03d}"] = task
                    frame = _neutral_frame(final_snapshot)
                    _task_fact(frame, state, folder, task)
                    append(identity + ":source-state", "task-transition", "评审派发事务中记录的交付状态",
                           recorded_at, refs, frame, _task_cue(frame, state, folder, task, known_tasks))
                frame = _neutral_frame(final_snapshot)
                if action["action"] in PUBLICATIONS:
                    owner = action["role"] if action["action"] == "assign-dev" else action["owner"]
                    known_tasks[f"{owner}/task-{action['task']['seq']:03d}"] = action["task"]
                kind, label, cue = _operation_fact(frame, state, action, known_tasks)
                # Terminal conclusions belong to their actual final snapshot only.
                append(identity, kind, label, recorded_at, refs, frame, cue)
            for ref, task in tasks:
                known_tasks[ref] = task
                frame = _neutral_frame(final_snapshot)
                folder = ref.split("/", 1)[0]
                _task_fact(frame, state, folder, task)
                append("task-result:" + ref, "task-record", "任务记录补充 · 时间未记录", None, [ref + ".json"],
                       frame, _task_cue(frame, state, folder, task, known_tasks))
            if steps:
                final = copy.deepcopy(final_snapshot)
                final["producer_seq"] = len(steps) + 1
                steps.append({"id": "final-observation", "kind": "final-snapshot", "label": "当前终局记录",
                              "recorded_at": None, "source_refs": ["task.json", "workflow.json"], "snapshot": final,
                              "cue": _cue(None, "terminal" if terminal else "coordination")})
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
        if _operation_input_fingerprint(task_dir) != operation_fingerprint:
            raise BridgeError("input-inconsistent", "operation history changed during observation", projection.EXIT_NO_DATA)
        return result
    except BridgeError:
        raise
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
        raise BridgeError("read-failed", "task history could not be read", projection.EXIT_NO_DATA) from exc
