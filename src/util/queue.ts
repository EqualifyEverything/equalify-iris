// A bounded, FIFO queue for pipeline runs.
//
// Runs used to start with a bare `void runPipeline(...)` straight out of the
// request handler, so N simultaneous uploads meant N unthrottled pipelines: N
// jsdom+axe instances, and N × extraction_concurrency model calls in flight.
// Nothing in the process bounded that. On a single-machine deployment — a
// laptop, a Mac Mini, a self-hosted box, all first-class targets (README, "One
// machine, no vendor lock-in") —
// the failure mode is the whole service degrading for everyone at once instead
// of one run taking longer.
//
// Two design choices are worth stating, because both take the expensive-but-safe
// direction the rest of the pipeline takes:
//
//   * Over the cap a session WAITS; it is not rejected. The upload has already
//     been received and written to disk, so a 429 would discard work the user
//     has already paid for (potentially a 25-page PDF) to save a few seconds of
//     queueing. Waiting sessions sit in the `queued` status the store has always
//     had — a value that, until now, no client could observe for more than an
//     instant.
//   * The cap is GLOBAL, not per user. The resources it protects — memory, jsdom
//     instances, the provider's rate limit — are global, so a per-user cap would
//     let ten users each start a run and still exhaust the machine. The cost is
//     fairness: order is strictly FIFO, so a burst from one user delays others.
//     For a single-instance deployment whose operator knows its users that is
//     the right trade; per-user fairness needs a real scheduler, not a counter.
//
// Note what this canNOT bound: multer has already buffered the entire upload in
// memory by the time a handler runs (it parses the body before the route sees
// it), so no gate here reduces that. The upload-side ceiling is set by multer's
// own `limits` in routes/sessions.ts.

export interface QueueStats {
  /** Runs executing right now. Never more than `limit`. */
  running: number;
  /** Runs admitted but not yet started. */
  waiting: number;
  /** The configured cap (`defaults.max_concurrent_runs`). */
  limit: number;
}

interface Job {
  task: () => Promise<unknown>;
  onStart?: () => void;
  settle: () => void;
}

export class RunQueue {
  readonly limit: number;
  private active = 0;
  private pending: Job[] = [];
  private onError: (error: unknown) => void;

  constructor(limit: number, onError?: (error: unknown) => void) {
    // The caller normalizes (config.normalizeMaxConcurrentRuns), but a queue
    // whose limit is 0 would silently accept work and never run it — the worst
    // possible failure here — so refuse to construct one.
    this.limit = Math.max(1, Math.floor(limit) || 1);
    // A task that rejects is a bug: runPipeline handles its own failures and
    // records them on the session. Log it rather than swallowing it, but never
    // let it propagate — see submit().
    this.onError = onError ?? ((e) => console.error("run queue task threw:", e));
  }

  /**
   * Admit a run. Returns immediately: the returned promise settles when the task
   * finishes and **always resolves**, including when the task throws. That
   * matters because every call site is `void queue.submit(...)`, and `void` does
   * not attach a rejection handler — a rejecting promise there would surface as
   * an unhandled rejection and take the process down with it.
   *
   * `onStart` fires when the job actually leaves the queue, which is where the
   * caller records how long it waited.
   */
  submit(task: () => Promise<unknown>, onStart?: () => void): Promise<void> {
    return new Promise<void>((settle) => {
      this.pending.push({ task, onStart, settle });
      this.pump();
    });
  }

  stats(): QueueStats {
    return { running: this.active, waiting: this.pending.length, limit: this.limit };
  }

  private pump(): void {
    // A loop rather than a single `if`. Today it never iterates twice — submit()
    // pumps once per push and the finally below frees exactly one slot — so this
    // is defensive, not load-bearing, and no test can tell the two apart. It is
    // written this way so pump() stays correct as "drain whatever slots are free"
    // rather than "start at most one job", which is what a later caller (a
    // resizable limit, a batch admit) would need and would otherwise silently not
    // get.
    while (this.active < this.limit && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.active++;
      try {
        job.onStart?.();
      } catch (e) {
        // Observability must never cost a slot or drop a run.
        this.onError(e);
      }
      // Invoked directly rather than through Promise.resolve().then(...) so the
      // task's SYNCHRONOUS prefix runs before submit() returns. runPipeline
      // writes `status: "running"` there, and deferring it by even a microtask
      // would leave a window where the response says a run started and the store
      // still says `queued`. A synchronous throw is converted to a rejection so
      // both failure modes take the same path.
      let settled: Promise<unknown>;
      try {
        settled = Promise.resolve(job.task());
      } catch (e) {
        settled = Promise.reject(e);
      }
      // Deliberately not awaited. The .finally() is the only place `active` is
      // decremented, so a throwing task cannot leak a slot and wedge the queue
      // at capacity forever — which would leave every later session stuck in
      // `queued` with no error anywhere to explain it.
      void settled
        .catch((e) => this.onError(e))
        .finally(() => {
          this.active--;
          job.settle();
          this.pump();
        });
    }
  }
}
