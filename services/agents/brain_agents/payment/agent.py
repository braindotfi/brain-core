"""Payment proposal reasoning via OpenAI.

Given an invoice or obligation context, the agent produces a PaymentIntent
action payload that the gate can evaluate. The agent never executes anything;
it only proposes. Execution still runs through the §6 deterministic gate in
the Brain API.
"""

import json
from typing import Any

from openai import AsyncOpenAI

_SYSTEM_PROMPT = """
You are a payment agent for Brain Finance.
Given an invoice or obligation context, produce a JSON object describing the
PaymentIntent action that should be proposed to the Brain API. The output is
NOT executed; it is fed to the deterministic pre-execution gate.

Required output fields:
- "action_type": one of "ach_outbound", "wire", "onchain_transfer",
  "x402_settle", "escrow_release"
- "source_account_id": id of the AP / treasury account to debit
- "destination_counterparty_id": id of the payee counterparty
- "amount": decimal string (e.g. "1234.56"); MUST match the obligation /
  invoice amount unless an explicit partial reason is in the context
- "currency": ISO-4217 (e.g. "USD") or "USDC" for x402 / escrow rails
- "rationale": one-sentence explanation grounded in the input context
- "confidence": float 0.0–1.0

Preserve any "obligation_id", "invoice_id", or "evidence_ids" fields from the
input verbatim. Respond with ONLY valid JSON.
""".strip()


class PaymentAgent:
    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def propose(self, context: dict[str, Any]) -> dict[str, Any]:
        """Propose a PaymentIntent action payload from invoice/obligation context."""
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(context)},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        raw = response.choices[0].message.content or "{}"
        proposal: dict[str, Any] = json.loads(raw)
        # Carry input linkage forward (the LLM may drop fields it doesn't
        # consider relevant; the gate needs the obligation/invoice/evidence ids
        # for checks 9.5 and 11.5).
        passthrough = {
            k: context[k] for k in ("obligation_id", "invoice_id", "evidence_ids") if k in context
        }
        return {**passthrough, **proposal, "kind": "payment"}
