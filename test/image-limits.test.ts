import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IrisConfig } from "../src/config.ts";
import { Store } from "../src/store/db.ts";
import type { AuthedRequest } from "../src/auth/middleware.ts";
import { sessionsRouter } from "../src/routes/sessions.ts";
import {
  IMAGE_MEDIA_TYPES,
  formatBytes,
  imageLimitsHint,
  imageRejection,
  longEdgeFor,
  modelGeneration,
  rawBytesForBase64Cap,
  resolveImageLimits,
} from "../src/providers/imageLimits.ts";
import { limitsRouter } from "../src/routes/limits.ts";
import { mediaTypeFor } from "../src/pipeline/context.ts";

// What an upload may be, and whether that answer still follows the configured model.
//
// The bug behind all of this: a photo-weight PNG was accepted by the upload route
// (multer's 50 MB ceiling was the only check) and then failed two to four minutes
// later inside a vision call, surfacing to the user as "no output arrived within
// 120s" — which reads as a service problem rather than "this file is too big". The
// limits were documented in five places and enforced in none, and two of those places
// were wrong: TIFF was advertised and unreadable, GIF readable and rejected.
//
// So these tests are about a property, not a number. Every limit is a fact about the
// configured model or provider, and the whole point of imageLimits.ts is that pointing
// the config at a different model moves all of them together. A test that only
// asserted today's byte count would pass just as happily if the resolution stopped
// looking at the config at all.

// Minimum viable config: only `providers` is read here, but the type wants the rest.
function cfg(providers: IrisConfig["providers"]): IrisConfig {
  return {
    server: { port: 3000, base_url: "http://localhost:3000" },
    storage: { data_dir: "/tmp/iris-test", agents_dir: "agents", database: ":memory:" },
    github: {
      client_id: "Iv1.test",
      client_secret: "s",
      upstream_repo: "o/r",
      api_base_url: "https://api.github.com",
      oauth_base_url: "https://github.com",
    },
    providers,
    defaults: { max_review_iterations: 3, extraction_concurrency: 5, max_concurrent_runs: 2 },
  };
}

const SONNET_46 = "us.anthropic.claude-sonnet-4-6";
const OPUS_47 = "us.anthropic.claude-opus-4-7";
// Bedrock's documented per-image cap is 5 MB of base64, which is 3,932,160 bytes on
// disk. Stated once here so the expectations below read as "3/4 of the cap" rather
// than as a magic number repeated.
const BEDROCK_RAW = 3_932_160;

test("base64 caps convert to bytes on disk, floored to a whole encoding group", () => {
  // The unit the platform documents is base64 characters, and the unit a user has is
  // a file. 4 characters per 3 bytes, so a file may be 3/4 of the cap.
  assert.equal(rawBytesForBase64Cap(5 * 1024 * 1024), BEDROCK_RAW);
  // Floored to a 3-byte group, or the encoded form could land a character over the
  // cap that this function exists to stay inside.
  assert.equal(rawBytesForBase64Cap(4), 3);
  assert.equal(rawBytesForBase64Cap(5), 3);
  assert.equal(rawBytesForBase64Cap(7), 3);
  assert.equal(rawBytesForBase64Cap(8), 6);
});

test("the resolution tier is read from the model id, in both providers' spellings", () => {
  // Bedrock hyphenates, OpenRouter uses dots, and both name the same models.
  assert.equal(modelGeneration(SONNET_46), 4.6);
  assert.equal(modelGeneration("anthropic/claude-sonnet-4.6"), 4.6);
  assert.equal(modelGeneration(OPUS_47), 4.7);
  assert.equal(modelGeneration("anthropic/claude-opus-4.7"), 4.7);
  // A bare major version is a whole number, not a parse failure.
  assert.equal(modelGeneration("claude-opus-5"), 5);
  assert.equal(modelGeneration("anthropic/claude-haiku-4-5-20251001-v1:0"), 4.5);
  // Anything this cannot read must say so rather than guess.
  assert.equal(modelGeneration("mock-model"), null);
  assert.equal(modelGeneration(""), null);
});

