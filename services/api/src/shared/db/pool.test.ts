import { describe, expect, it } from "vitest";
import { isLocalHost } from "./pool.js";

describe("isLocalHost", () => {
  it("treats localhost and loopback as local", () => {
    expect(isLocalHost("postgres://u:p@localhost:5432/db")).toBe(true);
    expect(isLocalHost("postgres://u:p@127.0.0.1:5432/db")).toBe(true);
    expect(isLocalHost("postgres://u:p@[::1]:5432/db")).toBe(true);
  });

  it("treats hosted databases as remote", () => {
    expect(
      isLocalHost("postgres://u:p@brain-postgres.postgres.database.azure.com:5432/db"),
    ).toBe(false);
    expect(isLocalHost("postgres://u:p@10.0.0.5:5432/db")).toBe(false);
  });

  it("returns false for malformed connection strings", () => {
    expect(isLocalHost("not a url")).toBe(false);
  });
});
