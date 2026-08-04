# QR Code generator

Encodes a string into a QR Code module matrix. Used by
[QrCodeRenderer](../../Globals/Classes/QrCodeRenderer.js) to draw the share code shown on a paid
deck's store page (`paid-deck-share-qr-panel`) and offered as a downloadable PNG.

| | |
|---|---|
| Version | 1.4.4 |
| File | `qrcode-generator-1.4.4.js` — the version is in the filename on purpose (see below) |
| Source | `https://unpkg.com/qrcode-generator@1.4.4/qrcode.js` (Kazuhiko Arase, `qrcode-generator` on npm) |
| License | MIT (full notice retained at the top of the file) |
| Global exposed | `qrcode` — a factory: `qrcode(typeNumber, errorCorrectionLevel)` |

Unmodified from upstream.

The library ends with a UMD-style tail that only registers with AMD `define` or CommonJS `exports`.
Neither exists in a plain `<script>` context, so under a classic script tag the top-level
`var qrcode = …` simply becomes the global. That is the load path used here.

Surface actually used: `qrcode(0, "M")` (0 = pick the smallest version that fits), `.addData(text)`,
`.make()`, `.getModuleCount()`, `.isDark(row, column)`. Nothing else, and in particular none of the
library's own `createImgTag` / `createSvgTag` helpers — the rendering lives in `QrCodeRenderer` so
the quiet zone, colours and integer pixel scaling are ours to control.

## Why it is lazy-loaded

The file is ~57 KB and only two screens in the whole application ever draw a QR code. Adding it to
`index.html` beside katex would put it on every cold start for a feature most sessions never touch.
`QrCodeRenderer` therefore injects it on demand, once, the first time a share panel renders — the
same pattern [GeneratedVisualRenderer](../../Globals/Classes/GeneratedVisualRenderer.js) uses for
Mermaid and SmilesDrawer.

## Upgrading

The filename carries the version so the file can be served `immutable` for a year
([StaticCachePolicy](../../../Dock/Endpoints/Plugins/StaticCachePolicy.js)). To upgrade: add the new
`qrcode-generator-<version>.js`, update `#QR_CODE_GENERATOR_SCRIPT_PATH` in
[QrCodeRenderer](../../Globals/Classes/QrCodeRenderer.js), delete the old file. The old URL stops
being requested, so no cache anywhere needs invalidating. **Do not** replace the contents of an
existing versioned filename — that is the one change caching cannot absorb.

## CSP

The library uses no `eval` and no `new Function`, so it runs under the strict policy in
[SecurityHeaders.js](../../../Dock/Endpoints/Plugins/SecurityHeaders.js) that drops `'unsafe-eval'`.
It also never touches `document` or `window`. Verified by inspection before vendoring; re-check on
any version bump.
