import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stagingManifest = readFileSync(new URL("../slack/manifest.yaml", import.meta.url), "utf8");
const productionManifest = readFileSync(
  new URL("../slack/manifest.production.yaml", import.meta.url),
  "utf8",
);

describe("Slack app manifests", () => {
  it("keeps every staging callback on staging-api.brain.fi", () => {
    expect(stagingManifest).toContain("https://staging-api.brain.fi/surfaces/slack/oauth/callback");
    expect(stagingManifest).toContain("https://staging-api.brain.fi/surfaces/slack/interactions");
    expect(stagingManifest).toContain("https://staging-api.brain.fi/surfaces/slack/events");
    expect(stagingManifest).not.toContain("surface.brain.fi");
  });

  it("keeps production callbacks isolated from staging", () => {
    expect(productionManifest).toContain("https://surface.brain.fi/surfaces/slack/oauth/callback");
    expect(productionManifest).not.toContain("staging-api.brain.fi");
  });

  it.each([stagingManifest, productionManifest])(
    "requests only the implemented bot scopes and event",
    (manifest) => {
      expect(manifest).toContain("- chat:write\n");
      expect(manifest).toContain("- chat:write.public\n");
      expect(manifest).toContain("- app_uninstalled\n");
      expect(manifest).not.toMatch(/history|app_mentions:read|users:read/);
    },
  );
});
