const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * Telemetry sink for attempted exports of AI-generated decks.
 *
 * Every deck node produced by the generation pipeline is marked
 * additionalData.aiGenerated = true by DeckHierarchyBuilder, and the deck a run
 * was launched from is marked by AiGeneratedTargetDeckStamper. The export UI
 * refuses to run on such a deck — Deck.isAiGenerated() hides the button on the
 * node, Deck.containsAiGeneratedContent() blocks a recursive export of a clean
 * parent whose subtree holds generated content, and Deck.getExportData() throws
 * if a caller reaches it anyway.
 *
 * Even so, that gate is deterrence, not enforcement. Export is a purely
 * client-side operation (the deck already lives in the user's own store), so a
 * modified client can simply skip the check — there is no server call to
 * intercept and therefore nothing to enforce server-side. What CAN be done is
 * to observe: the unmodified client reports every attempt here, blocked or not,
 * so "we hid a button" becomes "we monitored, and here is what we saw and
 * when". Without it, bypassing would become a pattern with nobody noticing.
 *
 * The record is intentionally minimal (no deck content, no card bodies) — it is
 * an access-attempt log, not a copy of the material. A 90-day TTL matches the
 * screenshotEvents convention.
 */
async function logAiGeneratedExportAttempt(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const database = await DatabaseConnector.getDatabase();

    await database
        .collection(DatabaseConstants.AI_GENERATED_EXPORT_EVENTS_COLLECTION)
        .insertOne
        ({
            userId: session.getUserId(),
            deviceId: session.getDeviceId(),
            deckId: typeof body?.deckId === "string" ? body.deckId : null,
            // Whether the user asked for the whole subtree. A recursive attempt
            // on a clean parent is the interesting case — that is the shape a
            // bypass takes when someone tries to launder generated descendants
            // out through an unmarked ancestor.
            recursiveRequested: body?.recursiveRequested === true,
            // Whether the client-side gate actually refused. False means the
            // export went ahead, which for a generated deck should be impossible
            // on an unmodified client.
            blocked: body?.blocked === true,
            // Why the gate fired (or would have): node-level vs subtree-level.
            reason: typeof body?.reason === "string" ? body.reason.substring(0, 200) : null,
            userAgent: typeof body?.userAgent === "string" ? body.userAgent.substring(0, 400) : null,
            timestamp: new Date()
        });

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { logAiGeneratedExportAttempt };
