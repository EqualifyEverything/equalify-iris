import assert from "node:assert/strict";
import {
  convertedHtmlFilename,
  filledPdfFilename,
  outputBasenameFromUploads,
  sanitizeBasename,
} from "../src/util/outputNames.ts";

assert.equal(sanitizeBasename("Form123.pdf"), "Form123");
assert.equal(convertedHtmlFilename("Form123"), "Form123_converted.html");
assert.equal(filledPdfFilename("Form123"), "Form123_filled.pdf");
assert.equal(outputBasenameFromUploads([{ originalname: "Form123.pdf" }]), "Form123");
assert.equal(outputBasenameFromUploads([{ originalname: "weird name!.pdf" }]), "weird_name_");

console.log("outputNames.test.mjs passed");
