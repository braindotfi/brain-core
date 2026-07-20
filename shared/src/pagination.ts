import { brainError } from "./errors.js";

export interface KeysetCursor {
  sort: string;
  id: string;
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeKeysetCursor(raw: string): KeysetCursor {
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("cursor must be an object");
    }
    const sort = (decoded as Record<string, unknown>)["sort"];
    const id = (decoded as Record<string, unknown>)["id"];
    if (
      typeof sort !== "string" ||
      sort.length === 0 ||
      typeof id !== "string" ||
      id.length === 0
    ) {
      throw new Error("cursor fields are invalid");
    }
    return { sort, id };
  } catch {
    throw brainError("invalid_cursor", "cursor is invalid");
  }
}
