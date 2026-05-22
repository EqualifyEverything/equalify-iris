import assert from "node:assert/strict";
import {
  convertedHtmlFilename,
  outputBasenameFromInputName,
  sanitizeBasename,
} from "../src/util/outputNames.ts";

assert.equal(sanitizeBasename("Form123.pdf"), "Form123");
assert.equal(sanitizeBasename("Form123-p1.png"), "Form123");
assert.equal(convertedHtmlFilename("Form123"), "Form123_converted.html");
assert.equal(outputBasenameFromInputName("Form123.pdf"), "Form123");
assert.equal(outputBasenameFromInputName("weird name!.pdf"), "weird_name_");

console.log("outputNames.test.mjs passed");
