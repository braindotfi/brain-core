"""POST /run/plaid_extract — turn a Plaid sync payload into raw ingest envelopes.

The route runs the deterministic extraction step and then POSTs each envelope
to the Brain API's /v1/raw/ingest endpoint, returning per-envelope results so
the caller can see what was created vs deduplicated.
"""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from brain_agents.deps import AppDeps, get_deps

router = APIRouter()
_get_deps = Depends(get_deps)


class PlaidExtractRequest(BaseModel):
    agent_id: str
    tenant_id: str
    sync_payload: dict[str, Any]


class PlaidExtractResult(BaseModel):
    ingested: int
    skipped: int
    results: list[dict[str, Any]]


@router.post("/run/plaid_extract", response_model=PlaidExtractResult)
async def run_plaid_extract(
    req: PlaidExtractRequest,
    deps: AppDeps = _get_deps,
) -> Any:
    envelopes = deps.plaid_extractor_agent.extract(req.sync_payload)
    results: list[dict[str, Any]] = []
    ingested = 0
    skipped = 0
    for env in envelopes:
        try:
            result = await deps.brain_client.raw_ingest(env)
        except Exception as e:  # noqa: BLE001 — surfaced to caller, no swallow
            skipped += 1
            results.append({"sourceRef": env.get("sourceRef"), "error": str(e), "ingested": False})
            continue
        ingested += 1
        results.append({**result, "sourceRef": env.get("sourceRef"), "ingested": True})
    return {"ingested": ingested, "skipped": skipped, "results": results}
