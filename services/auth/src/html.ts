/**
 * Server-rendered HTML for /login, /set-password, /forgot-password. No client
 * framework, no bundler -- same posture as services/api/src/proof/view.ts,
 * whose `esc()` this started as a verbatim copy of. It now differs in form
 * only (global regexes rather than string-argument replaceAll, see below);
 * the escaped character set is the same. Every interpolated value goes
 * through `esc()`.
 */

/**
 * The same five replacements as before, written as global regexes instead of
 * `replaceAll` with string arguments. Behaviour is identical. The reason for
 * the shape is legibility to static analysis: CodeQL's XSS sanitizer model
 * (and most others) recognises a `replace(/</g, ...)` chain as HTML escaping
 * and does not recognise the string-argument `replaceAll` form. Every value
 * this file interpolates already went through here, so the reflected-XSS
 * findings against the auth pages were false positives, but an escaper the
 * scanner can see is worth more than one only a reviewer can see. `&` stays
 * first: escaping it after the others would double-encode their output.
 */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PageOptions {
  readonly title: string;
  readonly bodyHtml: string;
  /** Per-request CSP nonce (reply.cspNonce.style); omit => no nonce attribute. */
  readonly styleNonce?: string | undefined;
}

function shell(opts: PageOptions): string {
  const nonceAttr = opts.styleNonce !== undefined ? ` nonce="${esc(opts.styleNonce)}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(opts.title)} - Brain</title>
<style${nonceAttr}>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 2rem 1.5rem; max-width: 420px; margin-inline: auto; color: #1a1a2e; }
  h1 { font-size: 1.25rem; margin: 0 0 1.25rem; }
  label { display: block; font-weight: 600; margin: 0.9rem 0 0.3rem; }
  input[type="email"], input[type="password"] {
    width: 100%; box-sizing: border-box; padding: 0.5rem 0.6rem; font-size: 1rem;
    border: 1px solid #ccc; border-radius: 6px;
  }
  button { margin-top: 1.25rem; width: 100%; padding: 0.6rem; font-size: 1rem; font-weight: 600;
    border: none; border-radius: 6px; background: #1a1a2e; color: #fff; cursor: pointer; }
  .error { background: #fde2e1; color: #8a1c14; padding: 0.6rem 0.8rem; border-radius: 6px;
    margin-bottom: 1rem; font-size: 0.92rem; }
  .notice { background: #d8f5e0; color: #07632c; padding: 0.6rem 0.8rem; border-radius: 6px;
    margin-bottom: 1rem; font-size: 0.92rem; }
  .muted { color: #666; font-size: 0.85rem; margin-top: 1rem; }
  a { color: #1a1a2e; }
</style>
</head>
<body>
  <h1>${esc(opts.title)}</h1>
  ${opts.bodyHtml}
</body>
</html>`;
}

function banner(kind: "error" | "notice", text: string | undefined): string {
  if (text === undefined) return "";
  return `<p class="${kind}">${esc(text)}</p>`;
}

export interface LoginPageInput {
  readonly csrfToken: string;
  readonly error?: string | undefined;
  readonly notice?: string | undefined;
  readonly styleNonce?: string | undefined;
  /**
   * A pending-authorization blob (pending-authorization.ts) carried through
   * an unauthenticated GET /authorize -> GET /login redirect. Resubmitted as
   * a hidden field so a successful login can resume the OAuth flow instead
   * of rendering the plain "signed in" page.
   */
  readonly continueToken?: string | undefined;
}

export function renderLoginPage(input: LoginPageInput): string {
  const continueField =
    input.continueToken !== undefined
      ? `<input type="hidden" name="continue" value="${esc(input.continueToken)}" />`
      : "";
  const bodyHtml = `
  ${banner("error", input.error)}
  ${banner("notice", input.notice)}
  <form method="post" action="/login">
    <input type="hidden" name="csrf" value="${esc(input.csrfToken)}" />
    ${continueField}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
  </form>
  <p class="muted"><a href="/forgot-password">Forgot your password?</a></p>`;
  return shell({ title: "Sign in", bodyHtml, styleNonce: input.styleNonce });
}

export interface SignedInPageInput {
  readonly email: string;
  readonly styleNonce?: string | undefined;
}

export function renderSignedInPage(input: SignedInPageInput): string {
  const bodyHtml = `<p>You're signed in as <strong>${esc(input.email)}</strong>.</p>`;
  return shell({ title: "Signed in", bodyHtml, styleNonce: input.styleNonce });
}

export interface SetPasswordFormInput {
  readonly csrfToken: string;
  readonly tid: string;
  readonly token: string;
  readonly error?: string | undefined;
  readonly styleNonce?: string | undefined;
}

