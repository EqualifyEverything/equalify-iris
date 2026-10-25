// iris-pdf's detailed report (equalify-iris-pdf #52): asked for only when iris-pdf supports it, and
// only when the caller wants it (audit mode, routes/sessions.ts). An older iris-pdf refuses the flag,
// so asking one would fail every tagged PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supportsReportDetail, tagPdf } from "../src/util/taggedPdf.ts";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-iris-pdf.mjs");

async function tag(command: string, detail: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "iris-detail-"));
  try {
    writeFileSync(join(dir, "in.pdf"), "%PDF fake source");
    const { report } = await tagPdf(command, {
      pdfPath: join(dir, "in.pdf"),
      input: { pages: [{ sourcePage: 1, html: "<h1>Quarterly Report</h1>" }] },
      values: {},
      scratchRoot: join(dir, "tmp"),
      timeoutSeconds: 30,
      detail,
    });
    return report as { detail?: unknown };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the detailed report is asked for when wanted and supported, and not otherwise", async () => {
  assert.equal(supportsReportDetail(fake), true);
  assert.ok((await tag(fake, true)).detail, "detail asked for and returned");
  assert.equal((await tag(fake, false)).detail, undefined, "not asked for when not wanted");
});

test("an iris-pdf that does not know the flag is never sent it, so tagging still works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-old-pdf-"));
  try {
    // An older iris-pdf: its help has no --report-detail, and it exits 3 on the flag.
    const old = join(dir, "iris-pdf-old");
    writeFileSync(old, `#!/bin/sh\nFAKE_NO_DETAIL=1 exec node "${fake}" "$@"\n`);
    chmodSync(old, 0o755);
    assert.equal(supportsReportDetail(old), false);
    assert.equal((await tag(old, true)).detail, undefined, "tagged without the flag, and did not fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
