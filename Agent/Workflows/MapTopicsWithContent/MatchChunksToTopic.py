from Workflows.MapTopicsWithContent.ChunkUtils import (
    get_chunks,
    is_garbage_chunk,
    clean_chunk,
)


# ── Thresholds ────────────────────────────────────────────────────────────────
UPPER_THRESHOLD      = 0.45   # bi-encoder: auto-accept above this
LOWER_THRESHOLD      = 0.28   # bi-encoder: drop below this (unless continuity prior fires)
CROSS_ENCODER_CUTOFF = 0.0    # cross-encoder logit: accept if >= this


def _pages_for_span(page_spans: list, span_start: int, span_end: int) -> list:
    """
    Returns the list of (source_hash, page_number) pairs whose page region
    overlaps the character range [span_start, span_end). page_spans must be a
    list of (character_offset, source_hash, page_number) tuples sorted ascending
    by offset; each page region runs from its offset up to the next span's
    offset. Empty (zero-width) page regions are still reported when a chunk
    straddles their offset, so an image-only slide sandwiched between text pages
    inherits its neighbours' topic placement.
    """
    overlapping_pages = []
    for span_index in range(len(page_spans)):
        page_offset, source_hash, page_number = page_spans[span_index]
        next_offset = page_spans[span_index + 1][0] if span_index + 1 < len(page_spans) else None

        if next_offset is not None and next_offset <= span_start:
            continue
        if page_offset >= span_end:
            break

        overlapping_pages.append((source_hash, page_number))

    return overlapping_pages


def match_chunks_to_topics(
    fullText: str,
    leaves: list[dict],
    topicStrings: list[str],
    topicEmbeddings,
    biEncoder      ,
    crossEncoder,
    chunkSize: int,
    page_spans: list = None,
) -> dict[int, list]:
    """
    Splits fullText into overlapping chunks, filters garbage, then assigns
    every surviving chunk to its best-matching topic via:
      - bi-encoder cosine similarity (fast, handles bulk)
      - cross-encoder re-ranking (precise, handles grey zone)
      - continuity prior (if previous chunk was a strong match for topic X
        and current chunk's own best match is also topic X, accept it even
        if the score is below LOWER_THRESHOLD)

    page_spans (optional) carries the page provenance of fullText so each
    surviving chunk records the source pages it was sliced from.

    Returns topicBuckets: {topicIndex: [{'chunkIndex': int, 'content': str, 'pages': list}]}
    """
    from sentence_transformers import SentenceTransformer, CrossEncoder, util
    from Workflows.MapTopicsWithContent.ChunkUtils import CHUNK_OVERLAP

    sorted_page_spans = sorted(page_spans, key=lambda span: span[0]) if page_spans else []
    chunk_step = max(chunkSize - CHUNK_OVERLAP, 1)

    rawChunks = get_chunks(fullText, chunkSize)
    print(f"\n  {len(rawChunks)} raw chunks (size={chunkSize}, overlap={CHUNK_OVERLAP}).")

    # chunkPages is kept parallel to chunks: chunkPages[i] is the page list of
    # the surviving chunk whose post-filter index is i.
    chunks, chunkPages, filteredCount = [], [], 0
    for raw_index, raw_chunk in enumerate(rawChunks):
        drop, _ = is_garbage_chunk(raw_chunk)
        if drop:
            filteredCount += 1
            continue
        chunks.append(clean_chunk(raw_chunk))
        chunk_start = raw_index * chunk_step
        chunkPages.append(_pages_for_span(sorted_page_spans, chunk_start, chunk_start + chunkSize))
    print(f"  {filteredCount} garbage chunks removed. {len(chunks)} chunks for matching.")

    if not chunks:
        print("  [WARN] No chunks remain after filtering.")
        return {i: [] for i in range(len(leaves))}

    print(f"  Encoding {len(chunks)} chunks ...")
    chunkEmbeddings = biEncoder.encode(
        [f"search_document: {c}" for c in chunks],
        convert_to_tensor=True,
        show_progress_bar=True,
    )

    simMatrix = util.cos_sim(chunkEmbeddings, topicEmbeddings)

    topicBuckets: dict[int, list[dict]] = {i: [] for i in range(len(leaves))}
    greyZone:  list[tuple[int, int, str]] = []
    dropped = 0

    # Tracks the topic index the previous chunk was strongly assigned to.
    prevStrongTopicIdx: int | None = None

    for i, chunk in enumerate(chunks):
        scores       = simMatrix[i]
        bestTopicIdx = int(scores.argmax())
        bestScore    = float(scores[bestTopicIdx])

        if bestScore < LOWER_THRESHOLD:
            if prevStrongTopicIdx is not None and bestTopicIdx == prevStrongTopicIdx:
                # Continuity prior — still mid-explanation of the same topic
                topicBuckets[bestTopicIdx].append({"chunkIndex": i, "content": chunk, "pages": chunkPages[i]})
                continue
            dropped += 1
            prevStrongTopicIdx = None
            continue

        if bestScore >= UPPER_THRESHOLD:
            topicBuckets[bestTopicIdx].append({"chunkIndex": i, "content": chunk, "pages": chunkPages[i]})
            prevStrongTopicIdx = bestTopicIdx
        else:
            greyZone.append((i, bestTopicIdx, chunk))
            # Grey-zone doesn't update the prior — not confident enough to anchor

    print(f"  {dropped} chunks dropped (score < {LOWER_THRESHOLD}). "
          f"{len(greyZone)} grey-zone chunks -> cross-encoder.")

    if greyZone:
        ceInputs = [(topicStrings[tIdx], content) for _, tIdx, content in greyZone]
        print(f"  Running cross-encoder on {len(ceInputs)} chunks ...")
        ceScores = crossEncoder.predict(ceInputs, show_progress_bar=True)
        accepted = 0
        for (cIdx, tIdx, content), score in zip(greyZone, ceScores):
            if float(score) >= CROSS_ENCODER_CUTOFF:
                topicBuckets[tIdx].append({"chunkIndex": cIdx, "content": content, "pages": chunkPages[cIdx]})
                accepted += 1
        print(f"  Cross-encoder: {accepted}/{len(greyZone)} grey-zone chunks accepted.")

    matched = sum(len(v) for v in topicBuckets.values())
    print(f"  Total chunks assigned: {matched} / {len(chunks)}")
    return topicBuckets