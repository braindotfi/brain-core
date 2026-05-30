# Audit Area: SDK

**Scope:** The `@brain/sdk` typed HTTP client at `clients/sdk/`. Codegen drift, exported surface, real consumers, dead exports, test reality.

**Reports planned:**

- `clients-sdk.md`. OpenAPI codegen fidelity vs `Brain_API_Specification.yaml`, exported resource classes, real consumers (who imports `@brain/sdk`?), test coverage, npm publication status (currently `0.1.0-rc.0`, not published).

**Out of scope here:** The API spec itself (cross-reference with `services/api.md`), MCP client surface (see `mcp/`).

**Relevant files:** `clients/sdk/src/`, `clients/sdk/package.json`, `Brain_API_Specification.yaml`.
