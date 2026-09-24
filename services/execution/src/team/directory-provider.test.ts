import { describe, expect, it } from "vitest";
import { NoneDirectoryProvider, TodoDirectoryProvider } from "./directory-provider.js";

describe("DirectoryProvider", () => {
  it("none adapter is a no-op", async () => {
    const provider = new NoneDirectoryProvider();

    await expect(provider.listUsers()).resolves.toEqual([]);
    expect(provider.kind).toBe("none");
  });

  it("future adapters are inert stubs until configured", async () => {
    const provider = new TodoDirectoryProvider("okta");

    await expect(provider.listUsers()).resolves.toEqual([]);
    expect(provider.kind).toBe("okta");
  });
});
