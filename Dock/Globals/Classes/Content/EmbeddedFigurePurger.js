const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const EmbeddedFigureStripper = require("./EmbeddedFigureStripper");

/**
 * EmbeddedFigurePurger
 *
 * Removes figures cropped from an uploaded document out of the synced entities
 * that embedded them — study material bodies and card faces — and republishes
 * those entities so every device drops its copy too.
 *
 * This is the half of the erasure cascade that reaches content the user already
 * has. DerivedContentPurger removes the `figures` cache and the PNG objects
 * behind it, which is where the pipeline keeps figures for its own reuse; it
 * does not touch the base64 copy that was pasted into the generated HTML and
 * shipped to the client. Those are different copies in different places, and
 * only the second one is what a reader actually sees.
 *
 * How the removal reaches devices. A client accepts an incoming study material
 * or card only when the payload's `lifecycle.lastModified` is strictly newer
 * than its local copy (SyncApplier), and only pulls entities whose server-side
 * `serverUpdatedAt` is newer than its cursor (SyncQueryEngine). A rewrite that
 * bumped one and not the other would either never be fetched or be fetched and
 * discarded, so both are stamped, together, in the same update.
 *
 * Scope. Study material content and card question/answer faces are the only
 * places the injector puts a figure (PrepareImages writes assignments of exactly
 * those two kinds). Mock tests are deliberately not swept: nothing embeds a
 * figure into one, and scanning them would cost a collection pass per notice to
 * find nothing.
 *
 * Cost. Matching is a substring test over generated HTML, which Mongo can only
 * serve as a collection scan. That is accepted rather than indexed: the
 * per-user path runs on a delete of one document and is bounded by one
 * account's entities, and the cross-tenant path runs only when an operator
 * actions a rightsholder notice. Both are rare, and paying a scan then is a
 * better trade than carrying an index for it.
 */
class EmbeddedFigurePurger
{
    static #CARD_HTML_FIELD_NAMES = ["question", "answer"];

