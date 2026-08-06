/**
 * End-to-end verification harness for organization member profiles: tags,
 * attributes, the imported-sheet contract, range filtering and filtered
 * removal.
 *
 * Run from the Dock directory:
 *     node VerifyOrganizationMembers.mjs
 *     VERIFY_ORGANIZATION_DB=1 node VerifyOrganizationMembers.mjs
 *
 *   1. ALWAYS — pure checks of the normalisation and filter algebra: header to
 *      attribute key, tag canonicalisation, the typed comparable value, the
 *      inclusive ends of a string range, and that the new routes are
 *      registered. No network, no database.
 *
 *   2. DB (opt-in: VERIFY_ORGANIZATION_DB=1) — drives the real query engine and
 *      list builder against MongoDB: an import adds and REPLACES, absent
 *      members are untouched, the per-organization filter set is built from the
 *      attributes actually present, ranges select inclusively at both ends, and
 *      filtered removal previews exactly what it then deletes — with the seat
 *      count following it. Everything it creates is prefixed and removed.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const OrganizationMemberProfileNormaliser = require("./Globals/Classes/Organization/OrganizationMemberProfileNormaliser");
const OrganizationMemberListBuilder = require("./Globals/Classes/Organization/OrganizationMemberListBuilder");
const OrganizationMemberQueryEngine = require("./Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationQueryEngine = require("./Globals/Classes/Organization/OrganizationQueryEngine");
const StringRangeFilter = require("./Globals/Classes/PaidDeckFilters/StringRangeFilter");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const Organization = require("./Globals/Model/Organization");
const { handleOrganizationEndpoints } = require("./Endpoints/HandleOrganizationEndpoints");
const { organizationStatus } = require("./Globals/Enumerations/OrganizationStatus");
const { memberAttributeValueTypes } = require("./Globals/Enumerations/MemberAttributeValueTypes");
const { paidDeckFilterTypes } = require("./Globals/Enumerations/PaidDeckFilterTypes");

const TEST_NAME_PREFIX = "verify-members-";

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
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
    section("Tier 1 — normalisation, filter algebra and routes");

    // ── Header to attribute key ───────────────────────────────────────────
    assert(OrganizationMemberProfileNormaliser.toAttributeKey("Roll Number") === "rollNumber", '"Roll Number" becomes rollNumber');
    assert(OrganizationMemberProfileNormaliser.toAttributeKey("roll_number") === "rollNumber", '"roll_number" becomes the SAME key');
    assert(OrganizationMemberProfileNormaliser.toAttributeKey("roll-number") === "rollNumber", '"roll-number" becomes the SAME key');
    assert(OrganizationMemberProfileNormaliser.toAttributeKey("  Join Year  ") === "joinYear", "Surrounding whitespace does not change the key");
    assert(OrganizationMemberProfileNormaliser.toAttributeKey("   ") === "", "A blank header yields no key");

    // ── Tags ──────────────────────────────────────────────────────────────
    const tagProfile = OrganizationMemberProfileNormaliser.normalise({ tags: ["Final-Year", "final-year", " Scholarship ", ""] });
    assert(tagProfile.tags.length === 2, "Tags differing only in case collapse to one");
    assert(tagProfile.tags.includes("final-year") && tagProfile.tags.includes("scholarship"), "Tags are stored lowercased and trimmed");

    // ── Attributes and their comparable copies ────────────────────────────
    const profile = OrganizationMemberProfileNormaliser.normalise
    ({
        attributes: { "Name": "Arjun Rao", "Join Year": "2024", "Stream": "", "Enrolled On": "2024-07-15" }
    });

    assert(profile.attributes.name === "Arjun Rao", "An attribute value keeps the casing it was typed in");
    assert(profile.attributesNormalised.name === "arjun rao", "A lowercased copy is stored for text ranges");
    assert(profile.attributesComparable.joinYear === 2024, "A numeric value gets a NUMBER comparable copy");
    assert(typeof profile.attributesComparable.name === "undefined", "Plain text gets no comparable copy");
    assert(profile.attributes.stream === undefined, "An empty cell is an absent value, not an empty one");
    assert(typeof profile.attributesComparable.enrolledOn === "string" && profile.attributesComparable.enrolledOn.startsWith("2024-07-15"), "A date value gets an ISO comparable copy");

    assert(OrganizationMemberProfileNormaliser.toComparableValue("2024") === 2024, "A bare year is a NUMBER, not a date");
    assert(OrganizationMemberProfileNormaliser.toComparableValue("A0142") === undefined, "A roll number is neither a number nor a date");

    // ── Inclusive string range ────────────────────────────────────────────
    const stringRangeFilter = new StringRangeFilter({ key: "attribute:rollNumber", label: "Roll number", field: "attributesNormalised.rollNumber" });
    const rangeQuery = stringRangeFilter.toMongoQuery({ start: "A0100", end: "A0450" });
    const rangeClause = rangeQuery["attributesNormalised.rollNumber"];

    assert(rangeClause.$gte === "a0100", "The start bound is lowercased to match the stored copy");
    assert(rangeClause.$lte.startsWith("a0450"), "The end bound is lowercased too");
    assert(rangeClause.$lte.length > "a0450".length, "The end bound is extended so the range INCLUDES values that merely extend it");
    assert("a0450a" <= rangeClause.$lte, "A longer value starting with the end bound falls inside the range");
    assert(!("a0451" <= rangeClause.$lte), "The next value beyond the end bound falls outside the range");

    assert(stringRangeFilter.toMongoQuery({ start: "", end: "" }) === null, "An empty range produces no query fragment");
    assert(stringRangeFilter.toMongoQuery({ start: "A0100" })["attributesNormalised.rollNumber"].$lte === undefined, "An open-ended range constrains only the end it was given");

    const filterMetadata = await stringRangeFilter.getMetadata(null);
    assert(filterMetadata.type === paidDeckFilterTypes.STRING_RANGE, "The filter reports the STRING_RANGE type the client renders from");

    // ── Routes ────────────────────────────────────────────────────────────
    const registeredRoutes = [];
    handleOrganizationEndpoints({ handle: (routeDefinition) => registeredRoutes.push(routeDefinition) });
    const routePaths = registeredRoutes.map(route => route.routePath);

    for (const expectedPath of ["/Organization/Members/Import", "/Organization/Members/RemoveByFilter", "/Organization/Lists/Metadata", "/Organization/Lists/Query"])
    {
        assert(routePaths.includes(expectedPath), `Route ${expectedPath} is registered`);
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

    let database = null;
    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`MongoDB unreachable (${connectionError.message}) — database tier not run`);
        return;
    }

    if (!database)
    {
        skip("MongoDB not configured — database tier not run");
        return;
    }

    const uniqueSuffix = process.pid;
    const createdOrganizationIds = [];

    try
    {
        const now = new Date();
        const organization = await OrganizationQueryEngine.createOrganization(new Organization
        ({
            name: `${TEST_NAME_PREFIX}${uniqueSuffix}`,
            adminEmail: `${TEST_NAME_PREFIX}owner-${uniqueSuffix}@example.invalid`,
            adminUserId: `${TEST_NAME_PREFIX}owner-${uniqueSuffix}`,
            status: organizationStatus.ACTIVE,
            currency: "INR",
            creationAmountMinor: 0,
            maxMembers: 50,
            currentMemberCount: 0,
            creationDate: now,
            activationDate: now,
            additionalData: {}
        }));
        createdOrganizationIds.push(organization.getId());
        const organizationId = organization.getId();

        // ── Import a roster ───────────────────────────────────────────────
        const rosterRows =
        [
            { email: `${TEST_NAME_PREFIX}a-${uniqueSuffix}@example.invalid`, attributes: { "Name": "Arjun Rao", "Join Year": "2024", "Roll Number": "A0142" }, tags: ["First-Year", "scholarship"] },
            { email: `${TEST_NAME_PREFIX}b-${uniqueSuffix}@example.invalid`, attributes: { "Name": "Meera Iyer", "Join Year": "2022", "Roll Number": "E0317" }, tags: ["final-year"] },
            { email: `${TEST_NAME_PREFIX}c-${uniqueSuffix}@example.invalid`, attributes: { "Name": "Zoya Khan", "Join Year": "2023", "Roll Number": "M0500" }, tags: ["second-year"] }
        ];

        const normalisedRoster = rosterRows.map(row => ({ email: row.email, ...OrganizationMemberProfileNormaliser.normalise(row) }));

        await OrganizationQueryEngine.tryIncrementMemberCountBy(organizationId, normalisedRoster.length);
        const addResult = await OrganizationMemberQueryEngine.bulkAddMembers(organizationId, normalisedRoster, "importer");
        assert(addResult.added.length === 3, "Every roster row is inserted");

        const storedMembers = await OrganizationMemberQueryEngine.listMembers(organizationId);
        const storedFirst = storedMembers.find(member => member.getEmail() === rosterRows[0].email);
        assert(storedFirst.getTags().includes("first-year"), "An imported tag is stored canonicalised");
        assert(storedFirst.getAttributes().rollNumber === "A0142", "An imported attribute keeps the casing it was typed in");
        assert(storedFirst.getAttributesComparable().joinYear === 2024, "A numeric attribute is stored as a number for range comparison");

        // ── Re-import REPLACES, and leaves absentees alone ────────────────
        const correctedRow =
        {
            email: rosterRows[0].email,
            ...OrganizationMemberProfileNormaliser.normalise({ attributes: { "Name": "Arjun Rao", "Join Year": "2024", "Roll Number": "A0143" }, tags: ["first-year"] })
        };
        await OrganizationMemberQueryEngine.replaceProfilesForExistingMembers(organizationId, [correctedRow]);

        const reimportedMembers = await OrganizationMemberQueryEngine.listMembers(organizationId);
        const reimportedFirst = reimportedMembers.find(member => member.getEmail() === rosterRows[0].email);
        const untouchedSecond = reimportedMembers.find(member => member.getEmail() === rosterRows[1].email);

        assert(reimportedFirst.getAttributes().rollNumber === "A0143", "Re-importing replaces a corrected attribute");
        assert(!reimportedFirst.getTags().includes("scholarship"), "A tag dropped from the sheet is REMOVED from the member");
        assert(untouchedSecond.getTags().includes("final-year"), "A member absent from the re-import is left untouched");
        assert(reimportedMembers.length === 3, "Re-importing adds nobody and removes nobody");

        // ── The per-organization filter set ───────────────────────────────
        const { definition } = await OrganizationMemberListBuilder.build(database, organizationId);
        const metadata = await definition.getMetadata(database);
        const filterKeys = metadata.filters.map(filter => filter.key);

        assert(filterKeys.includes("tags"), "A tags filter is offered because tags are in use");
        assert(filterKeys.includes("attribute:rollNumber"), "A filter is offered for an attribute the organization actually uses");
        assert(filterKeys.includes("attribute:joinYear"), "A filter is offered for the join-year attribute");
        assert(!filterKeys.includes("attribute:section"), "No filter is offered for an attribute nobody uploaded");

        const joinYearFilter = metadata.filters.find(filter => filter.key === "attribute:joinYear");
        assert(joinYearFilter.type === paidDeckFilterTypes.NUMBER_RANGE, "An all-numeric attribute is offered as a NUMBER range");

        const rollNumberFilter = metadata.filters.find(filter => filter.key === "attribute:rollNumber");
        assert(rollNumberFilter.type === paidDeckFilterTypes.STRING_RANGE, "A text attribute is offered as a STRING range");

        // ── Ranges select inclusively, at both ends ───────────────────────
        const collection = database.collection("organizationMembers");

        const numberRangeQuery = OrganizationMemberListBuilder.buildFilterQuery(definition, { "attribute:joinYear": { min: 2022, max: 2023 } }, "");
        const numberMatches = await collection.countDocuments({ ...numberRangeQuery, organizationId: organizationId });
        assert(numberMatches === 2, "A number range includes BOTH its end values (2022 and 2023 matched, 2024 excluded)");

        const stringRangeQuery = OrganizationMemberListBuilder.buildFilterQuery(definition, { "attribute:rollNumber": { start: "A0100", end: "E0317" } }, "");
        const stringMatches = await collection.countDocuments({ ...stringRangeQuery, organizationId: organizationId });
        assert(stringMatches === 2, "A string range includes its end value (A0143 and E0317 matched, M0500 excluded)");

        const tagQuery = OrganizationMemberListBuilder.buildFilterQuery(definition, { tags: ["final-year"] }, "");
        const tagMatches = await collection.countDocuments({ ...tagQuery, organizationId: organizationId });
        assert(tagMatches === 1, "A tag filter matches exactly the tagged member");

        // ── The scope cannot be widened by a filter payload ───────────────
        const otherOrganization = await OrganizationQueryEngine.createOrganization(new Organization
        ({
            name: `${TEST_NAME_PREFIX}other-${uniqueSuffix}`,
            adminEmail: `${TEST_NAME_PREFIX}other-${uniqueSuffix}@example.invalid`,
            adminUserId: `${TEST_NAME_PREFIX}other-owner-${uniqueSuffix}`,
            status: organizationStatus.ACTIVE,
            currency: "INR",
            creationAmountMinor: 0,
            maxMembers: 10,
            currentMemberCount: 0,
            creationDate: now,
            activationDate: now,
            additionalData: {}
        }));
        createdOrganizationIds.push(otherOrganization.getId());
        await OrganizationQueryEngine.tryIncrementMemberCount(otherOrganization.getId());
        await OrganizationMemberQueryEngine.addMember(otherOrganization.getId(), `${TEST_NAME_PREFIX}outsider-${uniqueSuffix}@example.invalid`, "importer");

        const AdminListQueryRunner = require("./Globals/Classes/AdminLists/AdminListQueryRunner");
        const pageWithForgedScope = await AdminListQueryRunner.run(definition, database,
        {
            search: "",
            filters: { organizationId: otherOrganization.getId() },
            limit: 100,
            offset: 0
        });
        assert(pageWithForgedScope.totalCount === 3, "A filter payload naming another organization cannot widen the scope");
        assert(pageWithForgedScope.items.every(item => item.email.indexOf("outsider") < 0), "No other organization's member appears in the page");

        // ── Filtered removal previews exactly what it deletes ─────────────
        const removalFilterQuery = OrganizationMemberListBuilder.buildFilterQuery(definition, { "attribute:joinYear": { min: 2024, max: 2024 } }, "");
        assert(!OrganizationMemberListBuilder.isFilterQueryEmpty(removalFilterQuery), "A populated filter is not treated as empty");
        assert(OrganizationMemberListBuilder.isFilterQueryEmpty(OrganizationMemberListBuilder.buildFilterQuery(definition, {}, "")), "An empty filter payload IS treated as empty, so removal refuses it");

        const preview = await OrganizationMemberQueryEngine.previewMembersMatching(organizationId, removalFilterQuery, 10);
        assert(preview.matchedCount === 1, "The dry run reports the number it would remove");
        assert(preview.sample[0].getEmail() === rosterRows[0].email, "The dry run names who would be removed");

        const beforeRemovalOrganization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        const removal = await OrganizationMemberQueryEngine.removeMembersMatching(organizationId, removalFilterQuery);
        assert(removal.removed === preview.matchedCount, "Removal deletes exactly the number the dry run promised");

        const afterRemovalOrganization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        assert(afterRemovalOrganization.getCurrentMemberCount() === beforeRemovalOrganization.getCurrentMemberCount() - removal.removed, "The seat count follows a filtered removal");

        const survivors = await OrganizationMemberQueryEngine.listMembers(organizationId);
        assert(survivors.length === 2, "Only the matched member was removed");
        assert(survivors.every(member => member.getEmail() !== rosterRows[0].email), "The matched member is gone");

        // Removal is scoped: the other organization's member is untouched.
        const otherSurvivors = await OrganizationMemberQueryEngine.listMembers(otherOrganization.getId());
        assert(otherSurvivors.length === 1, "Filtered removal never reaches another organization's roster");

        // ── The vocabulary reflects what remains ──────────────────────────
        const vocabulary = await OrganizationMemberQueryEngine.listProfileVocabulary(organizationId);
        assert(vocabulary.attributeKeys.includes("rollNumber") && vocabulary.attributeKeys.includes("joinYear"), "The attribute vocabulary lists the keys in use");
        assert(!vocabulary.tags.includes("first-year"), "A tag whose only holder was removed leaves the vocabulary");
    }
    catch (databaseTierError)
    {
        assert(false, `Database tier threw: ${databaseTierError.message}`);
        console.error(databaseTierError);
    }
    finally
    {
        for (const organizationId of createdOrganizationIds)
        {
            try
            {
                await OrganizationQueryEngine.deleteOrganization(organizationId);
            }
            catch (cleanupError)
            {
                console.log(`  NOTE  Cleanup of ${organizationId} failed: ${cleanupError.message}`);
            }
        }
    }
}


async function main()
{
    console.log("CogniumLearn — organization member profiles verification\n");

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
