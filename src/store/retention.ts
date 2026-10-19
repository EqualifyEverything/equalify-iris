import { rmSync } from "node:fs";
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
 * expired, so its routes answer 410 instead of failing on missing files. Returns how many
 * were expired.
 */
export function pruneSessions(store: Store, paths: Paths, days: number, now = Date.now()): number {
  const ids = store.expireSessions(new Date(now - days * DAY_MS).toISOString(), new Date(now).toISOString());
  for (const id of ids) {
    try {
      rmSync(paths.sessionDir(id), { recursive: true, force: true });
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
  const run = (): void => {
    const n = pruneSessions(store, paths, days);
    if (n > 0) console.log(`Deleted the files of ${n} session(s) older than ${days} day(s).`);
  };
  run();
  setInterval(run, DAY_MS).unref();
}
