# Setup Your Account

Create a Brain account, set up your first tenant, and invite teammates.

### Sign Up

Go to [console.brain.dev](https://console.brain.dev) for sandbox or [console.brain.fi](https://console.brain.fi) for production.

<table><thead><tr><th width="100">Step</th><th>Action</th></tr></thead><tbody><tr><td>1</td><td>Click <strong>Sign up</strong></td></tr><tr><td>2</td><td>Enter your email and a strong password (or use SSO via Google or Microsoft)</td></tr><tr><td>3</td><td>Verify your email address</td></tr><tr><td>4</td><td>Complete the onboarding flow</td></tr></tbody></table>

{% hint style="info" %}
Use the **sandbox** Console for everything in Getting Started. It runs against Base Sepolia and accepts test credentials. You can deploy the same code against production once you're ready.
{% endhint %}

### Create Your First Tenant

A **tenant** is the unit of isolation in Brain. Each tenant has its own Ledger, Wiki, policies, agents, audit chain, and KMS-managed encryption keys.

<table><thead><tr><th width="150">Field</th><th>Description</th></tr></thead><tbody><tr><td><strong>Tenant ID</strong></td><td>A short slug (lowercase, hyphens). This is what you'll pass as <code>tenantId</code> in API calls.</td></tr><tr><td><strong>Display Name</strong></td><td>A human-readable label shown in the Console.</td></tr><tr><td><strong>Region</strong></td><td>Where data is stored. Options vary by environment.</td></tr><tr><td><strong>Time Zone</strong></td><td>Default for date filters and rolling summaries.</td></tr></tbody></table>

```
Example:
  tenantId:     acme
  displayName:  Acme Corporation
  region:       us-east-1
  timeZone:     America/Los_Angeles
```

{% hint style="warning" %}
A tenant ID is permanent. Pick something stable: your CRM customer ID, your company slug, or a generated UUID if you're building multi-tenant infrastructure.
{% endhint %}

### Invite Teammates

The Console supports role-based access for human team members.

<table><thead><tr><th width="150">Role</th><th>Can Do</th></tr></thead><tbody><tr><td><strong>Owner</strong></td><td>Full access; manages billing and tenant deletion</td></tr><tr><td><strong>Admin</strong></td><td>Manage sources, policies, agents, keys</td></tr><tr><td><strong>Approver</strong></td><td>Approve escalated actions; cannot create policy</td></tr><tr><td><strong>Developer</strong></td><td>Generate API keys; read all data</td></tr><tr><td><strong>Viewer</strong></td><td>Read-only access to dashboards</td></tr></tbody></table>

To invite:

<table><thead><tr><th width="100">Step</th><th>Action</th></tr></thead><tbody><tr><td>1</td><td>Open <strong>Settings → Team</strong></td></tr><tr><td>2</td><td>Click <strong>Invite Member</strong></td></tr><tr><td>3</td><td>Enter the email address and pick a role</td></tr><tr><td>4</td><td>The teammate receives an email with a signup link</td></tr></tbody></table>

### Single Sign-On

For organizations with SSO, Brain supports SAML and OIDC via Auth0.

<table><thead><tr><th width="250">SSO Type</th><th>Setup</th></tr></thead><tbody><tr><td><strong>Google Workspace</strong></td><td>One-click integration in Settings → SSO</td></tr><tr><td><strong>Microsoft Entra ID</strong></td><td>Connect via Azure AD app registration</td></tr><tr><td><strong>Okta</strong></td><td>SAML setup with metadata exchange</td></tr><tr><td><strong>Custom OIDC</strong></td><td>Provide issuer, client ID, and client secret</td></tr></tbody></table>

{% hint style="info" %}
SSO is available on all paid plans. If your team uses SSO, set it up before inviting members so they sign up through the SSO flow rather than email/password.
{% endhint %}

### Environments

Brain has two environments. The Console you use, the API base URL, and the keys are environment-specific.

| Environment    | Console             | API Base URL    | Network      |
| -------------- | ------------------- | --------------- | ------------ |
| **Sandbox**    | `console.brain.dev` | `api.brain.dev` | Base Sepolia |
| **Production** | `console.brain.fi`  | `api.brain.fi`  | Base mainnet |

You'll typically have separate tenants in sandbox and production. Use sandbox for development and CI; switch to production once you've validated end-to-end flows.
