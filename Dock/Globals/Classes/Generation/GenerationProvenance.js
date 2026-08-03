/**
 * GenerationProvenance
 *
 * Extracts the set of uploaded-document content hashes that fed a generation
 * run, so the entities it produces can record where they came from.
 *
 * Why this exists, and deliberately what it is NOT. When a rightsholder asserts
 * that generated content reproduces their material, the platform needs to be
 * able to answer "what did we generate from this document". Before this, the
 * association existed only inside a transient task payload, so the question was
 * not answerable at all — not merely unimplemented, but inexpressible.
 *
 * This is a provenance record for INVESTIGATION, not a deletion trigger:
 *
 *   - Generated cards and study material that state facts in original wording
 *     are not reproductions. Facts are not copyrightable, so a takedown notice
 *     against a source document does not automatically reach them.
 *   - Provenance is many-to-many and lossy by nature. One study material can be
 *     synthesised from several uploads merged with web content, users edit the
 *     result through content overlays, and synced copies live on devices the
 *     server cannot reach. Treating this field as a complete lineage would be
 *     wrong.
 *
 * So the correct use is: given a notice, find the candidate entities, measure
 * how much of each is actually verbatim (SourceSimilarityScorer), and decide
 * per case. Automatic mass deletion keyed on this field would remove lawful
 * original content and would still miss content it could not attribute.
 */
class GenerationProvenance
{
    /**
     * Pulls the de-duplicated content hashes out of a generation run's
     * information sources.
     *
     * URL-backed and description-only sources contribute no hash — only
     * uploaded documents are content-addressed — so they are skipped rather
     * than recorded as empty entries.
     *
     * @param {GeneralGenerationSettings|null} generalGenerationSettings
     * @return {string[]} Content hashes, de-duplicated. Empty when the run used no uploads.
     */
    static extractSourceContentHashes(generalGenerationSettings)
    {
        if (!generalGenerationSettings || typeof generalGenerationSettings.getInformationSources !== "function")
        {
            return [];
        }

        const informationSources = generalGenerationSettings.getInformationSources() || [];
        const contentHashes = [];

        for (const extractableSource of informationSources)
        {
            const informationSource = GenerationProvenance.#resolveInformationSource(extractableSource);
            if (informationSource === null)
            {
                continue;
            }

            const contentHash = typeof informationSource.getHash === "function"
                ? informationSource.getHash()
                : informationSource.hash;

            if (typeof contentHash === "string" && contentHash.length > 0 && !contentHashes.includes(contentHash))
            {
                contentHashes.push(contentHash);
            }
        }

        return contentHashes;
    }

    /**
     * An information source arrives wrapped in an ExtractableInformationSource
     * (which pairs it with page ranges), but some call paths pass the bare
     * source. Accept either rather than depending on the caller's shape.
     */
    static #resolveInformationSource(extractableSource)
    {
        if (!extractableSource || typeof extractableSource !== "object")
        {
            return null;
        }

        if (typeof extractableSource.getInformationSource === "function")
        {
            return extractableSource.getInformationSource() || null;
        }

        if (extractableSource.informationSource)
        {
            return extractableSource.informationSource;
        }

        return extractableSource;
    }

    /**
     * Merges the provenance hashes into an entity's additionalData, leaving it
     * untouched when the run used no uploaded documents so a purely web- or
     * description-driven generation does not carry an empty marker.
     *
     * @param {object|undefined} existingAdditionalData
     * @param {string[]} sourceContentHashes
     * @return {object} additionalData with provenance applied.
     */
    static applyTo(existingAdditionalData, sourceContentHashes)
    {
        const additionalData = { ...(existingAdditionalData ?? {}) };

        if (Array.isArray(sourceContentHashes) && sourceContentHashes.length > 0)
        {
            additionalData[GenerationProvenance.SOURCE_CONTENT_HASHES_FIELD] = sourceContentHashes;
        }

        return additionalData;
    }

    static SOURCE_CONTENT_HASHES_FIELD = "sourceContentHashes";
}

module.exports = GenerationProvenance;
