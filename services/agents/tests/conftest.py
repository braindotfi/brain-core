"""Test session bootstrap.

Default the inbound-auth dependency to dev-override so the existing route
tests (test_reconciliation, test_payment, test_anomaly, test_plaid_extractor)
keep posting JSON without HMAC signatures. test_auth.py opts back into
production posture via monkeypatch.

Without this, every existing /run/* test would have to sign every payload.
"""

import os


def pytest_configure() -> None:
    # NEVER production at test time; the dev override only honors non-prod.
    os.environ.setdefault("BRAIN_ENV", "test")
    os.environ.setdefault("BRAIN_AGENTS_ALLOW_UNAUTHENTICATED", "true")
