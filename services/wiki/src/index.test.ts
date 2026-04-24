import { describe, expect, it } from "vitest";
import { SERVICE_NAME } from "./index.js";

describe("brain-wiki scaffold", () => {
  it("exports the service name", () => {
    expect(SERVICE_NAME).toBe("brain-wiki");
  });
});
