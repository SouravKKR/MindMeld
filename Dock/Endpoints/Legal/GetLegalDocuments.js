const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const LegalDocumentQueryEngine = require("../../Globals/Classes/Database/LegalDocumentQueryEngine");


/**
 * GET /LegalDocuments
 *
 * Returns the full list of legal documents (Terms of Service, Privacy
 * Policy) seeded into the `legalDocuments` collection. Each entry carries:
 *   { key, title, version, contentHtml }
 *
 * The client compares each entry's `version` against the user's stored
 * `agreed<Key>Version` in additionalData and shows the popup when the
 * stored value is missing or lower.
 *
 * Endpoint is public (no ensureLogin): the homepage's pre-login legal
 * notice needs to download these documents on behalf of anonymous
 * visitors, and the served data is operator-curated seed content with
 * nothing user-specific in it.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleGetLegalDocuments(request, response)
{
    const legalDocuments = await LegalDocumentQueryEngine.getAll();
    response.sendJson(legalDocuments);
}

module.exports = { handleGetLegalDocuments };
