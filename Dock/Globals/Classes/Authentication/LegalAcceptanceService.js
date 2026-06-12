const LegalDocumentQueryEngine = require("../Database/LegalDocumentQueryEngine");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");

/**
 * LegalAcceptanceService
 *
 * Server-authoritative source of truth for "has this user accepted the
 * current Terms of Service / Privacy Policy". It exists so consent is no
 * longer a client-asserted flag merged through a generic endpoint, but a
 * server-recorded fact validated against the live document versions in the
 * `legalDocuments` collection.
 *
 * Responsibilities:
 *   1. Decide which legal documents a user still owes acceptance for
 *      (getPendingDocuments / hasOutstandingAcceptance). The global
 *      EnsureLegalAcceptance plugin calls this on every authenticated
 *      request and blocks access until the set is empty.
 *   2. Record an acceptance (recordAcceptance) against the server's CURRENT
 *      version with a server-stamped timestamp — never trusting a
 *      client-supplied version number to mark consent.
 *   3. Identify the reserved consent keys so the generic
 *      /UpdateUserAdditionalData merge can refuse to write them
 *      (isReservedConsentKey), leaving this service the only writer.
 *
 * Version-key naming mirrors the frontend TermsAndConditionsManager exactly:
 * a document key like "TERMS_OF_SERVICE" maps to additionalData fields
 * "agreedTermsOfServiceVersion" and "agreedTermsOfServiceAt".
 */
class LegalAcceptanceService
{
    static #AGREED_PREFIX = "agreed";
    static #VERSION_SUFFIX = "Version";
    static #AT_SUFFIX = "At";

    // Matches the agreed*Version / agreed*At fields this service owns, so the
    // generic additionalData merge can strip them and keep consent writes
    // exclusive to recordAcceptance below.
    static #RESERVED_CONSENT_KEY_REGEX = /^agreed[A-Za-z0-9]+(Version|At)$/;

    /**
     * Returns the legal documents the user has NOT yet accepted at the
     * current server version, each as { key, title, version }. An empty
     * array means the user is fully up to date. Returns an empty array when
     * no documents are seeded so the gate fails open rather than locking
     * everyone out.
     *
     * @param {import("../../Model/User")} user
     * @returns {Promise<Array<{key:string,title:string,version:number}>>}
     */
    static async getPendingDocuments(user)
    {
        const legalDocuments = await LegalDocumentQueryEngine.getAll();
        if (!Array.isArray(legalDocuments) || legalDocuments.length === 0)
        {
            return [];
        }

        const additionalData = (user && typeof user.getAdditionalData === "function" && user.getAdditionalData()) || {};

        const pendingDocuments = [];
        for (const legalDocument of legalDocuments)
        {
            const agreedVersionKey = LegalAcceptanceService.buildAgreedVersionKey(legalDocument.key);
            const storedVersion = Number(additionalData[agreedVersionKey] || 0);

            if (storedVersion < Number(legalDocument.version))
            {
                pendingDocuments.push
                ({
                    key: legalDocument.key,
                    title: legalDocument.title,
                    version: Number(legalDocument.version)
                });
            }
        }

        return pendingDocuments;
    }

    /**
     * Convenience wrapper — true when the user owes acceptance of at least
     * one current legal document.
     *
     * @param {import("../../Model/User")} user
     * @returns {Promise<boolean>}
     */
    static async hasOutstandingAcceptance(user)
    {
        const pendingDocuments = await LegalAcceptanceService.getPendingDocuments(user);
        return pendingDocuments.length > 0;
    }

    /**
     * Records the user's acceptance of a single legal document. The version
     * stamped is always the server's CURRENT version (never the client's
     * claim); a supplied claimedVersion is only used to reject a stale
     * acceptance (the document was re-seeded between display and submit).
     *
     * @param {string} userId
     * @param {string} documentKey  e.g. "TERMS_OF_SERVICE"
     * @param {number|null} claimedVersion  version the client believes it agreed to, or null
     * @returns {Promise<{ok:boolean, reason?:string, additionalData?:object, documents?:Array}>}
     */
    static async recordAcceptance(userId, documentKey, claimedVersion)
    {
        if (!userId || typeof documentKey !== "string" || documentKey.length === 0)
        {
            return { ok: false, reason: "INVALID_REQUEST" };
        }

        const legalDocuments = await LegalDocumentQueryEngine.getAll();
        const targetDocument = Array.isArray(legalDocuments)
            ? legalDocuments.find(legalDocument => legalDocument.key === documentKey)
            : null;

        if (!targetDocument)
        {
            return { ok: false, reason: "UNKNOWN_DOCUMENT" };
        }

        const currentVersion = Number(targetDocument.version);

        // A mismatched claim means the user agreed to a copy that is no longer
        // current — surface the live set so the client re-prompts on the new
        // version rather than silently recording stale consent.
        if (claimedVersion !== null && Number.isFinite(claimedVersion) && claimedVersion !== currentVersion)
        {
            return { ok: false, reason: "VERSION_MISMATCH", documents: LegalAcceptanceService.#toPublicShape(legalDocuments) };
        }

        const agreedVersionKey = LegalAcceptanceService.buildAgreedVersionKey(documentKey);
        const agreedAtKey = LegalAcceptanceService.buildAgreedAtKey(documentKey);

        const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(userId,
        {
            [agreedVersionKey]: currentVersion,
            [agreedAtKey]: new Date().toISOString()
        });

        if (!updatedAdditionalData)
        {
            return { ok: false, reason: "PERSIST_FAILED" };
        }

        return { ok: true, additionalData: updatedAdditionalData };
    }

    /**
     * True when fieldKey is one of the reserved consent fields this service
     * owns. Used by the generic /UpdateUserAdditionalData endpoint to refuse
     * client writes to consent state.
     *
     * @param {string} fieldKey
     * @returns {boolean}
     */
    static isReservedConsentKey(fieldKey)
    {
        return typeof fieldKey === "string" && LegalAcceptanceService.#RESERVED_CONSENT_KEY_REGEX.test(fieldKey);
    }

    static buildAgreedVersionKey(documentKey)
    {
        return LegalAcceptanceService.#AGREED_PREFIX
            + LegalAcceptanceService.#toCamel(documentKey)
            + LegalAcceptanceService.#VERSION_SUFFIX;
    }

    static buildAgreedAtKey(documentKey)
    {
        return LegalAcceptanceService.#AGREED_PREFIX
            + LegalAcceptanceService.#toCamel(documentKey)
            + LegalAcceptanceService.#AT_SUFFIX;
    }

    static #toPublicShape(legalDocuments)
    {
        if (!Array.isArray(legalDocuments))
        {
            return [];
        }
        return legalDocuments.map(legalDocument =>
        ({
            key: legalDocument.key,
            title: legalDocument.title,
            version: Number(legalDocument.version)
        }));
    }

    static #toCamel(snakeCaseString)
    {
        const lowered = String(snakeCaseString || "").toLowerCase();
        return lowered
            .split("_")
            .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
            .join("");
    }
}

module.exports = LegalAcceptanceService;
