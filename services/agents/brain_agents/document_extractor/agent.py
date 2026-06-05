"""Document → doc_obligation_v1 extraction via OpenAI.

Given the text of an uploaded financial document (a bill, invoice, or
statement), the agent extracts the single obligation it represents and
returns a payload matching the Ledger `doc_obligation_v1` parser shape
(see services/ledger/src/extractors/doc-obligation.ts). This is the only
non-deterministic step in the RFC 0004 pipeline; everything downstream
(the Raw parsed write, the Ledger normalize, the §6 gate) is deterministic
and treats the result as low-confidence (<= 0.5) agent-contributed evidence.

The agent never calls the Ledger directly. Its output is written to Raw via
POST /raw/{id}/parsed by the route, preserving the layer boundary.
"""

import json
from typing import Any

from openai import AsyncOpenAI

# Keys the Ledger doc_obligation_v1 parser understands. The model is asked
# to fill these; anything else it returns is dropped before the payload is
# written, so a chatty model cannot inject unexpected fields.
_PAYLOAD_KEYS = (
    "counterparty_name",
    "direction",
    "type",
    "amount",
    "currency",
    "due_date",
    "status",
    "minimum_due",
    "recurrence",
)

_SYSTEM_PROMPT = """
You extract a single financial obligation from the text of an uploaded
document (a bill, invoice, subscription notice, loan or rent statement).
Respond with ONLY a JSON object with these fields:

{
  "counterparty_name": "the other party (vendor we owe, or customer who owes us)",
  "direction": "payable" | "receivable",
  "type": "bill" | "invoice" | "subscription" | "loan" | "rent" | "payroll" | "tax" | "card_statement" | "other",
  "amount": "total amount due, as a plain decimal string e.g. \\"120.50\\"",
  "currency": "ISO 4217 code, 3 uppercase letters e.g. \\"USD\\"",
  "due_date": "ISO 8601 date-time e.g. \\"2026-07-01T00:00:00Z\\"",
  "status": "upcoming" | "due" | "paid" | "overdue" | "cancelled" | "disputed",
  "minimum_due": "optional minimum payment as a decimal string, omit if absent",
  "recurrence": "optional RFC 5545 RRULE or cron-ish string, omit if not recurring",
  "confidence": 0.0 to 1.0 — your confidence in the extraction
}

direction is "payable" when the document is a bill/invoice WE must pay, and
"receivable" when it is an invoice WE issued. Use "upcoming" for status when
the document does not state one. Respond with ONLY valid JSON.
""".strip()


class DocumentExtractorAgent:
    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def extract(self, document_text: str) -> dict[str, Any]:
        """Extract a doc_obligation_v1 payload + confidence from document text.

        Returns ``{"kind": "doc_obligation", "payload": {...}, "confidence": f}``.
        The payload contains only the keys the Ledger parser understands; the
        confidence is split out (default 0.5) so the caller can forward it to
        the raw_parsed write.
        """
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": document_text},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        raw = response.choices[0].message.content or "{}"
        try:
            parsed: dict[str, Any] = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {}

        confidence = _coerce_confidence(parsed.get("confidence"))
        payload = {k: parsed[k] for k in _PAYLOAD_KEYS if k in parsed and parsed[k] is not None}
        return {"kind": "doc_obligation", "payload": payload, "confidence": confidence}


def _coerce_confidence(value: Any) -> float:
    """Clamp a model-provided confidence into [0, 1]; default 0.5 when absent."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0.0, min(1.0, float(value)))
    return 0.5
