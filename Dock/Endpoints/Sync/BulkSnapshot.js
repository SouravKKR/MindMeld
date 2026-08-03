const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeckSyncCrypto = require("../../Globals/Classes/Security/PaidDeckSyncCrypto");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * BulkSnapshotEndpoint
 *
 * Streams every entity the authenticated user owns across all four
 * synced collections as a single NDJSON response (one JSON document
 * per line). The client (Force Pull / fresh-login auto-route in
 * SyncOrchestrator) parses line-by-line, so neither end ever
 * materialises the full payload as a single string — JSON.stringify
 * / JSON.parse on a medium-large library blow V8's ~512 MB string
 * cap and OOM either the Node process or the Chrome renderer.
 *
 * Wire format:
 *   Line 1   — header  { header: true, totalCount, deckCount, cardCount,
 *                         studyMaterialCount, mockTestCount, serverTime }
 *   Lines 2..— entity  { type: <entityTypes enum value>, data: <entity data> }
 *
 * The header carries the per-collection counts so the client can
 * report real "X / Y entities" progress to the user.
 */
class BulkSnapshotEndpoint
{
    /**
     * Public entry point — routed at GET /Sync/BulkSnapshot.
     *
     * @param {PacketronRequest} request
     * @param {PacketronResponse} response
     */
    static async handle(request, response)
    {
        const user = await getUser(request);

        if (!user)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return;
        }

        const userId   = user.getId();
        const database = await DatabaseConnector.getDatabase();

        const decksCollection          = database.collection(DatabaseConstants.DECKS_COLLECTION);
        const cardsCollection          = database.collection(DatabaseConstants.CARDS_COLLECTION);
        const studyMaterialsCollection = database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
        const mockTestsCollection      = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
        const popupLinksCollection     = database.collection(DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION);
        const contentOverlaysCollection = database.collection(DatabaseConstants.CONTENT_OVERLAYS_COLLECTION);

        // Snapshot the server clock at request start. Both countDocuments
        // and the streaming cursor are gated on serverUpdatedAt <= this
        // ceiling, so the header's totalCount is a tight upper bound on the
        // number of entities the stream emits — even if Generate is still
        // writing new rows on the same Mongo behind us. (It is an UPPER bound
        // rather than exact because paid entities with no active license are
        // withheld during streaming; the client forces the progress bar to
        // 100% on stream end, so an upper-bound count is fine.) Anything
        // created after the ceiling is picked up by the next /Sync delta
        // because the client advances lastSync to this exact value.
        const snapshotCeiling = new Date();
        const userFilter      = { userId: userId, serverUpdatedAt: { $lte: snapshotCeiling } };

        const deckCount          = await decksCollection.countDocuments(userFilter);
        const cardCount          = await cardsCollection.countDocuments(userFilter);
        const studyMaterialCount = await studyMaterialsCollection.countDocuments(userFilter);
        const mockTestCount      = await mockTestsCollection.countDocuments(userFilter);
        const popupLinkCount     = await popupLinksCollection.countDocuments(userFilter);
        const contentOverlayCount = await contentOverlaysCollection.countDocuments(userFilter);
        const totalCount         = deckCount + cardCount + studyMaterialCount + mockTestCount + popupLinkCount + contentOverlayCount;

        console.log(`[Sync/BulkSnapshot] user=${userId} — streaming decks:${deckCount} cards:${cardCount} studyMaterials:${studyMaterialCount} mockTests:${mockTestCount} popupLinks:${popupLinkCount} contentOverlays:${contentOverlayCount} totalCount:${totalCount} ceiling:${snapshotCeiling.toISOString()}`);

        // Per-request cache of unwrapped paid-deck content keys, identical to the
        // incremental /Sync pull: paid content MUST be encrypted in transit on
        // EVERY path, so a full resync can never stream it in cleartext. A null
        // entry means "no active license" → that deck's entities are withheld
        // (access is ownership-bound). All buffers are zeroed in the finally.
        const paidContentKeyByDeckId = new Map();
        const resolvePaidContentKey = async (paidDeckId) =>
        {
            if (paidContentKeyByDeckId.has(paidDeckId))
            {
                return paidContentKeyByDeckId.get(paidDeckId);
            }
            const contentKeyBuffer = await KeyManagementService.getPaidDeckContentKeyBufferForUser(userId, paidDeckId);
            paidContentKeyByDeckId.set(paidDeckId, contentKeyBuffer);
            return contentKeyBuffer;
        };

        response.setHeader("Content-Type", "application/x-ndjson");
        response.setHeader("Cache-Control", "no-store");

        try
        {
            await BulkSnapshotEndpoint.#writeHeaderLine(response,
            {
                totalCount:         totalCount,
                deckCount:          deckCount,
                cardCount:          cardCount,
                studyMaterialCount: studyMaterialCount,
                mockTestCount:      mockTestCount,
                popupLinkCount:     popupLinkCount,
                contentOverlayCount: contentOverlayCount,
                serverTime:         snapshotCeiling.getTime(),
            });

