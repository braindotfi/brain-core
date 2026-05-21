"""Shared dependency container injected via FastAPI request state."""

from dataclasses import dataclass

from fastapi import Request

from brain_agents.client import BrainApiClient
from brain_agents.reconciliation.agent import ReconciliationAgent


@dataclass
class AppDeps:
    brain_client: BrainApiClient
    recon_agent: ReconciliationAgent


def get_deps(request: Request) -> AppDeps:
    deps: AppDeps = request.app.state.deps
    return deps
