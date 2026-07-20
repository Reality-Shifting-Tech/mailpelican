import {
  fetchDueOutbox,
  markOutboxAttemptFailed,
  markOutboxDispatched,
  type Database,
  type OutboxRow,
} from "@dispatch/db";

export interface EnqueueFn {
  (topic: string, payload: Record<string, unknown>, jobId: string): Promise<void>;
}

export interface OutboxDispatcherOptions {
  db: Database;
  enqueue: EnqueueFn;
  batchSize?: number;
  pollMs?: number;
  maxAttempts?: number;
  onError?: (error: unknown) => void;
}

/**
 * Drain one batch of due outbox rows. Exported separately from the polling
 * loop so tests can drive it deterministically (crash-between-commit-and-
 * enqueue recovery is one tick on the next row).
 */
export async function drainOutboxOnce(options: OutboxDispatcherOptions): Promise<number> {
  const rows = await fetchDueOutbox(options.db, options.batchSize ?? 50);
  for (const row of rows) {
    await dispatchRow(options, row);
  }
  return rows.length;
}

async function dispatchRow(options: OutboxDispatcherOptions, row: OutboxRow): Promise<void> {
  try {
    await options.enqueue(row.topic, row.payload, row.id);
    await markOutboxDispatched(options.db, row.id);
  } catch (error) {
    await markOutboxAttemptFailed(
      options.db,
      row,
      error instanceof Error ? error.message : "enqueue failed",
      options.maxAttempts ?? 10,
    );
    options.onError?.(error);
  }
}

export interface OutboxDispatcher {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Poll the outbox and enqueue committed side effects (architecture §4).
 * Rows are created in the same transaction as the state change, so a crash
 * between commit and enqueue is recovered by the next poll.
 */
export function createOutboxDispatcher(options: OutboxDispatcherOptions): OutboxDispatcher {
  const pollMs = options.pollMs ?? 1000;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await drainOutboxOnce(options);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer === null) {
        timer = setInterval(() => void tick(), pollMs);
        timer.unref();
      }
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
