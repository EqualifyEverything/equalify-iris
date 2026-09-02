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
  limitsBasisFor,
  longEdgeFor,
  modelGeneration,
  rasterizedPageRejection,
  rawBytesForBase64Cap,
  resolveImageLimits,
  visionModelWarning,
} from "../src/providers/imageLimits.ts";
import { imageDimensions } from "../src/util/imageSize.ts";
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
    defaults: { max_review_iterations: 3, extraction_concurrency: 5, max_concurrent_runs: 2, recheck_sample_size: 1 },
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
  assert.deepEqual(modelGeneration(SONNET_46), { major: 4, minor: 6 });
  assert.deepEqual(modelGeneration("anthropic/claude-sonnet-4.6"), { major: 4, minor: 6 });
  assert.deepEqual(modelGeneration(OPUS_47), { major: 4, minor: 7 });
  assert.deepEqual(modelGeneration("anthropic/claude-opus-4.7"), { major: 4, minor: 7 });
  // A bare major version has an implied minor of 0, not a parse failure.
  assert.deepEqual(modelGeneration("claude-opus-5"), { major: 5, minor: 0 });
  assert.deepEqual(modelGeneration("anthropic/claude-haiku-4-5-20251001-v1:0"), {
    major: 4,
    minor: 5,
  });
  // Anything this cannot read must say so rather than guess.
  assert.equal(modelGeneration("mock-model"), null);
  assert.equal(modelGeneration(""), null);
});

test("a two-digit minor version is a counter, not a decimal fraction", () => {
  // Read as a number, "4.10" is 4.1 — below 4.7 — so a claude-*-4-10 would be treated
  // as older than the model released before it and dropped to the standard tier.
  // Nothing is named that yet, which is the only reason this was not a live bug.
  assert.deepEqual(modelGeneration("claude-opus-4-10"), { major: 4, minor: 10 });
  assert.equal(longEdgeFor("claude-opus-4-10"), 2576);
  assert.equal(longEdgeFor("anthropic/claude-opus-4.10"), 2576);
  // And the comparison still has to reject genuinely older models on the same axis.
  assert.equal(longEdgeFor("claude-opus-3-10"), 1568);
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

test("an override on a provider that only serves some agents still narrows the limit", () => {
  // The override used to be read off whichever provider block won on byte cap, with a
  // STRICT comparison — and both providers in the table are 5 MB, so the first agent's
  // block always won the tie and an override anywhere else was silently dropped. The
  // route then published 3.75 MB while the call on the tightened provider failed
  // mid-run: the failure this module exists to prevent, reintroduced through its own
  // escape hatch.
  const limits = resolveImageLimits(
    cfg({
      default: "bedrock",
      bedrock: { region: "us-east-1", default_model: SONNET_46 },
      openrouter: {
        api_key: "k",
        default_model: "anthropic/claude-sonnet-4.6",
        image_limits: { max_base64_bytes: 1024 * 1024 },
      },
      per_agent: { feedback: "openrouter" },
    }),
  );
  assert.equal(limits.max_base64_bytes, 1024 * 1024);
  assert.equal(limits.max_image_bytes, rawBytesForBase64Cap(1024 * 1024));
});

test("each limit is resolved on its own axis, so two overrides cannot cancel out", () => {
  // A mixed deployment can have the tighter byte cap on one provider and the smaller
  // long edge on the other. One "strictest block" carrying both would honour whichever
  // axis it won on and drop the other.
  const limits = resolveImageLimits(
    cfg({
      default: "bedrock",
      bedrock: {
        region: "us-east-1",
        default_model: OPUS_47,
        image_limits: { max_base64_bytes: 2 * 1024 * 1024 },
      },
      openrouter: {
        api_key: "k",
        default_model: "anthropic/claude-opus-4.7",
        image_limits: { max_long_edge_px: 1000 },
      },
      per_agent: { feedback: "openrouter" },
    }),
  );
  assert.equal(limits.max_base64_bytes, 2 * 1024 * 1024); // from bedrock's block
  assert.equal(limits.max_long_edge_px, 1000); // from openrouter's, on the same call
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

// ── Whether the published limits are facts or guesses ────────────────────────────────
//
// Everything above resolves NUMBERS. These resolve whether Iris is entitled to state
// them: `providers.bedrock.api: converse` can reach a model Anthropic did not make, and
// then the pixel limits and the format list are Claude's, published in the same voice as
// a checked number. The numbers stay put — being conservative is right while nobody has
// measured — so the whole difference is in what is claimed, which is what these pin.

const QWEN_VL = "qwen.qwen3-vl-235b-a22b-instruct-v1:0";
// A second vision model this build cannot place, on a DIFFERENT provider block, so the boot
// warning can be asked about two of them at once.
const OTHER_VL = "mistral/pixtral-large-2502";

test("a model id decides whether the limits are documented or assumed", () => {
  // Both spellings and the legacy ordering: the question is the same one modelGeneration
  // answers, deliberately, so there is no second list of names to keep in step.
  assert.equal(limitsBasisFor(SONNET_46), "documented");
  assert.equal(limitsBasisFor("anthropic/claude-opus-4.7"), "documented");
  assert.equal(limitsBasisFor("anthropic.claude-3-5-sonnet-20240620-v1:0"), "documented");
  // Nothing here is a judgement about the model — a Qwen or a Nova may well read larger
  // images than any Claude. It is that this file has not been told, so it cannot speak
  // for it.
  assert.equal(limitsBasisFor(QWEN_VL), "assumed");
  assert.equal(limitsBasisFor("us.amazon.nova-pro-v1:0"), "assumed");
  assert.equal(limitsBasisFor("mock-model"), "assumed");
  assert.equal(limitsBasisFor(""), "assumed");
});

test("an unrecognized vision model changes the claim, not the limits", () => {
  const providers = { region: "us-east-1", api: "converse" };
  const onClaude = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { ...providers, default_model: SONNET_46 } }),
  );
  const onQwen = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { ...providers, default_model: QWEN_VL } }),
  );
  // Same numbers: the conservative end of what Iris knows is the right thing to serve an
  // upload with while nobody has checked, and lowering them would refuse files that
  // convert fine to make a point about documentation.
  assert.equal(onQwen.max_image_bytes, onClaude.max_image_bytes);
  assert.equal(onQwen.max_long_edge_px, onClaude.max_long_edge_px);
  assert.equal(onQwen.max_dimension_px, onClaude.max_dimension_px);
  // What differs is whether they are facts.
  assert.equal(onClaude.basis, "documented");
  assert.equal(onQwen.basis, "assumed");
});