test("an unreadable model id falls to the SMALLER long edge, not the larger", () => {
  // The direction matters. High-resolution reading is a capability of Claude 4.7 and
  // later; an unrecognized id (a mock in a test, a fine-tune, a naming scheme this
  // file has not seen) getting 2576 px would publish advice that is wrong in the
  // expensive direction — telling a user to keep pixels the model then throws away.
  assert.equal(longEdgeFor(SONNET_46), 1568);
  assert.equal(longEdgeFor("anthropic/claude-sonnet-4.6"), 1568);
  assert.equal(longEdgeFor(OPUS_47), 2576);
  assert.equal(longEdgeFor("claude-opus-5"), 2576);
  assert.equal(longEdgeFor("mock-model"), 1568);
});

test("the published limits follow the configured model, not a constant", () => {
  // The whole reason this module exists: switching the model has to move the limits.
  const onSonnet = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
  );
  assert.equal(onSonnet.max_long_edge_px, 1568);
  assert.equal(onSonnet.max_image_bytes, BEDROCK_RAW);

  const onOpus = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: OPUS_47 } }),
  );
  assert.equal(onOpus.max_long_edge_px, 2576);
  // Same provider, so the same byte cap: the two limits move independently, one with
  // the model and one with the provider.
  assert.equal(onOpus.max_image_bytes, BEDROCK_RAW);
});

test("the strictest agent sets the limit, because every agent sees the upload", () => {
  // The config example recommends running verification on a stronger model than
  // extraction. A limit true only of the first call is not a limit: the same image is
  // attached again in the fidelity check and (when pages are attached) the review.
  const limits = resolveImageLimits(
    cfg({
      default: "bedrock",
      bedrock: { region: "us-east-1", default_model: OPUS_47 },
      per_agent: { feedback: { model: SONNET_46 } },
    }),
  );
  // Opus would read 2576 px, but the Feedback Agent's Sonnet would not — so 1568 is
  // the honest number to publish.
  assert.equal(limits.max_long_edge_px, 1568);
});

test("a per-provider override wins, for a model the table cannot know yet", () => {
  const limits = resolveImageLimits(
    cfg({
      default: "bedrock",
      bedrock: {
        region: "us-east-1",
        default_model: "us.anthropic.claude-something-9",
        image_limits: { max_base64_bytes: 10 * 1024 * 1024, max_long_edge_px: 4000 },
      },
    }),
  );
  assert.equal(limits.max_base64_bytes, 10 * 1024 * 1024);
  // Not overridden directly, so it is still derived from the cap that WAS.
  assert.equal(limits.max_image_bytes, rawBytesForBase64Cap(10 * 1024 * 1024));
  assert.equal(limits.max_long_edge_px, 4000);
});

test("an empty or nonsensical override falls back instead of rejecting everything", () => {
  // YAML parses a valueless `max_image_bytes:` as null, and Number(null) is 0 — which
  // as a limit rejects every upload ever made, with the message "the maximum is 0 MB".
  const limits = resolveImageLimits(
    cfg({
      default: "bedrock",
      bedrock: {
        region: "us-east-1",
        default_model: SONNET_46,
        image_limits: {
          max_image_bytes: null as unknown as number,
          max_long_edge_px: 0,
          max_base64_bytes: "" as unknown as number,
        },
      },
    }),
  );
  assert.equal(limits.max_image_bytes, BEDROCK_RAW);
  assert.equal(limits.max_long_edge_px, 1568);
  assert.equal(limits.max_base64_bytes, 5 * 1024 * 1024);
});

test("a provider with no entry in the table gets the stricter cap, not none", () => {
  // Being wrong toward strict costs one "make it smaller" message; being wrong toward
  // permissive costs a run that fails minutes later inside a model call.
  const limits = resolveImageLimits(
    cfg({ default: "acme", acme: { default_model: "acme/vision-1" } }),
  );
  assert.equal(limits.max_base64_bytes, 5 * 1024 * 1024);
  assert.equal(limits.max_image_bytes, BEDROCK_RAW);
});

test("a config with no reachable provider publishes defaults, never Infinity", () => {
  // resolveAgentModel throws when the default provider has no block. That must not be
  // the thing that breaks answering "how big may my file be".
  const limits = resolveImageLimits(cfg({ default: "missing" }));
  assert.ok(Number.isFinite(limits.max_image_bytes));
  assert.equal(limits.max_image_bytes, BEDROCK_RAW);
  assert.equal(limits.max_long_edge_px, 1568);
});

