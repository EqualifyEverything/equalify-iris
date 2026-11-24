# PDF remediation QA plan

## Purpose

Define a repeatable quality-assurance program for Iris PDF remediation. The
program will combine automated regression checks with structured human review
to produce PDFs that meet the relevant accessibility requirements, including
the Title II standard adopted by the organization.

This is a working document. Each criterion should eventually name its source
fixture(s), machine-verifiable assertion(s), human-review instruction(s),
severity, and owner.

## Test-source strategy

Use three complementary fixture sets:

1. **Industry conformance corpus.** The veraPDF corpus contains atomic,
   self-documented PDF/UA-1 and PDF/UA-2 cases, including tagged-PDF content.
   Use it for known pass/fail structural cases.
2. **Reference outputs.** The PDF Association PDF/UA-1 Reference Suite
   provides known-good examples of sophisticated tagged documents, including
   complex tables, forms, links, and scanned documents.
3. **Iris paired fixtures.** Maintain source-PDF to expected-output cases for
   issues Iris is expected to repair. These are the primary regression suite:
   industry corpora validate conformance rules, while paired fixtures test Iris
   behavior.

Every fixture must carry provenance, license, expected outcome, applicable
criteria IDs, and whether it is permitted in CI.

## Evaluation layers

| Layer | Question answered | Result |
| --- | --- | --- |
| Structural validation | Is the output technically well-formed and appropriately tagged? | Automated pass/fail findings |
| Behavioral regression | Did Iris perform the intended repair without regressions? | Automated source/output assertions |
| Human accessibility review | Does the result accurately communicate the document's meaning and intent? | Rubric score, findings, disposition |

An automated pass does not itself establish accessibility. Human review is
required whenever meaningful interpretation is involved.

## Alt text

Alt-text quality has two distinct concerns: retaining descriptions that already
exist and generating new descriptions where the input lacks them. They must be
measured independently.

### Alt-text retention

**Criterion:** If a meaningful figure in the original PDF has programmatically
associated alternative text, the output retains the same alternative text and
associates it with the corresponding output figure.

**Decorative-content criterion:** If an original image is decorative or
artifacted, the output preserves that treatment and does not introduce
unnecessary alternative text.

#### Automated checks

- Extract every input and output figure, its structure-tree location, `/Alt`
  value (if any), artifact/decorative treatment, page, bounding box, and an
  image/content fingerprint where available.
- Match each input figure to its output counterpart using stable structure
  identity first, then page/location and content similarity as fallbacks.
- Require exact alt-text equality after only explicitly allowed normalization
  (for example, PDF string encoding normalization).
- Fail on a missing alt value, changed value, reassignment to a different
  figure, lost decorative treatment, or unexpected new alt text on a
  decorative figure.
- Emit an inconclusive result rather than a pass when matching confidence is
  insufficient; route those cases to human review.

#### Human review

- Confirm the retained description still matches the rendered output image.
- Confirm it remains appropriate in its surrounding document context.
- Confirm that preserving the original description did not preserve an
  obviously misleading or obsolete description; record that as an input-quality
  finding, not an Iris retention defect.

### Alt-text generation

**Criterion:** If a meaningful figure lacks alternative text and generation is
enabled, the output attaches a concise, contextually accurate alternative-text
description to the correct figure.

**Abstention criterion:** If the figure's meaning cannot be established with
sufficient confidence, Iris flags it for review rather than generating a
potentially misleading description.

#### Automated checks

- Identify images and figures lacking alt text, then measure coverage of
  generated alternatives and correct programmatic attachment.
- Verify that decorative images are artifacted/decorative rather than given
  boilerplate descriptions.
- Detect empty, duplicate, generic, excessively long, or malformed generated
  text; flag prohibited patterns such as filename-only descriptions.
- Verify that a generated description is attached to the intended output
  figure, not merely present elsewhere in the structure tree.
- Record generation model/version, prompt/policy version, confidence, and
  routing decision for each generated description.
- Route low-confidence, visually complex, data-bearing, or policy-excluded
  figures to human review. These cases are not automated passes.

#### Human-review rubric

Reviewers score each generated description for:

1. **Accuracy:** It states only what the figure supports and does not invent
   details.
2. **Contextual usefulness:** It conveys the figure's relevant meaning for the
   surrounding text and task.
3. **Appropriate detail:** It is neither empty/boilerplate nor needlessly
   exhaustive.
4. **Non-redundancy:** It avoids restating information already available to the
   reader unless that repetition is needed to convey the figure's purpose.
5. **Correct classification:** Decorative, meaningful, complex, and
   review-required figures receive the proper treatment.

Record a reviewer disposition: accept, edit, reject/replace, or escalate. A
generated description is not quality-approved until this review has an
accepted disposition or a documented sampling policy explicitly permits it.

