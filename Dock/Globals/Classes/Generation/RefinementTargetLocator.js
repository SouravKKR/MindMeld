const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { refinementTargetKinds } = require("../../Enumerations/RefinementTargetKinds");

/**
 * RefinementTargetLocator — works out which entity a verification flag is about.
 *
 * A flag says what is wrong and quotes the text it objects to, but it does not
 * say which card or which lesson that text came from: verification reads a flat
 * list of staged content, and the flag is filed against a topic chain rather
 * than an entity id. Auto-fixing a flag therefore starts by finding the passage
 * again, in a deck that may since have been edited.
 *
 * Three rules, each there because the obvious shortcut is wrong:
 *
 *   SCOPE BY RUN, NOT BY NAME. A topic chain is a list of deck NAMES, and deck
 *   names are not unique across a tree — "Introduction" appears under every
 *   unit. Matching on name alone can resolve into a different unit entirely, so
 *   the search is confined to the decks the run actually produced.
 *
 *   NEVER PICK SILENTLY. Where several entities contain the quoted text, all of
 *   them are returned and a person chooses. The quoted text is a model-authored
 *   excerpt of generated prose; near-duplicates across sibling topics are normal
 *   rather than exceptional, and taking the first match would eventually apply a
 *   correction to a passage nobody reviewed.
 *
 *   SAY WHEN THE TARGET IS NOT EDITABLE. A flag can land on a mock test, whose
 *   content this pipeline does not treat as a refinable field. That is a
 *   distinct answer from "not found" and is reported as one, so a reviewer is
 *   told why the button is missing rather than left to conclude it is broken.
 */
class RefinementTargetLocator
{
    /**
     * Outcome kinds, so callers branch on a constant rather than on prose.
     */
    static OUTCOME_RESOLVED = "RESOLVED";
    static OUTCOME_AMBIGUOUS = "AMBIGUOUS";
    static OUTCOME_NOT_FOUND = "NOT_FOUND";
    static OUTCOME_NOT_EDITABLE = "NOT_EDITABLE";

    /**
     * How many candidates to hand back for a person to choose between. A flag
     * that matches more than a handful of passages is not really located at all,
     * and a list of thirty is a worse answer than an honest "narrow this down".
     */
    static MAXIMUM_CANDIDATES = 8;

    /**
     * Locates the entity a flag refers to.
     *
     * @param {object} locateRequest
     *   ownerUserId  — whose library the generated deck lives in
     *   deckIds      — the decks this run produced, plus the deck it ran into
     *   quotedText   — the flag's quotedText
     *   topicChain   — the flag's topicChain (deck names, root first)
     * @return {Promise<{outcome: string, candidates: object[], detail: string}>}
     */
    static async locate(locateRequest)
    {
        const searchableDeckIds = Array.isArray(locateRequest.deckIds)
            ? locateRequest.deckIds.filter(deckId => typeof deckId === "string" && deckId.length > 0)
            : [];

        if (searchableDeckIds.length === 0)
        {
            return RefinementTargetLocator.#buildOutcome(
                RefinementTargetLocator.OUTCOME_NOT_FOUND,
                [],
                "This generation run did not record which decks it produced, so its content cannot be located automatically.",
            );
        }

        const normalizedQuotedText = RefinementTargetLocator.normalizeForMatching(locateRequest.quotedText);

