// Audit mode's recorder (config `server.audit`). It keeps what the run log cannot hold: the
// prompts as sent, and the document at each stage. The run log names each of them, so the log
// stays the one account of a run and these files are what its lines point at.
//
// Prompts are stored once per distinct text, by sha256: a run sends the same agent contract on
// every page, and one copy per call would make a 6-page run's prompts megabytes. Images are not
// stored again: the page images are already in input/, and a call's image is named by its sha256
// so it can be matched to one.
//
// Form values never reach here: they are sent only to POST /pdf, which makes no model call.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Image, Message } from "../providers/types.ts";
import type { RunLog } from "./runlog.ts";

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export class AuditRecorder {
  private dir: string;
  private log: RunLog;
  // This run's number: one more than the runs already recorded, so a feedback re-run keeps the
  // first run's snapshots.
  readonly run: number;

  constructor(dir: string, log: RunLog) {
    this.dir = dir;
    this.log = log;
    mkdirSync(join(dir, "prompts"), { recursive: true });
    mkdirSync(join(dir, "runs"), { recursive: true });
    this.run = readdirSync(join(dir, "runs")).filter((n) => /^\d+$/.test(n)).length + 1;
  }

  // What `model_call_start` carries about the prompt: each message by role, hash and length, and
  // each image by hash and size.
  prompt(messages: Message[], images: Image[] = []): Record<string, unknown> {
    return {
      prompt: {
        messages: messages.map((m) => {
          const hash = sha256(m.content);
          const file = join(this.dir, "prompts", `${hash}.txt`);
          if (!existsSync(file)) writeFileSync(file, m.content);
          return { role: m.role, sha256: hash, chars: m.content.length };
        }),
        images: images.map((i) => ({ media_type: i.media_type, bytes: i.data.length, sha256: sha256(i.data) })),
      },
    };
  }

  // The document at one stage of this run, logged as `audit_snapshot`. Best-effort: an audit file
  // that cannot be written must not fail the run it describes.
  snapshot(name: string, html: string): void {
    try {
      const dir = join(this.dir, "runs", String(this.run));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.html`), html);
      this.log.event("audit_snapshot", { run: this.run, name, chars: html.length });
    } catch {
      // ignore — observability must not block the run
    }
  }
}
