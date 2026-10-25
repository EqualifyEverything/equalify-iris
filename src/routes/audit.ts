// GET /v1/sessions/{id}/audit and the files it lists. Audit mode only (config `server.audit`);
// with it off, every route here answers 404 `audit_off`.
//
// Everything is read-only and readable while the run is still working, which is what the
// /how-it-works page needs to show a run as it happens. A file is served only from a fixed list,
// and a hash or a run number only in its exact shape, so no request names a path.
//
// Saved HTML is served as text/plain: it is model output, and the API's own origin must not run it.
import { Router } from "express";
import type { Response } from "express";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { auditOn, type IrisConfig } from "../config.ts";
import type { Store } from "../store/db.ts";
import { Paths } from "../store/paths.ts";
import { sha256 } from "../store/audit.ts";
import { mediaTypeFor } from "../pipeline/context.ts";
import { sendError } from "./errors.ts";

// The session's working files a reader may fetch, by the name the manifest lists them under.
const FILES: Record<string, { path: (p: Paths, id: string) => string; type: string }> = {
  "final.json": { path: (p, id) => p.sessionFinalFragments(id), type: "application/json" },
  "lint.json": { path: (p, id) => p.sessionLint(id), type: "application/json" },
  "links.json": { path: (p, id) => p.sessionLinks(id), type: "application/json" },
  "fields.json": { path: (p, id) => p.sessionFields(id), type: "application/json" },
  "text-layer.json": { path: (p, id) => p.sessionTextLayer(id), type: "application/json" },
  "unresolved.md": { path: (p, id) => p.sessionUnresolved(id), type: "text/plain; charset=utf-8" },
  "agent-updates.md": { path: (p, id) => p.sessionAgentUpdates(id), type: "text/plain; charset=utf-8" },
  "source.pdf": { path: (p, id) => p.sessionSourcePdf(id), type: "application/pdf" },
};

// Each page image's sha256, so the list does not re-read every image on every request: the page
// polls it while the run works, in the process that runs the pipeline. Keyed by path, size and time
// written, and bounded.
const digests = new Map<string, string>();
function digest(file: string): string {
  const st = statSync(file);
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  let d = digests.get(key);
  if (!d) {
    d = sha256(readFileSync(file));
    if (digests.size >= 2000) digests.delete(digests.keys().next().value!);
    digests.set(key, d);
  }
  return d;
}

export function auditRouter(cfg: IrisConfig, store: Store): Router {
  const r = Router();
  const paths = new Paths(cfg);
  const base = (id: string) => `/v1/sessions/${id}/audit`;

  // The session, or an answer already sent.
  const session = (id: string, res: Response): string | null => {
    res.set("X-Content-Type-Options", "nosniff");
    if (!auditOn(cfg)) {
      sendError(res, 404, "audit_off", "Audit mode is off on this deployment (server.audit).");
      return null;
    }
    const s = store.getSession(id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return null;
    }
    if (s.files_deleted_at) {
      sendError(res, 410, "session_expired", "This session's files were deleted after the retention period.");
      return null;
    }
    return s.session_id;
  };

  const pageFiles = (id: string): { order: number; file: string; name: string }[] => {
    const dir = paths.sessionInput(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d+__/.test(f))
      .map((f) => ({ order: parseInt(f, 10), file: join(dir, f), name: f.slice(f.indexOf("__") + 2) }))
      .sort((a, b) => a.order - b.order);
  };

  const runsDir = (id: string) => join(paths.sessionAudit(id), "runs");

  r.get("/:id/audit", (req, res) => {
    const id = session(req.params.id, res);
    if (!id) return;
    const pages = pageFiles(id).map((p) => ({
      order: p.order,
      name: p.name,
      media_type: mediaTypeFor(p.name),
      bytes: statSync(p.file).size,
      sha256: digest(p.file),
      url: `${base(id)}/pages/${p.order}`,
    }));
    const files = Object.entries(FILES)
      .filter(([, f]) => existsSync(f.path(paths, id)))
      .map(([name, f]) => ({ name, bytes: statSync(f.path(paths, id)).size, url: `${base(id)}/files/${name}` }));
    const runs = existsSync(runsDir(id))
      ? readdirSync(runsDir(id))
          .filter((n) => /^\d+$/.test(n))
          .map(Number)
          .sort((a, b) => a - b)
          .map((run) => ({
            run,
            snapshots: readdirSync(join(runsDir(id), String(run)))
              .filter((f) => f.endsWith(".html"))
              .map((f) => ({
                name: f.slice(0, -5),
                bytes: statSync(join(runsDir(id), String(run), f)).size,
                url: `${base(id)}/runs/${run}/${f.slice(0, -5)}`,
              })),
          }))
      : [];
    const promptDir = join(paths.sessionAudit(id), "prompts");
    const prompts = existsSync(promptDir) ? readdirSync(promptDir).filter((f) => f.endsWith(".txt")).length : 0;
    res.json({ session_id: id, pages, files, runs, prompts: { count: prompts, url: `${base(id)}/prompts/{sha256}` } });
  });

  r.get("/:id/audit/pages/:order", (req, res) => {
    const id = session(req.params.id, res);
    if (!id) return;
    const page = /^\d+$/.test(req.params.order) ? pageFiles(id).find((p) => p.order === Number(req.params.order)) : undefined;
    if (!page) {
      sendError(res, 404, "not_found", "No such page");
      return;
    }
    res.type(mediaTypeFor(page.name)).send(readFileSync(page.file));
  });

  r.get("/:id/audit/files/:name", (req, res) => {
    const id = session(req.params.id, res);
    if (!id) return;
    const f = Object.hasOwn(FILES, req.params.name) ? FILES[req.params.name] : undefined;
    if (!f || !existsSync(f.path(paths, id))) {
      sendError(res, 404, "not_found", "No such file");
      return;
    }
    res.type(f.type).send(readFileSync(f.path(paths, id)));
  });

  r.get("/:id/audit/prompts/:hash", (req, res) => {
    const id = session(req.params.id, res);
    if (!id) return;
    // Checked before any path is built from it.
    const hash = /^[0-9a-f]{64}$/.exec(req.params.hash)?.[0];
    const file = hash ? join(paths.sessionAudit(id), "prompts", `${hash}.txt`) : undefined;
    if (!file || !existsSync(file)) {
      sendError(res, 404, "not_found", "No such prompt");
      return;
    }
    res.type("text/plain; charset=utf-8").send(readFileSync(file));
  });

  r.get("/:id/audit/runs/:run/:name", (req, res) => {
    const id = session(req.params.id, res);
    if (!id) return;
    // Both checked before any path is built from them.
    const run = /^\d+$/.exec(req.params.run)?.[0];
    const name = /^(?:assembled|round-\d+)$/.exec(req.params.name)?.[0];
    const file = run && name ? join(runsDir(id), run, `${name}.html`) : undefined;
    if (!file || !existsSync(file)) {
      sendError(res, 404, "not_found", "No such snapshot");
      return;
    }
    res.type("text/plain; charset=utf-8").send(readFileSync(file));
  });

  return r;
}
