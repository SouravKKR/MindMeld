# Mermaid

Renders Mermaid diagram source into SVG. Used by
[GeneratedVisualRenderer](../../Globals/Classes/GeneratedVisualRenderer.js) to draw the
`<pre class="mermaid">` markup that paid-deck generation emits for `FLOW_OR_PROCESS` and
`HIERARCHY` visuals (reaction mechanisms, classification trees).

| | |
|---|---|
| Version | 11.4.1 |
| Source | `https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js` |
| License | MIT |
| Global exposed | `mermaid` (the bundle ends with `globalThis.mermaid = globalThis.__esbuild_esm_mermaid.default;`) |

Unmodified from upstream.

## Why it is lazy-loaded

This bundle is ~2.5 MB — it carries d3 and dagre. Adding it to `index.html` beside katex would put
that on every cold start of the app for a feature most decks never use.
`GeneratedVisualRenderer` therefore injects it on demand, only once a study material containing a
`pre.mermaid` block is actually rendered.

## CSP

The build uses no `eval` and no `new Function`, so it runs under the strict policy in
[SecurityHeaders.js](../../../Dock/Endpoints/Plugins/SecurityHeaders.js) that drops `'unsafe-eval'`.
Verified by inspection before vendoring; re-check on any version bump.