            await BulkSnapshotEndpoint.#streamCollection(response, decksCollection,          userFilter, entityTypes.DECK,              resolvePaidContentKey);
            await BulkSnapshotEndpoint.#streamCollection(response, cardsCollection,          userFilter, entityTypes.CARD,              resolvePaidContentKey);
            await BulkSnapshotEndpoint.#streamCollection(response, studyMaterialsCollection, userFilter, entityTypes.STUDY_MATERIAL,    resolvePaidContentKey);
            await BulkSnapshotEndpoint.#streamCollection(response, mockTestsCollection,      userFilter, entityTypes.MOCK_TEST,         resolvePaidContentKey);
            await BulkSnapshotEndpoint.#streamCollection(response, popupLinksCollection,     userFilter, entityTypes.ASK_AI_POPUP_LINK, resolvePaidContentKey);
            // Overlays stream LAST: each one targets a card or study material,
            // so the entity it overlays has already arrived by the time the
            // client applies it.
            await BulkSnapshotEndpoint.#streamCollection(response, contentOverlaysCollection, userFilter, entityTypes.CONTENT_OVERLAY,   resolvePaidContentKey);

            response.end();

            console.log(`[Sync/BulkSnapshot] user=${userId} — stream finished.`);
        }
        catch (streamError)
        {
            console.error(`[Sync/BulkSnapshot] user=${userId} — stream failed:`, streamError);
            try
            {
                response.destroy(streamError);
            }
            catch (destroyError)
            {
                console.error("[Sync/BulkSnapshot] destroy() after stream error threw:", destroyError);
            }
        }
        finally
        {
            // Zero every unwrapped content key the stream derived — plaintext key
            // bytes must not linger in process memory beyond the request.
            for (const contentKeyBuffer of paidContentKeyByDeckId.values())
            {
                if (contentKeyBuffer)
                {
                    contentKeyBuffer.fill(0);
                }
            }
            paidContentKeyByDeckId.clear();
        }
    }

    /**
     * Emits the header NDJSON line with collection counts and the
     * snapshot ceiling — the client uses both for the progress UI
     * and to advance its lastSync after the stream completes. The
     * snapshot ceiling MUST match the value used to gate the count
     * + cursor filters or the client's next delta /Sync would either
     * miss or duplicate rows that landed during the stream.
     */
    static async #writeHeaderLine(response, counts)
    {
        const headerObject =
        {
            header:             true,
            totalCount:         counts.totalCount,
            deckCount:          counts.deckCount,
            cardCount:          counts.cardCount,
            studyMaterialCount: counts.studyMaterialCount,
            mockTestCount:      counts.mockTestCount,
            popupLinkCount:     counts.popupLinkCount,
            contentOverlayCount: counts.contentOverlayCount,
            serverTime:         counts.serverTime,
        };
        await BulkSnapshotEndpoint.#writeLine(response, JSON.stringify(headerObject));
    }

    /**
     * Iterates the collection via a Mongo cursor (no `toArray`) and
     * emits one NDJSON line per entity. Memory pressure is bounded by
     * a single document's size, not the collection's total size.
     *
     * Paid entities (non-empty `additionalData.paidDeckId`) are encrypted
     * before they leave the server — byte-for-byte the same treatment the
     * incremental /Sync pull applies — so paid content is NEVER streamed in
     * cleartext, on any path. An entity whose content key cannot be resolved
     * (no active license) is withheld entirely. A normal deck has no
     * paidDeckId and streams unchanged; encryption in transit is the ONLY
     * difference between a paid and a normal deck. (Withholding can make the
     * emitted count fall below the header's totalCount; the client's bulk
     * reader forces the progress bar to 100% on stream end, so an upper-bound
     * count is fine.)
     */
    static async #streamCollection(response, collection, userFilter, entityTypeValue, resolvePaidContentKey)
    {
        const projection = { projection: { _id: 0, data: 1 } };
        const cursor     = collection.find(userFilter, projection);

        for await (const document of cursor)
        {
            if (!document.data)
            {
                continue;
            }

            let outgoingData = document.data;

            const paidDeckId = document.data?.additionalData?.paidDeckId;
            if (typeof paidDeckId === "string" && paidDeckId.length > 0)
            {
                const contentKeyBuffer = await resolvePaidContentKey(paidDeckId);
                if (!contentKeyBuffer)
                {
                    continue;
                }
                outgoingData = PaidDeckSyncCrypto.encryptEntityContent(entityTypeValue, document.data, contentKeyBuffer);
            }

            await BulkSnapshotEndpoint.#writeLine(response, JSON.stringify(
            {
                type: entityTypeValue,
                data: outgoingData,
            }));
        }
    }

    /**
     * Writes a single NDJSON line (payload + "\n") with backpressure
     * awareness. Awaits the 'drain' event when Node's socket buffer
     * fills, so a slow client cannot inflate server memory beyond the
     * stream's high-water mark.
     */
    static #writeLine(response, line)
    {
        return new Promise((resolve, reject) =>
        {
            const bAcceptedImmediately = response.write(line + "\n", (writeError) =>
            {
                if (writeError)
                {
                    reject(writeError);
                }
            });

            if (bAcceptedImmediately)
            {
                resolve();
                return;
            }

            response.once("drain", resolve);
        });
    }
}

module.exports =
{
    handleBulkSnapshot: (request, response) => BulkSnapshotEndpoint.handle(request, response),
};
