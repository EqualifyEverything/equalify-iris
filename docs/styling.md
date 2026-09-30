# Where styling comes from

Iris is the engine. Its HTML has no styling, on purpose. The tools that use Iris add the styling.

## What Iris outputs

- **Content and structure only.** Headings, lists, tables, links, alt text and reading order.
  These are what make a document accessible.
- **No styling.** The document shell has no stylesheet. `agents/page.md` tells the model to write no
  `style` attribute, no class and no `<style>` element.
- **`style` attributes are removed.** If a model writes one anyway, Iris takes it out and logs a
  [`page_style_attributes`](API.md#page_style_attributes) event.

The demo's "View converted document" button opens this output as it is, so it looks plain. That is
the engine's output, not what a reader sees on a site that uses Iris.

## Why

- The same document is shown in many places: a WordPress site, a course in Canvas, a Drupal page, a
  download. Each has its own theme. Styling that suits one would clash with the others.
- The reader's own settings should apply, such as high-contrast mode, text size and reader view.
  Styling baked into the document can get in their way.
- Content is where accessibility is won or lost. Keeping Iris to content keeps its checks (axe,
  the reader, the copy editor) on the part that matters.

## Who adds it

A tool that uses Iris adds the styling and any extra page elements, to help people find and read
the document where it lives.

- **[equalify-iris-wp](https://github.com/EqualifyEverything/equalify-iris-wp)**, the WordPress
  plugin, publishes each converted PDF as a page. It adds:
  - a title bar
  - a Contents panel
  - an "About this accessible version" panel, with a link to the original PDF
  - an icon next to each PDF link on the site
  - its own stylesheet, which styles those additions and leaves the document to the site's theme
- **Canvas, Drupal or another platform.** An integration for any of these should do the same: add
  its own page elements and styling, and leave Iris's HTML as it is.

## If you want the output styled

Add the styling in your integration, not in Iris. Please don't change an agent's prompt to make it
write styling: Iris removes styling on purpose, and a review will ask for it to come out.
