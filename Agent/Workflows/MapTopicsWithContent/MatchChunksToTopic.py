from Workflows.MapTopicsWithContent.ChunkUtils import (
    get_chunks,
    is_garbage_chunk,
    clean_chunk,
)


# ── Thresholds ────────────────────────────────────────────────────────────────
UPPER_THRESHOLD      = 0.45   # bi-encoder: auto-accept above this
LOWER_THRESHOLD      = 0.28   # bi-encoder: drop below this (unless continuity prior fires)
CROSS_ENCODER_CUTOFF = 0.0    # cross-encoder logit: accept if >= this


def match_chunks_to_topics(
    fullText: str,
    leaves: list[dict],
    topicStrings: list[str],
    topicEmbeddings,
    biEncoder      ,
    crossEncoder,
    chunkSize: int,
) -> dict[int, list]:
    """
    Splits fullText into overlapping chunks, filters garbage, then assigns
    every surviving chunk to its best-matching topic via:
      - bi-encoder cosine similarity (fast, handles bulk)
      - cross-encoder re-ranking (precise, handles grey zone)
      - continuity prior (if previous chunk was a strong match for topic X
        and current chunk's own best match is also topic X, accept it even
        if the score is below LOWER_THRESHOLD)

    Returns topicBuckets: {topicIndex: [{'chunkIndex': int, 'content': str}]}
    """
    from sentence_transformers import SentenceTransformer, CrossEncoder, util
    from Workflows.MapTopicsWithContent.ChunkUtils import CHUNK_OVERLAP
    rawChunks = get_chunks(fullText, chunkSize)
    print(f"\n  {len(rawChunks)} raw chunks (size={chunkSize}, overlap={CHUNK_OVERLAP}).")

    chunks, filteredCount = [], 0
    for c in rawChunks:
        drop, _ = is_garbage_chunk(c)
        if drop:
            filteredCount += 1
        else:
            chunks.append(clean_chunk(c))
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
                topicBuckets[bestTopicIdx].append({"chunkIndex": i, "content": chunk})
                continue
            dropped += 1
            prevStrongTopicIdx = None
            continue

        if bestScore >= UPPER_THRESHOLD:
            topicBuckets[bestTopicIdx].append({"chunkIndex": i, "content": chunk})
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
                topicBuckets[tIdx].append({"chunkIndex": cIdx, "content": content})
                accepted += 1
        print(f"  Cross-encoder: {accepted}/{len(greyZone)} grey-zone chunks accepted.")

    matched = sum(len(v) for v in topicBuckets.values())
    print(f"  Total chunks assigned: {matched} / {len(chunks)}")
    return topicBuckets