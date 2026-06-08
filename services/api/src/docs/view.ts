/**
 * Renders the interactive API reference page (GET /v1/docs).
 *
 * The page is deliberately tiny and contains NO inline executable script: the
 * Scalar standalone bundle auto-initialises from the `<script id="api-reference"
 * data-url=...>` element (an empty, data-only tag, which CSP does not block) and
 * is itself loaded same-origin, so the gateway's strict `script-src 'self'` is
 * satisfied without any nonce or 'unsafe-inline'. Runtime style injection by the
 * bundle is handled by a route-scoped style-src relaxation in routes.ts.
 *
 * `renderDocsHtml` is a pure function so it is unit-testable without a server,
 * mirroring `proof/view.ts`.
 */

/** Escape a string for safe interpolation into HTML attributes / text. */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface RenderDocsOptions {
  /** Mount prefix the routes live under. Default "/v1". */
  basePath?: string;
  /** Page <title>. Default "Brain API Reference". */
  title?: string;
}

/** Render the Scalar API reference host page. Pure — no I/O. */
export function renderDocsHtml(opts: RenderDocsOptions = {}): string {
  const basePath = opts.basePath ?? "/v1";
  const specUrl = `${basePath}/openapi.yaml`;
  const bundleUrl = `${basePath}/docs/scalar.js`;
  const title = opts.title ?? "Brain API Reference";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
</head>
<body>
<script id="api-reference" data-url="${esc(specUrl)}"></script>
<script src="${esc(bundleUrl)}"></script>
</body>
</html>`;
}