export function renderSetPasswordPage(input: SetPasswordFormInput): string {
  const bodyHtml = `
  ${banner("error", input.error)}
  <form method="post" action="/set-password">
    <input type="hidden" name="csrf" value="${esc(input.csrfToken)}" />
    <input type="hidden" name="tid" value="${esc(input.tid)}" />
    <input type="hidden" name="t" value="${esc(input.token)}" />
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required />
    <button type="submit">Set password</button>
  </form>`;
  return shell({ title: "Set your password", bodyHtml, styleNonce: input.styleNonce });
}

export function renderSetPasswordInvalidPage(styleNonce?: string | undefined): string {
  const bodyHtml = `<p class="error">This link is invalid, expired, or has already been used.</p>
  <p class="muted"><a href="/forgot-password">Request a new link</a></p>`;
  return shell({ title: "Link invalid", bodyHtml, styleNonce });
}

export interface ForgotPasswordPageInput {
  readonly csrfToken: string;
  readonly submitted?: boolean | undefined;
  readonly styleNonce?: string | undefined;
}

export function renderForgotPasswordPage(input: ForgotPasswordPageInput): string {
  if (input.submitted === true) {
    const bodyHtml = `<p class="notice">If that email has a Brain account, a reset link is on its way.</p>
    <p class="muted"><a href="/login">Back to sign in</a></p>`;
    return shell({ title: "Check your email", bodyHtml, styleNonce: input.styleNonce });
  }
  const bodyHtml = `
  <form method="post" action="/forgot-password">
    <input type="hidden" name="csrf" value="${esc(input.csrfToken)}" />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required />
    <button type="submit">Send reset link</button>
  </form>
  <p class="muted"><a href="/login">Back to sign in</a></p>`;
  return shell({ title: "Reset your password", bodyHtml, styleNonce: input.styleNonce });
}

export function renderErrorPage(message: string, styleNonce?: string | undefined): string {
  const bodyHtml = `<p class="error">${esc(message)}</p>`;
  return shell({ title: "Error", bodyHtml, styleNonce });
}

/** Short human-readable text per scope, for the consent screen. Falls back to the raw scope string. */
const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "ledger:read": "Read your ledger (accounts, balances, transactions)",
  "wiki:read": "Read wiki answers about your business data",
  "raw:read": "Read uploaded documents and source data",
  "raw:write": "Upload documents and source data",
  "payment_intent:propose": "Propose payments (never approve or send money)",
  "execution:propose": "Propose actions for a human to review",
};

export interface ConsentPendingFields {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly response_type: string;
  readonly scope: string;
  readonly state: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly resource: string;
}

export interface ConsentAgentOption {
  readonly agentId: string;
  readonly displayName: string;
  readonly role: string;
  readonly consentableScopes: readonly string[];
}

export interface ConsentPageInput {
  readonly csrfToken: string;
  readonly clientName: string;
  readonly tenantId: string;
  readonly pending: ConsentPendingFields;
  readonly agents: readonly ConsentAgentOption[];
  readonly styleNonce?: string | undefined;
}

function pendingFieldsHtml(pending: ConsentPendingFields): string {
  return (Object.entries(pending) as Array<[string, string]>)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}" />`)
    .join("\n    ");
}

export function renderConsentPage(input: ConsentPageInput): string {
  const hidden = pendingFieldsHtml(input.pending);
  const agentForms = input.agents
    .map((agent) => {
      const checkboxes = agent.consentableScopes
        .map(
          (scope) => `
        <label><input type="checkbox" name="scope_selected" value="${esc(scope)}" checked />
          ${esc(SCOPE_DESCRIPTIONS[scope] ?? scope)}</label>`,
        )
        .join("");
      return `
      <form method="post" action="/authorize/consent">
        <input type="hidden" name="csrf" value="${esc(input.csrfToken)}" />
        ${hidden}
        <input type="hidden" name="agent_id" value="${esc(agent.agentId)}" />
        <input type="hidden" name="decision" value="allow" />
        <fieldset>
          <legend>${esc(agent.displayName)} (${esc(agent.role)})</legend>
          ${checkboxes}
        </fieldset>
        <button type="submit">Grant access as ${esc(agent.displayName)}</button>
      </form>`;
    })
    .join("\n");

  const noAgents =
    input.agents.length === 0
      ? `<p class="muted">No eligible agent is available to grant this request to.</p>`
      : "";

  const denyForm = `
    <form method="post" action="/authorize/consent">
      <input type="hidden" name="csrf" value="${esc(input.csrfToken)}" />
      ${hidden}
      <input type="hidden" name="decision" value="deny" />
      <button type="submit">Deny</button>
    </form>`;

  const bodyHtml = `
  <p><strong>${esc(input.clientName)}</strong> is requesting access to act as an agent in
  tenant <code>${esc(input.tenantId)}</code>.</p>
  ${noAgents}
  ${agentForms}
  ${denyForm}`;
  return shell({ title: "Authorize access", bodyHtml, styleNonce: input.styleNonce });
}
