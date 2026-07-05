# Static embedding table (deck Chat retrieval)

This folder holds the **vendored word→vector table** the deck Chat mode uses for
client-side semantic retrieval ([StaticEmbedder.js](../../Globals/Classes/Embeddings/StaticEmbedder.js)).
It is **data, not a library** — the encoder is our own ~200 lines of plain JS; no
WASM, no third-party runtime, no neural network. Everything runs in the browser
(and on mobile) and adds **zero server load**.

## Files the loader expects

| File | What it is |
|------|------------|
| `manifest.json` | `{ "dimensions": <int>, "scale": <int>, "vocabSize": <int>, "version": <int> }` |
| `vocab.json` | JSON array of lowercase word tokens, one per row, in vector-row order |
| `vectors.int8.bin` | flat `Int8Array` of `vocabSize × dimensions` values (row-major), each = `round(value * scale)` |

The tokens MUST be **whole lowercase words** (matching `StaticEmbedder`'s
`[a-z0-9]+` tokenizer). Words not in the table fall back to the deterministic
hashing vector, so the table only needs to cover common + domain vocabulary.

## Until the table is committed: hashing fallback

If these files are absent (the default in a fresh checkout), `StaticEmbedder`
runs in **hashing mode** — every token maps to a deterministic vector. Chat
retrieval still works, but only on exact-word overlap (lexical), not synonyms.
Commit a real table (below) to get semantic retrieval. Nothing else changes.

## Generating the real table (one-time, offline)

Run [`Common/Scripts/ExportStaticEmbeddingTable.py`](../../../Common/Scripts/ExportStaticEmbeddingTable.py)
on a machine with internet + Python. It distills a small static model
(Model2Vec, MIT-licensed) over a word list, reduces it to a compact dimension,
quantizes to int8, and writes the three files above here. See the script header
for the exact command and dependencies. After it runs, `npm run setup`
copies the files into `Dock/Static/` like any other asset, and `StaticEmbedder`
auto-detects and loads them (no code change).

> Keep the table small (≈64–128 dims, ≈30–50k words → ~2–4 MB). Smaller
> dimensions are fine; the loader reads `dimensions`/`scale` from `manifest.json`.
