"""历史推演记录、结果 JSON 导出与版本差异比对。"""
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..diff import build_run_diff

router = APIRouter(prefix="/api/runs", tags=["runs"])


def _load_run(run_id: int, db: Session) -> models.Run:
    run = db.get(models.Run, run_id)
    if run is None:
        raise HTTPException(404, f"推演记录 id={run_id} 不存在")
    return run


def _load_diff_pair(base_id: int, target_id: int, db: Session):
    """载入并校验差异比对的两条记录：必须不同、均属于同一方案。"""
    if base_id == target_id:
        raise HTTPException(422, "请选择两条不同的推演记录进行版本差异比对")

    base_run, target_run = _load_run(base_id, db), _load_run(target_id, db)

    if base_run.plan_id is None or target_run.plan_id is None:
        raise HTTPException(422, "只有绑定了方案的推演记录才能进行版本差异比对")
    if base_run.plan_id != target_run.plan_id:
        raise HTTPException(
            409,
            f"两条记录不属于同一方案："
            f"记录 {base_id} 属于方案「{base_run.plan_name}」(id={base_run.plan_id})，"
            f"记录 {target_id} 属于方案「{target_run.plan_name}」(id={target_run.plan_id})",
        )
    return base_run, target_run


@router.get("")
def list_runs(limit: int = 100, db: Session = Depends(get_db)):
    runs = (
        db.query(models.Run)
        .order_by(models.Run.created_at.desc())
        .limit(min(limit, 500))
        .all()
    )
    return [
        {
            "id": r.id,
            "plan_id": r.plan_id,
            "plan_name": r.plan_name,
            "rule_revision": r.rule_revision,
            "status": r.status,
            "created_at": r.created_at,
        }
        for r in runs
    ]


@router.get("/diff")
def diff_runs(
    base_id: int = Query(..., alias="base", description="较早一次推演记录 ID"),
    target_id: int = Query(..., alias="target", description="较近一次推演记录 ID"),
    export: bool = False,
    db: Session = Depends(get_db),
):
    """比较同一方案的两条推演记录：按步骤编号 + 规则 ID 对齐命中并汇总变化。

    服务端自动按记录创建时间（tie-breaker：记录 ID）归一化为旧→新方向。
    记录不存在返回 404；同一记录返回 422；方案不一致返回 409。
    """
    first, second = _load_diff_pair(base_id, target_id, db)
    # 统一按"旧 → 新"方向呈现；创建时间相同（极少见）时以 ID 较小者为旧
    if (first.created_at, first.id) > (second.created_at, second.id):
        base_run, target_run = second, first
    else:
        base_run, target_run = first, second

    base_report = json.loads(base_run.report)
    target_report = json.loads(target_run.report)
    result = build_run_diff(base_run, target_run, base_report, target_report)

    if export:
        return JSONResponse(
            result,
            headers={
                "Content-Disposition": (
                    f'attachment; filename="run-diff-{base_run.id}-vs-{target_run.id}.json"'
                ),
                "Cache-Control": "no-store",
            },
        )
    return result


@router.get("/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db)):
    run = _load_run(run_id, db)
    return json.loads(run.report) | {"id": run.id, "created_at": run.created_at.isoformat()}


@router.get("/{run_id}/export")
def export_run(run_id: int, db: Session = Depends(get_db)):
    run = _load_run(run_id, db)
    report = json.loads(run.report)
    report["run_id"] = run.id
    report["exported_at"] = run.created_at.isoformat()
    return JSONResponse(
        report,
        headers={
            "Content-Disposition": f'attachment; filename="run-{run_id}-report.json"',
            "Cache-Control": "no-store",
        },
    )


@router.delete("/{run_id}", status_code=204)
def delete_run(run_id: int, db: Session = Depends(get_db)):
    run = _load_run(run_id, db)
    db.delete(run)
    db.commit()
