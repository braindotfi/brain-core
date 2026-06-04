"""Document extraction agent (RFC 0004).

Reads an uploaded financial document's text and extracts a structured
`doc_obligation_v1` payload, then writes it to Raw via POST /raw/{id}/parsed.
The Ledger normalize step promotes that parsed row into a candidate
obligation (capped at confidence <= 0.5 as agent-contributed evidence).
"""
