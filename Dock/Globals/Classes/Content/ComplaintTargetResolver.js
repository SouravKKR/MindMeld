const InformationSourceQueryEngine = require("../Database/InformationSourceQueryEngine");
const GenerationProvenanceQueryEngine = require("../Database/GenerationProvenanceQueryEngine");
const PaidDeckProvenanceLinkResolver = require("../Generation/PaidDeckProvenanceLinkResolver");
const ContentTakedownNoticeQueryEngine = require("../Database/ContentTakedownNoticeQueryEngine");
const IntellectualPropertyComplaintConstants = require("../../Constants/IntellectualPropertyComplaintConstants");

/**
 * ComplaintTargetResolver — turns what a complainant can actually tell us into
 * what the takedown endpoint actually accepts.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * /Admin/Content/Takedown takes a sha512 content hash and nothing else. That is
 * the right key — storage is content-addressed, and one hash is what reaches
 * every tenant holding a copy — but it is a key no rightsholder can produce. A
 * complainant knows the title of their book and roughly where on the platform
 * they saw it. Before this class, the machinery to honour a notice existed and
 * the notice could not be connected to it, which in practice meant it could not
 * be honoured at all.
 *
 * ── Two modes, because complaints arrive in two shapes ─────────────────────
 *
 * BY NAMED ENTITY. The complainant (or the administrator reading their
 * description) can point at a specific deck or paid-deck listing. That resolves
 * through the generation provenance to the documents the content was made from,
 * and their hashes are exact rather than guessed.
 *
 * BY WORK DESCRIPTION. Nothing is named, only the work. Uploaded documents are
 * searched by name, because a user's upload is usually called what the book is
 * called. This mode returns CANDIDATES and says so — it is a search result, not
 * an identification.
 *
 * ── Nothing here removes anything ──────────────────────────────────────────
 *
 * This class only reads. Every candidate it returns goes in front of a person,
 * who runs the dry run and then decides. That is deliberate and should stay
 * that way: a takedown is irreversible, it crosses the tenant boundary, and the
 * highest-confidence input this resolver ever has is still a substring match on
 * a file name somebody typed.
 *
 * Prior notices are attached to each candidate so an administrator can see at a
 * glance that content has already been actioned, rather than re-actioning it and
 * recording a second removal of something already gone.
 */
class ComplaintTargetResolver
{
    /**
     * Resolves every candidate for one complaint, from whichever of its fields
     * carry information.
     *
     * Runs both modes when both are possible and merges them, rather than
     * stopping at the first that returns something. A complainant who named a
     * deck AND described the work has told us two things, and an administrator
     * seeing only one of them would be reading a narrower notice than the one
     * that was sent.
     *
     * @param {import("../../Model/IntellectualPropertyComplaint")} complaint
     * @returns {Promise<{candidates: Array<object>, byEntityCount: number, bySearchCount: number}>}
     */
    static async resolve(complaint)
    {
        const candidatesByHash = new Map();

        const entityCandidates = await ComplaintTargetResolver.resolveByNamedEntity(complaint);
        for (const candidate of entityCandidates)
        {
            candidatesByHash.set(candidate.contentHash, candidate);
        }

        const searchCandidates = await ComplaintTargetResolver.resolveByWorkDescription(complaint.getWorkDescription());
        for (const candidate of searchCandidates)
        {
            // A hash reached BOTH ways keeps its named-entity provenance — that
            // is the stronger statement of the two, and losing it here would
            // downgrade an exact match to "matched a file name".
            if (!candidatesByHash.has(candidate.contentHash))
            {
                candidatesByHash.set(candidate.contentHash, candidate);
            }
        }

        const candidates = [...candidatesByHash.values()];

        await ComplaintTargetResolver.#attachPriorNotices(candidates);

        return {
            candidates: candidates,
            byEntityCount: entityCandidates.length,
            bySearchCount: searchCandidates.length
        };
    }

