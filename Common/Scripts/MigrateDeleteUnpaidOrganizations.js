/**
 * MigrateDeleteUnpaidOrganizations
 *
 * One-off migration: deletes every organization still sitting at
 * PENDING_PAYMENT.
 *
 * Why. Creating an organization used to be billed, so a new organization was
 * written at PENDING_PAYMENT and only flipped to ACTIVE once a provider
 * callback cleared. Creation is now free and no code path can ever produce that
 * state again — but the rows already in the database would sit there forever:
 * unusable (every edit endpoint refuses a non-ACTIVE organization), invisible
 * to their own admin (the members view lists ACTIVE organizations only), and
 * indistinguishable in the admin list from an organization that is merely new.
 *
 * They are deleted rather than activated because a PENDING_PAYMENT row is, by
 * definition, an organization whose payment never completed — it was never a
 * customer. Activating them would silently hand out free organizations to
 * whoever abandoned a checkout.
 *
 * Deletion goes through OrganizationQueryEngine.deleteOrganization, so it
 * cascades exactly as an admin-initiated delete does: members, deck perks and
 * any outstanding owner verification are removed with the organization. Deck
 * licences are deliberately NOT touched — that is the established contract, and
 * a PENDING organization could never have issued one anyway.
 *
 * Safe to re-run: it only ever matches PENDING_PAYMENT rows, and there is no
 * longer any way to create one.
 *
 * Usage (dry run first — it reports what it found and changes nothing):
 *     node Common/Scripts/MigrateDeleteUnpaidOrganizations.js
 *     node Common/Scripts/MigrateDeleteUnpaidOrganizations.js --confirm
 *
 * Reads Dock's environment, so it targets whichever environment Dock is
 * configured for. Run it once per environment.
 */

const path = require("path");

const dockDirectory = path.join(__dirname, "..", "..", "Dock");
require(path.join(dockDirectory, "node_modules", "dotenv")).config({ path: path.join(dockDirectory, ".env") });

const DatabaseConnector = require(path.join(dockDirectory, "Globals", "Classes", "Database", "DatabaseConnector"));
const DatabaseConstants = require(path.join(dockDirectory, "Globals", "Constants", "DatabaseConstants"));
const OrganizationQueryEngine = require(path.join(dockDirectory, "Globals", "Classes", "Organization", "OrganizationQueryEngine"));
const { organizationStatus } = require(path.join(dockDirectory, "Globals", "Enumerations", "OrganizationStatus"));

const bConfirmed = process.argv.includes("--confirm");


async function migrateDeleteUnpaidOrganizations()
{
    const database = await DatabaseConnector.getDatabase();
    if (database === null)
    {
        console.error("[Migrate] No database connection — check MONGODB_URL. Nothing was changed.");
        process.exitCode = 1;
        return;
    }

    const organizationsCollection = database.collection(DatabaseConstants.ORGANIZATIONS_COLLECTION);
    const pendingFilter = { status: organizationStatus.PENDING_PAYMENT };

    const pendingOrganizations = await organizationsCollection
        .find(pendingFilter, { projection: { _id: 0, id: 1, name: 1, adminEmail: 1, currentMemberCount: 1, creationDate: 1 } })
        .toArray();

    console.log(`[Migrate] Database: ${database.databaseName}`);
    console.log(`[Migrate] Mode: ${bConfirmed ? "EXECUTE" : "DRY RUN (pass --confirm to apply)"}`);
    console.log(`[Migrate] Organizations still at PENDING_PAYMENT: ${pendingOrganizations.length}`);
    console.log("");

    if (pendingOrganizations.length === 0)
    {
        console.log("[Migrate] Nothing to delete.");
        return;
    }

    for (const pendingOrganization of pendingOrganizations)
    {
        console.log(`[Migrate]   ${pendingOrganization.id} — "${pendingOrganization.name}" (owner ${pendingOrganization.adminEmail}, ${pendingOrganization.currentMemberCount} member(s), created ${pendingOrganization.creationDate})`);
    }
    console.log("");

    if (!bConfirmed)
    {
        console.log("[Migrate] Dry run complete — nothing was deleted. Re-run with --confirm to apply.");
        return;
    }

    let deletedCount = 0;
    let failedCount = 0;

    for (const pendingOrganization of pendingOrganizations)
    {
        try
        {
            const deleteResult = await OrganizationQueryEngine.deleteOrganization(pendingOrganization.id);
            if (deleteResult.deleted)
            {
                deletedCount++;
            }
            else
            {
                // Already gone — another run, or an admin deleted it meanwhile.
                console.warn(`[Migrate] ${pendingOrganization.id} was no longer present.`);
            }
        }
        catch (deleteError)
        {
            failedCount++;
            console.error(`[Migrate] Failed to delete ${pendingOrganization.id}: ${deleteError.message}`);
        }
    }

    const remainingCount = await organizationsCollection.countDocuments(pendingFilter);

    console.log("");
    console.log(`[Migrate] Deleted ${deletedCount} organization(s); ${failedCount} failed.`);
    console.log(`[Migrate] Organizations still at PENDING_PAYMENT: ${remainingCount}`);
}

migrateDeleteUnpaidOrganizations()
    .catch((migrationError) =>
    {
        console.error("[Migrate] Failed:", migrationError);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