test("the format allowlist is the model's, not the one Iris used to advertise", () => {
  const exts = Object.keys(IMAGE_MEDIA_TYPES);
  // GIF is readable and was rejected; TIFF was accepted and unreadable — the second
  // being the same undiagnosable mid-run failure as an oversized upload.
  assert.ok(exts.includes(".gif"));
  assert.ok(!exts.includes(".tif"));
  assert.ok(!exts.includes(".tiff"));
  assert.deepEqual(exts, [".png", ".jpg", ".jpeg", ".gif", ".webp"]);
  // And the media type actually sent with a page comes from the same map, so the
  // route's allowlist and the provider payload cannot disagree.
  assert.equal(mediaTypeFor("page-001.PNG"), "image/png");
  assert.equal(mediaTypeFor("scan.jpeg"), "image/jpeg");
  assert.equal(mediaTypeFor("art.gif"), "image/gif");
  // The fallback for an extension that reached the pipeline anyway (a PDF page is
  // always a PNG), rather than sending an empty media type.
  assert.equal(mediaTypeFor("page-001"), "image/png");
});

test("a published limit is floored, so it never promises more than the check allows", () => {
  // 3,932,160 bytes is 3.75 MB. Rounded, that reads "3.8 MB" — and a user who trusts
  // it and sends 3.78 MB is rejected by the sentence that invited the upload.
  assert.equal(formatBytes(BEDROCK_RAW), "3.7 MB");
  // No trailing ".0": "5 MB", not "5.0 MB".
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
  assert.equal(formatBytes(512 * 1024), "512 KB");
});

test("an oversized image is rejected with the limit and what to do about it", () => {
  const limits = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
  );
  // Inclusive at the boundary. The number is published, so a file of exactly that
  // size must pass: "under 3.7 MB" that rejects 3.7 MB is the hardest version of this
  // bug to report.
  assert.equal(imageRejection({ name: "ok.png", bytes: limits.max_image_bytes }, limits), null);
  assert.ok(imageRejection({ name: "over.png", bytes: limits.max_image_bytes + 1 }, limits));
  const why = imageRejection({ name: "huge.png", bytes: 6_300_000 }, limits);
  assert.ok(why, "an over-limit file must be rejected");
  // The filename, so a caller who sent twelve pages knows which one.
  assert.match(why, /huge\.png/);
  // Its size and the limit, in that order.
  assert.match(why, /6 MB/);
  assert.match(why, /3\.7 MB/);
  // And the way out. A user told only "too large" reasonably fears losing detail the
  // conversion needs; the answer is that the model discards those pixels anyway.
  assert.match(why, /1568 px/);
});

test("the hint leads with the rule an upload is actually rejected by", () => {
  const limits = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
  );
  const hint = imageLimitsHint(limits);
  // Size first, formats second, the downscale advice last: that is the order of
  // usefulness to someone choosing a file, and it is one sentence used verbatim by
  // the demo page, the docs and the 400.
  assert.ok(hint.indexOf("3.7 MB") < hint.indexOf("PNG"), `size should lead: ${hint}`);
  assert.match(hint, /GIF/);
  assert.doesNotMatch(hint, /TIFF/i);
});

// ----- GET /v1/limits -----

