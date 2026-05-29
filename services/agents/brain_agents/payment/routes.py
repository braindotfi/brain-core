"""POST /run/payment — invoke payment agent and propose to Brain API."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from brain_agents.auth import require_inbound_auth
from brain_agents.deps import AppDeps, get_deps

router = APIRouter(dependencies=[Depends(require_inbound_auth)])
_get_deps = Depends(get_deps)


class PaymentRequest(BaseModel):
    agent_id: str
    context: dict[str, Any]
    tenant_id: str


class ProposalRecord(BaseModel):
    id: str
    proposing_agent_id: str
    action: dict[str, Any]
    policy_decision_id: str
    status: str
    approvers_signed: list[str]
    created_at: str


@router.post("/run/payment", response_model=ProposalRecord)
async def run_payment(
    req: PaymentRequest,
    deps: AppDeps = _get_deps,
) -> Any:
    proposed_action = await deps.payment_agent.propose(req.context)
    proposal = await deps.brain_client.propose(proposed_action, req.agent_id)
    return proposal
