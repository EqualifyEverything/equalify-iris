// The depth check that runs before every jsdom parse (#535). jsdom 30 parses deep documents in
// time that grows with the square of the depth, where jsdom 25 threw; this check keeps the throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceDepth, assertParseable, MAX_PARSE_DEPTH } from "../src/pipeline/parse-depth.ts";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";

test("plain nesting is counted exactly, and ordinary markup does not look deep", () => {
  assert.equal(sourceDepth("<div>".repeat(50)), 50);
  assert.equal(sourceDepth("<div><section><span>x</span></section></div>"), 3);
  // An end tag closes back to its match, so unclosed inline elements do not pile up.
  assert.equal(sourceDepth("<div><span>x</div>".repeat(1000)), 2);
  // A stray end tag closes nothing.
  assert.equal(sourceDepth("</div></div><div>x</div>"), 1);
  // Cells and paragraphs with no end tag, and void elements, are not counted.
  assert.equal(sourceDepth(`<table>${"<tr><td>a<td>b".repeat(5000)}</table>`), 1);
  assert.equal(sourceDepth("<p>a".repeat(5000)), 0);
  assert.equal(sourceDepth("<br>".repeat(600) + "<img alt=x><hr>"), 0);
  // Markup inside comments and raw-text elements is not markup.
  assert.equal(sourceDepth(`<!-- ${"<div>".repeat(100)} -->`), 0);
  assert.equal(sourceDepth(`<script>${"<div>".repeat(100)}</script><style>${"<b>".repeat(9)}</style>`), 0);
  // The parser's other recoveries do not pile up either (review of #549).
  assert.equal(sourceDepth(`<ul>${"<li><em>a</li>".repeat(5000)}</ul>`), 2);
  assert.equal(sourceDepth(`<table><tr>${"<td><b>a</td>".repeat(5000)}</table>`), 2);
  assert.equal(sourceDepth(`<div>${"<p><span>a</p>".repeat(5000)}</div>`), 2);
  assert.equal(sourceDepth("<a href=#>x".repeat(5000)), 1);
  assert.equal(sourceDepth(`<svg>${"<path/>".repeat(5000)}</svg>`), 1);
  assert.equal(sourceDepth(`<ul>${"<li><em>a".repeat(5000)}</ul>`), 2);
  assert.equal(sourceDepth("<h2>x".repeat(5000)), 1);
  assert.equal(sourceDepth("<button>x".repeat(5000)), 1);
  assert.equal(sourceDepth("<nobr>x".repeat(5000)), 1);
  // A nested list does not close the item it sits in.
  assert.equal(sourceDepth("<ul><li><ul><li><ul><li>x</ul></ul></ul>"), 3);
  // Tag names are case-insensitive, so `</DIV>` closes `<div>`.
  assert.equal(sourceDepth("<DIV>x</div>".repeat(50)), 1);
});

test("everything jsdom 25 could parse is still parsed, and deeper is refused", () => {
  // jsdom 25 parsed 10,000 levels and threw by 12,000. flatten.test.ts depends on 10,000.
  assert.doesNotThrow(() => assertParseable("<div>".repeat(10_000) + "<ul><li>x</ul>"));
  assert.doesNotThrow(() => assertParseable("<div>".repeat(MAX_PARSE_DEPTH)));
  assert.throws(() => assertParseable("<div>".repeat(MAX_PARSE_DEPTH + 1)), RangeError);
});

test("a document far too deep fails fast instead of hanging", async () => {
  // 200,000 levels took hours to parse on jsdom 30 with no check, and hung CI.
  const deep = "<div>".repeat(200_000);
  const start = Date.now();
  const lint = await runAxe(wrapDocument(deep));
  assert.equal(lint.errorWhere, "parse");
  assert.equal(lint.errorName, "RangeError");
  assert.ok(Date.now() - start < 2000, `refusing took ${Date.now() - start} ms`);
});
