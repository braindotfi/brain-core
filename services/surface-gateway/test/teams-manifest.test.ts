import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const teamsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../teams");

describe("Teams app package manifest", () => {
  it("contains the expected multi-tenant bot package fields", () => {
    const manifest = JSON.parse(readFileSync(resolve(teamsDir, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const bots = manifest["bots"] as Array<Record<string, unknown>>;
    const icons = manifest["icons"] as Record<string, unknown>;

    expect(manifest["$schema"]).toBe(
      "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    );
    expect(manifest["manifestVersion"]).toBe("1.17");
    expect(manifest["id"]).toBe("${TEAMS_APP_ID}");
    expect(bots[0]?.["botId"]).toBe("${TEAMS_APP_ID}");
    expect(bots[0]?.["scopes"]).toEqual(["personal", "team", "groupchat"]);
    expect(manifest["validDomains"]).toContain("surface.brain.fi");
    expect(icons["color"]).toBe("color.png");
    expect(icons["outline"]).toBe("outline.png");
  });

  it("includes non-empty package icons", () => {
    expect(statSync(resolve(teamsDir, "color.png")).size).toBeGreaterThan(0);
    expect(statSync(resolve(teamsDir, "outline.png")).size).toBeGreaterThan(0);
  });
});
