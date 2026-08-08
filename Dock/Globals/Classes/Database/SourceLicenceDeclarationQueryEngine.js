const crypto = require("crypto");
const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * SourceLicenceDeclarationQueryEngine — the permanent, append-only record of
 * every intellectual-property declaration an administrator has made about a
 * document used to verify a paid deck.
 *
 * Insert-and-read only. There is no update method and no delete method, and
 * none should be added. The whole value of this collection is that it can be
 * produced later to answer "what was this deck checked against, on whose word,
 * under what claimed licence, and when" — and a log that could be revised
 * afterwards answers none of those questions, it only appears to.
 *
 * WHY IT IS SEPARATE FROM THE LIBRARY IT DESCRIBES.
 * paidDeckVerificationSources is the working set: the sources a deck is checked
 * against right now, which an administrator adds to and removes from. That
 * collection has to be mutable to be useful. This one records the EVENTS —
 * ATTACHED and DETACHED — so removing a source from the working set does not
 * remove the fact that the deck was once verified against it. If the two were
 * one collection, detaching a source would erase the declaration that justified
 * consulting it, which is precisely the record an auditor would come looking
 * for.
 *
 * WHY IT IS NOT ON THE PROVENANCE RECORD. Provenance is one document per
 * generation RUN and is written when the run finishes. Verification sources are
 * attached to a DECK and are added and removed long after any run has ended, so
 * they have no run to belong to. The two are joined where it matters: the
 * audit-trail PDF renders this log beside the run records, and every flag the
 * source-grounded pass raises names the source that raised it.
 *
 * WHY THERE IS NO TTL. Every other event-ish collection in DatabaseConstants
 * has a retention window. This one deliberately does not: a licence declaration
 * that expires is a licence declaration you cannot produce on the day someone
 * asks about it, which is the only day it matters.
 *
 * This collection also holds an attached source against deletion, the same way
 * contentRefinements does — see ReferencedProofSourceHashes.
 */
class SourceLicenceDeclarationQueryEngine
{
    /**
     * The two things that can happen to a declared source. Recorded as separate
     * events rather than as a status field on one row, so the history reads as a
     * sequence of acts by named people rather than as a current state whose past
     * has been overwritten.
     */
    static EVENT_ATTACHED = "ATTACHED";
    static EVENT_DETACHED = "DETACHED";

    /**
     * Appends one declaration event.
     *
     * @param {object} declarationDetails
     * @return {Promise<object>} The stored document.
     */
    static async record(declarationDetails)
    {
        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.SOURCE_LICENCE_DECLARATIONS_COLLECTION);

        const declarationDocument =
        {
            declarationId: crypto.randomUUID(),

            event: declarationDetails.event === SourceLicenceDeclarationQueryEngine.EVENT_DETACHED
                ? SourceLicenceDeclarationQueryEngine.EVENT_DETACHED
                : SourceLicenceDeclarationQueryEngine.EVENT_ATTACHED,

            // Which deck this source was declared for.
            deckId: declarationDetails.deckId || "",
            verificationSourceId: declarationDetails.verificationSourceId || "",

            // The source itself. sourceHash names the retained bytes and is what
            // the retention hold keys on; a URL-only source has no hash and
            // holds nothing, because there are no bytes of ours to hold.
            informationSourceId: declarationDetails.informationSourceId || "",
            sourceName: SourceLicenceDeclarationQueryEngine.#clampString(declarationDetails.sourceName, 256),
            sourceUrl: SourceLicenceDeclarationQueryEngine.#clampString(declarationDetails.sourceUrl, 2048),
            sourceHash: declarationDetails.sourceHash || "",
            mimeType: declarationDetails.mimeType || "",

            // The declaration proper.
            licenceType: typeof declarationDetails.licenceType === "number" ? declarationDetails.licenceType : 0,
            licenceNote: SourceLicenceDeclarationQueryEngine.#clampString(declarationDetails.licenceNote, 1024),

            // Whose word it is. The email is denormalised deliberately: an
            // account can be deleted, and a log naming only a user id that no
            // longer resolves to anyone is a log that has quietly lost the one
            // fact it was keeping.
            declaredByUserId: declarationDetails.declaredByUserId || "",
            declaredByEmail: SourceLicenceDeclarationQueryEngine.#clampString(declarationDetails.declaredByEmail, 320),

            createdAt: Date.now(),
        };

        await collection.insertOne(declarationDocument);
        delete declarationDocument._id;

        return declarationDocument;
    }

    /**
     * Every declaration event for one deck, oldest first — the order a reader
     * needs to follow what the deck was checked against over time.
     */
    static async findAllByDeckId(deckId)
    {
        if (typeof deckId !== "string" || deckId.length === 0)
        {
            return [];
        }

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.SOURCE_LICENCE_DECLARATIONS_COLLECTION);

        return await collection
            .find({ deckId: deckId }, { projection: { _id: 0 } })
            .sort({ createdAt: 1 })
            .toArray();
    }

    /**
     * The content hashes of every source this user has declared as a
     * verification basis, whether or not it is still attached.
     *
     * DETACHED sources are included on purpose. The declaration is what the
     * retention hold protects, and a detached source is still the document a
     * past verification was carried out against — deleting the bytes would
     * leave a log entry nobody can check against the thing it describes, which
     * is a claim rather than evidence.
     *
     * Scoped to one user because that is how the reaper sweeps.
     *
     * @param {string} userId
     * @return {Promise<Set<string>>}
     */
    static async findReferencedSourceHashesForUser(userId)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return new Set();
        }

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.SOURCE_LICENCE_DECLARATIONS_COLLECTION);

        const referencingDocuments = await collection
            .find(
                {
                    sourceHash: { $nin: [null, ""] },
                    declaredByUserId: userId,
                },
                { projection: { _id: 0, sourceHash: 1 } },
            )
            .toArray();

        return new Set(referencingDocuments.map(document => document.sourceHash).filter(Boolean));
    }

    static #clampString(value, maximumLength)
    {
        if (typeof value !== "string")
        {
            return "";
        }

        return value.length > maximumLength ? value.substring(0, maximumLength) : value;
    }
}

module.exports = SourceLicenceDeclarationQueryEngine;