test("one unrecognized agent is enough, because one sentence is published", () => {
  // Same rule as the strictest number winning: the hint has to hold for every call the
  // upload makes, so a deployment that extracts on a Claude and verifies elsewhere is a
  // deployment whose pixel limits are a guess about half its calls.
  const limits = resolveImageLimits(
    cfg({
      default: "bedrock",
      bedrock: { region: "us-east-1", default_model: OPUS_47 },
      per_agent: { feedback: { model: QWEN_VL } },
    }),
  );
  assert.equal(limits.basis, "assumed");
  // And the number is still the honest one across both models.
  assert.equal(limits.max_long_edge_px, 1568);
});

test("an operator who sets the long edge has answered the question", () => {
  // The escape hatch is the answer this asks for: a number on the provider block is the
  // operator saying they read their model's documentation, so it stops being a guess —
  // and the guess is what the qualification and the boot warning are about.
  const config = cfg({
    default: "bedrock",
    bedrock: {
      region: "us-east-1",
      default_model: QWEN_VL,
      image_limits: { max_long_edge_px: 3000 },
    },
  });
  const limits = resolveImageLimits(config);
  assert.equal(limits.max_long_edge_px, 3000);
  assert.equal(limits.basis, "documented");
  assert.equal(visionModelWarning(config), null);
});

