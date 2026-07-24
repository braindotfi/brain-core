"""Boot-fence tests for the BRAIN_API_TOKEN expiry check."""

import base64
import json
import time

import pytest

from brain_agents.server import _assert_api_token_not_expired, _jwt_expiry_epoch


def _jwt(exp: object) -> str:
    """Build a structurally valid JWT with the given exp claim.

    The signature is never verified by this code path, so a placeholder is
    enough; only the claim segment matters.
    """
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


def test_expiry_epoch_reads_exp_claim() -> None:
    assert _jwt_expiry_epoch(_jwt(1784888765)) == 1784888765


@pytest.mark.parametrize(
    "token",
    ["", "not-a-jwt", "only.two", "a.!!!notbase64!!!.c", "a.e30.c"],
    ids=["empty", "opaque", "two-segments", "bad-base64", "no-exp-claim"],
)
def test_expiry_epoch_returns_none_for_unreadable_tokens(token: str) -> None:
    """An unreadable credential must degrade to "cannot tell", never to a crash."""
    assert _jwt_expiry_epoch(token) is None


def test_boot_fails_on_expired_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BRAIN_ENV", "production")
    monkeypatch.setenv("BRAIN_API_TOKEN", _jwt(int(time.time()) - 60))
    with pytest.raises(RuntimeError, match="BRAIN_API_TOKEN expired"):
        _assert_api_token_not_expired()


def test_boot_warns_when_token_expires_soon(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("BRAIN_ENV", "production")
    monkeypatch.setenv("BRAIN_API_TOKEN", _jwt(int(time.time()) + 5 * 86400))
    with caplog.at_level("WARNING"):
        _assert_api_token_not_expired()
    assert "expires in 5 day(s)" in caplog.text


def test_boot_silent_when_token_has_long_life(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("BRAIN_ENV", "production")
    monkeypatch.setenv("BRAIN_API_TOKEN", _jwt(int(time.time()) + 365 * 86400))
    with caplog.at_level("WARNING"):
        _assert_api_token_not_expired()
    assert caplog.text == ""


def test_fence_is_production_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """Dev and test boot must not be blocked by an expired local token."""
    monkeypatch.delenv("BRAIN_ENV", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.setenv("BRAIN_API_TOKEN", _jwt(int(time.time()) - 60))
    _assert_api_token_not_expired()
