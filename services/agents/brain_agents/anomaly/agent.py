"""Anomaly detection reasoning via OpenAI.

Given a batch of recent transactions, the agent scores each row for anomaly
risk (unusually large amount vs counterparty history, duplicates, suspected
structuring, suddenly-changed payee). The output is a list of `findings` the
Brain API can persist as evidence; nothing is auto-actioned. The deterministic
gate is the only path to a payment-altering action.
"""

import json
from typing import Any

from openai import AsyncOpenAI

_SYSTEM_PROMPT = """
You are an anomaly detection agent for Brain Finance.
You are given a batch of recent transactions (each with id, amount, currency,
counterparty_id, posted_at, and optionally counterparty_name). Score each row
for anomaly risk and produce a JSON object:

{
  "kind": "anomaly_scan",
  "findings": [
    {
      "transaction_id": "...",
      "category": "outlier_amount" | "duplicate_suspect" | "structuring" | "payee_swap" | "other",
      "severity": "low" | "medium" | "high",
      "rationale": "one sentence grounded in the input",
      "confidence": 0.0..1.0
    }
  ],
  "summary": "one-sentence batch-level outcome",
  "scanned": <count of input rows>
}

Findings list MUST be empty when nothing is anomalous; do not invent risk.
Respond with ONLY valid JSON.
""".strip()


class AnomalyAgent:
    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def scan(self, transactions: list[dict[str, Any]]) -> dict[str, Any]:
        """Score a batch of transactions for anomaly risk."""
        payload = {"transactions": transactions, "scanned": len(transactions)}
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(payload)},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        raw = response.choices[0].message.content or "{}"
        parsed: dict[str, Any] = json.loads(raw)
        # Always carry the scanned count forward; the LLM occasionally omits it.
        return {
            "kind": "anomaly_scan",
            "scanned": len(transactions),
            "findings": parsed.get("findings", []),
            "summary": parsed.get("summary", ""),
        }
