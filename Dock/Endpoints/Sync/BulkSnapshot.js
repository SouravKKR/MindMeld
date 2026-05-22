const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");


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
            response.sendStatusCode(401);
            return;
        }

        const userId   = user.getId();
        const database = await DatabaseConnector.getDatabase();

        const decksCollection          = database.collection(DatabaseConstants.DECKS_COLLECTION);
        const cardsCollection          = database.collection(DatabaseConstants.CARDS_COLLECTION);
        const studyMaterialsCollection = database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
        const mockTestsCollection      = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);

        const userFilter = { userId: userId };

        const deckCount          = await decksCollection.countDocuments(userFilter);
        const cardCount          = await cardsCollection.countDocuments(userFilter);
        const studyMaterialCount = await studyMaterialsCollection.countDocuments(userFilter);
        const mockTestCount      = await mockTestsCollection.countDocuments(userFilter);
        const totalCount         = deckCount + cardCount + studyMaterialCount + mockTestCount;

        console.log(`[Sync/BulkSnapshot] user=${userId} — streaming decks:${deckCount} cards:${cardCount} studyMaterials:${studyMaterialCount} mockTests:${mockTestCount} totalCount:${totalCount}`);

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
            });

            await BulkSnapshotEndpoint.#streamCollection(response, decksCollection,          userFilter, entityTypes.DECK);
            await BulkSnapshotEndpoint.#streamCollection(response, cardsCollection,          userFilter, entityTypes.CARD);
            await BulkSnapshotEndpoint.#streamCollection(response, studyMaterialsCollection, userFilter, entityTypes.STUDY_MATERIAL);
            await BulkSnapshotEndpoint.#streamCollection(response, mockTestsCollection,      userFilter, entityTypes.MOCK_TEST);

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
    }

    /**
     * Emits the header NDJSON line with collection counts and the
     * server clock — the client uses both for the progress UI and
     * to advance its lastSync after the stream completes.
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
            serverTime:         Date.now(),
        };
        await BulkSnapshotEndpoint.#writeLine(response, JSON.stringify(headerObject));
    }

    /**
     * Iterates the collection via a Mongo cursor (no `toArray`) and
     * emits one NDJSON line per entity. Memory pressure is bounded by
     * a single document's size, not the collection's total size.
     */
    static async #streamCollection(response, collection, userFilter, entityTypeValue)
    {
        const projection = { projection: { _id: 0, data: 1 } };
        const cursor     = collection.find(userFilter, projection);

        for await (const document of cursor)
        {
            if (!document.data)
            {
                continue;
            }
            await BulkSnapshotEndpoint.#writeLine(response, JSON.stringify(
            {
                type: entityTypeValue,
                data: document.data,
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
