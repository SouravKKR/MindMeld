/**
 * End-to-end verification harness for an organization's own member columns —
 * how they are discovered, named, retyped, and RENAMED.
 *
 * Run from the Dock directory:
 *     node VerifyOrganizationMemberColumns.mjs
 *     VERIFY_ORGANIZATION_DB=1 node VerifyOrganizationMemberColumns.mjs
 *
 *   1. ALWAYS — the pure parts: that a header resolves to the same key however
 *      it is spelled and that doing so twice is a no-op (a normaliser that is
 *      not idempotent silently forks a column in two the first time a stored key
 *      is written back), and that a header resolves through a column's current
 *      name and its former names.
 *
 *   2. DB (opt-in: VERIFY_ORGANIZATION_DB=1) — the rename, which is the part
 *      with teeth. There is no replica set behind this deployment, so the
 *      migration cannot be a transaction; it is a copy → repoint → cleanup
 *      sequence instead. What is checked is the property that ordering buys:
 *      a permission rule covers exactly the same people BEFORE, DURING and
 *      AFTER the rename, so nobody loses a feature while it is in flight. A run
 *      killed halfway is resumed and must reach the same answer.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const OrganizationMemberColumnRenamer = require("./Globals/Classes/Organization/OrganizationMemberColumnRenamer");
const OrganizationMemberColumnQueryEngine = require("./Globals/Classes/Organization/OrganizationMemberColumnQueryEngine");
const OrganizationMemberColumnBackfiller = require("./Globals/Classes/Organization/OrganizationMemberColumnBackfiller");
const MemberSheetHeaderResolver = require("./Globals/Classes/Organization/MemberSheetHeaderResolver");
const MemberAttributeTypeInferrer = require("./Globals/Classes/Organization/MemberAttributeTypeInferrer");
const MemberAudienceMatcher = require("./Globals/Classes/Organization/MemberAudienceMatcher");
const OrganizationMemberProfileNormaliser = require("./Globals/Classes/Organization/OrganizationMemberProfileNormaliser");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const OrganizationMemberColumn = require("./Globals/Model/OrganizationMemberColumn");
const { handleOrganizationEndpoints } = require("./Endpoints/HandleOrganizationEndpoints");
const { memberAttributeValueTypes } = require("./Globals/Enumerations/MemberAttributeValueTypes");
const { memberColumnRenamePhases } = require("./Globals/Enumerations/MemberColumnRenamePhases");
const { paidDeckFilterTypes } = require("./Globals/Enumerations/PaidDeckFilterTypes");
const { tagMatchModes } = require("./Globals/Enumerations/TagMatchModes");

const TEST_ORGANIZATION_ID = "verify-columns-organization";

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(bCondition, description)
{
    if (bCondition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  ${description}`);
    }
}

function skip(description)
{
    skippedCount = skippedCount + 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}


async function runAlwaysOnTier()
{
    section("Tier 1 — header resolution, idempotence and type inference");

    // ── Idempotence ───────────────────────────────────────────────────────
    // Every stored key is re-normalised on every edit. A normaliser that
    // lowercases first turns "joinYear" into "joinyear" — a DIFFERENT attribute
    // — so an edit would write the corrected value to a new column beside the
    // original and leave every filter and rule reading the old one.
    for (const rawHeader of ["Join Year", "joinYear", "join_year", "join-year", "JOIN YEAR", "  Join   Year  "])
    {
        assert(OrganizationMemberProfileNormaliser.toAttributeKey(rawHeader) === "joinYear", `"${rawHeader}" resolves to joinYear`);
    }

    for (const rawHeader of ["Join Year", "joinYear", "Roll Number", "rollNumber", "name"])
    {
        const firstPass = OrganizationMemberProfileNormaliser.toAttributeKey(rawHeader);
        assert(OrganizationMemberProfileNormaliser.toAttributeKey(firstPass) === firstPass, `Normalising "${rawHeader}" twice is a no-op`);
    }

    // ── Labels derived from stored keys ───────────────────────────────────
    assert(OrganizationMemberColumnQueryEngine.describeAttributeKey("joinYear") === "Join Year", "A camelCase key reads back as separate words");
    assert(OrganizationMemberColumnQueryEngine.describeAttributeKey("rollNumber") === "Roll Number", "So does a two-word key");

    // ── Header resolution through current and former names ────────────────
    const renamedColumn = OrganizationMemberColumn.fromJson
    ({
        id: "column-1", organizationId: TEST_ORGANIZATION_ID, key: "admissionYear", label: "Year of Admission",
        valueType: memberAttributeValueTypes.NUMBER, aliases: ["joinYear"], displayOrder: 0,
        renamePhase: memberColumnRenamePhases.IDLE, pendingRenameToKey: "", createdAt: new Date().toISOString()
    });

    assert(OrganizationMemberColumnQueryEngine.resolveColumnForHeader([renamedColumn], "admissionYear")?.getKey() === "admissionYear", "A header matching the stored key resolves");
    assert(OrganizationMemberColumnQueryEngine.resolveColumnForHeader([renamedColumn], "Year of Admission")?.getKey() === "admissionYear", "A header matching the institute's own label resolves");
    assert(OrganizationMemberColumnQueryEngine.resolveColumnForHeader([renamedColumn], "Join Year")?.getKey() === "admissionYear", "A header matching a FORMER name still resolves — the office's old spreadsheet keeps working");
    assert(OrganizationMemberColumnQueryEngine.resolveColumnForHeader([renamedColumn], "Stream") === null, "A genuinely new header resolves to nothing and becomes its own column");

    const resolvedAttributes = MemberSheetHeaderResolver.resolveAttributeKeys([renamedColumn], { "Join Year": "2021", "Stream": "B.Tech CSE" });
    assert(resolvedAttributes.admissionYear === "2021", "A sheet still headed with the old name lands in the renamed column");
    assert(resolvedAttributes.joinYear === undefined, "It does NOT recreate the old column alongside it");
    assert(resolvedAttributes.stream === "B.Tech CSE", "An unrelated column is carried through untouched");

    // ── Type inference is a suggestion with a known failure mode ──────────
    assert(MemberAttributeTypeInferrer.inferTypeFromValues(["2024", "2019"]) === memberAttributeValueTypes.NUMBER, "An all-numeric column reads as a number");
    assert(MemberAttributeTypeInferrer.inferTypeFromValues(["2024", "N/A"]) === memberAttributeValueTypes.STRING, "One non-numeric value drops the whole column to text — which is why the type is overridable");
    assert(MemberAttributeTypeInferrer.inferTypeFromValues(["2024-07-15", "2023-01-02"]) === memberAttributeValueTypes.DATE, "An all-date column reads as a date");
    assert(MemberAttributeTypeInferrer.inferTypeFromValues([]) === memberAttributeValueTypes.STRING, "A column with no observed values falls back to text");

    // ── Routes ────────────────────────────────────────────────────────────
    const registeredRoutes = [];
    handleOrganizationEndpoints({ handle: (configuration) => registeredRoutes.push(configuration) });

    for (const routePath of ["/Organization/Members/Update", "/Organization/Members/BulkUpdate", "/Organization/Members/UpdateByFilter",
                             "/Organization/Members/Columns/List", "/Organization/Members/Columns/Set",
                             "/Organization/Members/Columns/Rename", "/Organization/Members/Columns/Delete",
                             "/Organization/Permissions/PreviewRule"])
    {
        assert(registeredRoutes.some(route => route.routePath === routePath), `Route ${routePath} is registered`);
    }

    assert(registeredRoutes.every(route => Array.isArray(route.plugins) && route.plugins.length > 0), "Every organization route still carries an authorization plugin");
}


async function runDatabaseTier()
{
    section("Tier 2 — live database (opt-in: VERIFY_ORGANIZATION_DB=1)");

    if (process.env.VERIFY_ORGANIZATION_DB !== "1")
    {
        skip("Database tier disabled — set VERIFY_ORGANIZATION_DB=1 to run it");
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        skip("No database connection available");
        return;
    }

    const membersCollection = database.collection(DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION);
    const columnsCollection = database.collection(DatabaseConstants.ORGANIZATION_MEMBER_COLUMNS_COLLECTION);
    const rulesCollection = database.collection(DatabaseConstants.ORGANIZATION_PERMISSION_RULES_COLLECTION);

    const resetFixture = async () =>
    {
        await membersCollection.deleteMany({ organizationId: TEST_ORGANIZATION_ID });
        await columnsCollection.deleteMany({ organizationId: TEST_ORGANIZATION_ID });
        await rulesCollection.deleteMany({ organizationId: TEST_ORGANIZATION_ID });

        // A deliberately heterogeneous roster: the teacher carries no joining
        // year at all, which is the shape a real institute uploads.
        const seedProfiles =
        [
            { id: "verify-column-member-1", email: "one@verify.edu", attributes: { "Name": "Arjun Rao", "Join Year": "2024", "Role": "student" }, tags: ["first-year"] },
            { id: "verify-column-member-2", email: "two@verify.edu", attributes: { "Name": "Sara Iyer", "Join Year": "2019", "Role": "student" }, tags: [] },
            { id: "verify-column-member-3", email: "three@verify.edu", attributes: { "Name": "M Khan", "Role": "teacher" }, tags: [] }
        ];

        await membersCollection.insertMany(seedProfiles.map((seedProfile) =>
        {
            const normalisedProfile = OrganizationMemberProfileNormaliser.normalise(seedProfile);
            return {
                id: seedProfile.id,
                organizationId: TEST_ORGANIZATION_ID,
                email: seedProfile.email,
                userId: "",
                addedBy: "",
                delegatePowers: 0,
                tags: normalisedProfile.tags,
                attributes: normalisedProfile.attributes,
                attributesNormalised: normalisedProfile.attributesNormalised,
                attributesComparable: normalisedProfile.attributesComparable,
                addedAt: new Date()
            };
        }));

        await OrganizationMemberColumnBackfiller.backfillForOrganization(database, TEST_ORGANIZATION_ID);

        await rulesCollection.insertOne
        ({
            id: "verify-column-rule", organizationId: TEST_ORGANIZATION_ID, name: "Recent intake",
            tagFilter: [], matchMode: tagMatchModes.EVERYONE,
            attributeConditions: [{ key: "attribute:joinYear", type: paidDeckFilterTypes.NUMBER_RANGE, field: "attributesComparable.joinYear", value: { min: 2020, max: 2030 } }],
            allowedFeatures: [], storageGrantBytes: 0, createdAt: new Date().toISOString()
        });
    };

    // Who the rule covers right now, decided exactly the way the live feature
    // gate decides it.
    const whoTheRuleCovers = async () =>
    {
        const rule = await rulesCollection.findOne({ id: "verify-column-rule" });
        const members = await membersCollection.find({ organizationId: TEST_ORGANIZATION_ID }).toArray();
        return members
            .filter(member => MemberAudienceMatcher.matchesMember(member, { tagFilter: rule.tagFilter, matchMode: rule.matchMode, attributeConditions: rule.attributeConditions }))
            .map(member => member.id)
            .sort();
    };

    try
    {
        // ── The schema is discovered from the roster ──────────────────────
        await resetFixture();

        const discoveredColumns = await OrganizationMemberColumnQueryEngine.listColumnsForOrganization(TEST_ORGANIZATION_ID);
        const discoveredKeys = discoveredColumns.map(column => column.getKey()).sort();
        assert(JSON.stringify(discoveredKeys) === JSON.stringify(["joinYear", "name", "role"]), `The schema is derived from the roster: ${JSON.stringify(discoveredKeys)}`);
        assert(discoveredColumns.find(column => column.getKey() === "joinYear").getValueType() === memberAttributeValueTypes.NUMBER, "An all-numeric column is discovered as a number");
        assert(discoveredColumns.find(column => column.getKey() === "joinYear").getLabel() === "Join Year", "It is labelled the way a person would write it");
        assert(discoveredColumns.find(column => column.getKey() === "role").getValueType() === memberAttributeValueTypes.STRING, "A role column stays plain text");

        // ── The backfill never overwrites the institute's own naming ──────
        await OrganizationMemberColumnQueryEngine.updateColumns(TEST_ORGANIZATION_ID,
        [
            { key: "joinYear", label: "Year of Admission", valueType: memberAttributeValueTypes.NUMBER, displayOrder: 0 }
        ]);
        await OrganizationMemberColumnBackfiller.backfillForOrganization(database, TEST_ORGANIZATION_ID);

        const afterSecondBackfill = await OrganizationMemberColumnQueryEngine.listColumnsForOrganization(TEST_ORGANIZATION_ID);
        assert(afterSecondBackfill.length === 3, "Re-running the backfill creates no duplicates");
        assert(afterSecondBackfill.find(column => column.getKey() === "joinYear").getLabel() === "Year of Admission", "A label the institute chose survives a re-run");

        // ── The rename ────────────────────────────────────────────────────
        section("Tier 2a — renaming a column keeps every entitlement intact");

        await resetFixture();
        const coverageBefore = await whoTheRuleCovers();
        assert(JSON.stringify(coverageBefore) === JSON.stringify(["verify-column-member-1"]), `The rule covers [${coverageBefore.join(",")}] before the rename`);

        const renameResult = await OrganizationMemberColumnRenamer.rename(TEST_ORGANIZATION_ID, "joinYear", "admissionYear", "Year of Admission");
        assert(renameResult.ok === true, `The rename completed (${renameResult.membersCopied} members, ${renameResult.rulesRepointed} rule(s) repointed)`);

        const coverageAfter = await whoTheRuleCovers();
        assert(JSON.stringify(coverageAfter) === JSON.stringify(coverageBefore), `The rule STILL covers exactly [${coverageAfter.join(",")}] — nobody lost a feature`);

        const renamedMember = await membersCollection.findOne({ id: "verify-column-member-1" });
        assert(renamedMember.attributes.admissionYear === "2024", "The displayed value moved to the new key");
        assert(renamedMember.attributesComparable.admissionYear === 2024, "The comparable copy moved and is still a number");
        assert(renamedMember.attributesNormalised.admissionYear === "2024", "The lowercased copy moved");
        assert(renamedMember.attributes.joinYear === undefined && renamedMember.attributesComparable.joinYear === undefined, "The old key is gone from every copy");

        const teacherAfterRename = await membersCollection.findOne({ id: "verify-column-member-3" });
        assert(teacherAfterRename.attributes.admissionYear === undefined, "A member who never had the column did not gain an empty one");

        const repointedRule = await rulesCollection.findOne({ id: "verify-column-rule" });
        assert(repointedRule.attributeConditions[0].field === "attributesComparable.admissionYear", "The rule's field was repointed");
        assert(repointedRule.attributeConditions[0].key === "attribute:admissionYear", "The rule's key was repointed alongside it");

        const renamedColumnRow = await OrganizationMemberColumnQueryEngine.findColumnByKey(TEST_ORGANIZATION_ID, "admissionYear");
        assert(renamedColumnRow !== null && renamedColumnRow.getLabel() === "Year of Admission", "The column row carries the new key and label");
        assert(renamedColumnRow.getAliases().includes("joinYear"), "The old name is kept, so existing spreadsheets still import");
        assert(renamedColumnRow.getRenamePhase() === memberColumnRenamePhases.IDLE, "The rename settled back to IDLE");

        // ── Guards ────────────────────────────────────────────────────────
        section("Tier 2b — guards");

        await resetFixture();
        const relabelOnly = await OrganizationMemberColumnRenamer.rename(TEST_ORGANIZATION_ID, "joinYear", "Join Year", "Relabelled Only");
        assert(relabelOnly.ok === true && relabelOnly.newKey === "joinYear", "Renaming to the same key is a relabel, not a migration");
        assert((await OrganizationMemberColumnQueryEngine.findColumnByKey(TEST_ORGANIZATION_ID, "joinYear")).getLabel() === "Relabelled Only", "The new label was still applied");

        const ontoExisting = await OrganizationMemberColumnRenamer.rename(TEST_ORGANIZATION_ID, "joinYear", "role", "Clash");
        assert(ontoExisting.ok === false, `Renaming onto an existing column is refused (${ontoExisting.reason})`);

        const ontoEmail = await OrganizationMemberColumnRenamer.rename(TEST_ORGANIZATION_ID, "joinYear", "email", "Nope");
        assert(ontoEmail.ok === false, `Renaming onto the reserved email column is refused (${ontoEmail.reason})`);

        // ── Crash recovery ────────────────────────────────────────────────
        section("Tier 2c — a rename killed halfway is resumable");

        await resetFixture();
        // A process that recorded the phase and died before repointing.
        await OrganizationMemberColumnQueryEngine.setRenamePhase(TEST_ORGANIZATION_ID, "joinYear", memberColumnRenamePhases.COPYING, "admissionYear");

        const coverageMidFlight = await whoTheRuleCovers();
        assert(JSON.stringify(coverageMidFlight) === JSON.stringify(["verify-column-member-1"]), "Mid-rename, the rule covers the same member — the window where entitlements would lapse does not exist");

        const blockedRename = await OrganizationMemberColumnRenamer.rename(TEST_ORGANIZATION_ID, "joinYear", "somethingElse", "X");
        assert(blockedRename.ok === false, `A second rename while one is in flight is refused (${blockedRename.reason})`);

        const resumeResult = await OrganizationMemberColumnRenamer.resumeInterruptedRename(TEST_ORGANIZATION_ID, "joinYear");
        assert(resumeResult.ok === true && resumeResult.resumed === true, "The interrupted rename resumes from its recorded phase");

        const coverageAfterResume = await whoTheRuleCovers();
        assert(JSON.stringify(coverageAfterResume) === JSON.stringify(["verify-column-member-1"]), `After resuming, the rule covers [${coverageAfterResume.join(",")}] — unchanged throughout`);

        const settledColumn = await OrganizationMemberColumnQueryEngine.findColumnByKey(TEST_ORGANIZATION_ID, "admissionYear");
        assert(settledColumn !== null && settledColumn.getRenamePhase() === memberColumnRenamePhases.IDLE, "The resumed rename completed and settled");

        const secondResume = await OrganizationMemberColumnRenamer.resumeInterruptedRename(TEST_ORGANIZATION_ID, "admissionYear");
        assert(secondResume.ok === true && secondResume.resumed === false, "Resuming an already-settled column does nothing");

        // ── A renamed column keeps absorbing the old spreadsheet ──────────
        const columnsAfterRename = await OrganizationMemberColumnQueryEngine.listColumnsForOrganization(TEST_ORGANIZATION_ID);
        const reimported = MemberSheetHeaderResolver.resolveAttributeKeys(columnsAfterRename, { "Join Year": "2021" });
        assert(reimported.admissionYear === "2021", "A re-import using the OLD header lands in the renamed column");
    }
    finally
    {
        try
        {
            await membersCollection.deleteMany({ organizationId: TEST_ORGANIZATION_ID });
            await columnsCollection.deleteMany({ organizationId: TEST_ORGANIZATION_ID });
            await rulesCollection.deleteMany({ organizationId: TEST_ORGANIZATION_ID });
        }
        catch (cleanupError)
        {
            console.log(`  NOTE  Cleanup of ${TEST_ORGANIZATION_ID} failed: ${cleanupError.message}`);
        }
    }
}


async function main()
{
    console.log("CogniumLearn — organization member columns verification\n");

    await runAlwaysOnTier();
    await runDatabaseTier();

    console.log(`\n---------------------------------------------`);
    console.log(`Passed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("\nFATAL — verification harness crashed:");
    console.error(fatalError);
    process.exit(1);
});
