# Accessibility at Equalify Iris

Equalify Iris helps people improve document accessibility. Accessibility is part of the product and of how we build and maintain it. We follow the [Open Source Accessibility Framework](https://open-source-accessibility.github.io/Open-Source-Accessibility-Framework/) as an incremental improvement process, not a certification.

## Priorities

- Make the Iris application usable with a keyboard and assistive technology.
- Make the HTML produced by Iris usable with semantic structure, meaningful text alternatives, and a logical reading order.
- Aim for WCAG 2.2 AA in relevant web interfaces and generated HTML; automated checks alone cannot demonstrate conformance.
- Make documentation, reporting, and contribution paths accessible.

## Report an accessibility barrier

[Open an accessibility issue](https://github.com/EqualifyEverything/equalify-iris/issues/new/choose). Describe the task you were trying to complete, what happened, what you expected, and steps to reproduce. Include browser, operating system, assistive technology, and screenshots or examples only if you are comfortable sharing them. Do not publish sensitive documents or personal information. If GitHub itself is inaccessible, contact a project maintainer through an alternative channel listed in the project README, if available.

Maintainers should acknowledge reports respectfully, apply the `accessibility` label, assess impact, and keep the issue updated. A **critical** barrier prevents a core task with no reasonable workaround; **serious** barriers substantially hinder it; **moderate** barriers make it difficult; **minor** barriers cause limited friction. Prioritize by user impact and available workarounds. Explain fixes and invite the reporter to verify them when practical. No response-time guarantee is currently established.

## Contributor expectations

- For changes to interfaces, check keyboard operation, visible focus, accessible names, logical reading order, errors, and screen reader output.
- For changes to generated HTML, verify headings, tables, images, links, language, and reading order with representative documents.
- Run `npm run typecheck`, `npm test`, and relevant accessibility checks. The demo's existing axe-core lint should report zero violations.
- For documentation, use descriptive links, meaningful headings, text alternatives, and plain language.
- Describe testing and any untested areas in pull requests. Track unresolved barriers in issues.

## Manual smoke tests

1. Using only a keyboard, navigate the demo, upload or select a document, start remediation, review output, and access results. Confirm focus is visible and no keyboard traps occur.
2. Repeat a representative flow with a screen reader (for example, NVDA with Firefox or VoiceOver with Safari). Check control names, announcements, status updates, and reading order.
3. Inspect generated HTML using keyboard navigation and a screen reader. Check heading hierarchy, table associations, alternative text, and meaningful link names.
4. Record the browser, operating system, assistive technology, versions, date, findings, and linked issues.

These are procedures to run, not claims that the listed environments have passed testing.

## Supported environments and known limitations

A verified support matrix has not yet been published. Record tested environments and known barriers in labeled [accessibility issues](https://github.com/EqualifyEverything/equalify-iris/issues?q=label%3Aaccessibility). The existing automated axe-core check covers only detectable classes of issues and does not replace manual testing. Report any additional barriers using the issue link above.

## Ownership and progress

**Accessibility owner:** [@bbertucc](https://github.com/bbertucc). The accessibility owner coordinates triage of accessibility reports, prioritizes barriers, reviews accessibility-related changes, and maintains this document and the project's accessibility progress tracking. Repository maintainers collaborate on fixes and reviews. A regular review cadence remains to be established. Follow progress through [accessibility issues](https://github.com/EqualifyEverything/equalify-iris/issues?q=label%3Aaccessibility) and project pull requests. This document should be updated as testing and support information become available.
