"""Datasets landing reads (todo13 Milestone 3, docs/datasets.md §2.1, §4).

    GET  /api/v1/projects/{id}/dataset-summaries              one bounded summary per dataset
    GET  /api/v1/projects/{id}/dataset-attention?datasetId=   what needs a person: malformed files,
                                                              unconfirmed suggestions, waiting drop plans

Not under `/projects/{id}/datasets/…`, where a path segment is a dataset id. People only for
now: neither route is in the agent's route list (kernel/agent_scope.py), and both carry only
counts, kernel-written titles, collection names and ids (no file names, paths or values).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import datasets_views, features, projects

# Behind API_FEATURE_DATASETS_TAB (todo13 §7.1): off, both reads answer 404 and the landing
# falls back to per-dataset profiles.
router = APIRouter(prefix="/api/v1", dependencies=[Depends(features.require("datasets_tab"))])


@router.get("/projects/{project_id}/dataset-summaries")
def dataset_summaries(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return datasets_views.summaries(db, projects.require_project(db, ctx, project_id))


@router.get("/projects/{project_id}/dataset-attention")
def dataset_attention(project_id: str, datasetId: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):  # noqa: N803 (query name)
    p = projects.require_project(db, ctx, project_id)
    if datasetId:
        d, dp = projects.require_dataset(db, ctx, datasetId)
        if dp.id != p.id:
            raise HTTPException(404, "no such dataset in this project")
    return datasets_views.attention(db, p, datasetId)