## Structural text and heading levels

The output structure tree must convey the document's logical text hierarchy,
not merely reproduce visual styling. Heading quality is assessed independently
from visual appearance: text that looks like a heading but is tagged as a
paragraph is a structural defect, and a visually plain but correctly structured
heading may be intentional.

### Criteria

**Text retention:** Text that is meaningful in the input remains available to
assistive technology in the output, in the intended reading order and without
unintended duplication, omission, or fragmentation.

**Heading semantics:** If source content represents a heading, the output tags
it as a heading with the appropriate level (`H1` through `H6`) and places it in
the correct logical reading order.

**Heading hierarchy:** Heading levels form a coherent document outline. A level
may not be skipped solely because of visual styling; exceptions must be
intentional and documented by the fixture or review record.

**Non-heading protection:** Body text, labels, table content, headers/footers,
and other non-heading content are not incorrectly promoted to headings.

### Automated checks

- Extract output structure-tree elements, marked-content references, text,
  page locations, and reading order; detect untagged meaningful text and text
  duplicated across structural elements.
- Compare source and output text inventories after documented normalization;
  flag unexpected textual loss, gain, repetition, or ordering changes.
- Verify every output heading uses a valid heading structure type and has a
  supported level representation.
- Build an output heading outline and flag multiple apparent document titles,
  missing top-level headings where the fixture expects one, skipped levels,
  empty headings, repeated headings, and heading tags applied to short
  boilerplate patterns.
- Compare expected heading text, level, and order against paired-fixture
  assertions. A fixture may explicitly permit a repair such as changing a
  visually styled paragraph into a semantic heading.
- Run structure and text-extraction checks with at least two independent
  consumers where practical, since a single extraction engine can mask parser-
  specific defects.

### Human review

- Read the document outline in a screen reader or structure-tree view and
  confirm it represents the author's intended hierarchy.
- Confirm headings describe the content that follows, distinguish sections
  effectively, and are not merely visual labels promoted by heuristic.
- Verify reading order for multi-column pages, sidebars, page-spanning
  headings, repeated page furniture, and layouts where geometry alone is
  ambiguous.
- Evaluate whether intentional level changes are comprehensible in context;
  record approved exceptions in the fixture metadata.

## Artifact removal

Artifacting removes non-meaningful visual material from the accessibility tree.
It is not a generic deletion operation: meaningful content must never be
artifacted simply because it resembles decoration.

### Criteria

**Decorative-content handling:** If content is purely decorative, repeated page
furniture, or otherwise irrelevant to the document's meaning, the output marks
it as an artifact or excludes it from the logical structure tree.

**Meaningful-content protection:** Meaningful text, images, data visualizations,
links, form controls, and content required to understand the document remain
available to assistive technology and are not artifacted.

**Repeated-content handling:** Repeated headers, footers, page numbers, and
watermarks are artifacted only when they do not carry information needed to use
or understand the document. Material exceptions, such as changing chapter
titles or legally required notices, remain semantic content.

### Automated checks

- Inventory tagged content, artifacts, and untagged marked content before and
  after remediation; identify changes in classification and structure-tree
  membership.
- Match input/output content by page, bounding box, text, and rendering
  fingerprint, then flag any meaningful-source candidate that became an
  artifact or disappeared from the accessibility tree.
- Detect likely repeated page furniture across pages and assert the expected
  treatment per paired fixture; do not treat repetition as sufficient evidence
  for artifacting.
- Verify that output artifacts are not referenced by the structure tree and
  that meaningful structural elements still resolve to marked content.
- Flag artifacted items that contain link annotations, form fields, data-like
  text, or figure/table structure for mandatory human review.
- Render source and output pages and compare visual content so that artifacting
  defects are separated from accidental visible-content deletion.

### Human review

- Review every artifact-removal decision that was based on semantic inference
  rather than an explicit input designation.
- Confirm decorative borders, logos, background images, and repeated furniture
  do not interrupt reading when using assistive technology.
- Confirm that page numbers, running heads, watermarks, labels, and repeated
  controls have not been hidden when they are meaningful in the document's
  context.
- Test representative pages with a screen reader to ensure the experience is
  quieter without becoming incomplete.

## References

- [W3C WCAG 2.2 Techniques for PDF](https://www.w3.org/WAI/WCAG22/Techniques/#pdf)

## Open decisions

- Define the organization-specific Title II conformance target and acceptance
  thresholds.
- Define when generated alt text may be sampled versus reviewed exhaustively.
- Define allowed text normalization for retention comparison.
- Establish fixture storage, licensing records, and CI execution limits.
- Map spreadsheet criteria to stable IDs and test ownership.
