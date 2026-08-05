"""Reconciliation reasoning via OpenAI."""

import json
from typing import Any, Final

from openai import AsyncOpenAI

_SYSTEM_PROMPT = """
You are a financial reconciliation agent for Brain Finance.
Given a reconciliation action object, analyze the provided transaction identifiers or
period details and return a JSON object with:
- "matches": list of matched transaction pairs (each with "ledger_id" and "source_id")
- "discrepancies": list of unmatched entries with "id" and "reason"
- "match_confidence": float 0.0-1.0, your own confidence in the match quality above.
  This is advisory only; it never feeds the approval gate.
- "summary": one-sentence human-readable outcome

Respond with ONLY valid JSON. Do not include any other fields.
""".strip()

# The only keys the model's JSON response may contribute to the final action.
# Everything else -- most importantly "confidence", "evidence_score", and
# "risk_level", the exact fields the section 6 policy VM reads straight off
# this action (services/policy/src/vm.ts) to decide whether the proposal
# auto-approves -- is silently dropped, never merged in, no matter what the
# model returns.
#
# The action passed into analyze() already carries those three fields,
# deterministically computed upstream (the TS scanner) before this agent
# ever runs. Without this allowlist, a vendor who controls a transaction
# memo could steer the model into emitting a fabricated high-confidence /
# low-risk action that silently overwrites the real ones (RFC F1). An
# allowlist is safer than a denylist here because it fails closed on every
# future gate-read field the model might guess at, not just the three known
# today.
_MODEL_CONTRIBUTED_FIELDS: Final = frozenset(
    {"matches", "discrepancies", "summary", "match_confidence"}
)


class ReconciliationAgent:
    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def analyze(self, action: dict[str, Any]) -> dict[str, Any]:
        """Enrich a reconciliation action dict with LLM-derived findings.

        The model's output can only ADD the allowlisted keys above; it can
        never overwrite a key already present on `action` (the deterministic
        gate-read fields included), and any other key it returns is dropped.
        """
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
        model_output: dict[str, Any] = json.loads(raw)
        contributed = {k: v for k, v in model_output.items() if k in _MODEL_CONTRIBUTED_FIELDS}
        # Deterministic action fields always win: even an allowlisted key
        # cannot overwrite one the caller already set.
        return {**contributed, **action, "kind": action.get("kind", "reconciliation")}
