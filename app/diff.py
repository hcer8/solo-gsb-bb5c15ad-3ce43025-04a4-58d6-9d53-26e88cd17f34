"""两条同一方案推演记录之间的"规则版本差异"计算。

两份报告按 **命中步骤编号（incoming_step）+ 规则 ID（rule_id）+ 冲突步骤（existing_step）**
对齐 finding——同一规则在同一步可能与多个已加入试剂配对，加入 existing_step 以消歧：

- ``added``             新版本新增的命中
- ``removed``           新版本中消失的命中
- ``severity_changed``  两版本都命中但严重级别发生变化
- ``unchanged``         两版本一致

同时汇总整体状态、首次危险、受影响/阻断/警示步骤集合与逐步状态的变化。
"""
from .engine import SEVERITY_LABEL, STATUS_LABEL

CHANGE_TYPES = ("added", "removed", "severity_changed", "unchanged")
CHANGE_LABELS = {
    "added": "新增命中",
    "removed": "命中消失",
    "severity_changed": "严重级别变化",
    "unchanged": "无变化",
}

STATUS_RANK = {"safe": 0, "warning": 1, "danger": 2}


def _index_findings(findings: list[dict]) -> dict[tuple, list[dict]]:
    """按 (命中步骤, 规则 ID, 冲突步骤) 建立索引；同一键保留全部（多类别标签可能重复）。"""
    indexed: dict[tuple, list[dict]] = {}
    for f in findings:
        key = (f.get("incoming_step"), f.get("rule_id"), f.get("existing_step"))
        indexed.setdefault(key, []).append(f)
    return indexed


def _entry(change: str, base_f: dict | None, target_f: dict | None) -> dict:
    f = target_f or base_f or {}
    return {
        "change": change,
        "change_label": CHANGE_LABELS[change],
        "rule_id": f.get("rule_id"),
        "step": f.get("incoming_step"),
        "conflicts_with_step": f.get("existing_step"),
        "incoming_reagent": f.get("incoming_reagent"),
        "existing_reagent": f.get("existing_reagent"),
        "base": base_f,
        "target": target_f,
    }


def _diff_findings(base_findings: list[dict], target_findings: list[dict]) -> list[dict]:
    base_map = _index_findings(base_findings)
    target_map = _index_findings(target_findings)

    def _key_order(k):
        incoming, rule_id, existing = k
        return (
            incoming if incoming is not None else 1 << 30,
            existing if existing is not None else 1 << 30,
            rule_id or "",
        )

    entries: list[dict] = []
    for key in sorted(set(base_map) | set(target_map), key=_key_order):
        bf = base_map.get(key, [])
        tf = target_map.get(key, [])
        paired = min(len(bf), len(tf))
        for i in range(paired):
            if bf[i].get("severity") != tf[i].get("severity"):
                entries.append(_entry("severity_changed", bf[i], tf[i]))
            else:
                entries.append(_entry("unchanged", bf[i], tf[i]))
        for f in bf[paired:]:
            entries.append(_entry("removed", f, None))
        for f in tf[paired:]:
            entries.append(_entry("added", None, f))
    return entries


def _first_danger_change(base_fd: dict | None, target_fd: dict | None) -> dict:
    """首次危险是否变化：从无到有 / 从有到无 / 发生步骤或命中规则不同都算变化。"""
    def _sig(fd):
        if fd is None:
            return None
        return (fd.get("step"), fd.get("rule_id"), fd.get("conflicts_with_step"))

    changed = _sig(base_fd) != _sig(target_fd)
    return {"changed": changed, "base": base_fd, "target": target_fd}


def _step_set_change(name: str, base_steps: list[int], target_steps: list[int]) -> dict:
    base_set, target_set = set(base_steps), set(target_steps)
    return {
        "name": name,
        "base": sorted(base_set),
        "target": sorted(target_set),
        "added": sorted(target_set - base_set),
        "removed": sorted(base_set - target_set),
        "changed": base_set != target_set,
    }


