import { createHmac, timingSafeEqual } from "node:crypto";
import type { ApprovalService } from "../core/approval.js";
import {
  toIncomingDecision,
  type SlackInteractionPayload,
} from "../surfaces/slack/interactions.js";

const SLACK_VERSION = "v0";
const MAX_AGE_MS = 5 * 60 * 1000;

export interface SlackVerificationInput {
  rawBody: string | Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  signingSecret: string;
  nowMs?: number | undefined;
}

export type SlackVerificationResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "stale" | "bad_signature" };

export function verifySlackRequest(input: SlackVerificationInput): SlackVerificationResult {
  if (!input.timestamp || !input.signature) return { ok: false, reason: "missing_header" };

  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: "missing_header" };

  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampSeconds * 1000) > MAX_AGE_MS) {
    return { ok: false, reason: "stale" };
  }

  const body = Buffer.isBuffer(input.rawBody) ? input.rawBody.toString("utf8") : input.rawBody;
  const base = `${SLACK_VERSION}:${input.timestamp}:${body}`;
  const expected = `${SLACK_VERSION}=${createHmac("sha256", input.signingSecret)
    .update(base)
    .digest("hex")}`;

  if (!safeEqual(input.signature, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

export interface SlackInteractionRequest {
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  signingSecret: string;
  approvals: ApprovalService;
  nowMs?: number | undefined;
}

export interface SlackInteractionResponse {
  status: number;
  body: string;
}

export async function handleSlackInteraction(
  request: SlackInteractionRequest,
): Promise<SlackInteractionResponse> {
  const signature = header(request.headers, "x-slack-signature");
  const timestamp = header(request.headers, "x-slack-request-timestamp");
  const verified = verifySlackRequest({
    rawBody: request.rawBody,
    signature,
    timestamp,
    signingSecret: request.signingSecret,
    nowMs: request.nowMs,
  });
  if (!verified.ok) return { status: 401, body: "invalid slack signature" };

  const payload = parseSlackPayload(request.rawBody);
  if (!payload) return { status: 400, body: "invalid slack payload" };

  const normalized = toIncomingDecision(payload);
  if (!normalized) return { status: 400, body: "unknown slack action" };

  void request.approvals.handle(normalized.decision, normalized.deliveredRef);
  return { status: 200, body: "" };
}

function parseSlackPayload(rawBody: string | Buffer): SlackInteractionPayload | null {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const params = new URLSearchParams(body);
  const encoded = params.get("payload");
  if (!encoded) return null;
  try {
    return JSON.parse(encoded) as SlackInteractionPayload;
  } catch {
    return null;
  }
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