    /**
     * Mode one: the complaint names a deck or a paid-deck listing.
     *
     * Every provenance record for the deck is read, not just the newest. A deck
     * can be the target of several generation runs, and all of them govern what
     * is in it — reading only one would resolve a complaint against half the
     * content and report success.
     *
     * @param {import("../../Model/IntellectualPropertyComplaint")} complaint
     * @returns {Promise<Array<object>>}
     */
    static async resolveByNamedEntity(complaint)
    {
        const candidates = [];
        const seenHashes = new Set();

        const deckIdsToInspect = [];

        if (complaint.getPaidDeckId().length > 0)
        {
            try
            {
                // A listing id is not the deck id its provenance is filed under.
                // This bridge is the same one every other admin surface uses;
                // querying provenance with the listing id directly matches
                // nothing, by construction.
                const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(complaint.getPaidDeckId());

                if (provenanceDeckId.length > 0)
                {
                    deckIdsToInspect.push(provenanceDeckId);
                }
            }
            catch (linkError)
            {
                console.warn(`[ComplaintTargetResolver] Could not resolve the paid-deck link for ${complaint.getReference()}: ${linkError?.message || linkError}`);
            }
        }

        if (complaint.getDeckId().length > 0)
        {
            try
            {
                deckIdsToInspect.push(await PaidDeckProvenanceLinkResolver.resolveForDeckId(complaint.getDeckId()));
            }
            catch (linkError)
            {
                deckIdsToInspect.push(complaint.getDeckId());
            }
        }

        for (const deckId of [...new Set(deckIdsToInspect.filter(deckId => typeof deckId === "string" && deckId.length > 0))])
        {
            let provenanceRecords = [];

            try
            {
                provenanceRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(deckId);
            }
            catch (provenanceError)
            {
                console.warn(`[ComplaintTargetResolver] Could not read provenance for deck ${deckId}: ${provenanceError?.message || provenanceError}`);
                continue;
            }

            for (const provenanceRecord of (provenanceRecords || []))
            {
                for (const source of (provenanceRecord.sources || []))
                {
                    const contentHash = typeof source?.contentHash === "string" ? source.contentHash : "";

                    if (contentHash.length === 0 || seenHashes.has(contentHash))
                    {
                        continue;
                    }

                    seenHashes.add(contentHash);

                    candidates.push
                    ({
                        contentHash: contentHash,
                        names: [source.name].filter(Boolean),
                        matchedVia: ComplaintTargetResolver.MATCHED_VIA_NAMED_ENTITY,
                        // Named so the administrator can see WHICH deck and which
                        // run put this document in front of them, rather than a
                        // hash with no story attached.
                        deckId: deckId,
                        deckName: provenanceRecord.deckName || "",
                        mainTaskId: provenanceRecord.mainTaskId || "",
                        holderCount: null,
                        priorNoticeCount: 0
                    });
                }
            }
        }

        return candidates;
    }

    /**
     * Mode two: nothing is named, so uploaded documents are searched by name.
     *
     * @param {string} workDescription
     * @returns {Promise<Array<object>>}
     */
    static async resolveByWorkDescription(workDescription)
    {
        const searchTerms = ComplaintTargetResolver.extractSearchTerms(workDescription);

        if (searchTerms.length === 0)
        {
            return [];
        }

        const candidatesByHash = new Map();

        for (const searchTerm of searchTerms)
        {
            let matches = [];

            try
            {
                matches = await InformationSourceQueryEngine.findDistinctDocumentsByNameSearch(
                    searchTerm,
                    IntellectualPropertyComplaintConstants.TARGET_RESOLUTION_CANDIDATE_LIMIT);
            }
            catch (searchError)
            {
                console.warn(`[ComplaintTargetResolver] Document search failed for "${searchTerm}": ${searchError?.message || searchError}`);
                continue;
            }

            for (const match of matches)
            {
                if (candidatesByHash.has(match.contentHash))
                {
                    continue;
                }

                candidatesByHash.set(match.contentHash,
                {
                    contentHash: match.contentHash,
                    names: match.names || [],
                    matchedVia: ComplaintTargetResolver.MATCHED_VIA_NAME_SEARCH,
                    matchedTerm: searchTerm,
                    deckId: "",
                    deckName: "",
                    mainTaskId: "",
                    // How many accounts hold a copy. Shown because it is the
                    // blast radius of actioning this candidate, and an
                    // administrator should see it before, not after.
                    holderCount: match.holderCount,
                    priorNoticeCount: 0
                });
            }

            if (candidatesByHash.size >= IntellectualPropertyComplaintConstants.TARGET_RESOLUTION_CANDIDATE_LIMIT)
            {
                break;
            }
        }

        return [...candidatesByHash.values()];
    }

