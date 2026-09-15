# PRD: tagged PDF output

**Status: proposal. Nothing in this document is built.**

This is a plan of work, written to be handed to a person or an AI agent and acted on. Everything in
it is a decision or an instruction. Where a decision is deliberately left open, it says so and says
who decides.

**Retire this file when the work lands.** Iris's design record is the git history, the issues each
decision cites, [design-notes.md](design-notes.md), [API.md](API.md) and the code. A requirements
document that outlives its build goes stale and starts lying; the last one here was retired for
exactly that reason. The final PR in this plan deletes this file and moves each surviving decision
into the doc whose job it is.

---

## 1. What we are building, in one sentence

Give Iris a second output: the **same PDF the user uploaded, now tagged for accessibility, carrying
any form data they entered, and visually identical to the original in every other respect**.

## 2. Who this is for

A person using a screen reader receives a PDF form — a benefits application, a permit, a school
registration. The PDF is untagged, so their screen reader reads it as a wall of unordered text, or
as nothing at all. They cannot fill it in.

Today Iris solves half of that. It converts the PDF into accessible HTML they can actually read. But
the agency wants **its form back**, on its own paper, with the boxes filled. An HTML transcript is
not a submission.

This feature closes the loop:

1. Upload the PDF to Iris. (works today)
2. Get accessible HTML back. (works today)
3. Fill in the fields — in the browser app, or through the API. (new)
4. Download a **tagged PDF**: the original document, with your answers in it, readable by a screen
   reader, and pixel-for-pixel the same page otherwise. (new)

Step 4 is the deliverable. Steps 3 and 4 are the work.

## 3. What "done" looks like

A maintainer can run this and get a file they would submit to a government agency:

```bash
curl -X POST http://localhost:8080/v1/sessions -F "images=@form.pdf"
# ... poll until ready_for_review, read the HTML, decide what to enter ...
curl -X POST http://localhost:8080/v1/sessions/$ID/pdf \
  -H 'Content-Type: application/json' \
  -d '{"values": {"applicant.name": "Ada Lovelace", "applicant.consent": true}}'
curl -o form_tagged.pdf http://localhost:8080/v1/sessions/$ID/pdf
```

And all five of these are true of `form_tagged.pdf`:

1. **It is tagged.** It has a structure tree whose reading order is the reading order Iris worked out,
   with headings as headings, tables as tables, lists as lists, and images with alt text.
2. **It carries the data.** `applicant.name` shows "Ada Lovelace" and the consent box is ticked.
3. **Nothing else moved.** Rendered at 150 DPI and compared to the original page by page, every pixel
   outside the filled fields is identical. This is checked by the tool itself, not asserted.
4. **It was produced on this machine.** No network call was made. No account was needed.
5. **It says what it could not do.** A machine-readable report lists every page, every field, and
   every thing the source file made impossible.

## 4. Non-goals

- **Not a PDF beautifier.** We do not re-flow, re-typeset, re-render, or "clean up" anything.
- **Not a PDF writer.** We never build a new PDF from the HTML. See §7.1 for why that is the wrong
  idea and not merely a different one.
- **Not a remediation suite.** We do not fix a source file's non-embedded fonts, broken ToUnicode
  tables or missing colour contrast. We report them.
- **Not for sessions that uploaded images.** No source PDF, no tagged PDF. Clear error, no fallback.
- **Not a service.** The new component is a library and a command. It listens on no port.

## 5. Constraints that cannot be traded

These come from Iris and apply to every line of this work.

- **Open source only.** Every dependency has an OSI-approved licence and a public source repository.
  No third-party API, no freemium tier, no "free for non-commercial", no account, no key.
- **AGPL-3.0-or-later.** The new repository is AGPLv3, same as Iris. Every dependency must be
  compatible with distributing it under AGPLv3.
- **One machine.** A laptop, a Mac Mini, a self-hosted box. No AWS, no GCP, no Azure, no hosted
  database, no object store.
- **No network at runtime.** The tagger makes zero outbound connections. This is testable, and §15
  requires the test.
