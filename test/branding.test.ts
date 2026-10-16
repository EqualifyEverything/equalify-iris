// The demo page's name and logo (#542).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAxe } from "../src/pipeline/lint.ts";
import { brandDemo, loadBrand } from "../src/branding.ts";
import type { IrisConfig } from "../src/config.ts";

const demoHtml = readFileSync(join(import.meta.dirname, "..", "public", "demo.html"), "utf8");
const cfg = (branding?: IrisConfig["branding"]) => ({ branding }) as IrisConfig;

test("with no branding the page is unchanged", () => {
  const brand = loadBrand(cfg());
  assert.deepEqual(brand, { name: "Equalify Iris - Uploader" });
  assert.equal(brandDemo(demoHtml, brand), demoHtml);
  // Blank env vars expand to "", which also means the default.
  assert.deepEqual(loadBrand(cfg({ name: "", logo_file: "" })), { name: "Equalify Iris - Uploader" });
});

test("a name replaces the title and heading, escaped", () => {
  const out = brandDemo(demoHtml, loadBrand(cfg({ name: "UIC <Equalify> Iris" })));
  assert.match(out, /<title>UIC &lt;Equalify&gt; Iris<\/title>/);
  assert.match(out, /<h1>UIC &lt;Equalify&gt; Iris<\/h1>/);
  assert.doesNotMatch(out, /<h1>Equalify Iris - Uploader<\/h1>/);
});

test("a logo goes left of the name, as a decorative image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-brand-"));
  const file = join(dir, "logo.png");
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const brand = loadBrand(cfg({ name: "UIC Equalify Iris", logo_file: file }));
  assert.equal(brand.logo?.type, "image/png");
  assert.equal(brand.logo?.bytes.length, 4);
  const out = brandDemo(demoHtml, brand);
  assert.match(out, /<h1><img class="brand-logo" src="\/brand-logo\?v=[0-9a-f]{12}" alt="">UIC Equalify Iris<\/h1>/);
  const lint = await runAxe(out);
  assert.equal(lint.error, undefined, `axe-core did not run: ${lint.error}`);
  assert.deepEqual(lint.violations, [], "the branded demo page has axe-core violations");
});

test("a logo that cannot be used is dropped with a warning", () => {
  const missing = loadBrand(cfg({ logo_file: "/nonexistent/logo.png" }));
  assert.equal(missing.logo, undefined);
  assert.match(missing.warning ?? "", /cannot be read/);
  const wrongType = loadBrand(cfg({ logo_file: "/tmp/logo.gif" }));
  assert.equal(wrongType.logo, undefined);
  assert.match(wrongType.warning ?? "", /must be/);
  assert.equal(loadBrand(cfg({ logo_file: "/tmp/logo.svg" })).logo, undefined, "SVG can run script");
});