        if (normalizedQuotedText.length === 0)
        {
            return RefinementTargetLocator.#buildOutcome(
                RefinementTargetLocator.OUTCOME_NOT_FOUND,
                [],
                "This flag quotes no text, so there is nothing to match against.",
            );
        }

        const candidates = [];

        candidates.push(...await RefinementTargetLocator.#findStudyMaterialCandidates(
            locateRequest.ownerUserId,
            searchableDeckIds,
            normalizedQuotedText,
        ));

        candidates.push(...await RefinementTargetLocator.#findCardCandidates(
            locateRequest.ownerUserId,
            searchableDeckIds,
            normalizedQuotedText,
        ));

        if (candidates.length === 0)
        {
            const bMockTestOnly = await RefinementTargetLocator.#quotedTextAppearsInMockTest(
                locateRequest.ownerUserId,
                searchableDeckIds,
                normalizedQuotedText,
            );

            if (bMockTestOnly)
            {
                return RefinementTargetLocator.#buildOutcome(
                    RefinementTargetLocator.OUTCOME_NOT_EDITABLE,
                    [],
                    "This flag is about a mock test question. Mock test content cannot be corrected here — "
                        + "regenerate the mock test, or resolve the flag with a note.",
                );
            }

            return RefinementTargetLocator.#buildOutcome(
                RefinementTargetLocator.OUTCOME_NOT_FOUND,
                [],
                "The quoted text is no longer in this deck. It may already have been corrected, in which case "
                    + "resolve the flag directly.",
            );
        }

        // Order by topic agreement, so the candidate from the topic the flag was
        // actually filed against sits at the top when several passages share the
        // wording. Ordering only — the choice stays with the reviewer.
        const flagTopicChain = Array.isArray(locateRequest.topicChain) ? locateRequest.topicChain : [];
        const deckNamesById = await RefinementTargetLocator.#loadDeckNames(
            locateRequest.ownerUserId,
            [...new Set(candidates.map(candidate => candidate.deckId).filter(Boolean))],
        );

        for (const candidate of candidates)
        {
            candidate.deckName = deckNamesById.get(candidate.deckId) || "";
            candidate.topicAffinityScore = RefinementTargetLocator.#scoreTopicAffinity(candidate.deckName, flagTopicChain);
        }

        candidates.sort((firstCandidate, secondCandidate) => secondCandidate.topicAffinityScore - firstCandidate.topicAffinityScore);

        const cappedCandidates = candidates.slice(0, RefinementTargetLocator.MAXIMUM_CANDIDATES);

        if (cappedCandidates.length === 1)
        {
            return RefinementTargetLocator.#buildOutcome(RefinementTargetLocator.OUTCOME_RESOLVED, cappedCandidates, "");
        }

        return RefinementTargetLocator.#buildOutcome(
            RefinementTargetLocator.OUTCOME_AMBIGUOUS,
            cappedCandidates,
            `The quoted text appears in ${candidates.length} places. Choose the one this flag is about.`,
        );
    }

    /**
     * Collapses a passage to something two differently-formatted copies of the
     * same sentence compare equal on: markup removed, entities of the two
     * characters models most often re-spell resolved, whitespace collapsed,
     * case folded.
     *
     * This is a matcher, not a sanitiser. It exists so a flag quoting
     * "the value is 3.0 x 10^8" still finds the passage after the generator
     * wrapped that sentence in a <strong>, and it is never written back.
     */
    static normalizeForMatching(rawValue)
    {
        if (typeof rawValue !== "string")
        {
            return "";
        }

        return rawValue
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, "\"")
            .replace(/&#39;/gi, "'")
            .replace(/[‘’]/g, "'")
            .replace(/[“”]/g, "\"")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    static async #findStudyMaterialCandidates(ownerUserId, deckIds, normalizedQuotedText)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);

        const storedDocuments = await collection
            .find(
                { userId: ownerUserId, "data.deckId": { $in: deckIds } },
                { projection: { _id: 0, "data.id": 1, "data.deckId": 1, "data.content": 1 } },
            )
            .toArray();

        const candidates = [];

        for (const storedDocument of storedDocuments)
        {
            const contentValue = storedDocument.data ? storedDocument.data.content : null;

            if (typeof contentValue !== "string")
            {
                continue;
            }

            if (!RefinementTargetLocator.normalizeForMatching(contentValue).includes(normalizedQuotedText))
            {
                continue;
            }

            candidates.push({
                entityId: storedDocument.data.id,
                deckId: storedDocument.data.deckId || "",
                targetKind: refinementTargetKinds.STUDY_MATERIAL,
                entityTypeName: "STUDY_MATERIAL",
                previewText: RefinementTargetLocator.#buildPreview(contentValue),
            });
        }

        return candidates;
    }

    static async #findCardCandidates(ownerUserId, deckIds, normalizedQuotedText)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);

        const storedDocuments = await collection
            .find(
                { userId: ownerUserId, "data.deckId": { $in: deckIds } },
                { projection: { _id: 0, "data.id": 1, "data.deckId": 1, "data.question": 1, "data.answer": 1 } },
            )
            .toArray();

        const candidates = [];

        for (const storedDocument of storedDocuments)
        {
            if (!storedDocument.data)
            {
                continue;
            }

            // Question and answer are separate targets, because they are
            // separate fields and a correction writes exactly one of them. A
            // flag quoting the answer must not rewrite the question.
            const searchableFields =
            [
                { fieldValue: storedDocument.data.question, targetKind: refinementTargetKinds.CARD_QUESTION, sideName: "question" },
                { fieldValue: storedDocument.data.answer, targetKind: refinementTargetKinds.CARD_ANSWER, sideName: "answer" },
            ];

            for (const searchableField of searchableFields)
            {
                if (typeof searchableField.fieldValue !== "string")
                {
                    continue;
                }

                if (!RefinementTargetLocator.normalizeForMatching(searchableField.fieldValue).includes(normalizedQuotedText))
                {
                    continue;
                }

                candidates.push({
                    entityId: storedDocument.data.id,
                    deckId: storedDocument.data.deckId || "",
                    targetKind: searchableField.targetKind,
                    entityTypeName: "CARD",
                    previewText: `(${searchableField.sideName}) ${RefinementTargetLocator.#buildPreview(searchableField.fieldValue)}`,
                });
            }
        }

        return candidates;
    }

    static async #quotedTextAppearsInMockTest(ownerUserId, deckIds, normalizedQuotedText)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.MOCK_TESTS_COLLECTION);

        const storedDocuments = await collection
            .find(
                { userId: ownerUserId, "data.deckId": { $in: deckIds } },
                { projection: { _id: 0, "data.items": 1 } },
            )
            .toArray();

        for (const storedDocument of storedDocuments)
        {
            const items = storedDocument.data && Array.isArray(storedDocument.data.items) ? storedDocument.data.items : [];

            for (const item of items)
            {
                const combinedText = [item.question, item.expectedAnswer, item.answerReason, item.solvingSteps]
                    .filter(fieldValue => typeof fieldValue === "string")
                    .join(" ");

                if (RefinementTargetLocator.normalizeForMatching(combinedText).includes(normalizedQuotedText))
                {
                    return true;
                }
            }
        }

        return false;
    }

    static async #loadDeckNames(ownerUserId, deckIds)
    {
        if (deckIds.length === 0)
        {
            return new Map();
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);

        const storedDocuments = await collection
            .find(
                { userId: ownerUserId, "data.id": { $in: deckIds } },
                { projection: { _id: 0, "data.id": 1, "data.name": 1 } },
            )
            .toArray();

        return new Map(storedDocuments
            .filter(storedDocument => storedDocument.data && storedDocument.data.id)
            .map(storedDocument => [storedDocument.data.id, storedDocument.data.name || ""]));
    }

    /**
     * How well a candidate's deck agrees with the flag's topic chain. Used only
     * to order candidates for a person to choose between — never to pick one.
     *
     * Two points for the leaf topic, one for any ancestor. The leaf is the topic
     * the flag was actually filed under, so a passage sitting in a deck of that
     * name is the likeliest target; a match further up the chain says only that
     * the candidate is in the right part of the tree, which is worth something
     * and not worth as much.
     */
    static #scoreTopicAffinity(deckName, flagTopicChain)
    {
        if (flagTopicChain.length === 0 || deckName.length === 0)
        {
            return 0;
        }

        const normalizedDeckName = RefinementTargetLocator.normalizeForMatching(deckName);
        const normalizedChain = flagTopicChain.map(topicName => RefinementTargetLocator.normalizeForMatching(topicName));

        if (normalizedChain[normalizedChain.length - 1] === normalizedDeckName)
        {
            return 2;
        }

        return normalizedChain.includes(normalizedDeckName) ? 1 : 0;
    }

    static #buildPreview(contentValue)
    {
        const plainText = RefinementTargetLocator.normalizeForMatching(contentValue);
        return plainText.length > 160 ? `${plainText.substring(0, 160)}…` : plainText;
    }

    static #buildOutcome(outcome, candidates, detail)
    {
        return { outcome: outcome, candidates: candidates, detail: detail };
    }
}

module.exports = RefinementTargetLocator;