- **Concise plain language in the docs.** [CONTRIBUTING.md § Documentation](../CONTRIBUTING.md#documentation)
  states the rules, and they cover everything this work writes.

## 6. Decision: a new repository

**Build this as a new repository — `equalify-iris-pdf` — that ships a library and a command-line
tool, plus a small, listed set of changes inside `equalify-iris`.**

### Why not a feature inside Iris

Iris's first stated constraint is "content only — no CSS, no visual fidelity, no pixel-perfect
layout". Tagging a PDF in place is nothing but coordinates and visual fidelity. It is the opposite
discipline, with an opposite test strategy: Iris's tests mock a model and assert on prose, and this
tool's tests take fixture PDFs and assert on bytes and pixels. Iris's CI would grow a PDF corpus, a
rasterizer comparison and eventually a Java validator, none of which any existing test needs.

### Why not a service

A second service breaks "one machine, no vendor lock-in" — another port, another config file,
another gate, another thing to deploy. Iris already shells out to a local binary (`pdftoppm`,
`pdfinfo`, `pdftohtml`) and degrades cleanly when it is missing. **`iris-pdf` is the fourth one.**
That pattern already exists in the codebase, an operator already installs poppler, and running the
work in a child process keeps Iris's single event loop free — which matters, because tagging a
25-page document is seconds of CPU and Iris serves every request on one thread.

### What lives where

| Repository | Holds | Knows about |
|---|---|---|
| `equalify-iris-pdf` (new) | Everything that touches a PDF's bytes: the structure tree, content-stream marking, form filling, pixel verification, the report | The shape of Iris's HTML. Nothing else about Iris — no config, no database, no HTTP, no model |
| `equalify-iris` (this repo) | Keeping the source PDF, reading the form fields out of it, telling the page agent about them, the endpoints, the browser UI | That `iris-pdf` exists and may not be installed |

The boundary is a pure function: **source PDF + per-page HTML + values → tagged PDF + report.** No
state, no clock, no network, no randomness. That is what makes it testable, and it is why this split
is worth two repositories instead of one.

---

## 7. How the tagging works

Read this section before writing any code. The method is the whole design.

### 7.0 What a tagged PDF is

A gloss, because the rest of this document assumes it.

A PDF page is a list of drawing instructions — "set this font", "draw these glyphs here", "paint this
image". Nothing in that list says which glyphs are a heading and which are a footnote, and nothing
says what order a human reads them in. A screen reader given only that list has to guess, and it
guesses from geometry, which is why an untagged two-column page is read straight across the columns.

A **tagged** PDF adds a second, parallel structure — the **structure tree** — that says: this run of
glyphs is an `H1`, this one is a `P` inside a `TD` inside a `Table`, they are read in this order, and
this image is a `Figure` whose alt text is "Organisation chart". The tree hangs off the document
catalog as `/StructTreeRoot`. It points into the page's drawing instructions using **marked content**:
the instructions get wrapped in `BDC`/`EMC` operators carrying a number (an **MCID**), and a structure
element names the page and the MCID. Anything on the page that is decoration rather than content —
a running head, a page number, a rule — is wrapped as an **artifact** instead, which tells a screen
reader to skip it.

`BDC`, `EMC` and `BMC` change nothing about rendering. They are bookkeeping. That is what makes this
whole feature possible: **you can add a full structure tree to a page without moving a single pixel.**

### 7.1 Why we do not re-render from the HTML

The obvious idea — take Iris's HTML, run it through an HTML-to-PDF renderer, ship that — is wrong,
and it is worth being explicit about because it is what everyone suggests first.

Iris's HTML is content-only **by design**. It has no CSS, no columns, no page geometry, no logos, no
signature rules, no boxes. A PDF rendered from it is a different document that happens to contain the
same words. Hand that to the agency and they reject it: it is not their form. The requirement is "no
other visible changes", and a re-render changes every visible thing there is.

So the original PDF is the substrate. The HTML is the map.

### 7.2 The method: artifact-and-overlay

For each page, in order:

1. **Mark the whole existing content stream as an artifact.** Prepend `/Artifact BMC` to the page's
   content and append `EMC`. No parsing: a valid page's content stream is already balanced with
   respect to `q`/`Q` and `BT`/`ET`, so a wrapper around all of it is properly nested by construction.
   If `/Contents` is an array of streams, prepend to the first and append to the last — the array is
   concatenated before interpretation.
2. **Get the page's words and where they sit.**
   - If the page has a text layer, take it from mupdf's structured text: every character with its
     origin, its quad, its font and its size.
   - If the page has no text layer (a scan), run Tesseract to get word boxes. The OCR text is used
     **only for positions**. See §7.4.
3. **Align those words to Iris's HTML for that page.** §7.5. The result is: for every element in the
   HTML, the list of word boxes on the page that element's text occupies.
4. **Append a new content stream** to the page holding an **invisible text layer**: text render mode
   3 (`3 Tr`), Iris's text, positioned and scaled to sit exactly over the word boxes from step 3. It
   draws nothing. It is selectable, searchable and readable by assistive technology.
5. **Mark that new stream up as you write it.** You author it, so you know exactly where every
   element begins and ends: emit `/P <</MCID 7>> BDC … EMC` around each run as you go. No content
   stream analysis is needed anywhere in this method.
6. **Build the structure tree** from Iris's HTML using the map in §8, pointing each element at the
   MCIDs you just wrote.
7. **Handle the non-text parts.** Images become `/Figure` elements with `/Alt` from the HTML's alt
   text, referencing the image by a marked-content id written into the overlay stream at the image's
   position. Link annotations get `/Link` elements. Form widgets get `/Form` elements. §8, §9.
8. **Set the document-level requirements.** §8.3.

Step 1 plus step 4 is the trick. Because the original content is an artifact and the accessible
content is something we wrote, we never have to understand, parse or modify anyone else's drawing
instructions. That removes the single hardest and most fragile part of building a tagger.

### 7.3 The cost of this method, stated plainly

On a page that already had a text layer, the words now exist twice: once in the original content
(marked as an artifact) and once in the overlay (marked as content).

- **A conforming consumer sees them once.** Acrobat, NVDA, JAWS and VoiceOver read the structure tree
  and skip artifacts. That is what "artifact" means.
- **A naive text extractor sees them twice.** `pdftotext`, a plain `grep`-the-PDF script, and some
  simple in-browser viewers concatenate every text operator regardless of marking. Copying a
  paragraph in such a viewer can yield it doubled.

This is a real defect and it is the reason §17 (in-place tagging) exists. It is accepted for v1
because the alternative — parsing, decoding and rewriting arbitrary content streams — is the part of
this project most likely to produce a broken PDF, and shipping a working tagger for scanned documents
first is worth more than shipping nothing.

**v1 must print this caveat in the report** for every page where a text layer already existed, as
warning code `duplicate_text_layer`. Do not bury it.

### 7.4 Scanned pages

A scanned page has no text layer. It is one image. Iris's own corpus is mostly these, so this path is
not an edge case — it is the main one.

- Word boxes come from **Tesseract** (`tesseract <img> - tsv`), which gives one row per word with
  its bounding box and confidence.
- The **text** placed in the overlay is always **Iris's**, never Tesseract's. Tesseract supplies
  geometry; the vision model supplies the words. Where they disagree, Iris wins, because Iris is what
  the human reviewed and corrected.
- Render the page for OCR at 300 DPI, not the 150 DPI Iris uses for the vision model. OCR word boxes
  get meaningfully better and the image is thrown away afterwards.
- If Tesseract is not installed and a page has no text layer, that page **fails** with code
  `no_text_positions`. Do not fall back to a whole-page `/Figure` with the transcript in `/Alt`: a
  multi-kilobyte `/Alt` string is one unnavigable blob and several readers truncate it.
- `--ocr off` skips OCR entirely and fails such pages the same way. `--ocr required` fails the run if
  Tesseract is missing at all. `--ocr auto` (default) uses it when a page needs it and it is there.

### 7.5 Aligning HTML text to word boxes

This is the one genuinely fiddly algorithm. Specify it as its own module with its own tests.

**Input:** the page's word boxes in the page's own order, and the page's HTML fragment.

**Output:** for each text node in the HTML, the boxes it occupies; and for each box, the element that
claimed it or `null`.

**Method:**

1. Flatten the HTML fragment to a list of text runs, each carrying a path to its element. Reuse the
   thinking in `src/pipeline/flatten.ts` but not the code — this needs element identity, which the
   screen-reader view deliberately throws away.
2. Normalise both sides the same way: lower-case, strip accents for comparison only, collapse
   whitespace, drop soft hyphens, join a word the source broke at a line end (Iris already does this
   in `src/pipeline/hyphens.ts` — the same rule applies here in reverse).
3. Align the two token sequences with a standard sequence alignment (Needleman–Wunsch over words,
   or an anchor-and-recurse diff). Word-level, not character-level: the sequences are hundreds of
   tokens long, not tens of thousands, so an O(n·m) alignment is cheap and exact.
4. Reading order will differ between the two sides, and that is the point — Iris fixed the column
   order and the PDF's operator order did not. So align on **content**, and never assume the two
   orders match. A two-column page must produce a correct alignment; there is a fixture for it.

**What the alignment produces, and what each outcome means:**

| Outcome | Meaning | Action |
|---|---|---|
| Matched | The word is in both | Tag it as the element says |
| In HTML, not on the page | Iris added scaffolding — a `<caption>` it generated, an `[not legible]` marker, alt text | Emit it in the overlay at the position of its neighbours, tagged. It is content |
| On the page, not in HTML, **and** inside the top or bottom 10% of the page **or** matching the page's own number | Page furniture. Iris strips these deliberately (`src/pipeline/markers.ts`) | Already an artifact from step 1. Nothing to do. Count it in the report |
| On the page, not in HTML, **anywhere else** | Iris **lost content** | Warning `unmatched_text` with the page, the text and the box. Emit it in the overlay as a bare `/P` so it is not silently dropped |

That last row matters. The easy bug here is to treat every unmatched word as decoration, which
quietly deletes from the accessible document exactly the words the model missed. **Unmatched text
inside the body of the page is a reported failure, never an artifact.**

---

## 8. Mapping Iris's HTML to PDF structure

### 8.1 The element map

Implement as one table in one file. Anything not in the table maps to `P` and raises warning
`unmapped_element` naming the tag, so the gap shows up in a report instead of silently disappearing.

| Iris HTML | PDF structure type | Notes |
|---|---|---|
| document root | `Document` | One per PDF, the tree's only child of `/StructTreeRoot` |
| `<h1>`…`<h6>` | `H1`…`H6` | Iris lints heading order with axe-core before delivering (`src/pipeline/lint.ts`), so take the level as given |
| `<p>` | `P` | |
| `<ul>`, `<ol>` | `L` | `/ListNumbering` from the list type |
| `<li>` | `LI` | The bullet or number becomes `Lbl`; the rest becomes `LBody` |
| `<dl>` | `L` | `<dt>` → `Lbl`, `<dd>` → `LBody`, each pair in one `LI` |
| `<table>` | `Table` | `<caption>` → `Caption`. A table Iris joined across a page break (`src/pipeline/tables.ts`) stays one `Table` whose rows name two different pages. That is legal and correct |
| `<thead>`, `<tbody>`, `<tfoot>` | `THead`, `TBody`, `TFoot` | |
| `<tr>` | `TR` | |
| `<th>` | `TH` | Carry `scope` to `/Scope` (`Row`, `Column`, `Both`). Give every `TH` an `/ID` and every `TD` a `/Headers` array |
| `<td>` | `TD` | `colspan`/`rowspan` → `/ColSpan`/`/RowSpan` |
| `<figure>` | `Figure` | `<figcaption>` → `Caption`, as a sibling inside the `Figure` |
| `<img>` | `Figure` | `alt` → `/Alt`. `alt=""` → `/Artifact` instead, no structure element |
| `<a href>` | `Link` | §8.2 |
| `<blockquote>` | `BlockQuote` | |
| `<code>`, `<pre>` | `Code` | |
| `<form>` | `Form` per control, not per form | PDF has no container form type. The `<fieldset>`/`<legend>` becomes a `Sect` with `/T` from the legend |
| `<input>`, `<select>`, `<textarea>` | `Form` | §9 |
| `<label>` | — | Not an element of its own. Its text becomes the widget's `/TU` and the `Form` element's `/Alt` |
| `<hr role="doc-pagebreak">` | — | Not emitted. It is Iris's page separator, and a PDF already has pages |
| `<nav>`, `<aside>`, `<section>` | `Sect` | `aria-label` → `/T` |
| `<sup>` footnote reference | `Reference` | Target note → `Note` with an `/ID` |
| `lang` attribute anywhere | `/Lang` on that element | Only where it differs from the enclosing element |

### 8.2 Links

Iris already knows a PDF's links: `src/util/pdf.ts` extracts them and `src/pipeline/links.ts` feeds
them to the page agent and checks they came back. Use that.

A `Link` structure element's `/K` array holds the MCIDs of the link's text **and** an object
reference to the annotation:

```
<< /Type /StructElem /S /Link /P … /Pg …
   /K [ 12 << /Type /OBJR /Obj 47 0 R >> ] >>
```

Set `/Contents` on the annotation to the link's purpose (the HTML anchor text) — that is the
annotation's accessible name and untagged PDFs almost never have it. Give the annotation a
`/StructParent` pointing back through the number tree.

Internal links (`#fragment`) that Iris generated for footnotes and cross-references have no PDF
annotation behind them. Emit the `Reference`/`Note` pair from the table above and skip the
annotation. Do not invent a `/GoTo` annotation — that adds a clickable region the original page did
not have, which is a visible change on hover and a behavioural change on click.

### 8.3 Document-level requirements

All of these, every time:

- `/MarkInfo << /Marked true >>` in the catalog.
- `/StructTreeRoot` with `/K`, `/ParentTree`, `/ParentTreeNextKey`.
- `/StructParents` on every page dict, `/StructParent` on every annotation, and a `/ParentTree`
  number tree that resolves both. Page entries are arrays indexed by MCID; annotation entries are a
  single reference.
- `/Lang` on the catalog, from the HTML root's `lang`. Iris derives that carefully
  (`bodyLang` in `src/pipeline/assembly.ts`) and refuses to guess; if it refused, take the
  `--lang` argument, and if that is absent, fail with `no_document_language`. A wrong `/Lang` makes a
  screen reader read the document in the wrong accent, which is worse than being asked.
- `/ViewerPreferences << /DisplayDocTitle true >>`.
- A title, in both the document info dictionary and XMP `dc:title`. Use Iris's `<title>`, which
  already mirrors the uploaded filename (`src/util/outputNames.ts`).
- XMP metadata declaring PDF/UA-1: `pdfuaid:part` = 1.
- Every glyph the overlay draws comes from a font **embedded** in the output with a correct
  `/ToUnicode` CMap. Verify mupdf writes one; if it does not, write it (the format is small — a
  `begincmap`/`beginbfchar` stream). Pick the font by the document's script and embed a subset. A
  character with no glyph in the chosen font is warning `missing_glyph`, listing the characters — do
  not substitute and do not drop.

### 8.4 PDF/UA conformance: what we promise

**We promise a tagged PDF. We do not promise a PDF/UA-conformant PDF, because the source file can
make that impossible and we are not allowed to change how the page looks.**

Two examples. If the source embeds no font, PDF/UA fails and embedding one would change the
typeface. If the source's existing text has a broken `/ToUnicode` table, PDF/UA fails and fixing it
means re-encoding text we have marked as an artifact.

So the contract is: **every PDF/UA-1 clause we can satisfy without changing a pixel, we satisfy.
Every clause the source makes unreachable is named in the report, with which clause and why.** That
is a stronger promise than a conformance badge, because it is checkable and it never hides anything.

---

## 9. Forms

### 9.1 Field identity: how an HTML input maps to a PDF field

This is the crux of the feature and it is solved by copying a pattern Iris already has.

Iris extracts a PDF's link targets at upload time and hands them to the page agent as ground truth,
because a rasterized page cannot show where a link points. **A rasterized page cannot show a field's
name either.** So do exactly the same thing with form fields:

1. At upload, read the AcroForm (the PDF's interactive-form dictionary) and write
   `sessions/<id>/fields.json`, keyed by the page's processing order — the same shape and the same
   reason as the existing `links.json`.
2. Add a "Form fields on this page" section to the page agent's prompt, listing each field's fully
   qualified name, type, options and whether it is required.
3. Tell the agent to put the field's name in the `name` attribute of the `<input>` it emits for that
   field, exactly as given.
4. **Check deterministically that it did**, the way `missingLinks` checks links. A field name in the
   ground truth that appears in no `name` attribute in that page's HTML is a fidelity problem, fed
   back to the correction pass with the source image.

Why the model rather than a string substitution: deciding *which* transcribed label belongs to a
field rectangle is the same judgement the extraction is. The existing links code makes this argument
in full at the top of `src/pipeline/links.ts` — read it before you disagree with it.

Shape for radio groups and checkbox groups: `name` is the group's fully qualified name and `value` is
that option's export value.

### 9.2 The values contract

Values are a flat JSON object keyed by fully qualified field name. Types are fixed by field type,
not by the caller:

| Field type | JSON value | Rules |
|---|---|---|
| Text | string | Respect `/MaxLen`; a longer string is an error, never a silent truncation |
| Checkbox | boolean | **The tool resolves the on-state name** by reading the widget's `/AP /N` keys. Callers never send `"Yes"`, `"On"` or `"1"` |
| Radio group | string | Must be one of the widget's states. Anything else is an error naming the states |
| Combo / list box | string, or array when multi-select | Must be in `/Opt` unless the field is editable |
| Push button | — | Not settable. Error `field_not_settable` |
| Signature | — | Not settable. Warning `signature_field_skipped` |
| Read-only field | — | Skipped, counted in the report as `skippedReadOnly` |

Set values through mupdf's widget API (`setTextValue`, `setChoiceValue`, `toggle`), which regenerates
the appearance stream. Do **not** set `/NeedAppearances true` and hope: several viewers ignore it, and
a form whose values are invisible in Preview is a failed submission.

Every filled widget also gets:
- `/TU` set to the label text from the HTML — that is the accessible name a screen reader announces.
- A `Form` structure element containing an `/OBJR` reference to the widget, placed in the structure
  tree where the `<input>` sits in the HTML, so the field is read in the right place.
- `/StructParent` wired into the parent tree.

`/TU` is worth doing even when no value is set. A blank tagged form that announces its fields
correctly is already a large improvement on a blank untagged one.

### 9.3 Flattening

`--flatten` replaces the interactive fields with their drawn appearance and removes the widgets. Off
by default. Some agencies require a flattened submission and some require a live form; neither is our
call. When flattening, the `Form` structure elements become `P` elements carrying the same text, so
the values stay readable.

### 9.4 Forms with no AcroForm

A scanned form has ruled lines and boxes but no fields. There is nothing to set, so entered values
have nowhere to go without drawing them onto the page — and deciding where is guesswork.

**v1 refuses.** If values are supplied and the PDF has no matching field, fail with
`no_acroform_field` naming each value that had nowhere to go. Do not guess a position.

§17 describes the v2 feature that handles this properly.

---

## 10. The two guarantees, and how they are enforced

Both run inside the tool, before it writes anything. Both are on by default. Both fail the run rather
than warn.

### 10.1 Pixels

Render every page of the input and of the output with the same rasterizer (mupdf) at the same DPI
(150 by default, `--verify-dpi` to change) and compare.

- Outside the rectangles of fields whose values changed: **byte-identical pixels**, tolerance zero.
- Inside those rectangles: no constraint. That is where the data is.
- On failure: name the page, the count of differing pixels, and the bounding box of the difference.
  Write the two renderings next to the output path when `--verify-dump` is set, because the first
  thing anyone will want is to look at them.

This is what turns "no other visible changes" from a promise into a test. It also catches the whole
class of bugs where an unbalanced marked-content operator corrupts the graphics state.

### 10.2 Text

Extract the text of the input and of the output. Every word in the input must still be in the output.
Words may be added — the overlay adds Iris's text and the fields add values — but nothing may be
lost. On failure, name the page and the missing text.

Cheap, and it catches a content stream damaged in a way that happens to still render.

---

## 11. What we refuse, and what we say

Each refusal is a distinct exit reason with a distinct code. None of them is a crash and none is a
silent degradation.

| Situation | Code | Behaviour |
|---|---|---|
| Encrypted, no password supplied | `encrypted` | Refuse. `--password` accepts one |
| Encrypted with an owner password restricting modification | `permissions_denied` | Refuse. Do not circumvent it |
| Carries a digital signature | `signed` | Refuse by default; `--allow-signed` proceeds and the report says the signature is invalidated, because any change invalidates it |
| Dynamic XFA form | `xfa` | Refuse. The visible form is generated at open time and is not in the page content |
| No source PDF (session uploaded images) | `no_source_pdf` | Refuse |
| More than one PDF in the session | `multiple_sources` | Refuse in v1. §17 |
| A page has no text layer and no OCR available | `no_text_positions` | Fail that page, name it, continue only if `--partial` is set |
| Pixel check failed | `pixels_changed` | Refuse to write the output |
| Text check failed | `text_lost` | Refuse to write the output |
| More than 25 pages | `too_many_pages` | Refuse. Matches Iris's existing `MAX_PDF_PAGES` |

Save with an **incremental update** (mupdf `saveToBuffer` with the incremental option). The original
bytes stay in the file untouched and the changes are appended, so the change is auditable and nothing
in the original is re-compressed or re-encoded. Note the size cost in the report.

---

## 12. Dependencies and their licences

| What | Licence | Why | Runtime or build |
|---|---|---|---|
| **mupdf** (`mupdf` on npm, 1.28.x) | AGPL-3.0-or-later | The PDF engine. Full low-level object access (`newDictionary`, `addObject`, `addStream`, `getTrailer`), typed form widgets with appearance regeneration, per-character text positions, and a rasterizer for the pixel check. WASM, so no native build step | Runtime |
| **Tesseract** (`tesseract-ocr`) | Apache-2.0 | Word boxes on scanned pages. Invoked as a subprocess, like poppler | Runtime, optional |
| **veraPDF** | GPLv3+ / MPLv2 | The PDF/UA validator, for the conformance report and CI | Build and CI, optional |
| **poppler** | GPL-2.0-or-later | Already an Iris dependency. Not needed by the new tool | Iris only |

**On mupdf's licence.** It is AGPL-3.0-or-later, which is the same licence as Iris and therefore fine
here. It does mean neither Iris nor this tool can be combined into proprietary software — which is
already true of Iris, and is the point of choosing AGPL. Artifex also sells commercial MuPDF
licences; nothing in this plan needs one.

**Fallback if mupdf is rejected.** `@cantoo/pdf-lib` (MIT, actively maintained) for object-level work
plus `pdfjs-dist` (Apache-2.0) for text positions plus poppler for rendering. It is a permissive
stack and three dependencies instead of one, and pdf-lib has no form-appearance engine, so every
filled field's appearance stream would have to be drawn by hand. Choose it only if the AGPL of a
dependency is a real blocker for a real user. Note that the original `pdf-lib` (1.17.1, last released
2022) is not maintained; do not use it.

---

## 13. Repository A: `equalify-iris-pdf`

### 13.1 Layout

```
src/
  index.ts            # the library API: tag(), fields()
  cli.ts              # the iris-pdf command
  pdf/
    document.ts       # open, save incrementally, refusals from §11
    struct.ts         # StructTreeRoot, StructElem, ParentTree, MCID allocation
    content.ts        # artifact-wrap an existing stream; write the overlay stream
    fonts.ts          # pick, subset, embed; write ToUnicode
    widgets.ts        # AcroForm inventory, typed value setting, /TU, /OBJR
    metadata.ts       # XMP, /Lang, /ViewerPreferences, title
  html/
    parse.ts          # Iris's HTML -> an element tree with text runs
    map.ts            # the §8.1 table, and nothing else
  align/
    words.ts          # normalize + tokenize both sides
    align.ts          # the sequence alignment
    classify.ts       # matched / added / furniture / lost  (the §7.5 table)
  ocr/
    tesseract.ts      # subprocess, TSV parsing, "not installed" as a value not a throw
  verify/
    pixels.ts         # §10.1
    text.ts           # §10.2
    pdfua.ts          # veraPDF, optional
  report.ts           # the report type, and the only place it is built
test/
  fixtures/           # the corpus, §15
  *.test.ts
```

Node 24, TypeScript run directly through Node's type stripping, `node --test`. Same toolchain as
Iris, for the same reason: one runtime to install.

### 13.2 The command

```
iris-pdf tag --pdf <in.pdf> --pages <pages.json> [--values <values.json>] --out <out.pdf>
             [--report <report.json>] [--lang <bcp47>] [--title <text>]
             [--ocr auto|off|required] [--verify pixels,text|off] [--verify-dpi 150]
             [--flatten] [--password <pw>] [--allow-signed] [--partial] [--strict]

iris-pdf fields --pdf <in.pdf> [--json]
    # the AcroForm inventory: name, type, page, rect, options, required, readonly, maxlen.
    # This is what Iris calls at upload time. It is why Iris needs no PDF library of its own.

iris-pdf check --pdf <in.pdf>
    # veraPDF against PDF/UA-1, if veraPDF is installed. Exits 0 if it is not, saying so.
```

`pages.json`, the map from PDF page to Iris HTML:

```json
{ "pages": [ { "sourcePage": 1, "html": "<h1>Application</h1>…" } ] }
```

`sourcePage` is 1-based and refers to the **PDF's own page number**. Iris builds this file; see §14.2
for why the page number has to be carried explicitly and cannot be counted out of the HTML.

Exit codes: `0` success, `1` refused (§11), `2` verification failed, `3` bad arguments or unreadable
input. Every non-zero exit prints one line naming the code, and the full detail goes to the report.

### 13.3 The report

One JSON object. It is the feature's honesty surface, so it is a first-class output, not a log.

```json
{
  "tool": "iris-pdf 0.1.0",
  "source": { "pages": 4, "encrypted": false, "signed": false,
              "acroform": true, "xfa": false, "hadTextLayer": [1,2,3,4] },
  "pages": [ { "page": 1, "textSource": "pdf-text", "words": 412,
               "matched": 401, "addedFromHtml": 3, "furniture": 8,
               "lost": 0, "mcids": 214 } ],
  "structure": { "elements": 431,
                 "byType": { "P": 220, "H2": 12, "Table": 2, "Figure": 3,
                             "Link": 9, "Form": 22 } },
  "form": { "fields": 22, "set": 18, "skippedReadOnly": 2, "unresolved": [] },
  "verification": { "pixels": "identical-outside-fields", "differingPixels": 0,
                    "textPreserved": true },
  "pdfua": { "checked": true, "profile": "PDF/UA-1", "passed": false,
             "failures": [ { "clause": "7.21.4.2", "detail": "font Helvetica not embedded",
                             "inherited": true } ] },
  "warnings": [ { "code": "duplicate_text_layer", "page": 1 } ]
}
```

`"inherited": true` means the source file caused it and we could not fix it without changing a pixel.
That flag is what makes §8.4's promise checkable.

---

## 14. Repository B: changes inside `equalify-iris`

Six changes. Each is a separate PR.

### 14.1 Keep the source PDF

**Today Iris throws the uploaded PDF away.** `src/routes/sessions.ts` rasterizes it, writes the PNGs
into `input/`, and the original buffer goes out of scope. Nothing can be tagged later because nothing
was kept.

- Add `paths.sessionSource(id)` → `sessions/<id>/source/`, and write each uploaded PDF there as
  `<uploadIndex>__<sanitized name>.pdf`.
- Add `paths.sessionPageMap(id)` → `sessions/<id>/pages.json`, mapping each page's processing order
  to its source file and the page number inside it.
- Storage cost: a PDF is almost always smaller than the PNGs Iris already keeps for it. Note it in
  `config.example.yaml` under `storage` anyway.

### 14.2 The page map is not optional

Do not try to recover page numbers from the delivered HTML later. Two reasons, both load-bearing:

- A page the extractor accepted as blank emits **no** page-break marker
  (`src/pipeline/extraction.ts`), so counting markers undercounts pages.
- A marker's `aria-label` carries the page's **printed** number, which is not its position — a
  document numbered i, ii, 1, 2 is ordinary.

The per-page fragments in `sessions/<id>/fragments/final.json` carry `order`, which is what
everything else in Iris counts by. `pages.json` maps `order` to `sourcePage`. Build `pages.json` for
`iris-pdf` from those two.

### 14.3 Form fields as ground truth

New file `src/pipeline/fields.ts`, written as a sibling of `src/pipeline/links.ts`. Read that file
first; this one mirrors its structure, its prompt-section approach and its verification.

- At upload, call `iris-pdf fields` and write `sessions/<id>/fields.json`, keyed by page order.
- `pageFieldContext(fields)` returns the prompt section, the fields shown and the count dropped,
  exactly like `pageLinkContext`. Cap it the way links are capped, and log the truncation.
- `missingFields(html, fields)` returns the fields whose name reached no `name` attribute. Feed the
  result into the fidelity check in `src/pipeline/extraction.ts` next to `missingLinks`.
- Add the field rules to `agents/page.md`. The prompt already tells the model to render a fill-in
  block as a `<form>` with `<label>`/`<input>` and to transcribe a filled field as
  `<input readonly value="…">` — this adds "and put the field's name in `name`, exactly as listed".
- If `iris-pdf` is not installed, `fields.json` is simply absent. The page agent gets the prompt it
  gets today and the run is unaffected. Same degradation as poppler missing for links.

### 14.4 Endpoints

| Method & path | Purpose |
|---|---|
| `GET /v1/sessions/{id}/fields` | The form fields found in the source PDF: name, type, page, label, options, required, readonly, maxlen. What a client needs to build a fill UI without parsing HTML |
| `POST /v1/sessions/{id}/pdf` | Body `{"values": {…}}`, optional — a document with no form still gets tagged. Enqueues the job, `202` with its state |
| `GET /v1/sessions/{id}/pdf` | The tagged PDF. `409` while it is not ready, with the state. `Content-Disposition: attachment; filename="<base>_tagged.pdf"` |
| `GET /v1/sessions/{id}/pdf/report` | The §13.3 report |

- Gated by `server.api_token` like the rest of `/v1/sessions`.
- Runs on the **existing run queue** (`src/util/queue.ts`, `defaults.max_concurrent_runs`). That
  queue exists to bound what the machine is doing, and this is the machine doing something.
- The child process gets a timeout and its stderr goes to the run log. It writes the report to
  `--report`; Iris reads it from there and serves it unchanged.
- `GET /v1/sessions/{id}` gains `pdf` — `null`, or `{status, updated_at}`.
- `GET /v1/limits` gains `tagged_pdf: true|false`, so a client can hide the button on a deployment
  without the tool installed.
- Update [docs/API.md](API.md) in the same PR. That is the rule in
  [README § Working on Iris](../README.md#working-on-iris--including-if-you-are-an-ai-agent).

### 14.5 Config

```yaml
tagged_pdf:
  # Off unless the iris-pdf command is available. Blank means "find it on PATH".
  enabled: true
  command: iris-pdf
  # Refuse to write an output whose pages do not render identically to the source
  # outside the fields that were filled. Turning this off is not recommended and
  # the report says it was off.
  verify: true
  # Word boxes for pages with no text layer. auto = use Tesseract when a page needs
  # it and it is installed; required = fail the run if it is missing; off = never.
  ocr: auto
  # Validate against PDF/UA-1 with veraPDF and include the result in the report.
  # Off by default: it needs a Java runtime.
  pdfua_check: false
  # How long one document may take before the child process is killed.
  timeout_seconds: 300
```

### 14.6 The browser app

`public/demo.html` gains a third action next to "Download HTML":

- Render the fields from `GET /v1/sessions/{id}/fields` as a real HTML form, with the label Iris
  transcribed, the right control for the type, and `required` where the PDF says so.
- **The form must itself be accessible.** That is the whole point of this product and the demo page
  is already tested for it (`test/demo-a11y.test.ts`). Extend that test to cover the new form.
- "Download tagged PDF" posts the values and polls.
- Show the report's warnings in plain language. A user who learns their form came back with two
  fields unset needs to learn it here, not from the agency.

**The delivered HTML document does not change.** It stays a content-only document with no script and
no submit target. Filling happens in the app or through the API, never by turning the deliverable
into an application.

---

## 15. The test corpus

Without fixtures this project cannot be reviewed, so build the corpus first. Every fixture is a small
PDF committed to the repository, with a licence that permits redistribution — a US federal form
(public domain), a document the project generates itself, or an openly licensed sample. **No fixture
contains real personal data.**

| Fixture | Exercises |
|---|---|
| `text-simple.pdf` | Born-digital, one column, headings and paragraphs. The happy path |
| `text-two-column.pdf` | Reading order differs between the PDF's operator order and Iris's HTML. The alignment test that matters |
| `scan-300dpi.pdf` | Image-only. The OCR path |
| `scan-skewed.pdf` | Image-only, slightly rotated. Word boxes that do not sit on a grid |
| `form-acroform.pdf` | Text fields, checkboxes, a radio group, a combo box. The filling path |
| `form-flat.pdf` | A scanned form with ruled lines and no fields. Must refuse cleanly in v1 |
| `table-across-pages.pdf` | A table Iris joins across a page break, which must stay one `Table` |
| `links.pdf` | Link annotations, including one whose text wraps across two lines |
| `mixed.pdf` | Page 1 born-digital, page 2 scanned. Per-page method selection |
| `signed.pdf` | Must refuse unless `--allow-signed` |
| `encrypted.pdf` | Must refuse without `--password` |
| `cjk.pdf` | A non-Latin script. Font embedding and `/ToUnicode` |
| `blank-page.pdf` | A page Iris declares blank. No marker, no structure, no crash |

Each fixture ships with the Iris HTML for it, captured once and committed, so the tagger's tests need
no model and no network.

**One test asserts the no-network rule directly**: run the full corpus with outbound sockets stubbed
to throw, and fail if anything tries to open one. It is the cheapest possible guard on the constraint
that matters most to the people deploying this.

---

## 16. Build order

Each milestone ends with something that runs and something that is checked. Do not start the next one
until the previous one's exit criteria hold.

**M1 — Skeleton and refusals.** The repository, the CLI, `iris-pdf fields`, and every refusal in §11.
*Exit:* `iris-pdf fields --pdf form-acroform.pdf` prints the correct inventory; each refusal fixture
exits with its code and its one-line message.

**M2 — The structure writer.** `pdf/struct.ts`, `pdf/content.ts`, `pdf/metadata.ts`. Given a
hand-written mapping, produce a tagged PDF. No HTML, no alignment.
*Exit:* a fixture comes back with a valid `/StructTreeRoot`, a resolving `/ParentTree`, and pixels
identical to the input. Assert on the object graph, not on a byte hash.

**M3 — The pixel and text gates.** §10, wired into the CLI and on by default.
*Exit:* a deliberately corrupted content stream is caught and the output is not written.

**M4 — HTML mapping and alignment.** `html/`, `align/`. The §8.1 table and the §7.5 algorithm.
*Exit:* `text-simple.pdf` and `text-two-column.pdf` produce a structure tree whose reading order
matches the HTML, verified by walking the tree and comparing to the HTML's text order. The two-column
fixture is the one that proves it.

**M5 — Scanned pages.** `ocr/`, and the per-page method choice.
*Exit:* `scan-300dpi.pdf` produces selectable, tagged text carrying Iris's wording, not Tesseract's;
`mixed.pdf` uses a different method on each page; with Tesseract uninstalled the scanned page fails
with `no_text_positions` and the born-digital page still succeeds.

**M6 — Forms.** `pdf/widgets.ts`, the §9.2 contract, `/TU`, `Form` elements, `--flatten`.
*Exit:* `form-acroform.pdf` plus a values file comes back with the values visible, the fields
announced by name, and pixels identical outside the filled rectangles.

**M7 — Iris integration.** §14.1 to §14.4. Source PDF kept, page map, fields ground truth, endpoints.
*Exit:* `./test/e2e.sh` covers the full lifecycle — upload a PDF, convert, read fields, post values,
download a tagged PDF — against mocks, with no credentials.

**M8 — The app and the docs.** §14.6, `docs/API.md`, `docs/design-notes.md`, `config.example.yaml`,
the README's dependency line and further-reading table.
*Exit:* a person can do the whole thing at `http://localhost:8080/` with no API call; the demo
accessibility test passes with the new form; **this PRD is deleted.**

**M9 — Conformance.** veraPDF in CI over the corpus, `inherited` classification, the `pdfua` block of
the report.
*Exit:* every fixture's failures are either zero or marked inherited with a named clause.

M1–M6 are `equalify-iris-pdf`. M7–M8 are `equalify-iris`. M9 is both. M1–M3 and M4 can proceed in
parallel once the report type in M1 is fixed.

---

## 17. Deliberately deferred

Named so they are not re-discovered as gaps.

- **In-place tagging (v2).** Removes §7.3's duplicate text layer by marking the original text
  operators instead of overlaying new ones. Needs a content-stream tokenizer and a text-state tracker.
  The technique that avoids font metrics entirely: track only the explicit positioning operators
  (`Tm`, `Td`, `TD`, `T*`, `TL`), take the first text-showing operator's origin from them, and let
  mupdf's per-character origins supply the advance for each subsequent operator on the line. Do this
  only once v1 is in use and the corpus is real.
- **Filling a flat form (v2).** Create real AcroForm fields at detected blanks, then fill them. The
  rule that makes it safe: **a value may only be drawn where the original page has no ink**, which the
  §10.1 pixel machinery can check directly. Refuse anything else.
- **Multiple PDFs in one session (v2).** One tagged PDF per source, selected by
  `GET /v1/sessions/{id}/pdf?source=N`.
- **Building a PDF from uploaded images (v3).** Images become pages, overlay carries the text. Falls
  out of the v1 machinery nearly for free, but it invents a document rather than preserving one, so
  it is a separate decision.
- **PDF/UA-2.** Wait until veraPDF's PDF/UA-2 profile and reader support are both settled.

## 18. Privacy, and why it is in this document

**Entered form values are the most sensitive data Iris will ever hold.** A benefits application has a
name, an address, a date of birth, sometimes a national identity number. Today Iris holds documents
people chose to upload; after this change it holds what they typed into them.

Iris has no sign-in and no session isolation by design: `GET /v1/sessions` lists the deployment's
sessions, and a session id is all it takes to read one
([README](../README.md#one-github-identity-and-no-sign-in)). That is a defensible trade for a
document conversion service. It is a different trade once the session holds a filled form.

So this work carries five requirements, and they are not optional:

1. **Values never reach the run log.** Log that a field was set and its name. Never its value.
2. **Values never reach GitHub.** The contribution path files agent suggestions upstream under the
   deployment's own account. Nothing from `values.json` may enter an issue body, an agent draft or a
   regression fixture. Add a test that asserts it.
3. **Values never reach a model provider.** The tagger makes no model calls at all. But a feedback
   re-run re-extracts from the source images, and a page image of a form the user filled **in the
   PDF** already went to the provider today. State that plainly in the docs rather than implying more
   privacy than exists.
4. **`POST /v1/sessions/{id}/close` deletes `values.json` and the tagged PDF.** The HTML and the
   fixtures are what close is for; the personal data is not.
5. **The docs say to gate the deployment.** Any deployment accepting form data sets
   `server.api_token`. Say it in `config.example.yaml` next to `tagged_pdf.enabled`, where an
   operator turning this on will read it.

## 19. Open questions

Three, each with a default so nothing blocks on an answer.

1. **Does Iris store entered values at all, or only pass them through?** Storing them lets a user come
   back and re-download. Not storing them means requirement 4 above is free. *Default: do not store
   them.* The request body is used and dropped; a re-download needs the values again. A maintainer
   can overrule this.
2. **Should `/v1/sessions/{id}/fields` exist, or should clients parse the HTML?** The endpoint is more
   work and a second place field metadata lives. *Default: build it.* Asking every client to parse a
   document to find its form controls is how field identity gets guessed wrong.
3. **Is `iris-pdf` published to npm, or vendored?** Publishing is convenient; vendoring keeps the
   "one machine, nothing hosted" story absolute. *Default: publish, and document a vendored install
   too.* Iris already tolerates it being absent, so neither choice can break a deployment.
