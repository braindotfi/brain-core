"""FastAPI application factory for brain-agents."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from openai import AsyncOpenAI

from brain_agents.client import BrainApiClient
from brain_agents.config import settings
from brain_agents.deps import AppDeps
from brain_agents.reconciliation.agent import ReconciliationAgent
from brain_agents.reconciliation.routes import router as recon_router


def create_app(deps: AppDeps | None = None) -> FastAPI:
    """Return a configured FastAPI app. Pass `deps` to skip live wiring (tests)."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        if deps is not None:
            app.state.deps = deps
        else:
            openai_client = AsyncOpenAI(api_key=settings.openai_api_key)
            brain_client = BrainApiClient(settings.brain_api_base_url, settings.brain_api_token)
            recon_agent = ReconciliationAgent(openai_client, settings.openai_model)
            app.state.deps = AppDeps(brain_client=brain_client, recon_agent=recon_agent)
        yield

    application = FastAPI(
        title="Brain Agents",
        version="0.1.0",
        lifespan=lifespan,
    )
    application.include_router(recon_router)

    @application.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": "true", "service": "brain-agents"}

    return application


app = create_app()
