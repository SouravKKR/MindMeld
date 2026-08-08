const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const KeyManagementService = require("../Security/KeyManagementService");
const PaidDeckAcquisitionGate = require("./PaidDeckAcquisitionGate");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * PaidDeckRetirementService
 *
 * Taking a paid deck off the market, and — separately — destroying one.
 *
 * These are two different acts and conflating them is how buyers lose content
 * they paid for.
 *
 *   RETIRE   The deck stops being sold. Everyone who already bought it keeps it
 *            for exactly as long as their licence says: a finite licence runs
 *            to its own expiry and is then swept like any other lapsed licence,
 *            a perpetual one never expires and that buyer keeps it for good.
 *            Nobody new can acquire it by any route, and it cannot come back —
 *            so once a finite licence lapses there is nothing to renew, which
 *            is the whole point.
 *
 *   DELETE   The listing and its encrypted master content are destroyed.
 *            Refused by default while anybody holds an active licence. Retire
 *            first, wait for the licences to lapse, then delete.
 *
 * WHAT DELETING ACTUALLY BREAKS, stated precisely, because the refusal above
 * used to claim more than it could support. Deleting removes the master
 * entities and the wrapped content key; it does not touch anyone's licence or
 * anyone's own copy. So:
 *
 *   - A holder who has already seeded the deck KEEPS IT WORKING. Their content
 *     lives in their own rows and their licence still carries the key.
 *   - A holder who bought it and never opened it gets NOTHING, permanently:
 *     seeding reads the master.
 *   - Adding a device copy, updating content and rotating keys all stop working.
 *
 * So the guard protects un-seeded holders and future seeding, not "everyone".
 * FORCED DELETION (deletePermanently with bForceDeleteWithActiveHolders) exists
 * for the operator who accepts that, and it REVOKES every active licence in the
 * same operation. Leaving a holder an entitlement that points at content which
 * no longer exists would be worse than the deletion itself — they would see a
 * deck they own fail to open, with nothing to tell them why.
 *
 * Outside that explicit override, existing licences are never touched by either
 * path. That is not an omission: revoking on withdrawal would take away
 * something already paid for, and the lapsed-licence reaper already tears down
 * content the moment a licence stops being valid on its own terms.
 */
class PaidDeckRetirementService
{
    /**
     * How many people still hold this deck, and how they hold it.
     *
     * Perpetual holders are counted separately because they are the reason a
     * deck may never become deletable: their licences have no expiry to wait
     * for, so "retire and delete later" is not a plan for that deck.
     *
     * @param {string} deckId
     * @returns {Promise<{ activeCount: number, perpetualCount: number, latestExpiryIso: string }>}
     */
    static async summariseHolders(deckId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database || typeof deckId !== "string" || deckId.length === 0)
        {
            return { activeCount: 0, perpetualCount: 0, latestExpiryIso: "" };
        }

        const licenseDocuments = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find({ deckId: deckId, status: deckLicenseStatuses.ACTIVE }, { projection: { _id: 0, expiresAt: 1 } })
            .toArray();

        let perpetualCount = 0;
        let latestExpiryIso = "";

        for (const licenseDocument of licenseDocuments)
        {
            // The stored expiry is an ISO string and the epoch sentinel means
            // "never" — the same convention DeckLicense and the reaper use, so
            // the comparison is string-to-string rather than against a Date.
            const expiresAtIso = typeof licenseDocument.expiresAt === "string" ? licenseDocument.expiresAt : "";
            const expiryMilliseconds = expiresAtIso.length > 0 ? new Date(expiresAtIso).getTime() : 0;

            if (!expiresAtIso || isNaN(expiryMilliseconds) || expiryMilliseconds <= 0)
            {
                perpetualCount = perpetualCount + 1;
                continue;
            }

            if (expiresAtIso > latestExpiryIso)
            {
                latestExpiryIso = expiresAtIso;
            }
        }

