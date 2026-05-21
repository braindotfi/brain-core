"""Reconciliation reasoning via OpenAI."""

import json
from typing import Any

from openai import AsyncOpenAI

_SYSTEM_PROMPT = """
You are a financial reconciliation agent for Brain Finance.
Given a reconciliation action object, analyze the provided transaction identifiers or
period details and return a JSON object with:
- "matches": list of matched transaction pairs (each with "ledger_id" and "source_id")
- "discrepancies": list of unmatched entries with "id" and "reason"
- "confidence": float 0.0–1.0 reflecting overall match confidence
- "summary": one-sentence human-readable outcome

Respond with ONLY valid JSON. Preserve any extra fields from the input.
""".strip()


class ReconciliationAgent:
    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def analyze(self, action: dict[str, Any]) -> dict[str, Any]:
        """Enrich a reconciliation action dict with LLM-derived findings."""
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(action)},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        raw = response.choices[0].message.content or "{}"
        enriched: dict[str, Any] = json.loads(raw)
        # Preserve kind so the policy DSL can route on it.
        return {**action, **enriched, "kind": action.get("kind", "reconciliation")}
