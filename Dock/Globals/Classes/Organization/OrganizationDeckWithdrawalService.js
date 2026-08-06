const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const SyncQueryEngine = require("../Database/SyncQueryEngine");
const KeyManagementService = require("../Security/KeyManagementService");
const OrganizationDeckQueryEngine = require("./OrganizationDeckQueryEngine");
const PaidDeckScopeResolver = require("../PaidDeck/PaidDeckScopeResolver");
const { entityTypes } = require("../../Enumerations/EntityTypes");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");

/**
 * OrganizationDeckWithdrawalService
 *
 * Takes a deck back from everyone an organization gave it to.
 *
 * Withdrawal is not deletion of the deck — the master content stays, so the
 * institute can re-publish or correct it. What it removes is every member's
 * COPY, and it has to do so through the same mechanism a lapsed marketplace
 * licence uses: revoke the licence, then tombstone the seeded rows so every one
 * of that member's devices converges on the removal at its next sync rather
 * than keeping a local copy of content the institute has pulled.
 *
 * Progress goes with the content, and that is the intended behaviour rather
 * than an oversight: the progress belongs to entities that no longer exist, and
 * bulkRecordDeletions cascades from each copy's root deck to its cards, study
 * materials, mock tests and overlays for exactly that reason.
 *
 * Every step is idempotent, so a withdrawal interrupted half-way can simply be
 * run again — which matters, because it touches one member at a time and there
 * is no transaction spanning them.
 */
class OrganizationDeckWithdrawalService
{
    /**
     * Withdraws a deck from every member holding it.
     *
     * @param {string} organizationId
     * @param {string} deckId
     * @returns {Promise<{ withdrawn: boolean, licensesRevoked: number, membersAffected: number, rootsTombstoned: number }>}
     */
    static async withdraw(organizationId, deckId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            throw new Error("Database unavailable");
        }

        const paidDeck = await OrganizationDeckQueryEngine.getOrganizationDeck(organizationId, deckId);
        if (!paidDeck)
        {
            return { withdrawn: false, licensesRevoked: 0, membersAffected: 0, rootsTombstoned: 0 };
        }

        // Unpublish FIRST. A member who has not yet added the deck must not be
        // able to grab a copy while the withdrawal is walking the ones who have
        // — the shelf reads isPublished, so flipping it closes the door before
        // anybody else can come through it.
        await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .updateOne({ id: deckId, audienceOrganizationId: organizationId }, { $set: { isPublished: false, updatedAt: new Date() } });

        const licenseDocuments = await OrganizationDeckQueryEngine.listActiveLicenseDocuments(deckId);

        let licensesRevoked = 0;
        let rootsTombstoned = 0;

        for (const licenseDocument of licenseDocuments)
        {
            const memberUserId = licenseDocument.userId;
            const scopeKey = PaidDeckScopeResolver.resolveForLicense(licenseDocument, memberUserId);

            try
            {
                // Revoked before the rows are torn down. If the process dies
                // between the two, the member holds a revoked licence and the
                // lapsed-deck reaper finishes the job on their next sync — the
                // failure mode is "cleaned up slightly later", never "still
                // studying withdrawn content".
                await KeyManagementService.revokeLicense(memberUserId, deckId);
                licensesRevoked = licensesRevoked + 1;
            }
            catch (revokeError)
            {
                console.error(`[OrganizationDeckWithdrawal] Could not revoke ${deckId} for ${memberUserId}: ${revokeError?.message || revokeError}`);
                continue;
            }

            rootsTombstoned = rootsTombstoned + await OrganizationDeckWithdrawalService.#tombstoneCopiesInScope(database, scopeKey, deckId);
        }

        console.log(`[OrganizationDeckWithdrawal] Withdrew ${deckId} from ${licensesRevoked} member(s) of ${organizationId}; ${rootsTombstoned} copy root(s) tombstoned.`);

        return {
            withdrawn: true,
            licensesRevoked: licensesRevoked,
            membersAffected: licenseDocuments.length,
            rootsTombstoned: rootsTombstoned
        };
    }

    /**
     * Tombstones every copy of the deck inside one scope.
     *
     * bulkRecordDeletions both records the tombstone (so other devices
     * converge) and removes the rows, and cascades from each copy's root deck
     * through its whole subtree — which is why only the roots are collected
     * here.
     */
    static async #tombstoneCopiesInScope(database, scopeKey, deckId)
    {
        const copyRootRows = await database
            .collection(DatabaseConstants.DECKS_COLLECTION)
            .find({ userId: scopeKey, "data.additionalData.paidDeckId": deckId }, { projection: { _id: 0, "data.id": 1 } })
            .toArray();

        const deletionChanges = copyRootRows
            .filter(row => row?.data?.id)
            .map(row => ({ entityId: row.data.id, entityType: entityTypes.DECK }));

        if (deletionChanges.length === 0)
        {
            return 0;
        }

        await SyncQueryEngine.bulkRecordDeletions(scopeKey, database, deletionChanges);
        return deletionChanges.length;
    }

    /**
     * Withdraws one member's copies of every deck an organization gave them.
     *
     * Called when a membership ends. Without it, someone removed from an
     * institute would keep studying its material indefinitely — their licences
     * would still be ACTIVE, so nothing else in the system would ever take it
     * back.
     *
     * @param {string} organizationId
     * @param {string} memberUserId
     * @returns {Promise<{ licensesRevoked: number, rootsTombstoned: number }>}
     */
    static async withdrawAllForMember(organizationId, memberUserId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database || typeof memberUserId !== "string" || memberUserId.length === 0)
        {
            return { licensesRevoked: 0, rootsTombstoned: 0 };
        }

        const organizationDecks = await OrganizationDeckQueryEngine.listDecksForOrganization(organizationId);
        const organizationDeckIds = organizationDecks.map(paidDeck => paidDeck.getId());

        if (organizationDeckIds.length === 0)
        {
            return { licensesRevoked: 0, rootsTombstoned: 0 };
        }

        const licenseDocuments = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find({ userId: memberUserId, deckId: { $in: organizationDeckIds }, status: deckLicenseStatuses.ACTIVE })
            .toArray();

        let licensesRevoked = 0;
        let rootsTombstoned = 0;

        for (const licenseDocument of licenseDocuments)
        {
            const scopeKey = PaidDeckScopeResolver.resolveForLicense(licenseDocument, memberUserId);

            try
            {
                await KeyManagementService.revokeLicense(memberUserId, licenseDocument.deckId);
                licensesRevoked = licensesRevoked + 1;
            }
            catch (revokeError)
            {
                console.error(`[OrganizationDeckWithdrawal] Could not revoke ${licenseDocument.deckId} for ${memberUserId}: ${revokeError?.message || revokeError}`);
                continue;
            }

            rootsTombstoned = rootsTombstoned + await OrganizationDeckWithdrawalService.#tombstoneCopiesInScope(database, scopeKey, licenseDocument.deckId);
        }

        return { licensesRevoked: licensesRevoked, rootsTombstoned: rootsTombstoned };
    }
}

module.exports = OrganizationDeckWithdrawalService;