        return { activeCount: licenseDocuments.length, perpetualCount: perpetualCount, latestExpiryIso: latestExpiryIso };
    }

    /**
     * Withdraws the deck from sale.
     *
     * @param {string} deckId
     * @param {string} retiredByUserId
     * @returns {Promise<{ success: boolean, error?: string, holders?: object }>}
     */
    static async retire(deckId, retiredByUserId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return { success: false, error: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const collection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
        const deckDocument = await collection.findOne({ id: deckId });

        if (!deckDocument)
        {
            return { success: false, error: ErrorCodes.PAID_DECK_NOT_FOUND };
        }

        if (PaidDeckAcquisitionGate.isRetired(deckDocument))
        {
            return { success: false, error: ErrorCodes.PAID_DECK_ALREADY_RETIRED };
        }

        const holders = await PaidDeckRetirementService.summariseHolders(deckId);
        const retiredAt = new Date();

        // Unpublished AND stamped. Unpublishing alone is what an operator does
        // to a draft and is reversible; the stamp is what makes this permanent
        // and is what every acquisition path refuses on.
        await collection.updateOne
        (
            { id: deckId },
            {
                $set:
                {
                    isPublished: false,
                    retiredAt: retiredAt.toISOString(),
                    updatedAt: retiredAt
                }
            }
        );

        console.log(`[PaidDeckRetirement] ${deckId} retired by ${retiredByUserId || "unknown"}; ${holders.activeCount} active licence(s) left untouched.`);

        return { success: true, retiredAt: retiredAt.toISOString(), holders: holders };
    }

    /**
     * Destroys the listing and its encrypted master content.
     *
     * @param {string} deckId
     * @param {string} deletedByUserId
     * @param {boolean} bForceDeleteWithActiveHolders
     *   When true, proceeds despite active holders AND revokes their licences
     *   in the same operation. Only ever set from an administrator's second,
     *   explicitly-confirmed action naming how many holders it affects.
     * @returns {Promise<{ success: boolean, error?: string, holders?: object, revokedLicenseCount?: number }>}
     */
    static async deletePermanently(deckId, deletedByUserId, bForceDeleteWithActiveHolders = false)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return { success: false, error: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const collection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
        const deckDocument = await collection.findOne({ id: deckId });

        if (!deckDocument)
        {
            return { success: false, error: ErrorCodes.PAID_DECK_NOT_FOUND };
        }

        // The default stop. Removing the master takes the deck away from every
        // holder who has not seeded it yet, and stops content updates and extra
        // device copies for everyone else — so an operator who has not said
        // they accept that gets a refusal naming the holders.
        const holders = await PaidDeckRetirementService.summariseHolders(deckId);
        let revokedLicenseCount = 0;

        if (holders.activeCount > 0)
        {
            if (!bForceDeleteWithActiveHolders)
            {
                return { success: false, error: ErrorCodes.PAID_DECK_STILL_HELD, holders: holders };
            }

            // Revoked BEFORE the content goes, and in the same operation. A
            // holder left with an active licence pointing at a deleted deck
            // would see something they own simply fail, with nothing anywhere
            // to explain it — worse than being told the deck is gone.
            revokedLicenseCount = await PaidDeckRetirementService.#revokeActiveLicenses(database, deckId);

            console.log(
                `[PaidDeckRetirement] ${deckId} FORCE-DELETED by ${deletedByUserId || "unknown"}; `
                + `${revokedLicenseCount} active licence(s) revoked.`,
            );
        }

        // The master entities first. If this half succeeds and the listing
        // delete does not, the deck is left unsellable-but-listed, which an
        // operator can see and retry — the reverse would leave orphaned
        // encrypted content nothing points at.
        try
        {
            await KeyManagementService.deletePaidDeckMaster(deckId);
        }
        catch (masterDeleteError)
        {
            console.error(`[PaidDeckRetirement] Could not remove master content for ${deckId}: ${masterDeleteError?.message || masterDeleteError}`);
            return { success: false, error: ErrorCodes.EXCEPTION };
        }

        await collection.deleteOne({ id: deckId });

        // Everything that pointed at the listing. Left behind, a pricing row or
        // a perk would keep referring to a deck that no longer exists — and an
        // organization's perk list would show a blank row nobody can explain.
        await database.collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION).deleteMany({ deckId: deckId });
        await database.collection(DatabaseConstants.ORGANIZATION_DECK_PERKS_COLLECTION).deleteMany({ deckId: deckId });

        // A bundle that listed this deck as a child must stop doing so.
        await collection.updateMany({ bundleChildIds: deckId }, { $pull: { bundleChildIds: deckId } });
        await collection.updateMany({ parentBundleIds: deckId }, { $pull: { parentBundleIds: deckId } });

        console.log(`[PaidDeckRetirement] ${deckId} deleted permanently by ${deletedByUserId || "unknown"}.`);

        return { success: true, holders: holders, revokedLicenseCount: revokedLicenseCount };
    }

    /**
     * Marks every active licence for this deck revoked.
     *
     * Revoked rather than deleted: the row is the record that someone once held
     * this, which a refund or a dispute later needs. A deleted licence would
     * leave no trace that the platform took something away.
     *
     * @returns {Promise<number>} how many licences were revoked
     */
    static async #revokeActiveLicenses(database, deckId)
    {
        const revocationResult = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .updateMany(
                { deckId: deckId, status: deckLicenseStatuses.ACTIVE },
                {
                    $set:
                    {
                        status: deckLicenseStatuses.REVOKED,
                        revokedAt: new Date().toISOString(),
                        revocationReason: "The deck was permanently deleted by an administrator.",
                    },
                },
            );

        return revocationResult.modifiedCount || 0;
    }
}

module.exports = PaidDeckRetirementService;
