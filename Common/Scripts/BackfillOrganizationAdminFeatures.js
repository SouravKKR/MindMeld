/**
 * BackfillOrganizationAdminFeatures
 *
 * One-off migration: gives every organization created BEFORE the owner-features
 * grant existed the same default a new one gets — all of them.
 *
 * Why. What an owner may do inside their own organization's view is now
 * `Organization.adminAllowedFeatures`, ticked in full when the organization is
 * created. Rows written before that field existed do not carry it, and an
 * absent list resolves to an empty one: the owner keeps only the Free floor,
 * exactly as they did before the feature landed. That is not wrong, but it is
 * silent — the super-admin who ships this change would have to reopen every
 * organization and tick seven boxes to get the behaviour the change was made
 * for, and would have no way of knowing which ones they had missed.
 *
 * Only rows MISSING the field are touched. An organization whose list was set
 * deliberately — including one set deliberately to empty — is left exactly as
 * it is, so this can never overwrite a decision somebody made.
 *
 * Safe to re-run: the second run matches nothing.
 *
 * Usage (dry run first — it reports what it found and changes nothing):
 *     node Common/Scripts/BackfillOrganizationAdminFeatures.js
 *     node Common/Scripts/BackfillOrganizationAdminFeatures.js --confirm
 *
 * Reads Dock's environment, so it targets whichever environment Dock is
 * configured for. Run it once per environment.
 */

const path = require("path");

const dockDirectory = path.join(__dirname, "..", "..", "Dock");
require(path.join(dockDirectory, "node_modules", "dotenv")).config({ path: path.join(dockDirectory, ".env") });

const DatabaseConnector = require(path.join(dockDirectory, "Globals", "Classes", "Database", "DatabaseConnector"));
const DatabaseConstants = require(path.join(dockDirectory, "Globals", "Constants", "DatabaseConstants"));
const OrganizationFeatureSelection = require(path.join(dockDirectory, "Globals", "Classes", "Organization", "OrganizationFeatureSelection"));

const bConfirmed = process.argv.includes("--confirm");


async function backfillOrganizationAdminFeatures()
{
    const database = await DatabaseConnector.getDatabase();
    if (database === null)
    {
        console.error("[Backfill] No database connection — check MONGODB_URL. Nothing was changed.");
        process.exitCode = 1;
        return;
    }

    const organizationsCollection = database.collection(DatabaseConstants.ORGANIZATIONS_COLLECTION);

    // Missing OR null only. `$exists: false` alone would skip a row written by a
    // model that serialised the absent field as null, which is exactly what
    // Organization.toJson does for an unset array.
    const missingFilter = { $or: [{ adminAllowedFeatures: { $exists: false } }, { adminAllowedFeatures: null }] };
    const allFeatureValues = OrganizationFeatureSelection.getAllFeatureValues();

    const affectedOrganizations = await organizationsCollection
        .find(missingFilter, { projection: { _id: 0, id: 1, name: 1, adminEmail: 1, status: 1 } })
        .toArray();

    console.log(`[Backfill] Database: ${database.databaseName}`);
    console.log(`[Backfill] Mode: ${bConfirmed ? "EXECUTE" : "DRY RUN (pass --confirm to apply)"}`);
    console.log(`[Backfill] Granting: [${allFeatureValues.join(", ")}]`);
    console.log(`[Backfill] Organizations with no owner-feature list: ${affectedOrganizations.length}`);
    console.log("");

    if (affectedOrganizations.length === 0)
    {
        console.log("[Backfill] Nothing to do.");
        return;
    }

    for (const affectedOrganization of affectedOrganizations)
    {
        console.log(`[Backfill]   ${affectedOrganization.id} — "${affectedOrganization.name}" (owner ${affectedOrganization.adminEmail}, status ${affectedOrganization.status})`);
    }
    console.log("");

    if (!bConfirmed)
    {
        console.log("[Backfill] Dry run complete — nothing was changed. Re-run with --confirm to apply.");
        return;
    }

    const updateResult = await organizationsCollection.updateMany(missingFilter, { $set: { adminAllowedFeatures: allFeatureValues } });
    const remainingCount = await organizationsCollection.countDocuments(missingFilter);

    console.log(`[Backfill] Updated ${updateResult.modifiedCount} organization(s).`);
    console.log(`[Backfill] Organizations still without an owner-feature list: ${remainingCount}`);
}

backfillOrganizationAdminFeatures()
    .catch((migrationError) =>
    {
        console.error("[Backfill] Failed:", migrationError);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
