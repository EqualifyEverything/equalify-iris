import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { IrisConfig } from "../config.ts";

// Resolves the on-disk layout (see README, "Layout").
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
  sessionFragments(id: string): string {
    return join(this.sessionDir(id), "fragments");
  }
  // The final reviewed fragments (+ no-content signals) that produced output.html.
  // Persisted so a feedback re-run can refine the existing document iteratively
  // instead of regenerating it from the source images.
  sessionFinalFragments(id: string): string {
    return join(this.sessionFragments(id), "final.json");
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
  // The link annotations found in the uploaded PDFs, keyed by the page's 1-based
  // processing order: `{ "3": [{ text, href }] }`. A rasterized page cannot carry
  // them (see pipeline/links.ts), and the pipeline runs later — off a queue, in a
  // separate step that only reads this directory — so what the upload extracted has
  // to be persisted here or it is gone by extraction time.
  //
  // A file of its own, rather than a sidecar per image inside input/, because
  // `enumerateInputs` treats every `<order>__<name>` file in there as a page image;
  // a sidecar named to sit beside its image would be enumerated as one. Written only
  // when a document actually has links, so its absence and `{}` mean the same thing.
  sessionLinks(id: string): string {
    return join(this.sessionDir(id), "links.json");
  }
  // `sessionNewAgents()` and `sessionPrs()` used to sit here with zero callers,
  // left over from an earlier fork-and-PR design. That flow has been dropped
  // (contributions are issues filed under the user's identity), so they are gone
  // rather than waiting for it.
  sessionAgentUpdates(id: string): string {
    return join(this.sessionDir(id), "agent-updates.md");
  }
  sessionUnresolved(id: string): string {
    return join(this.sessionDir(id), "unresolved.md");
  }
  // Final axe-core result, summarized into the PR description on close.
  sessionLint(id: string): string {
    return join(this.sessionDir(id), "lint.json");
  }
  // Snapshots of prior outputs before feedback re-runs overwrite them.
  sessionHistory(id: string): string {
    return join(this.sessionDir(id), "history");
  }

  // Per-agent regression fixtures (triggering image + accepted output), captured
  // on accept and re-checked before any agent update/merge so an agent cannot be
  // changed in a way that breaks a use it already handled. Lives under data_dir
  // (per-instance, not committed — the agent library stays code-only).
  fixturesDir(): string {
    return join(this.cfg.storage.data_dir, "fixtures");
  }
  agentFixtures(agentName: string): string {
    return join(this.fixturesDir(), agentName.replace(/\.md$/, ""));
  }

  // Per-agent "memory": the example bank of generalized corrections learned from
  // user feedback, injected into the agent's prompt at run time instead of
  // rewriting the agent file. Lives under data_dir (per-instance, not committed).
  memoryDir(): string {
    return join(this.cfg.storage.data_dir, "memory");
  }
  agentMemory(agentName: string): string {
    return join(this.memoryDir(), `${agentName.replace(/\.md$/, "")}.json`);
  }

  tmpDir(id: string): string {
    return join(this.cfg.storage.data_dir, "tmp", id);
  }
  tmpAgentsDir(id: string): string {
    return join(this.tmpDir(id), "agents");
  }

  // Create the persisted session skeleton and the ephemeral tmp area.
  //
  // `notes/` is no longer created, and `sessionNotes()` is gone with it: the
  // Triage phase that would write `notes/<image>.md` is not
  // implemented, so every session got an empty directory that nothing ever read
  // or wrote. Restore both together if Triage is ever built — an empty
  // directory reads as "this ran and found nothing", which is the opposite of
  // what was true.
  initSession(id: string): void {
    for (const d of [
      this.sessionInput(id),
      this.sessionFragments(id),
      this.tmpAgentsDir(id),
    ]) {
      mkdirSync(d, { recursive: true });
    }
  }
}
