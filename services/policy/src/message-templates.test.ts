import { describe, expect, it } from "vitest";
import { findMessageTemplate, renderApprovedMessage } from "./message-templates.js";
import type { MessageTemplate, PolicyDocument } from "./dsl.js";

const TEMPLATE: MessageTemplate = {
  id: "reminder",
  subject: "Invoice {{invoice}} is due",
  body: "Hi {{name}}, invoice {{invoice}} for {{amount}} is due.",
  allowed_variables: ["invoice", "name", "amount"],
};

function doc(templates: MessageTemplate[]): PolicyDocument {
  return { version: 1, rules: [], message_templates: templates } as unknown as PolicyDocument;
}

describe("findMessageTemplate", () => {
  it("returns the template with the matching id", () => {
    expect(findMessageTemplate(doc([TEMPLATE]), "reminder")).toBe(TEMPLATE);
  });

  it("returns undefined for an unknown id", () => {
    expect(findMessageTemplate(doc([TEMPLATE]), "nope")).toBeUndefined();
  });

  it("returns undefined when the document has no message_templates", () => {
    expect(
      findMessageTemplate({ version: 1, rules: [] } as PolicyDocument, "reminder"),
    ).toBeUndefined();
  });
});

describe("renderApprovedMessage", () => {
  it("substitutes the approved variables into subject and body", () => {
    const rendered = renderApprovedMessage(TEMPLATE, {
      invoice: "INV-1",
      name: "Acme",
      amount: 120.5,
    });
    expect(rendered.subject).toBe("Invoice INV-1 is due");
    expect(rendered.body).toBe("Hi Acme, invoice INV-1 for 120.5 is due.");
  });

  it("throws when a caller supplies a variable outside the approved set", () => {
    expect(() => renderApprovedMessage(TEMPLATE, { invoice: "INV-1", evil: "x" })).toThrow(
      /not in the approved allowed-variable set/,
    );
  });

  it("throws when the template body references a disallowed variable", () => {
    const unsafe: MessageTemplate = {
      id: "bad",
      subject: "ok",
      body: "leaks {{secret}}",
      allowed_variables: [],
    };
    expect(() => renderApprovedMessage(unsafe, {})).toThrow(/disallowed variable "secret"/);
  });

  it("leaves the placeholder intact when an allowed variable has no value", () => {
    // `amount` is allowed but not supplied → the {{amount}} placeholder stays.
    const rendered = renderApprovedMessage(TEMPLATE, { invoice: "INV-1", name: "Acme" });
    expect(rendered.body).toBe("Hi Acme, invoice INV-1 for {{amount}} is due.");
  });
});
