"""POST /run/anomaly — scan a transaction batch for anomalies and post findings.

Unlike the payment/reconciliation routes, this one does NOT call
`brain_client.propose()`. Anomaly findings are advisory metadata; they may be
attached to subsequent payment proposals as evidence but never trigger an
action on their own. The route returns the raw scan output so the caller
decides how to record it.
"""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from brain_agents.auth import require_inbound_auth
from brain_agents.deps import AppDeps, get_deps

router = APIRouter(dependencies=[Depends(require_inbound_auth)])
_get_deps = Depends(get_deps)


class AnomalyRequest(BaseModel):
    agent_id: str
    transactions: list[dict[str, Any]]
    tenant_id: str


class AnomalyFinding(BaseModel):
    transaction_id: str
    category: str
    severity: str
    rationale: str
    confidence: float


class AnomalyResult(BaseModel):
    kind: str
    scanned: int
    findings: list[AnomalyFinding]
    summary: str


@router.post("/run/anomaly", response_model=AnomalyResult)
async def run_anomaly(
    req: AnomalyRequest,
    deps: AppDeps = _get_deps,
) -> Any:
    return await deps.anomaly_agent.scan(req.transactions)
