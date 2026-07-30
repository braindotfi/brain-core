import { describe, expect, it } from "vitest";
import {
  esc,
  renderLoginPage,
  renderSetPasswordPage,
  renderForgotPasswordPage,
  renderSignedInPage,
  renderSetPasswordInvalidPage,
  renderConsentPage,
  renderErrorPage,
} from "../src/html.js";

const XSS = `"><script>alert(1)</script>`;
const ESCAPED = "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;";

describe("esc", () => {
  it("escapes all five HTML metacharacters", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("stringifies non-string input", () => {
    expect(esc(42)).toBe("42");
  });
});

describe("renderLoginPage", () => {
  it("escapes the csrf token, error, and notice", () => {
    const html = renderLoginPage({ csrfToken: XSS, error: XSS, notice: XSS });
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED);
  });

  it("carries no interpolated email (the form has no server-known value to leak)", () => {
    const html = renderLoginPage({ csrfToken: "tok" });
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
  });

  it("omits the continue field when no pending-authorization blob is carried", () => {
    const html = renderLoginPage({ csrfToken: "tok" });
    expect(html).not.toContain('name="continue"');
  });

  it("embeds and escapes the continue field when a pending-authorization blob is carried", () => {
    const html = renderLoginPage({ csrfToken: "tok", continueToken: XSS });
    expect(html).toContain('name="continue"');
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED);
  });
});

describe("renderSetPasswordPage", () => {
  it("escapes csrf, tid, token, and error", () => {
    const html = renderSetPasswordPage({
      csrfToken: XSS,
      tid: XSS,
      token: XSS,
      error: XSS,
    });
    expect(html).not.toContain(XSS);
    // Four separate interpolation sites, each escaped.
    expect(html.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(4);
  });
});

describe("renderForgotPasswordPage", () => {
  it("escapes the csrf token on the form-rendering branch", () => {
    const html = renderForgotPasswordPage({ csrfToken: XSS });
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED);
  });

  it("renders the constant confirmation body when submitted, no email echoed", () => {
    const html = renderForgotPasswordPage({ csrfToken: "tok", submitted: true });
    expect(html).toContain("If that email has a Brain account");
    expect(html).not.toContain('name="email"');
  });
});

describe("renderSignedInPage", () => {
  it("escapes the email", () => {
    const html = renderSignedInPage({ email: XSS });
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED);
  });
});

describe("renderSetPasswordInvalidPage", () => {
  it("renders a static error with no interpolation to escape", () => {
    const html = renderSetPasswordInvalidPage();
    expect(html).toContain("invalid, expired, or has already been used");
  });
});

const PENDING = {
  client_id: "oacl_test",
  redirect_uri: "https://example.test/cb",
  response_type: "code",
  scope: "ledger:read wiki:read",
  state: "xyz",
  code_challenge: "challenge-value",
  code_challenge_method: "S256",
  resource: "",
};

describe("renderConsentPage", () => {
  it("HTML-escapes client_name", () => {
    const html = renderConsentPage({
      csrfToken: "tok",
      clientName: XSS,
      tenantId: "tnt_test",
      pending: PENDING,
      agents: [],
    });
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED);
  });

  it("HTML-escapes every interpolated pending field", () => {
    const html = renderConsentPage({
      csrfToken: "tok",
      clientName: "Claude Code",
      tenantId: "tnt_test",
      pending: { ...PENDING, state: XSS, redirect_uri: `https://example.test/${XSS}` },
      agents: [],
    });
    expect(html).not.toContain(XSS);
  });

  it("HTML-escapes agent display name, role, and each scope value", () => {
    const html = renderConsentPage({
      csrfToken: "tok",
      clientName: "Claude Code",
      tenantId: "tnt_test",
      pending: PENDING,
      agents: [
        {
          agentId: "agent_test",
          displayName: XSS,
          role: XSS,
          consentableScopes: ["ledger:read"],
        },
      ],
    });
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED);
  });

  it("renders one checked checkbox per consentable scope, and a Grant button per agent", () => {
    const html = renderConsentPage({
      csrfToken: "tok",
      clientName: "Claude Code",
      tenantId: "tnt_test",
      pending: PENDING,
      agents: [
        {
          agentId: "agent_a",
          displayName: "Payment Agent",
          role: "payment",
          consentableScopes: ["ledger:read", "wiki:read"],
        },
      ],
    });
    expect(html.match(/type="checkbox"/g)?.length).toBe(2);
    expect(html).toContain('value="ledger:read"');
    expect(html).toContain('value="wiki:read"');
    expect(html).toContain('name="agent_id" value="agent_a"');
    expect(html).toContain("checked");
  });

  it("renders a Deny path even with zero eligible agents", () => {
    const html = renderConsentPage({
      csrfToken: "tok",
      clientName: "Claude Code",
      tenantId: "tnt_test",
      pending: PENDING,
      agents: [],
    });
    expect(html).toContain('name="decision" value="deny"');
    expect(html).not.toContain('name="decision" value="allow"');
  });
});

describe("renderErrorPage", () => {
  it("escapes the message", () => {
    const html = renderErrorPage(XSS);
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED);
  });
});
