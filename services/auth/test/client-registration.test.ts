import { describe, expect, it } from "vitest";
import {
  MAX_CLIENT_NAME_LENGTH,
  MAX_REDIRECT_URIS,
  MAX_REDIRECT_URI_LENGTH,
  MAX_SOFTWARE_FIELD_LENGTH,
  validateClientRegistration,
} from "../src/client-registration.js";

const REDIRECT_URI = "https://client.example.test/cb";

describe("validateClientRegistration: redirect_uris", () => {
  it("rejects a missing redirect_uris", () => {
    const result = validateClientRegistration({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  it("rejects an empty redirect_uris array", () => {
    const result = validateClientRegistration({ redirect_uris: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-array redirect_uris", () => {
    const result = validateClientRegistration({ redirect_uris: REDIRECT_URI });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-https, non-loopback redirect_uri", () => {
    const result = validateClientRegistration({ redirect_uris: ["http://example.test/cb"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  it("rejects a redirect_uri with a fragment", () => {
    const result = validateClientRegistration({
      redirect_uris: ["https://example.test/cb#frag"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  it("accepts https:// and a loopback http:// literal", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI, "http://127.0.0.1:51000/cb"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redirectUris).toEqual([REDIRECT_URI, "http://127.0.0.1:51000/cb"]);
    }
  });

  it(`rejects more than ${MAX_REDIRECT_URIS} redirect_uris`, () => {
    const many = Array.from(
      { length: MAX_REDIRECT_URIS + 1 },
      (_, i) => `https://example.test/cb${i}`,
    );
    const result = validateClientRegistration({ redirect_uris: many });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  it(`accepts exactly ${MAX_REDIRECT_URIS} redirect_uris`, () => {
    const exactly = Array.from(
      { length: MAX_REDIRECT_URIS },
      (_, i) => `https://example.test/cb${i}`,
    );
    const result = validateClientRegistration({ redirect_uris: exactly });
    expect(result.ok).toBe(true);
  });

  it(`rejects a redirect_uri longer than ${MAX_REDIRECT_URI_LENGTH} characters`, () => {
    const long = `https://example.test/${"a".repeat(MAX_REDIRECT_URI_LENGTH)}`;
    const result = validateClientRegistration({ redirect_uris: [long] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });
});

describe("validateClientRegistration: token_endpoint_auth_method", () => {
  it("defaults an omitted value to none", () => {
    const result = validateClientRegistration({ redirect_uris: [REDIRECT_URI] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tokenEndpointAuthMethod).toBe("none");
  });

  it("accepts an explicit none", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an explicit client_secret_basic (public clients only)", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });
});

describe("validateClientRegistration: grant_types", () => {
  it("defaults an omitted value to authorization_code only", () => {
    const result = validateClientRegistration({ redirect_uris: [REDIRECT_URI] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.grantTypes).toEqual(["authorization_code"]);
  });

  it("accepts authorization_code plus refresh_token", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.grantTypes).toEqual(["authorization_code", "refresh_token"]);
    }
  });

  it("rejects refresh_token alone (no way to obtain the first refresh token)", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      grant_types: ["refresh_token"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });

  it("rejects a grant type outside the supported set", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      grant_types: ["implicit"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });

  it("rejects an empty grant_types array", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      grant_types: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });
});

describe("validateClientRegistration: response_types", () => {
  it('defaults an omitted value to ["code"]', () => {
    const result = validateClientRegistration({ redirect_uris: [REDIRECT_URI] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.responseTypes).toEqual(["code"]);
  });

  it('accepts an explicit ["code"]', () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects anything other than exactly [code]", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      response_types: ["token"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });

  it("rejects [code, token]", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      response_types: ["code", "token"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });
});

describe("validateClientRegistration: client_name", () => {
  it('defaults an omitted value to "Unnamed client"', () => {
    const result = validateClientRegistration({ redirect_uris: [REDIRECT_URI] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clientName).toBe("Unnamed client");
  });

  it(`rejects a client_name longer than ${MAX_CLIENT_NAME_LENGTH} characters`, () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      client_name: "a".repeat(MAX_CLIENT_NAME_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });

  it(`accepts a client_name of exactly ${MAX_CLIENT_NAME_LENGTH} characters`, () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      client_name: "a".repeat(MAX_CLIENT_NAME_LENGTH),
    });
    expect(result.ok).toBe(true);
  });

  // Load-bearing: html.ts's renderConsentPage escapes clientName at render
  // time (esc()). Validation must NOT strip or sanitize it -- if it did, the
  // render-layer escaping would look untested and someone could "simplify"
  // it away later. test/html.test.ts's "HTML-escapes client_name" test is the
  // matching render-side assertion.
  it("preserves a client_name containing <script> verbatim (escaping is the render layer's job)", () => {
    const xss = `Evil<script>alert(1)</script>Client`;
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      client_name: xss,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clientName).toBe(xss);
  });
});

describe("validateClientRegistration: software_id / software_version", () => {
  it("accepts and stores both as-is", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      software_id: "claude-code",
      software_version: "1.2.3",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.softwareId).toBe("claude-code");
      expect(result.value.softwareVersion).toBe("1.2.3");
    }
  });

  it("omits both when absent", () => {
    const result = validateClientRegistration({ redirect_uris: [REDIRECT_URI] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.softwareId).toBeUndefined();
      expect(result.value.softwareVersion).toBeUndefined();
    }
  });

  it(`rejects a software_id longer than ${MAX_SOFTWARE_FIELD_LENGTH} characters`, () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      software_id: "a".repeat(MAX_SOFTWARE_FIELD_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });

  it(`rejects a software_version longer than ${MAX_SOFTWARE_FIELD_LENGTH} characters`, () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      software_version: "a".repeat(MAX_SOFTWARE_FIELD_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_client_metadata");
  });
});

describe("validateClientRegistration: scope and unknown members", () => {
  it("accepts and ignores a scope member -- it is never echoed back", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      scope: "payment_intent:approve policy:sign",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.value)).not.toContain("payment_intent:approve");
    }
  });

  it("ignores unknown/extra members without affecting validity", () => {
    const result = validateClientRegistration({
      redirect_uris: [REDIRECT_URI],
      some_future_field: "whatever",
    });
    expect(result.ok).toBe(true);
  });
});
