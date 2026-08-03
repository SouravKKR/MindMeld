# SmilesDrawer

Renders SMILES strings (chemical structure notation) into SVG. Used by
[GeneratedVisualRenderer](../../Globals/Classes/GeneratedVisualRenderer.js) to draw the
`<span class="smiles-structure" data-smiles="...">` markup that paid-deck generation emits for
`CHEMICAL_STRUCTURE` visuals.

| | |
|---|---|
| Version | 2.1.7 |
| Source | `https://cdn.jsdelivr.net/npm/smiles-drawer@2.1.7/dist/smiles-drawer.min.js` |
| License | MIT |
| Globals exposed | `SmiDrawer`, `SmilesDrawer` |

`SmiDrawer` is the attribute-driven API — it reads `data-smiles` directly, which is why the Agent
emits that attribute rather than element text.

## Local modification

The trailing `//# sourceMappingURL=` comment was removed. The `.map` file is not vendored, and
leaving the reference makes every load emit a 404 in devtools. Nothing else is changed from upstream.

## Loading

Not referenced from `index.html`. `GeneratedVisualRenderer` injects it on demand the first time a
study material actually contains a chemical structure, so decks without one never pay for it.
