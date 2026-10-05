// The tagline's tagged-PDF clause shows only where GET /v1/limits reports `tagged_pdf`.
//
// `loadLimits` is lifted out of the inline script, as in test/demo-tally.test.ts, and run
// against a stub `fetch` and a `$` that only finds ids present in the page. A renamed span
// would make `$` return null, and the throw would be swallowed with the limits hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const demoHtml = readFileSync(join(import.meta.dirname, "..", "public", "demo.html"), "utf8");

function extract(name: string): string {
  const start = demoHtml.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} is no longer in public/demo.html`);
  let depth = 0;
  for (let i = demoHtml.indexOf("{", start); i < demoHtml.length; i++) {
    if (demoHtml[i] === "{") depth++;
    else if (demoHtml[i] === "}" && --depth === 0) return demoHtml.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name} from public/demo.html`);
}

async function run(limits: unknown) {
  const els = new Map<string, { hidden: boolean; textContent: string; setAttribute: () => void }>();
  for (const m of demoHtml.matchAll(/<[a-z0-9]+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    els.set(m[1]!, { hidden: /\shidden[\s>]/.test(m[0]), textContent: "", setAttribute: () => {} });
  }
  const $ = (id: string) => els.get(id) ?? null;
  const fetch = async () => ({ ok: true, json: async () => limits });
  const body = `let taggedPdfOn = false, uploadLimits = null; ${extract("loadLimits")}; return loadLimits();`;
  await new Function("$", "fetch", "API", body)($, fetch, "/v1");
  return { clause: els.get("tagline-pdf"), hint: els.get("limits-hint")!.textContent };
}

test("the tagline names a tagged PDF only where the deployment makes one", async () => {
  assert.match(demoHtml, /<p class="tagline">[^<]*<span id="tagline-pdf" hidden>, and get the PDF back tagged<\/span>\.<\/p>/);
  const image = { max_bytes: 5, hint: "Up to 5 B.", media_types: ["image/png"] };
  const on = await run({ tagged_pdf: true, image });
  assert.equal(on.clause?.hidden, false);
  assert.equal(on.hint, "Up to 5 B.", "the toggle does not break the rest of loadLimits");
  assert.equal((await run({ tagged_pdf: false, image })).clause?.hidden, true);
  assert.equal((await run({ image })).clause?.hidden, true);
  assert.equal((await run({ tagged_pdf: true })).clause?.hidden, false, "even with no image limits");
});