test("an override cannot answer for a model it was not written about", () => {
  // The override is per provider BLOCK and the basis question is per MODEL, so a block
  // that serves both can be read as an answer about the wrong one. Here the operator set
  // 2576 px having read Claude 4.7's documentation — which is what default_model is — and
  // `per_agent` sends the Feedback Agent to a Qwen on the same block. Reading the override
  // as an answer published "reads at most 2576 px … loses nothing" about the Qwen: the
  // exact sentence this flag exists to prevent, re-entered through the escape hatch.
  const mixed = cfg({
    default: "bedrock",
    bedrock: {
      region: "us-east-1",
      default_model: OPUS_47,
      image_limits: { max_long_edge_px: 2576 },
    },
    per_agent: { feedback: { model: QWEN_VL } },
  });
  assert.equal(resolveImageLimits(mixed).basis, "assumed");
  assert.match(String(visionModelWarning(mixed)), /feedback/);
  // The operator's number is still applied — it is their block, and this is about what is
  // CLAIMED of it, not about second-guessing the limit.
  assert.equal(resolveImageLimits(mixed).max_long_edge_px, 2576);

  // And the same override on a block that serves nothing else can only have been written
  // about the model it does serve, so there it is an answer.
  const foreign = cfg({
    default: "bedrock",
    bedrock: {
      region: "us-east-1",
      default_model: QWEN_VL,
      image_limits: { max_long_edge_px: 2576 },
    },
  });
  assert.equal(resolveImageLimits(foreign).basis, "documented");
  assert.equal(visionModelWarning(foreign), null);
});

test("a valueless override is not an answer, and does not silence the warning", () => {
  // YAML reads `max_long_edge_px:` with nothing after it as null, which falls back to the
  // table. Treating the presence of the key as the operator's answer would quietly accept
  // a line that changed nothing.
  const config = cfg({
    default: "bedrock",
    bedrock: {
      region: "us-east-1",
      default_model: QWEN_VL,
      image_limits: { max_long_edge_px: null as unknown as number },
    },
  });
  assert.equal(resolveImageLimits(config).basis, "assumed");
  assert.match(String(visionModelWarning(config)), /conservative guess/);
});

test("the hint promises what the model discards only when that is known", () => {
  const documented = imageLimitsHint(
    resolveImageLimits(
      cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
    ),
  );
  const assumed = imageLimitsHint(
    resolveImageLimits(
      cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: QWEN_VL } }),
    ),
  );
  // "Loses nothing" is a claim about the model's downscaling. On a model nobody has
  // limits for it is advice to destroy detail that may have been read — worse than the
  // rejection it is explaining, and invisible to the user it happens to.
  assert.match(documented, /reads at most 1568 px/);
  assert.match(documented, /loses nothing/);
  assert.doesNotMatch(assumed, /loses nothing/);
  assert.doesNotMatch(assumed, /reads at most/);
  // Still actionable, and still the same pixel number — offered as a size known to work
  // rather than as a size above which nothing counts.
  assert.match(assumed, /1568 px/);
  assert.match(assumed, /assumed to read/);
  // Both still lead with the rule an upload is actually rejected by, which is a fact
  // about the provider's endpoint and not in question either way.
  for (const hint of [documented, assumed]) {
    assert.ok(hint.startsWith("Each image must be under 3.7 MB"), hint);
    assert.match(hint, /PNG, JPEG, GIF, WEBP/);
  }
});

test("the hard ceiling is attributed to whoever actually refuses the image", () => {
  const big = { name: "poster.png", bytes: 1000, width: 9000, height: 400 };
  const onClaude = imageRejection(
    big,
    resolveImageLimits(
      cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
    ),
  );
  const onQwen = imageRejection(
    big,
    resolveImageLimits(
      cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: QWEN_VL } }),
    ),
  );
  // Both refuse it — Iris enforces the same 8000 px either way, because finding out
  // four minutes into a run is the failure this module exists to remove.
  assert.match(String(onClaude), /8000 px limit on a side/);
  assert.match(String(onQwen), /8000 px limit on a side/);
  // Only one of them can say the model does the refusing.
  assert.match(String(onClaude), /the vision model refuses an image that large/);
  assert.doesNotMatch(String(onQwen), /the vision model refuses/);
  assert.match(String(onQwen), /Iris does not send an image that large/);
});

