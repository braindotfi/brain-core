"""Plaid extractor — turns a Plaid transactions/sync payload into raw ingest envelopes.

This is the deterministic-glue agent: there is NO LLM reasoning step. The
Plaid sync response is already structured; the agent just shapes each
transaction into the `RawIngestRequest` envelope the Brain API expects (one
per Plaid transaction id). Kept inside the same brain_agents server so the
boot story stays "one Python service hosts every agent."
"""

import json
from typing import Any

_SOURCE_TYPE = "plaid_transactions_sync"


class PlaidExtractorAgent:
    """Stateless extractor. No constructor deps; pure transformation."""

    def extract(self, sync_payload: dict[str, Any]) -> list[dict[str, Any]]:
        """Return one RawIngestRequest envelope per transaction in the sync payload.

        Accepts the canonical Plaid `/transactions/sync` shape:
            {
              "added":    [...transactions...],
              "modified": [...transactions...],
              "removed":  [{"transaction_id": "..."}, ...],
              "next_cursor": "..."
            }

        `removed` is forwarded as a typed `{"removed": true, ...}` body so the
        Ledger reconciliation worker can tombstone the matching parsed row.
        Unknown / extra top-level keys are ignored.
        """
        envelopes: list[dict[str, Any]] = []
        added = sync_payload.get("added", []) or []
        modified = sync_payload.get("modified", []) or []
        removed = sync_payload.get("removed", []) or []

        for tx in [*added, *modified]:
            txid = tx.get("transaction_id")
            if txid is None:
                continue
            envelopes.append(
                {
                    "sourceType": _SOURCE_TYPE,
                    "sourceRef": str(txid),
                    "mimeType": "application/json",
                    "body": json.dumps(tx).encode("utf-8"),
                }
            )

        for r in removed:
            txid = r.get("transaction_id")
            if txid is None:
                continue
            envelopes.append(
                {
                    "sourceType": _SOURCE_TYPE,
                    "sourceRef": str(txid),
                    "mimeType": "application/json",
                    "body": json.dumps({"removed": True, "transaction_id": txid}).encode("utf-8"),
                }
            )

        return envelopes
