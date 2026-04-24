/**
 * BullMQ queue + worker factory.
 *
 * Centralizes connection options and the Brain default job settings so
 * individual services don't drift. Call createQueue() / createWorker() from
 * the service's boot code.
 */

import { Queue, Worker, type ConnectionOptions, type WorkerOptions } from "bullmq";
import { DEFAULT_JOB_OPTS, type BrainJobEnvelope, type QueueName } from "./types.js";

export interface QueueFactoryOptions {
  redisUrl: string;
}

/** Parse a redis:// URL into BullMQ's ConnectionOptions shape. */
export function redisConnectionFromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const port = parsed.port === "" ? 6379 : Number.parseInt(parsed.port, 10);
  return {
    host: parsed.hostname,
    port,
    ...(parsed.password !== "" ? { password: parsed.password } : {}),
    ...(parsed.username !== "" ? { username: parsed.username } : {}),
    maxRetriesPerRequest: null, // required by BullMQ v5
  };
}

export function createQueue<T>(name: QueueName, opts: QueueFactoryOptions): Queue<BrainJobEnvelope<T>> {
  return new Queue<BrainJobEnvelope<T>>(name, {
    connection: redisConnectionFromUrl(opts.redisUrl),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
}

export function createWorker<T, R = unknown>(
  name: QueueName,
  processor: (job: import("bullmq").Job<BrainJobEnvelope<T>>) => Promise<R>,
  opts: QueueFactoryOptions & { concurrency?: number },
): Worker<BrainJobEnvelope<T>, R> {
  const workerOpts: WorkerOptions = {
    connection: redisConnectionFromUrl(opts.redisUrl),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  };
  return new Worker<BrainJobEnvelope<T>, R>(name, processor, workerOpts);
}