test("boot says once that the published image limits are a guess", () => {
  // The hint qualifies itself for the user; this line is for whoever can fix it. Boot is
  // the only place that can be said, because every downstream reader of these limits is
  // written to be quoted verbatim.
  const config = cfg({
    default: "bedrock",
    bedrock: { region: "us-east-1", default_model: QWEN_VL, api: "converse" },
  });
  const warning = String(visionModelWarning(config));
  // Which agents, and which model — an operator reading this has to be able to find the
  // line of config that caused it.
  assert.match(warning, /page/);
  assert.match(warning, /feedback/);
  assert.match(warning, new RegExp(QWEN_VL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(warning, /providers\.bedrock\.image_limits/);
  // Quoting the numbers actually published, from the same resolution the route uses, so
  // the warning cannot describe a limit nobody is serving.
  const limits = resolveImageLimits(config);
  assert.match(warning, new RegExp(`${limits.max_long_edge_px} px on the long edge`));
  assert.match(warning, new RegExp(`${limits.max_dimension_px} px per side`));
  // The byte cap is named too, on the other side of the line: it is the provider's
  // endpoint limit, so it is the one published number this changes nothing about, and an
  // operator reading a list of suspect numbers should not have to wonder about it.
  assert.match(warning, new RegExp(`${formatBytes(limits.max_image_bytes)} per-image cap`));
  // And it is silent on a deployment running a model this build knows.
  assert.equal(
    visionModelWarning(
      cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
    ),
    null,
  );
});

test("boot asks for a setting only where the setting can answer", () => {
  // The remedy sentence used to be unconditional: "Set providers.bedrock.image_limits to
  // the numbers this model's documentation gives." On a block that also serves a model this
  // build knows, `foreignOnly` will not read that number as an answer, so following the
  // instruction means editing config, restarting, and meeting the same warning. And it is
  // not a corner: `api` is a block setting and only a block named `bedrock` builds a
  // Bedrock adapter, so a Bedrock deployment that sends ONE agent to another vendor — which
  // is what the UIC deployment does — is always in this case. See #320.
  const mixed = cfg({
    default: "bedrock",
    bedrock: { region: "us-east-1", default_model: SONNET_46, api: "converse" },
    per_agent: { page: { model: QWEN_VL } },
  });
  const warning = String(visionModelWarning(mixed));
  // Says which case it is, names the model it is about, and names what the block is shared
  // with so the ambiguity is legible rather than asserted.
  assert.match(warning, new RegExp(`cannot answer for ${QWEN_VL.replace(/[.:]/g, "\\$&")}`));
  assert.match(warning, new RegExp(SONNET_46.replace(/\./g, "\\.")));
  assert.match(warning, /nothing to set/);
  // And does NOT instruct. This is the assertion that fails on the old text.
  assert.doesNotMatch(warning, /Set providers/);
  // Still names the agent and the model, which is how an operator finds the config line.
  assert.match(warning, /page/);
  assert.doesNotMatch(warning, /feedback/); // feedback is on the Claude, and not in question

  // A block serving nothing this build can place still gets the instruction, because there
  // the number can only have been read about the model it does serve.
  const foreign = cfg({
    default: "bedrock",
    bedrock: { region: "us-east-1", default_model: QWEN_VL, api: "converse" },
  });
  const askable = String(visionModelWarning(foreign));
  assert.match(askable, /Set providers\.bedrock\.image_limits/);
  assert.doesNotMatch(askable, /cannot answer/);
});

test("each block gets its own sentence, naming its own model", () => {
  // Two guessed models on two blocks, one of which can be answered for and one of which
  // cannot. Both sentences are emitted, so a pronoun in either would point at a different
  // member of the model list this warning opens with — and this paragraph exists to be
  // quoted verbatim, which is what made #320 a defect rather than a wording preference.
  const two = cfg({
    default: "bedrock",
    bedrock: { region: "us-east-1", default_model: SONNET_46, api: "converse" },
    openrouter: { api_key: "k", default_model: OTHER_VL },
    per_agent: { page: { model: QWEN_VL }, copy_editor: "openrouter" },
  });
  const warning = String(visionModelWarning(two));
  const qwen = QWEN_VL.replace(/[.:]/g, "\\$&");
  const other = OTHER_VL.replace(/[./]/g, "\\$&");
  // The mixed block declines, for the model that is actually on it.
  assert.match(warning, new RegExp(`providers\\.bedrock\\.image_limits cannot answer for ${qwen}`));
  // The foreign-only block is asked, for ITS model — not for the other block's.
  assert.match(
    warning,
    new RegExp(`Set providers\\.openrouter\\.image_limits to the numbers documented for ${other}`),
  );
  // Neither sentence leans on a pronoun that the reader has to resolve against the list.
  assert.doesNotMatch(warning, /this one/);
  assert.doesNotMatch(warning, /this model's documentation/);
});

// NOT TESTED, deliberately, and worth saying why rather than leaving a name that claims a
// guard: `visionModelWarning` derives "does this block also serve a model we know" from
// `limitsBasisFor(a.model)` and not from the resolved `a.basis`. Those two spellings cannot
// disagree at that point today. `basis` differs from `limitsBasisFor(model)` only where
// `edgeOverride > 0 && foreignOnly.has(provider)`, and on such a block every agent is
// foreign and answered for, so no agent from it survives into `guessed` and the loop is
// never entered for it. Mutating the line to `a.basis === "documented"` leaves this whole
// file green, and no config makes it bite. The `limitsBasisFor` spelling is still the
// correct question — it is what keeps the sentence true if `foreignOnly` is ever widened to
// read one answered-for model as an answer for another on the same block — but it is a
// future-proofing, not a live invariant, and a test asserting otherwise would be theatre.

test("a config that resolves no model at all warns about nothing", () => {
  // Nothing is configured to warn ABOUT, and a config whose default provider has no
  // block fails validateConfig at startup anyway — a second line here would be noise on
  // top of the error that actually stops the boot.
  const config = cfg({ default: "missing" });
  assert.equal(visionModelWarning(config), null);
  // But the limits it publishes are still not documented about anything.
  assert.equal(resolveImageLimits(config).basis, "assumed");
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

// ----- Pixel dimensions, the one dimension limit that IS a limit -----

// Minimal valid headers, built by hand. A real encoder is not needed and would make
// the test assert its behaviour rather than the parser's: what these check is that the
// documented offsets are read, including the ones that are not simply "width, height".
function pngHeader(width: number, height: number, bytes = 64): Buffer {
  const buf = Buffer.alloc(Math.max(bytes, 24));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

// WebP is three encodings behind one container, each storing its size differently, and
// the two a real file is most likely to be are not the simple one.
function webpHeader(kind: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write("RIFF", 0, "latin1");
  buf.write("WEBP", 8, "latin1");
  buf.write(kind, 12, "latin1");
  if (kind === "VP8X") {
    // Extended: a 24-bit little-endian canvas size, stored minus one.
    buf.writeUIntLE(width - 1, 24, 3);
    buf.writeUIntLE(height - 1, 27, 3);
  } else if (kind === "VP8L") {
    // Lossless: a signature byte, then 14 bits of width and 14 of height packed into
    // one word — so the height straddles a byte boundary, which is the part a
    // hand-rolled reader gets wrong.
    buf.writeUInt8(0x2f, 20);
    buf.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  } else {
    // Lossy: a VP8 key-frame start code, then 14-bit dimensions whose top two bits are
    // a scaling hint rather than size — set here, so reading them as size would fail.
    buf.writeUInt8(0x9d, 23);
    buf.writeUInt8(0x01, 24);
    buf.writeUInt8(0x2a, 25);
    buf.writeUInt16LE(width | 0xc000, 26);
    buf.writeUInt16LE(height | 0xc000, 28);
  }
  return buf;
}

// A JPEG keeps its size in a frame header that sits behind a variable run of metadata
// segments, so the parser has to walk them — here, one APP0 in the way.
function jpegHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt16BE(0xffd8, 0); // SOI
  buf.writeUInt16BE(0xffe0, 2); // APP0
  buf.writeUInt16BE(16, 4); // its length, counting these two bytes
  buf.write("JFIF", 6, "latin1");
  const sof = 2 + 2 + 16;
  buf.writeUInt16BE(0xffc0, sof); // SOF0
  buf.writeUInt16BE(17, sof + 2);
  buf.writeUInt8(8, sof + 4); // sample precision
  buf.writeUInt16BE(height, sof + 5); // height BEFORE width, unlike every other format
  buf.writeUInt16BE(width, sof + 7);
  return buf;
}

test("pixel dimensions are read from the header of every format on the allowlist", () => {
  assert.deepEqual(imageDimensions(pngHeader(1275, 1650)), { width: 1275, height: 1650 });
  assert.deepEqual(imageDimensions(gifHeader(640, 480)), { width: 640, height: 480 });
  // All three WebP encodings, because the container tells them apart and only one of
  // them stores the size the obvious way.
  assert.deepEqual(imageDimensions(webpHeader("VP8X", 9000, 300)), { width: 9000, height: 300 });
  assert.deepEqual(imageDimensions(webpHeader("VP8L", 1600, 2400)), { width: 1600, height: 2400 });
  assert.deepEqual(imageDimensions(webpHeader("VP8 ", 1600, 2400)), { width: 1600, height: 2400 });
  // The one that is easy to get backwards, and would pass a square fixture.
  assert.deepEqual(imageDimensions(jpegHeader(800, 1200)), { width: 800, height: 1200 });
});

test("an unreadable header returns null, so no format becomes refusable by accident", () => {
  // The direction that matters: this reader gates a REJECTION. A format it cannot
  // parse, a truncated upload, or a header whose numbers make no sense must all mean
  // "cannot say", never "too big".
  assert.equal(imageDimensions(Buffer.alloc(0)), null);
  assert.equal(imageDimensions(Buffer.from("not an image at all")), null);
  assert.equal(imageDimensions(pngHeader(100, 100).subarray(0, 20)), null);
  assert.equal(imageDimensions(pngHeader(0, 0)), null);
  // A JPEG whose segments run off the end rather than reaching a frame header.
  const truncated = jpegHeader(10, 10).subarray(0, 8);
  assert.equal(imageDimensions(truncated), null);
  // A RIFF/WEBP container whose payload is not one of the three encodings, and a VP8L
  // chunk without its signature byte: both are "cannot say", not a guess at the bits
  // that happen to sit at those offsets.
  const unknownChunk = webpHeader("VP8X", 100, 100);
  unknownChunk.write("ALPH", 12, "latin1");
  assert.equal(imageDimensions(unknownChunk), null);
  const noSignature = webpHeader("VP8L", 100, 100);
  noSignature.writeUInt8(0x00, 20);
  assert.equal(imageDimensions(noSignature), null);
});

test("an image over the hard dimension ceiling is refused, cheap as it may be", () => {
  const limits = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
  );
  // 8000 px is not advice like the long edge is: past it the model returns an error
  // instead of downscaling. And pixels are nearly free in bytes — a 2400x2400 line-art
  // scan is 39 KB — so the byte cap does not stand in for this one.
  const why = imageRejection({ name: "banner.png", bytes: 500_000, width: 9000, height: 3000 }, limits);
  assert.ok(why, "an over-dimension image must be rejected");
  assert.match(why, /banner\.png is 9000x3000 px/);
  assert.match(why, /8000 px/);
  // At the ceiling, not over it: published numbers have to be inclusive.
  assert.equal(
    imageRejection({ name: "ok.png", bytes: 500_000, width: 8000, height: 8000 }, limits),
    null,
  );
  // Unknown dimensions cannot reject anything.
  assert.equal(imageRejection({ name: "unknown.png", bytes: 500_000 }, limits), null);
});

test("size is reported before dimensions, because size is what nearly everything fails on", () => {
  const limits = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
  );
  const why = imageRejection({ name: "both.png", bytes: 6_300_000, width: 9000, height: 9000 }, limits);
  assert.ok(why);
  assert.match(why, /is 6 MB, over the 3\.7 MB limit/);
});

test("a rasterized PDF page is measured too, and says so as a page rather than a file", () => {
  const limits = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
  );
  // A letter page at the DPI Iris renders with. This is the case the old blanket PDF
  // exemption was reasoning from, and it is fine.
  assert.equal(
    rasterizedPageRejection("report.pdf", 1, { bytes: 400_000, width: 1275, height: 1650 }, limits),
    null,
  );
  // A large-format page at the same DPI is not: rasterizing at a fixed resolution means
  // the page image scales with the physical page.
  const why = rasterizedPageRejection(
    "drawing.pdf",
    7,
    { bytes: 5_000_000, width: 3600, height: 5400 },
    limits,
  );
  assert.ok(why, "an over-limit rendered page must be rejected");
  // Which page of which file — the caller uploaded one PDF and needs to know where.
  assert.match(why, /Page 7 of drawing\.pdf/);
  assert.match(why, /3600x5400 px/);
  assert.match(why, /3\.7 MB limit/);
  // The advice is the one the caller can act on. Telling them to re-save the image
  // would be wrong: they never chose these pixels, Iris did.
  assert.match(why, /page size/);
  assert.doesNotMatch(why, /1568 px/);
  // The dimension ceiling applies to a rendered page as well, and at the same value —
  // a 60-inch banner page rasterizes past it while staying light.
  const wide = rasterizedPageRejection(
    "banner.pdf",
    1,
    { bytes: 900_000, width: 9000, height: 4000 },
    limits,
  );
  assert.match(wide ?? "", /9000x4000 px, over the 8000 px/);
});

test("a heavy page that is NOT large-format is diagnosed as density, not page size", () => {
  const limits = resolveImageLimits(
    cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: SONNET_46 } }),
  );
  // The ordinary case, and the one the first version of this message got wrong: a
  // letter page of photographic or halftoned content, rendered as lossless 24-bit PNG,
  // passes the cap at 1275x1650. Advice about splitting fold-outs describes a document
  // the caller does not have and a fix they cannot apply — the message would be
  // contradicting the dimensions it prints two clauses earlier.
  const why = rasterizedPageRejection(
    "magazine.pdf",
    4,
    { bytes: 4_100_000, width: 1275, height: 1650 },
    limits,
  );
  assert.ok(why);
  assert.match(why, /Page 4 of magazine\.pdf renders to 3\.9 MB \(1275x1650 px\)/);
  assert.match(why, /density rather than page size/);
  assert.match(why, /JPEG/);
  assert.doesNotMatch(why, /fold-out/);
  // And the large-format case keeps its own explanation.
  const drawing = rasterizedPageRejection(
    "drawing.pdf",
    1,
    { bytes: 4_100_000, width: 3600, height: 5400 },
    limits,
  );
  assert.match(drawing ?? "", /fold-out/);
  assert.doesNotMatch(drawing ?? "", /density/);
  // And a page whose header would not parse claims neither: the message prints no
  // dimensions for it, so it must not go on to say what size the page is.
  const unmeasured = rasterizedPageRejection("odd.pdf", 2, { bytes: 4_100_000 }, limits);
  assert.ok(unmeasured);
  assert.doesNotMatch(unmeasured, /px/);
  assert.doesNotMatch(unmeasured, /The page is letter- or A4-sized/);
  // It still has to say both things the caller might act on.
  assert.match(unmeasured, /smaller page size/);
  assert.match(unmeasured, /JPEG/);
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

test("and says no more about an unrecognized one than that it is unrecognized", async () => {
  // Where the line sits, now that the hint qualifies itself. The assumed wording tells an
  // unauthenticated caller exactly one thing about the deployment: that Iris has no
  // published image limits for the model behind it. That is the price of not making a
  // promise about pixels that could be false, it is paid in the text a client is told to
  // quote rather than in a field of its own, and it must not grow into naming the model —
  // which is the whole reason `basis` is not published.
  const s = await serve(
    limitsRouter(
      cfg({ default: "bedrock", bedrock: { region: "us-east-1", default_model: QWEN_VL } }),
    ),
  );
  try {
    const raw = await (await s.get()).text();
    assert.match(raw, /assumed to read/); // the qualification is there
    assert.doesNotMatch(raw, /qwen/i);
    assert.doesNotMatch(raw, /bedrock/i);
    assert.doesNotMatch(raw, /us-east-1/);
    assert.doesNotMatch(raw, /claude/i); // nor which family the numbers came from
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
    // `file` is either a byte count (contents irrelevant) or the actual bytes, for a
    // case that turns on what the header says rather than on how much there is.
    post: async (name: string, file: number | Buffer, type = "image/png") => {
      const fd = new FormData();
      const bytes = typeof file === "number" ? new Uint8Array(file) : new Uint8Array(file);
      fd.append("images", new Blob([bytes], { type }), name);
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

test("an image the model would refuse for its dimensions is refused here instead", async () => {
  // Light enough to sail past the byte cap — 9000x3000 of line art is a few hundred
  // KB — and over the one ceiling the model errors on rather than downscaling. Without
  // reading the header this upload is accepted and dies inside the first vision call.
  const s = await serveUploads();
  try {
    const { status, message } = await s.post("wide.png", pngHeader(9000, 3000, 200_000));
    assert.equal(status, 400);
    assert.match(message, /wide\.png is 9000x3000 px/);
    assert.match(message, /8000 px/);
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
