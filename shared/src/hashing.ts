/**
 * Streaming sha256 hasher.
 *
 * Raw ingestion (§3 Layer 1) content-addresses by sha256. For multipart
 * uploads we want to hash while streaming — never buffer a 50 MB artifact
 * in memory just to compute a hash.
 *
 * Use `hashStream(input)` for a one-shot sha256 of a readable stream. The
 * stream is *consumed*; callers that also need the bytes should tee first.
 *
 * For a hash-while-write pattern, call `teeSha256(input)` which returns
 * `{ bytesOut, sha256 }` — a pass-through stream + a promise resolving to
 * the hex digest once the input closes.
 */

import { createHash } from "node:crypto";
import { PassThrough, Transform, type Readable } from "node:stream";

export async function hashStream(input: Readable): Promise<{ sha256: string; bytes: number }> {
  const hasher = createHash("sha256");
  let bytes = 0;
  for await (const chunk of input) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string);
    bytes += buf.length;
    hasher.update(buf);
  }
  return { sha256: hasher.digest("hex"), bytes };
}

/**
 * Pass-through stream that computes sha256 as bytes flow.
 * Returns the output stream (to be piped to storage) and a promise
 * that resolves to { sha256, bytes } after the input ends.
 */
export function teeSha256(input: Readable): {
  bytesOut: PassThrough;
  done: Promise<{ sha256: string; bytes: number }>;
} {
  const hasher = createHash("sha256");
  let bytes = 0;
  const bytesOut = new PassThrough();

  const transform = new Transform({
    transform(chunk, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string);
      bytes += buf.length;
      hasher.update(buf);
      cb(null, buf);
    },
  });

  const done = new Promise<{ sha256: string; bytes: number }>((resolve, reject) => {
    bytesOut.on("finish", () => resolve({ sha256: hasher.digest("hex"), bytes }));
    bytesOut.on("error", reject);
    transform.on("error", reject);
    input.on("error", reject);
  });

  input.pipe(transform).pipe(bytesOut);
  return { bytesOut, done };
}