async function serve(router: express.Router) {
  const app = express();
  app.use("/v1/limits", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  return {
    get: () => fetch(`http://127.0.0.1:${port}/v1/limits`),
    close: () => server.close(),
  };
}

test("GET /v1/limits publishes what the upload route enforces", async () => {
  const config = cfg({
    default: "bedrock",
    bedrock: { region: "us-east-1", default_model: SONNET_46 },
  });
  const s = await serve(limitsRouter(config));
  try {
    const res = await s.get();
    assert.equal(res.status, 200);
    // Cacheable: the answer changes only when an operator edits config and restarts.
    assert.match(res.headers.get("cache-control") ?? "", /max-age=\d+/);
    const body = await res.json();
    const limits = resolveImageLimits(config);
    // The same number the route rejects by, not a second opinion about it.
    assert.equal(body.image.max_bytes, limits.max_image_bytes);
    assert.equal(body.image.hint, imageLimitsHint(limits));
    assert.equal(body.image.max_long_edge_px, 1568);
    assert.equal(body.image.max_dimension_px, 8000);
    assert.deepEqual(body.image.extensions, Object.keys(IMAGE_MEDIA_TYPES));
    assert.equal(body.max_pages, 25);
    assert.equal(body.pdf.max_pages, 25);
  } finally {
    s.close();
  }
});

test("GET /v1/limits does not publish the deployment's model or provider", async () => {
  // It is unauthenticated, and it answers a question about file sizes. Naming the
  // model would make it an infrastructure disclosure endpoint by accident — the same
  // care /v1/stats takes about what an aggregate may say. The detail belongs in the
  // authenticated 400 a caller with a real rejected upload gets.
  const s = await serve(
    limitsRouter(
      cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
    ),
  );
  try {
    const raw = await (await s.get()).text();
    assert.doesNotMatch(raw, /sonnet/i);
    assert.doesNotMatch(raw, /anthropic/i);
    assert.doesNotMatch(raw, /bedrock/i);
    assert.doesNotMatch(raw, /us-east-1/);
  } finally {
    s.close();
  }
});

// ----- POST /v1/sessions: the check that makes the limits real -----

// The upload route, mounted with the auth middleware stubbed out: what is under test
// is the validation ahead of `req.user`, and standing up GitHub auth to reach it would
// test something else. Only rejection paths are exercised on purpose — a file that
// PASSES validation starts a real pipeline, i.e. real model calls.
async function serveUploads() {
  const dir = mkdtempSync(join(tmpdir(), "iris-limits-"));
  const config = cfg({
    default: "bedrock",
    bedrock: { region: "us-east-1", default_model: SONNET_46 },
  });
  config.storage = { data_dir: dir, agents_dir: "agents", database: join(dir, "iris.sqlite") };
  const store = new Store(config.storage.database);
  const app = express();
  app.use((req, _res, next) => {
    (req as AuthedRequest).user = {
      github_user_id: 1,
      github_login: "tester",
      max_review_iterations: 3,
    } as AuthedRequest["user"];
    next();
  });
  app.use("/v1/sessions", sessionsRouter(config, store));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  return {
    post: async (name: string, bytes: number, type = "image/png") => {
      const fd = new FormData();
      fd.append("images", new Blob([new Uint8Array(bytes)], { type }), name);
      const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { method: "POST", body: fd });
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      return { status: res.status, message: body.error?.message ?? "" };
    },
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("an oversized image is refused at upload, not minutes later in a model call", async () => {
  const s = await serveUploads();
  try {
    const { status, message } = await s.post("photo-man.png", 6_300_000);
    assert.equal(status, 400);
    // The message names the file, its size, the limit and the way out — measured
    // against the file that produced the original report, a 6.3 MB photo.
    assert.match(message, /photo-man\.png is 6 MB, over the 3\.7 MB limit/);
    assert.match(message, /1568 px/);
  } finally {
    s.close();
  }
});

test("a format the model cannot read is refused, and TIFF is one of them", async () => {
  const s = await serveUploads();
  try {
    const { status, message } = await s.post("scan.tif", 1024, "image/tiff");
    assert.equal(status, 400);
    assert.match(message, /Unsupported file type: scan\.tif/);
    // The allowed list comes from the same table, so it cannot advertise TIFF back.
    assert.doesNotMatch(message, /TIF/);
    assert.match(message, /GIF/);
  } finally {
    s.close();
  }
});

test("a large PDF is not refused for its bytes — its pages are rasterized here", async () => {
  // A 20 MB PDF of 25 light pages is a perfectly convertible document: what reaches
  // the model is a 150-DPI page image Iris rendered, not the uploaded file. Applying
  // the per-image cap to PDFs would reject exactly the documents Iris exists for.
  // This upload is refused for not being a readable PDF, which is the point: it got
  // past the size gate that an image of the same weight would not have.
  const s = await serveUploads();
  try {
    const { message } = await s.post("big.pdf", 8_000_000, "application/pdf");
    assert.doesNotMatch(message, /limit for one image/);
  } finally {
    s.close();
  }
});
