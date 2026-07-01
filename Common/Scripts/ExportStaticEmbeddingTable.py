#!/usr/bin/env python3
"""
Export the static word->vector table the deck Chat mode loads in the browser.

This is a ONE-TIME, OFFLINE tool (needs internet + Python; NOT run by the app or
by setup.bat). It distills a small static embedding model over a word list,
reduces it to a compact dimension, quantizes to int8, and writes the three files
Main/ThirdParty/StaticEmbeddings/ expects:
    manifest.json   {"dimensions", "scale", "vocabSize", "version"}
    vocab.json      [lowercase word, ...]              (row order)
    vectors.int8.bin  Int8Array of vocabSize*dimensions (row-major)

The tokens are WHOLE lowercase words so they match StaticEmbedder.js's
[a-z0-9]+ tokenizer (words missing from the table fall back to hashing in the
browser, so the list only needs common + domain vocabulary).

Dependencies (install in a throwaway venv):
    pip install model2vec numpy scikit-learn

Usage:
    python Common/Scripts/ExportStaticEmbeddingTable.py \
        --word-list path/to/words.txt \
        --model minishlab/potion-base-8M \
        --dimensions 128

`words.txt` is one lowercase word per line (e.g. a frequency list of ~30-50k
English words plus any domain terms). If omitted, the script falls back to the
model's own most-frequent single-word vocabulary entries.

Model2Vec is MIT-licensed; only the resulting numeric table is vendored — no
runtime library ships to the client.
"""

import argparse
import json
import os
import re


REPOSITORY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUTPUT_DIRECTORY = os.path.join(REPOSITORY_ROOT, "Main", "ThirdParty", "StaticEmbeddings")
QUANTIZATION_SCALE = 127
TABLE_VERSION = 1
WORD_PATTERN = re.compile(r"^[a-z0-9]+$")


def load_word_list(word_list_path):
    words = []
    seen = set()
    with open(word_list_path, "r", encoding="utf-8") as word_file:
        for raw_line in word_file:
            word = raw_line.strip().lower()
            if not word or word in seen or not WORD_PATTERN.match(word):
                continue
            seen.add(word)
            words.append(word)
    return words


def reduce_dimensions(vectors, target_dimensions):
    import numpy

    if vectors.shape[1] <= target_dimensions:
        return vectors

    from sklearn.decomposition import PCA

    reducer = PCA(n_components=target_dimensions, random_state=0)
    return reducer.fit_transform(vectors)


def l2_normalize_rows(vectors):
    import numpy

    magnitudes = numpy.linalg.norm(vectors, axis=1, keepdims=True)
    magnitudes[magnitudes == 0] = 1.0
    return vectors / magnitudes


def main():
    parser = argparse.ArgumentParser(description="Export the deck-chat static embedding table.")
    parser.add_argument("--word-list", default=None, help="Path to a newline-delimited lowercase word list.")
    parser.add_argument("--model", default="minishlab/potion-base-8M", help="Model2Vec model id.")
    parser.add_argument("--dimensions", type=int, default=128, help="Target output dimensions (PCA-reduced).")
    arguments = parser.parse_args()

    import numpy
    from model2vec import StaticModel

    print(f"Loading model '{arguments.model}'...")
    model = StaticModel.from_pretrained(arguments.model)

    if arguments.word_list:
        words = load_word_list(arguments.word_list)
    else:
        # Fall back to single-word entries from the model's own tokenizer vocab.
        words = []
        seen = set()
        for token in model.tokenizer.get_vocab().keys():
            cleaned = token.lstrip("Ġ▁ ").lower()
            if WORD_PATTERN.match(cleaned) and cleaned not in seen:
                seen.add(cleaned)
                words.append(cleaned)

    if not words:
        raise SystemExit("No usable words to embed — provide --word-list.")

    print(f"Embedding {len(words)} words...")
    vectors = numpy.asarray(model.encode(words), dtype=numpy.float32)

    print(f"Reducing {vectors.shape[1]} -> {arguments.dimensions} dimensions...")
    vectors = reduce_dimensions(vectors, arguments.dimensions)
    vectors = l2_normalize_rows(vectors).astype(numpy.float32)

    quantized = numpy.clip(numpy.round(vectors * QUANTIZATION_SCALE), -127, 127).astype(numpy.int8)

    os.makedirs(OUTPUT_DIRECTORY, exist_ok=True)

    with open(os.path.join(OUTPUT_DIRECTORY, "vocab.json"), "w", encoding="utf-8") as vocab_file:
        json.dump(words, vocab_file, ensure_ascii=False)

    quantized.tofile(os.path.join(OUTPUT_DIRECTORY, "vectors.int8.bin"))

    manifest = {
        "dimensions": int(arguments.dimensions),
        "scale": QUANTIZATION_SCALE,
        "vocabSize": len(words),
        "version": TABLE_VERSION,
    }
    with open(os.path.join(OUTPUT_DIRECTORY, "manifest.json"), "w", encoding="utf-8") as manifest_file:
        json.dump(manifest, manifest_file, indent=2)

    size_megabytes = quantized.nbytes / (1024 * 1024)
    print(f"Wrote {len(words)} words x {arguments.dimensions} dims ({size_megabytes:.1f} MB) to {OUTPUT_DIRECTORY}")
    print("Run setup.bat --aggressive to copy the table into Dock/Static/.")


if __name__ == "__main__":
    main()