    /**
     * Strips one user's embedded copies of a document's figures.
     *
     * @param {string} userId
     * @param {string} contentHash - The sha512 content hash of the source document.
     * @return {Promise<{studyMaterialsUpdated: number, cardsUpdated: number, figuresStripped: number, unbalancedDocumentCount: number}>}
     */
    static async purgeForUserAndContentHash(userId, contentHash)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return EmbeddedFigurePurger.#emptyResult();
        }

        return await EmbeddedFigurePurger.#purgeMatching({ userId: userId }, contentHash);
    }

    /**
     * Strips EVERY tenant's embedded copies of a document's figures. The
     * takedown path — a notice is about the work, not about one account.
     *
     * @param {string} contentHash - The sha512 content hash of the source document.
     * @return {Promise<{studyMaterialsUpdated: number, cardsUpdated: number, figuresStripped: number, unbalancedDocumentCount: number}>}
     */
    static async purgeByContentHash(contentHash)
    {
        return await EmbeddedFigurePurger.#purgeMatching({}, contentHash);
    }

    /**
     * Counts what a strip would remove without changing anything. Feeds the
     * takedown dry run, so an operator sees that a notice reaches content the
     * user is actively studying — not only the upload they may have forgotten.
     *
     * @param {string} contentHash
     * @return {Promise<{studyMaterials: number, cards: number, figures: number}>}
     */
    static async countEmbeddedFigures(contentHash)
    {
        const counts = { studyMaterials: 0, cards: 0, figures: 0 };

        if (!EmbeddedFigurePurger.#isUsableContentHash(contentHash))
        {
            return counts;
        }

        const database = await DatabaseConnector.getDatabase();
        const matchFilter = EmbeddedFigurePurger.#buildContentHashFilter({}, contentHash);

        const studyMaterialDocuments = await database
            .collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION)
            .find(matchFilter)
            .toArray();

        for (const studyMaterialDocument of studyMaterialDocuments)
        {
            const stripResult = EmbeddedFigureStripper.strip(studyMaterialDocument?.data?.content, contentHash);
            if (stripResult.removedCount > 0)
            {
                counts.studyMaterials++;
                counts.figures += stripResult.removedCount;
            }
        }

        const cardDocuments = await database
            .collection(DatabaseConstants.CARDS_COLLECTION)
            .find(matchFilter)
            .toArray();

        for (const cardDocument of cardDocuments)
        {
            let cardFigureCount = 0;

            for (const fieldName of EmbeddedFigurePurger.#CARD_HTML_FIELD_NAMES)
            {
                cardFigureCount += EmbeddedFigureStripper.strip(cardDocument?.data?.[fieldName], contentHash).removedCount;
            }

            if (cardFigureCount > 0)
            {
                counts.cards++;
                counts.figures += cardFigureCount;
            }
        }

        return counts;
    }

    static async #purgeMatching(baseFilter, contentHash)
    {
        const result = EmbeddedFigurePurger.#emptyResult();

        if (!EmbeddedFigurePurger.#isUsableContentHash(contentHash))
        {
            return result;
        }

        const database = await DatabaseConnector.getDatabase();
        const matchFilter = EmbeddedFigurePurger.#buildContentHashFilter(baseFilter, contentHash);

        await EmbeddedFigurePurger.#purgeStudyMaterials(database, matchFilter, contentHash, result);
        await EmbeddedFigurePurger.#purgeCards(database, matchFilter, contentHash, result);

        return result;
    }

    static async #purgeStudyMaterials(database, matchFilter, contentHash, result)
    {
        const collection = database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
        const studyMaterialDocuments = await collection.find(matchFilter).toArray();

        for (const studyMaterialDocument of studyMaterialDocuments)
        {
            const stripResult = EmbeddedFigureStripper.strip(studyMaterialDocument?.data?.content, contentHash);

            if (stripResult.bUnbalancedMarkup)
            {
                result.unbalancedDocumentCount++;
            }

            if (stripResult.removedCount === 0)
            {
                continue;
            }

            const republishedAt = new Date();

            await collection.updateOne(
                { _id: studyMaterialDocument._id },
                {
                    $set:
                    {
                        "data.content": stripResult.html,
                        "data.lifecycle.lastModified": republishedAt.toISOString(),
                        serverUpdatedAt: republishedAt
                    }
                }
            );

            result.studyMaterialsUpdated++;
            result.figuresStripped += stripResult.removedCount;
        }
    }

    static async #purgeCards(database, matchFilter, contentHash, result)
    {
        const collection = database.collection(DatabaseConstants.CARDS_COLLECTION);
        const cardDocuments = await collection.find(matchFilter).toArray();

        for (const cardDocument of cardDocuments)
        {
            const fieldUpdates = {};
            let cardFigureCount = 0;

            for (const fieldName of EmbeddedFigurePurger.#CARD_HTML_FIELD_NAMES)
            {
                const stripResult = EmbeddedFigureStripper.strip(cardDocument?.data?.[fieldName], contentHash);

                if (stripResult.bUnbalancedMarkup)
                {
                    result.unbalancedDocumentCount++;
                }

                if (stripResult.removedCount === 0)
                {
                    continue;
                }

                fieldUpdates[`data.${fieldName}`] = stripResult.html;
                cardFigureCount += stripResult.removedCount;
            }

            if (cardFigureCount === 0)
            {
                continue;
            }

            const republishedAt = new Date();

            await collection.updateOne(
                { _id: cardDocument._id },
                {
                    $set: Object.assign(fieldUpdates,
                    {
                        "data.lifecycle.lastModified": republishedAt.toISOString(),
                        serverUpdatedAt: republishedAt
                    })
                }
            );

            result.cardsUpdated++;
            result.figuresStripped += cardFigureCount;
        }
    }

    /**
     * Narrows the scan server-side to documents whose stored HTML mentions the
     * hash at all, so the whole collection is not pulled across the wire. Every
     * candidate it returns is still re-tested exactly by EmbeddedFigureStripper
     * before anything is written — this filter is an optimisation, never the
     * decision.
     */
    static #buildContentHashFilter(baseFilter, contentHash)
    {
        const attributeNeedle = new RegExp(`data-source-hash="${EmbeddedFigurePurger.#escapeForRegularExpression(contentHash)}"`);

        return Object.assign({}, baseFilter,
        {
            $or:
            [
                { "data.content": attributeNeedle },
                { "data.question": attributeNeedle },
                { "data.answer": attributeNeedle }
            ]
        });
    }

    /**
     * A content hash is hexadecimal and carries no regular-expression
     * metacharacters, so this escapes nothing in practice. It is here because
     * the value reaches this line from an HTTP body, and a filter built by
     * interpolating request input is the kind of thing that stops being safe
     * the moment the surrounding assumptions change.
     */
    static #escapeForRegularExpression(value)
    {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    static #isUsableContentHash(contentHash)
    {
        return typeof contentHash === "string" && contentHash.length > 0;
    }

    static #emptyResult()
    {
        return {
            studyMaterialsUpdated: 0,
            cardsUpdated: 0,
            figuresStripped: 0,
            unbalancedDocumentCount: 0
        };
    }
}

module.exports = EmbeddedFigurePurger;
