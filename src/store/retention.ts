import { rm } from "node:fs/promises";
import type { IrisConfig } from "../config.ts";
import type { Store } from "./db.ts";
import type { Paths } from "./paths.ts";

const DAY_MS = 86_400_000;

// `storage.session_retention_days`, or null when it is off (blank, 0, or not a number).
export function retentionDays(cfg: IrisConfig): number | null {
  const d = Number(cfg.storage.session_retention_days);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * Delete the folders of finished sessions not updated in `days` days. Each row stays, marked
 * expired, so its routes answer 410 instead of failing on missing files. The deletes are async,
 * so a first sweep over thousands of folders doesn't block requests. Returns how many were expired.
 */
export async function pruneSessions(store: Store, paths: Paths, days: number, now = Date.now()): Promise<number> {
  const ids = store.expireSessions(new Date(now - days * DAY_MS).toISOString(), new Date(now).toISOString());
  for (const id of ids) {
    try {
      await rm(paths.sessionDir(id), { recursive: true, force: true });
      // Only /close removes tmp/<id>, and an expired session can't be closed.
      await rm(paths.tmpDir(id), { recursive: true, force: true });
    } catch (e) {
      console.warn(`retention: could not delete ${id}: ${(e as Error).message}`);
    }
  }
  return ids.length;
}

// Prune now, then once a day. Does nothing when retention is off.
export function scheduleRetention(cfg: IrisConfig, store: Store, paths: Paths): void {
  const days = retentionDays(cfg);
  if (days === null) return;
  // A failed sweep logs and waits for the next one; it must not crash the server.
  const run = (): void => {
    pruneSessions(store, paths, days)
      .then((n) => {
        if (n > 0) console.log(`Deleted the files of ${n} session(s) older than ${days} day(s).`);
      })
      .catch((e) => console.warn(`retention: sweep failed: ${(e as Error).message}`));
  };
  run();
  setInterval(run, DAY_MS).unref();
}
