"""Shared dependency container injected via FastAPI request state."""

from dataclasses import dataclass

from fastapi import Request

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.client import BrainApiClient
from brain_agents.document_extractor.agent import DocumentExtractorAgent
from brain_agents.payment.agent import PaymentAgent
from brain_agents.plaid_extractor.agent import PlaidExtractorAgent
from brain_agents.reconciliation.agent import ReconciliationAgent


@dataclass
class AppDeps:
    brain_client: BrainApiClient
    recon_agent: ReconciliationAgent
    payment_agent: PaymentAgent
    anomaly_agent: AnomalyAgent
    plaid_extractor_agent: PlaidExtractorAgent
    document_extractor_agent: DocumentExtractorAgent


def get_deps(request: Request) -> AppDeps:
    deps: AppDeps = request.app.state.deps
    return deps
