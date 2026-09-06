import { test } from "node:test";
import assert from "node:assert/strict";

import { extractLinks } from "../lib/webmention.js";

// A reply's target lives in a microformat property link (u-in-reply-to),
// which the theme renders inside .h-entry but OUTSIDE .e-content. The stored
// post content therefore does not contain it at all. Extracting from stored
// content yielded zero targets, the post was marked webmention-sent with
// nothing sent, and it was never retried.
const SITE = "https://rmendes.net";
const TARGET =
  "https://indiekit-demo.rmendes.net/articles/2026/09/06/pr-945-fix-endpoint-micropub-34ed11/";

const renderedPage = `
<html><body>
  <nav><a href="https://example.com/nav-should-be-ignored">nav</a></nav>
  <article class="h-entry">
    <a class="u-in-reply-to" href="${TARGET}">In reply to</a>
    <div class="e-content"><p>Nice fix.</p></div>
  </article>
</body></html>`;

// What the database holds for the same post: the body only.
const storedContent = `<p>Nice fix.</p>`;

test("the rendered page yields the reply target", () => {
  const links = extractLinks(renderedPage, SITE);
  assert.ok(links.includes(TARGET), `expected ${TARGET} in ${JSON.stringify(links)}`);
});

test("stored content alone yields nothing — the regression", () => {
  assert.deepEqual(extractLinks(storedContent, SITE), []);
});

test("links outside the h-entry are still ignored", () => {
  const links = extractLinks(renderedPage, SITE);
  assert.ok(!links.some((l) => l.includes("nav-should-be-ignored")));
});

test("same-host links are not targets", () => {
  const page = `<article class="h-entry">
    <a class="u-in-reply-to" href="${SITE}/notes/abc">self</a>
  </article>`;
  assert.deepEqual(extractLinks(page, SITE), []);
});
