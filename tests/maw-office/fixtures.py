"""Shared helpers for the maw-office Python suite: synthetic runtime fixtures.

All fixture content is sanitized synthetic data shaped like a real MAW runtime
(the er5-derived cancelled/running/pass combination included); no real project
text, paths or session identifiers are reproduced.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

AVO_ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True  # zero-write guarantee: no __pycache__ anywhere

import importlib.util  # noqa: E402

# The file name carries a hyphen, so load it explicitly by path instead of a
# plain import. dont_write_bytecode above keeps the load cache-free.
_spec = importlib.util.spec_from_file_location("maw_office", AVO_ROOT / "scripts" / "maw-office.py")
maw_office = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(maw_office)


def write(path: Path, payload, raw: str | None = None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if raw is not None:
        path.write_text(raw, encoding="utf-8")
    else:
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def manifest(status="active", plan_ref="docs/development/plan.md", plan_digest=None):
    data = {
        "schema": "maw.manifest/4",
        "standard_workflow_version": "4",
        "status": status,
        "next_seq": 3,
        "plan_ref": plan_ref,
        "plan_digest": plan_digest,
        "roles": ["manager-1", "executor-1", "reviewer-1"],
        "unconfirmed_roles": [],
        "termination_started": True,
        "agent": "zcode",
        "session": None,
        "terminal_outcome": None,
    }
    if plan_digest:
        data["plan_digest"] = plan_digest
    return data


def workflow(nodes_states=None, finish=None, selection_title="执行与审核流程", with_definition=True):
    nodes = {}
    definition_nodes = []
    order = [("team", "team-ready"), ("develop", "development-group"), ("evaluate", "delivery-evaluation"), ("shutdown", "shutdown")]
    for node_id, node_type in order:
        state = (nodes_states or {}).get(node_id, {"status": "completed", "blocking": None})
        nodes[node_id] = {"status": state["status"], "blocking": state.get("blocking"), "released": False, "result_ref": None, "work_items": []}
        definition_nodes.append({"id": node_id, "type": node_type, "depends_on": []})
    data = {
        "schema": "maw.workflow/2",
        "definition_digest": "sha256:deadbeef",
        "revision": 3,
        "nodes": nodes,
        "work_items": {},
        "review_obligations": {},
        "finish": finish or {"requested": False, "cancel_requested": False, "evaluation": None, "terminations_published": False, "await_state": None, "outcome": None, "unresolved": []},
        "operations": {"last": None},
    }
    if with_definition:
        data["definition"] = {"schema": "maw.workflow-definition/1", "id": "execution-review", "version": "1", "nodes": definition_nodes}
    data["selection"] = {"id": "execution-review", "title": selection_title}
    return data


def task(seq, type_="dev", status="in-progress", round_=1, ref_task=None, folder="executor-1", verdict=None):
    data = {
        "schema": "maw.task/3",
        "seq": seq,
        "type": type_,
        "round": round_,
        "ref_task": ref_task,
        "status": status,
        "details": "synthetic",
        "agent": "zcode",
        "session": None,
        "result": {"agent": "zcode", "session": None, "summary": None, "evidence": []},
        "review": {"review_task_file": None, "verdict": verdict, "comments": None, "agent": None, "session": None},
        "workflow_node_id": "develop",
        "logical_work_id": "slice-001" if type_ == "dev" else None,
        "attempt_id": None,
        "review_object": None,
        "aggregate": None,
    }
    if verdict is not None:
        data["review"]["verdict"] = verdict
    return data


def build_runtime(root: Path, manifest_status="active", nodes_states=None, finish=None,
                  executor_tasks=(), reviewer_tasks=(), decision_tasks=(),
                  executor_ready="confirmed", reviewer_ready="confirmed",
                  executor_terminate=None, reviewer_terminate=None):
    task_dir = root / RUNTIME_REL / "maw-synth-001"
    write(task_dir / "task.json", manifest(manifest_status))
    write(task_dir / "workflow.json", workflow(nodes_states, finish))
    plan = root / "docs" / "development" / "plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# synthetic plan\n", encoding="utf-8")

    def role(folder, ready, terminate, tasks):
        rdir = task_dir / folder
        if ready:
            write(rdir / "ready.json", {"schema": "maw.ready/1", "status": ready, "updated_at": "2026-10-22T12:00:00+08:00", "agent": "zcode", "session": None, "note": None})
        if terminate:
            write(rdir / "terminate.json", {"schema": "maw.terminate/1", "status": terminate, "details": "synthetic", "agent": "zcode", "session": None, "wrap_up_note": None})
        for t in tasks:
            write(rdir / f"task-{t['seq']:03d}.json", t)

    role("manager-1", "ready", None, [])
    role("executor-1", executor_ready, executor_terminate, list(executor_tasks))
    role("reviewer-1", reviewer_ready, reviewer_terminate, list(reviewer_tasks))
    role("decision-maker-1", "confirmed", None, list(decision_tasks))
    return root


def member_by_role(members, role):
    for m in members:
        if m["role"] == role:
            return m
    return None


RUNTIME_REL = maw_office.RUNTIME_REL


def uuid_tmp():
    """Fresh sanitized temp project root per test."""
    # macOS tempfile can spell the trusted system temp path through /var's
    # symlink. Tests supply the actual canonical project root to exercise the
    # same no-symlink ancestor contract as the Dashboard registry.
    return Path(tempfile.mkdtemp(prefix="maw-office-test-")).resolve()
