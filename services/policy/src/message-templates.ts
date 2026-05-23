/**
 * Approved-message rendering for counterparty-facing agents (Agent Autonomy v3,
 * 2.7). The LLM never writes counterparty-visible prose freely — every outbound
 * message is rendered from a tenant-approved MessageTemplate in the signed policy
 * document, substituting ONLY the template's allowed variables.
 */

import type { MessageTemplate, PolicyDocument } from "./dsl.js";

/** Find an approved message template by id in a policy document. */
export function findMessageTemplate(
  doc: PolicyDocument,
  templateId: string,
): MessageTemplate | undefined {
  return doc.message_templates?.find((t) => t.id === templateId);
}

export interface RenderedMessage {
  readonly subject: string;
  readonly body: string;
}

/**
 * Render an approved template, substituting only allowed variables. Throws if a
 * caller supplies a variable outside the approved set, or if the template body
 * references a variable that isn't approved (a malformed/unsafe template) — this
 * is the handler-boundary block on free-form counterparty text.
 */
export function renderApprovedMessage(
  template: MessageTemplate,
  vars: Readonly<Record<string, string | number>>,
): RenderedMessage {
  const allowed = new Set(template.allowed_variables);
  for (const key of Object.keys(vars)) {
    if (!allowed.has(key)) {
      throw new Error(`message variable "${key}" is not in the approved allowed-variable set`);
    }
  }
  const substitute = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      if (!allowed.has(name)) {
        throw new Error(`template references disallowed variable "${name}"`);
      }
      const value = vars[name];
      return value === undefined ? `{{${name}}}` : String(value);
    });
  return { subject: substitute(template.subject), body: substitute(template.body) };
}
