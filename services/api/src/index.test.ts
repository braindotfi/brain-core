import { describe, expect, it } from "vitest";
import { SERVICE_NAME } from "./index.js";

describe("brain-api scaffold", () => {
  it("exports the service name", () => {
    expect(SERVICE_NAME).toBe("brain-api");
  });
});
