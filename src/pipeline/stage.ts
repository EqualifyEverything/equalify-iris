// Turning an upload into a session on disk: validate the files, render PDFs to page images,
// write the session directory and create its row. Shared by the upload route
// (routes/sessions.ts) and the CLI (cli.ts), so a change to how uploads are staged reaches both.
import { writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { IrisConfig } from "../config.ts";
import type { Store, SessionRecord } from "../store/db.ts";
import type { Paths } from "../store/paths.ts";
import { RunLog } from "../store/runlog.ts";
import { rasterizePdf, rasterizePageToFit, MAX_PDF_PAGES, type PageImage, type PdfLink } from "../util/pdf.ts";
import { outputBasenameFromUploads, safeStem } from "../util/outputNames.ts";
import { imageDimensions } from "../util/imageSize.ts";
import {
  IMAGE_MEDIA_TYPES,
  imageRejection,
  rasterizedPageRejection,
  refitLongEdge,
  shrunkPageRejection,
  type ImageLimits,
} from "../providers/imageLimits.ts";
import { usableFieldName } from "./fields.ts";
import { textLayer, type TextLayer } from "./numbers.ts";
import { readFields, taggedPdfCommand, TaggedPdfError, type PdfField } from "../util/taggedPdf.ts";

export type Upload = { originalname: string; buffer: Buffer };

// A page that only fit after a second, smaller render (see renderUploads).
export type PageRefit = { pdf: string; page: number; long_edge_px: number; from: string };

// Built from the formats the vision model actually reads (providers/imageLimits.ts)
// rather than written out here, so this validator cannot go on accepting a format
// the model stopped supporting — or, as it did with TIFF, never supported.
export const IMAGE_EXT = new RegExp(`(?:${Object.keys(IMAGE_MEDIA_TYPES).map((e) => `\\${e}`).join("|")})$`, "i");
export const PDF_EXT = /\.pdf$/i;
export const MAX_TOTAL_PAGES = MAX_PDF_PAGES; // overall cap across all uploaded files

// How the allowed types read in an error message: ".png,.jpg" -> "PNG, JPG".
export const ALLOWED_TYPES = [...Object.keys(IMAGE_MEDIA_TYPES).map((e) => e.slice(1).toUpperCase()), "PDF"].join(", ");

// An upload Iris refuses: a rasterized PDF page the vision model cannot accept, or a page
// count it does not take. Thrown from the expansion loop rather than returned, because the
// check sits inside an `await` over several files and the alternative is threading a
// rejection out through both branches; it lands in the same catch as the other PDF
// failures. It carries the finished message so the caller decides the status code (or exit
// code) and nothing else re-words the diagnosis.
export class UploadRejectedError extends Error {}

// Why a file of this name cannot be converted, or null. Needs no config, so the CLI can
// check it before loading one.
export function unsupportedType(name: string): string | null {
  return IMAGE_EXT.test(name) || PDF_EXT.test(name) ? null : `Unsupported file type: ${name} (allowed: ${ALLOWED_TYPES})`;
}

// Why these files cannot become a session, or null. Checked before anything is rendered,
// written to disk or queued.
export function uploadRejection(files: Upload[], imageLimits: ImageLimits): string | null {
  for (const f of files) {
    const unsupported = unsupportedType(f.originalname);
    if (unsupported) return unsupported;
    // Too heavy for the vision model to accept. Without this the upload succeeded, the run
    // started, and the first vision call ate the whole payload and then failed — reaching
    // the user two to four minutes later as a message about a stream that produced no
    // output, naming neither the file nor anything to do about it.
    //
    // A PDF is not measured here — the file the caller sent is not what reaches the
    // model. A 20 MB PDF of 25 light pages is a perfectly convertible document, so
    // the size that matters is the size of each page AFTER rasterizing, and that is
    // checked where the pages exist (renderUploads).
    if (!PDF_EXT.test(f.originalname)) {
      const size = imageDimensions(f.buffer);
      const why = imageRejection(
        { name: f.originalname, bytes: f.buffer.length, width: size?.width, height: size?.height },
        imageLimits,
      );
      if (why) return why;
    }
  }
  return null;
}

// Throws UploadRejectedError for a page or page count Iris does not take; any other error is
// a PDF that could not be processed.
export async function renderUploads(
  files: Upload[],
  imageLimits: ImageLimits,
): Promise<{ pages: PageImage[]; refits: PageRefit[] }> {
  // Expand uploads into ordered page images (PDF -> one PNG per page), each
  // carrying the link annotations on that page — the one part of a PDF that
  // rasterizing destroys, so it travels alongside the image (see pipeline/links.ts).
  const pages: PageImage[] = [];
  // Pages that only fit after a second, smaller render. Collected rather than logged
  // here because the session whose log this belongs in does not exist yet — the pages
  // have to be measured before there is anything to record against (below).
  const refits: PageRefit[] = [];
  for (const f of files) {
    if (PDF_EXT.test(f.originalname)) {
      const rendered = await rasterizePdf(f.buffer, f.originalname);
      // The uploaded PDF was exempt from the per-image limits; its pages are not.
      // Rasterizing at a fixed DPI means the page image's size follows the
      // PHYSICAL page, so a large-format page (a drawing, a fold-out) renders past
      // what the model accepts — and the run would then die inside the first
      // vision call, minutes in, which is the failure this check exists to catch.
      for (const [i, p] of rendered.entries()) {
        const page = p.page ?? i + 1;
        const size = imageDimensions(p.buffer);
        const why = rasterizedPageRejection(
          f.originalname,
          page,
          { bytes: p.buffer.length, width: size?.width, height: size?.height },
          imageLimits,
        );
        if (!why) continue;
        // Iris chose these pixels, so before refusing the document it renders the
        // page again at a size it can send (issue #485). Only this page, and only
        // on the path that was about to fail: a document that converts today is
        // rendered exactly as it was.
        const target = refitLongEdge({ width: size?.width, height: size?.height }, imageLimits);
        // A target means the page's dimensions parsed (`refitLongEdge` answers null
        // otherwise), and `page` is set on everything `rasterizePdf` returns — but a
        // rejection is the safe reading of either being absent, since re-rendering
        // needs both the page to ask for and a size to ask for it at.
        if (target === null || !size || p.page === undefined) throw new UploadRejectedError(why);
        // A failed re-render gets the refusal it would have had, not pdftoppm's error.
        const smaller = await rasterizePageToFit(f.buffer, p.page, target).catch(() => {
          throw new UploadRejectedError(why);
        });
        const shrunk = imageDimensions(smaller);
        const still = shrunkPageRejection(
          f.originalname,
          page,
          target,
          { bytes: smaller.length, width: shrunk?.width, height: shrunk?.height },
          imageLimits,
        );
        if (still) throw new UploadRejectedError(still);
        refits.push({
          pdf: f.originalname,
          page,
          long_edge_px: target,
          from: `${size.width}x${size.height}`,
        });
        p.buffer = smaller;
      }
      pages.push(...rendered);
    } else {
      // Filtered like a PDF's page names (safeStem); the extension already passed IMAGE_EXT.
      pages.push({ name: safeStem(f.originalname, "page") + extname(f.originalname).toLowerCase(), buffer: f.buffer, links: [] });
    }
  }
  if (pages.length === 0) throw new UploadRejectedError("No pages found in the uploaded files");
  if (pages.length > MAX_TOTAL_PAGES) {
    throw new UploadRejectedError(`Too many pages (${pages.length}); the maximum is ${MAX_TOTAL_PAGES}.`);
  }
  return { pages, refits };
}

// Keep the upload for a tagged PDF later, when this deployment makes them and the upload
// was one PDF on its own. Then the PDF's page N is the session's page N.
export function keepSourcePdf(
  cfg: IrisConfig,
  paths: Paths,
  sessionId: string,
  files: { originalname: string; buffer: Buffer }[],
): boolean {
  if (!taggedPdfCommand(cfg) || files.length !== 1 || !PDF_EXT.test(files[0].originalname)) return false;
  writeFileSync(paths.sessionSourcePdf(sessionId), files[0].buffer);
  return true;
}

// What `sessions.source_sha256` stores (#509). One file: its own sha256. Several: the sha256 of
// their hex digests, one per line, in upload order.
export function uploadSha256(files: { buffer: Buffer }[]): string {
  const digests = files.map((f) => createHash("sha256").update(f.buffer).digest("hex"));
  return digests.length === 1 ? digests[0] : createHash("sha256").update(digests.join("\n")).digest("hex");
}

// The kept PDF's form fields, by page, so the page agent can name each control after its
// field (#483, pipeline/fields.ts). Written only when there are some. A failure is returned
// for the run log rather than raised: the run converts the same without them. A name that
// could end the attribute it is copied into is dropped and counted (`usableFieldName`).
export async function keepPdfFields(
  command: string,
  paths: Paths,
  sessionId: string,
): Promise<{ fields: number; unusable: number } | { error: string }> {
  let fields: PdfField[];
  try {
    fields = await readFields(command, paths.sessionSourcePdf(sessionId));
  } catch (e) {
    return { error: e instanceof TaggedPdfError ? e.code : "tagger_failed" };
  }
  if (!Array.isArray(fields)) return { error: "tagger_failed" };
  const byPage: Record<string, PdfField[]> = {};
  let unusable = 0;
  for (const f of fields) {
    if (!usableFieldName(f?.name) || !Number.isInteger(f.page)) {
      unusable++;
      continue;
    }
    (byPage[String(f.page)] ??= []).push(f);
  }
  if (Object.keys(byPage).length) writeFileSync(paths.sessionFields(sessionId), JSON.stringify(byPage, null, 2));
  return { fields: fields.length - unusable, unusable };
}

// Write a new session's directory and create its row, in the `queued` status. The caller
// starts the run.
export async function stageSession(
  cfg: IrisConfig,
  store: Store,
  paths: Paths,
  files: Upload[],
  pages: PageImage[],
  refits: PageRefit[],
): Promise<SessionRecord> {
  const sessionId = `ses_${ulid()}`;
  paths.initSession(sessionId);
  // Remember the source basename so the output title + download filename
  // mirror the upload (e.g. report.pdf -> report_converted.html).
  writeFileSync(paths.sessionSourceName(sessionId), outputBasenameFromUploads(files));
  // Persist page images with an order prefix so submitted order survives.
  pages.forEach((p, i) => {
    const order = String(i + 1).padStart(4, "0");
    writeFileSync(join(paths.sessionInput(sessionId), `${order}__${p.name}`), p.buffer);
  });
  // …and the link annotations beside them, keyed by that same order. Only when
  // there are some, so a session of plain images gains no empty file.
  const linksByOrder: Record<string, PdfLink[]> = {};
  pages.forEach((p, i) => {
    if (p.links.length) linksByOrder[String(i + 1)] = p.links;
  });
  if (Object.keys(linksByOrder).length) {
    writeFileSync(paths.sessionLinks(sessionId), JSON.stringify(linksByOrder, null, 2));
  }
  // Each page's text layer, as its size and its numbers, for the check in pipeline/numbers.ts (#585).
  const layerByOrder: Record<string, TextLayer> = {};
  pages.forEach((p, i) => {
    const layer = textLayer(p.text);
    if (layer) layerByOrder[String(i + 1)] = layer;
  });
  if (Object.keys(layerByOrder).length) {
    writeFileSync(paths.sessionTextLayer(sessionId), JSON.stringify(layerByOrder));
  }
  const formFields = keepSourcePdf(cfg, paths, sessionId, files)
    ? await keepPdfFields(taggedPdfCommand(cfg)!, paths, sessionId)
    : null;
  // A page the model reads at lower resolution than the rest is a fact about this
  // document's output, so the session says so rather than the deployment's stdout: the
  // owner of a document whose fold-out reads worse than its letter pages can find out
  // why from the log they already have (`GET /v1/sessions/{id}/logs`). Best-effort for
  // the same reason `run_queued` is — a run must not fail to start over its own log.
  if (refits.length || formFields) {
    try {
      const log = new RunLog(paths.sessionLog(sessionId));
      for (const r of refits) log.event("page_refit", r);
      if (formFields) log.event("form_fields", formFields);
    } catch {
      // ignore — observability must not block the run
    }
  }

  const record = store.createSession({
    session_id: sessionId,
    image_count: pages.length,
    iterations_max: cfg.defaults.max_review_iterations,
    source_sha256: uploadSha256(files),
  });
  return record;
}