def _timeline_change(base_timeline: list[dict], target_timeline: list[dict]) -> list[dict]:
    """按步骤编号对齐两次推演的逐步状态。"""
    def _by_order(timeline):
        return {t.get("order_index"): t for t in timeline}

    b_map, t_map = _by_order(base_timeline), _by_order(target_timeline)
    rows = []
    for order in sorted(set(b_map) | set(t_map)):
        b, t = b_map.get(order), t_map.get(order)
        rows.append(
            {
                "order_index": order,
                "base_reagent": b.get("reagent_name") if b else None,
                "target_reagent": t.get("reagent_name") if t else None,
                "base_state": b.get("state") if b else None,
                "target_state": t.get("state") if t else None,
                "base_state_label": b.get("state_label") if b else None,
                "target_state_label": t.get("state_label") if t else None,
                "changed": bool(b and t and b.get("state") != t.get("state"))
                or (b is None) != (t is None),
            }
        )
    return rows


def _summary_changes(base_summary: dict, target_summary: dict) -> dict:
    fields = ("total_steps", "executed_steps", "findings", "high", "medium", "low")
    out = {}
    for field_name in fields:
        bv, tv = base_summary.get(field_name, 0), target_summary.get(field_name, 0)
        out[field_name] = {"base": bv, "target": tv, "delta": tv - bv}
    return out


def _run_side(run, report: dict) -> dict:
    status = report.get("status", run.status)
    return {
        "run_id": run.id,
        "created_at": run.created_at.isoformat(),
        "rule_revision": report.get("rule_revision", run.rule_revision),
        "status": status,
        "status_label": report.get("status_label") or STATUS_LABEL.get(status, status),
        "plan_name": report.get("plan_name") or run.plan_name,
    }


def build_run_diff(base_run, target_run, base_report: dict, target_report: dict) -> dict:
    """构建同一方案两条推演记录的版本差异报告。base=较早记录，target=较晚记录。"""
    entries = _diff_findings(base_report.get("findings", []), target_report.get("findings", []))
    counts = {change: 0 for change in CHANGE_TYPES}
    for e in entries:
        counts[e["change"]] += 1

    b_status, t_status = base_report.get("status"), target_report.get("status")
    rank_delta = STATUS_RANK.get(t_status, 0) - STATUS_RANK.get(b_status, 0)
    trend = "worsened" if rank_delta > 0 else "improved" if rank_delta < 0 else "same"
    status_change = {
        "changed": b_status != t_status,
        "trend": trend,
        "base": b_status,
        "target": t_status,
        "base_label": base_report.get("status_label") or STATUS_LABEL.get(b_status, b_status),
        "target_label": target_report.get("status_label") or STATUS_LABEL.get(t_status, t_status),
    }

    first_danger_change = _first_danger_change(
        base_report.get("first_danger"), target_report.get("first_danger")
    )
    affected_change = _step_set_change(
        "affected_steps", base_report.get("affected_steps", []), target_report.get("affected_steps", [])
    )
    blocked_change = _step_set_change(
        "blocked_steps", base_report.get("blocked_steps", []), target_report.get("blocked_steps", [])
    )
    warning_change = _step_set_change(
        "warning_steps", base_report.get("warning_steps", []), target_report.get("warning_steps", [])
    )

    has_changes = (
        bool(counts["added"] or counts["removed"] or counts["severity_changed"])
        or status_change["changed"]
        or first_danger_change["changed"]
        or affected_change["changed"]
        or blocked_change["changed"]
        or warning_change["changed"]
    )

    return {
        "kind": "labmix-run-diff",
        "engine_version": "1.0",
        "plan_id": base_run.plan_id,
        "plan_name": base_report.get("plan_name") or base_run.plan_name,
        "base": _run_side(base_run, base_report),
        "target": _run_side(target_run, target_report),
        "has_changes": has_changes,
        "status_change": status_change,
        "first_danger_change": first_danger_change,
        "affected_steps_change": affected_change,
        "blocked_steps_change": blocked_change,
        "warning_steps_change": warning_change,
        "summary_changes": _summary_changes(
            base_report.get("summary", {}), target_report.get("summary", {})
        ),
        "steps": _timeline_change(
            base_report.get("timeline", []), target_report.get("timeline", [])
        ),
        "findings": entries,
        "counts": counts,
        "severity_labels": dict(SEVERITY_LABEL),
    }
