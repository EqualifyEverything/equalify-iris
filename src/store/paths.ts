import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { IrisConfig } from "../config.ts";

// Resolves the on-disk layout described in PRD §8.1.
export class Paths {
  private cfg: IrisConfig;
  constructor(cfg: IrisConfig) {
    this.cfg = cfg;
  }

  get agentsDir(): string {
    return this.cfg.storage.agents_dir;
  }

  sessionDir(id: string): string {
    return join(this.cfg.storage.data_dir, "sessions", id);
  }
  sessionInput(id: string): string {
    return join(this.sessionDir(id), "input");
  }
  sessionNotes(id: string): string {
    return join(this.sessionDir(id), "notes");
  }
  sessionFragments(id: string): string {
    return join(this.sessionDir(id), "fragments");
  }
  sessionOutput(id: string): string {
    return join(this.sessionDir(id), "output.html");
  }
  // Base name of the primary uploaded file, for the output title/filename.
  sessionSourceName(id: string): string {
    return join(this.sessionDir(id), "source-name.txt");
  }
  sessionLog(id: string): string {
    return join(this.sessionDir(id), "log.jsonl");
  }
  sessionNewAgents(id: string): string {
    return join(this.sessionDir(id), "new-agents.md");
  }
  sessionAgentUpdates(id: string): string {
    return join(this.sessionDir(id), "agent-updates.md");
  }
  sessionPrs(id: string): string {
    return join(this.sessionDir(id), "prs.md");
  }
  sessionUnresolved(id: string): string {
    return join(this.sessionDir(id), "unresolved.md");
  }
  // Final axe-core result, summarized into the PR description on close (§7.13).
  sessionLint(id: string): string {
    return join(this.sessionDir(id), "lint.json");
  }
  // Snapshots of prior outputs before feedback re-runs overwrite them (§7.12).
  sessionHistory(id: string): string {
    return join(this.sessionDir(id), "history");
  }

  tmpDir(id: string): string {
    return join(this.cfg.storage.data_dir, "tmp", id);
  }
  tmpAgentsDir(id: string): string {
    return join(this.tmpDir(id), "agents");
  }

  // Create the persisted session skeleton and the ephemeral tmp area (§8.2).
  initSession(id: string): void {
    for (const d of [
      this.sessionInput(id),
      this.sessionNotes(id),
      this.sessionFragments(id),
      this.tmpAgentsDir(id),
    ]) {
      mkdirSync(d, { recursive: true });
    }
  }
}
