#!/usr/bin/env python3
import base64
import binascii
import json
import re
import stat
import sys
from pathlib import Path


MINIMUM_PEPPER_BYTES = 32
EXPECTED_VALUES = {
    "BRAIN_API_KEY_AUTH_ENABLED": "true",
    "BRAIN_EDGE_RATE_LIMIT": "100000",
    "BRAIN_API_KEY_RATE_LIMIT_TIMEOUT_MS": "2000",
}
EXPECTED_KEYS = set(EXPECTED_VALUES) | {"BRAIN_API_KEY_PEPPER"}


def fail(message: str) -> None:
    raise SystemExit(message)


def read_patch(path: Path) -> dict[str, str]:
    if not path.is_file() or path.is_symlink():
        fail("enable patch is not a safe regular file")
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        fail("enable patch mode is not 0600")

    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            fail("enable patch contains an invalid line")
        key, value = line.split("=", 1)
        if key in values:
            fail("enable patch contains duplicate variables")
        values[key] = value

    if set(values) != EXPECTED_KEYS:
        fail("enable patch variable set is not fixed")
    if any(values[key] != value for key, value in EXPECTED_VALUES.items()):
        fail("enable patch fixed values do not match")
    return values


def decode_pepper(value: str) -> tuple[str, bytes]:
    if re.fullmatch(r"(?:[0-9A-Fa-f]{2})+", value):
        return "hex", bytes.fromhex(value)

    if re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", value):
        encoding = "base64"
        altchars = None
    elif re.fullmatch(r"[A-Za-z0-9_-]*={0,2}", value):
        encoding = "base64url"
        altchars = b"-_"
    else:
        fail("production pepper is not valid hex, Base64, or Base64URL")

    unpadded = value.rstrip("=")
    if "=" in unpadded or len(unpadded) % 4 == 1:
        fail("production pepper has invalid Base64 padding")
    padded = unpadded + "=" * (-len(unpadded) % 4)
    try:
        decoded = base64.b64decode(padded, altchars=altchars, validate=True)
    except (binascii.Error, ValueError):
        fail("production pepper has invalid Base64 encoding")
    return encoding, decoded


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: validate-api-key-enable-patch.py PATCH_FILE")
    values = read_patch(Path(sys.argv[1]))
    encoding, decoded = decode_pepper(values["BRAIN_API_KEY_PEPPER"])
    if len(decoded) < MINIMUM_PEPPER_BYTES:
        fail("production pepper decodes to fewer than 32 bytes")
    print(
        json.dumps(
            {
                "event": "production_api_key_pepper_entropy_validation",
                "encoding": encoding,
                "decoded_bytes": len(decoded),
                "minimum_bytes": MINIMUM_PEPPER_BYTES,
                "passed": True,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
