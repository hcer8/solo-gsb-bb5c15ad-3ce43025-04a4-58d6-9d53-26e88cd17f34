"""历史推演记录与结果 JSON 导出。"""
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db

router = APIRouter(prefix="/api/runs", tags=["runs"])


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


@router.get("/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db)):
    run = db.get(models.Run, run_id)
    if run is None:
        raise HTTPException(404, "推演记录不存在")
    return json.loads(run.report) | {"id": run.id, "created_at": run.created_at.isoformat()}


@router.get("/{run_id}/export")
def export_run(run_id: int, db: Session = Depends(get_db)):
    run = db.get(models.Run, run_id)
    if run is None:
        raise HTTPException(404, "推演记录不存在")
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
    run = db.get(models.Run, run_id)
    if run is None:
        raise HTTPException(404, "推演记录不存在")
    db.delete(run)
    db.commit()