    /**
     * Pulls the phrases worth searching out of a complainant's prose.
     *
     * Quoted spans first, because a complainant writing about a title usually
     * quotes it and that is the most precise thing in the whole complaint.
     * Failing that, runs of capitalised words — the shape a book title takes in
     * a sentence. Failing both, the longest few words, which is a weak signal
     * and is treated as one: everything this produces is a search that a person
     * then reads.
     *
     * @param {string} workDescription
     * @returns {string[]}
     */
    static extractSearchTerms(workDescription)
    {
        const description = String(workDescription ?? "").trim();

        if (description.length === 0)
        {
            return [];
        }

        const quotedSpans = [...description.matchAll(/["“”'‘’]([^"“”'‘’]{3,120})["“”'‘’]/g)].map(match => match[1].trim());

        if (quotedSpans.length > 0)
        {
            return ComplaintTargetResolver.#dedupeTerms(quotedSpans);
        }

        const capitalisedRuns = [...description.matchAll(/\b([A-Z][\w'’-]*(?:\s+(?:of|the|and|in|for|to|a|an)?\s*[A-Z][\w'’-]*){1,6})/g)]
            .map(match => match[1].trim())
            .filter(term => term.length >= 6);

        if (capitalisedRuns.length > 0)
        {
            return ComplaintTargetResolver.#dedupeTerms(capitalisedRuns).slice(0, ComplaintTargetResolver.MAXIMUM_SEARCH_TERMS);
        }

        const longWords = description
            .split(/[^\w'’-]+/)
            .filter(word => word.length >= 6)
            .sort((firstWord, secondWord) => secondWord.length - firstWord.length);

        return ComplaintTargetResolver.#dedupeTerms(longWords).slice(0, ComplaintTargetResolver.MAXIMUM_SEARCH_TERMS);
    }

    /**
     * Stamps each candidate with how many times its content has already been
     * actioned. Best-effort per candidate: a lookup failure leaves the count at
     * zero rather than dropping a candidate an administrator needs to see.
     *
     * @param {Array<object>} candidates
     * @returns {Promise<void>}
     */
    static async #attachPriorNotices(candidates)
    {
        for (const candidate of candidates)
        {
            try
            {
                const priorNotices = await ContentTakedownNoticeQueryEngine.findByContentHash(candidate.contentHash);
                candidate.priorNoticeCount = priorNotices.length;
            }
            catch (noticeLookupError)
            {
                console.warn(`[ComplaintTargetResolver] Could not read prior notices for ${candidate.contentHash}: ${noticeLookupError?.message || noticeLookupError}`);
            }
        }
    }

    /**
     * @param {string[]} terms
     * @returns {string[]}
     */
    static #dedupeTerms(terms)
    {
        const seenTerms = new Set();
        const uniqueTerms = [];

        for (const term of terms)
        {
            const normalisedTerm = term.trim();
            const comparisonKey = normalisedTerm.toLowerCase();

            if (normalisedTerm.length >= 3 && !seenTerms.has(comparisonKey))
            {
                seenTerms.add(comparisonKey);
                uniqueTerms.push(normalisedTerm);
            }
        }

        return uniqueTerms;
    }

    static MATCHED_VIA_NAMED_ENTITY = "NAMED_ENTITY";
    static MATCHED_VIA_NAME_SEARCH = "NAME_SEARCH";

    // Each term is a separate aggregation over the uploads collection, so the
    // count is bounded rather than "however many capitalised phrases the
    // complainant happened to write".
    static MAXIMUM_SEARCH_TERMS = 4;
}

module.exports = ComplaintTargetResolver;
