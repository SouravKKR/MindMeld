/**
 * End-to-end verification harness for how an organization decides WHO a
 * description covers — the shared answer behind permission rules, one-off credit
 * distribution and recurring credit assignments.
 *
 * Run from the Dock directory:
 *     node VerifyMemberAudienceMatching.mjs
 *     VERIFY_ORGANIZATION_DB=1 node VerifyMemberAudienceMatching.mjs
 *
 *   1. ALWAYS — the parts that need no server: tag semantics (everyone / any /
 *      all), that an unknown operator FAILS CLOSED rather than matching, that an
 *      unusable condition selects nobody, and that the rule field allow-list
 *      refuses paths a rule has no business reading.
 *
 *   2. DB (opt-in: VERIFY_ORGANIZATION_DB=1) — the reason this file exists.
 *      MongoQueryFragmentEvaluator answers "would Mongo have returned this
 *      document" without asking Mongo, so it is checked AGAINST a real Mongo for
 *      the identical fragment, document by document. Then the two paths that
 *      must never disagree — the set query behind the rule preview, and the
 *      per-member verdict behind the live feature gate — are run over the same
 *      audiences and required to name exactly the same people.
 *
 *      That second check is the load-bearing one. If those two drift, an
 *      administrator is shown one cohort in the preview and a different cohort
 *      is granted the paid feature, which is a discrepancy nobody would notice
 *      until a member either lost access or gained it unpaid.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const MongoQueryFragmentEvaluator = require("./Globals/Classes/Organization/MongoQueryFragmentEvaluator");
const MemberAudienceMatcher = require("./Globals/Classes/Organization/MemberAudienceMatcher");
const MemberConditionFilterFactory = require("./Globals/Classes/Organization/MemberConditionFilterFactory");
const OrganizationPermissionRuleQueryEngine = require("./Globals/Classes/Organization/OrganizationPermissionRuleQueryEngine");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const { paidDeckFilterTypes } = require("./Globals/Enumerations/PaidDeckFilterTypes");
const { tagMatchModes } = require("./Globals/Enumerations/TagMatchModes");

const PROBE_COLLECTION_NAME = "verifyMemberAudienceMatching";

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

/**
 * A roster chosen to be awkward on purpose: members missing columns entirely,
 * a numeric column polluted with text, a tag differing only in case, a member
 * with no tags field at all, and two roll numbers straddling the inclusive end
 * of a string range.
 */
function buildProbeMembers()
{
    return [
        { id: "m01", email: "a@x.edu", tags: ["first-year", "scholarship"], attributes: { name: "Arjun Rao", role: "student", joinYear: "2024" }, attributesNormalised: { name: "arjun rao", role: "student", joinYear: "2024" }, attributesComparable: { joinYear: 2024 } },
        { id: "m02", email: "b@x.edu", tags: ["final-year", "scholarship"], attributes: { name: "Sara Iyer", role: "student", joinYear: "2019" }, attributesNormalised: { name: "sara iyer", role: "student", joinYear: "2019" }, attributesComparable: { joinYear: 2019 } },
        { id: "m03", email: "c@x.edu", tags: ["staff"], attributes: { name: "M Khan", role: "teacher" }, attributesNormalised: { name: "m khan", role: "teacher" }, attributesComparable: {} },
        { id: "m04", email: "d@x.edu", tags: [], attributes: { name: "Zoe Ng", role: "teacher", joinYear: "N/A" }, attributesNormalised: { name: "zoe ng", role: "teacher", joinYear: "n/a" }, attributesComparable: {} },
        // The dangerous one: a year that LOOKS numeric but was stored as text.
        { id: "m05", email: "e@x.edu", tags: ["first-year"], attributes: { name: "Text Year", role: "student", joinYear: "2021" }, attributesNormalised: { name: "text year", role: "student", joinYear: "2021" }, attributesComparable: { joinYear: "2021" } },
        { id: "m06", email: "f@x.edu", tags: ["first-year", "scholarship", "merit"], attributes: { name: "Many Tags", role: "student", joinYear: "2022" }, attributesNormalised: { name: "many tags", role: "student", joinYear: "2022" }, attributesComparable: { joinYear: 2022 } },
        { id: "m07", email: "g@x.edu", attributes: { name: "No Tags Field" }, attributesNormalised: { name: "no tags field" }, attributesComparable: {} },
        // Tagged in a different case — must NOT match a lowercase tag filter.
        { id: "m08", email: "h@x.edu", tags: ["FIRST-YEAR"], attributes: { name: "Upper Tag", joinYear: "2024" }, attributesNormalised: { name: "upper tag", joinYear: "2024" }, attributesComparable: { joinYear: 2024 } },
        { id: "m09", email: "i@x.edu", tags: ["first-year"], attributes: { name: "Mz Edge", rollNumber: "Mz" }, attributesNormalised: { name: "mz edge", rollNumber: "mz" }, attributesComparable: {} },
        { id: "m10", email: "j@x.edu", tags: ["first-year"], attributes: { name: "Mza Edge", rollNumber: "Mza" }, attributesNormalised: { name: "mza edge", rollNumber: "mza" }, attributesComparable: {} }
    ];
}

function buildYearCondition(minimumYear, maximumYear)
{
    return { key: "attribute:joinYear", type: paidDeckFilterTypes.NUMBER_RANGE, field: "attributesComparable.joinYear", value: { min: minimumYear, max: maximumYear } };
}

function buildRoleCondition(roleName)
{
    return { key: "attribute:role", type: paidDeckFilterTypes.STRING_RANGE, field: "attributesNormalised.role", value: { start: roleName, end: roleName } };
}

function buildProbeAudiences()
{
    return [
        ["everyone", { matchMode: tagMatchModes.EVERYONE }],
        ["tag ANY", { tagFilter: ["scholarship"], matchMode: tagMatchModes.ANY }],
        ["tag ALL", { tagFilter: ["first-year", "scholarship"], matchMode: tagMatchModes.ALL }],
        ["tag ALL of three", { tagFilter: ["first-year", "scholarship", "merit"], matchMode: tagMatchModes.ALL }],
        ["tag filter is case-sensitive against stored tags", { tagFilter: ["first-year"], matchMode: tagMatchModes.ANY }],
        ["an empty tag list still means everyone", { tagFilter: [], matchMode: tagMatchModes.ANY }],
        ["a year range alone", { matchMode: tagMatchModes.EVERYONE, attributeConditions: [buildYearCondition(2022, 2024)] }],
        ["a role alone", { matchMode: tagMatchModes.EVERYONE, attributeConditions: [buildRoleCondition("teacher")] }],
        ["role AND year", { matchMode: tagMatchModes.EVERYONE, attributeConditions: [buildRoleCondition("student"), buildYearCondition(2022, 2024)] }],
        ["tag AND year", { tagFilter: ["scholarship"], matchMode: tagMatchModes.ANY, attributeConditions: [buildYearCondition(2022, 2024)] }],
        ["tag ALL AND role AND year", { tagFilter: ["first-year", "scholarship"], matchMode: tagMatchModes.ALL, attributeConditions: [buildRoleCondition("student"), buildYearCondition(2020, 2024)] }],
        ["a range matching nobody", { matchMode: tagMatchModes.EVERYONE, attributeConditions: [buildYearCondition(1900, 1901)] }],
        ["a range over a column some members lack", { matchMode: tagMatchModes.EVERYONE, attributeConditions: [buildYearCondition(2000, 2100)] }],
        ["an unusable condition selects nobody", { matchMode: tagMatchModes.EVERYONE, attributeConditions: [{ key: "k", type: 999, field: "attributes.role", value: {} }] }]
    ];
}


async function runAlwaysOnTier()
{
    section("Tier 1 — tag semantics, fail-closed behaviour and the field allow-list");

    const members = buildProbeMembers();

    // ── Tag match modes ───────────────────────────────────────────────────
    assert(MemberAudienceMatcher.filterMembers(members, { matchMode: tagMatchModes.EVERYONE }).length === members.length, "EVERYONE covers the whole roster");
    assert(MemberAudienceMatcher.filterMembers(members, { tagFilter: ["scholarship"], matchMode: tagMatchModes.ANY }).length === 3, "ANY covers every member holding the tag");
    assert(MemberAudienceMatcher.filterMembers(members, { tagFilter: ["first-year", "scholarship"], matchMode: tagMatchModes.ALL }).length === 2, "ALL requires every tag, not any of them");
    assert(MemberAudienceMatcher.filterMembers(members, { tagFilter: [], matchMode: tagMatchModes.ANY }).length === members.length, "An empty tag list can never select nobody");
    assert(MemberAudienceMatcher.filterMembers(members, { tagFilter: ["  SCHOLARSHIP "], matchMode: tagMatchModes.ANY }).length === 3, "A tag filter is trimmed and lowercased before matching");

    // ── An audience that narrows nothing ──────────────────────────────────
    assert(MemberAudienceMatcher.isEveryone({ matchMode: tagMatchModes.EVERYONE }) === true, "A rule with no tags and no conditions is recognised as covering everyone");
    assert(MemberAudienceMatcher.isEveryone({ tagFilter: ["staff"], matchMode: tagMatchModes.ANY }) === false, "A rule with a tag is not everyone");
    assert(MemberAudienceMatcher.isEveryone({ matchMode: tagMatchModes.EVERYONE, attributeConditions: [buildRoleCondition("teacher")] }) === false, "A rule with a condition is not everyone");

    // ── A tags-only stub is a legitimate caller ───────────────────────────
    const tagsOnlyStub = { getTags: () => ["scholarship"] };
    assert(MemberAudienceMatcher.matchesMember(tagsOnlyStub, { tagFilter: ["scholarship"], matchMode: tagMatchModes.ANY }) === true, "A member object carrying only tags can still be asked a tag question");

    // ── Fail closed ───────────────────────────────────────────────────────
    let bThrewOnUnknownFieldOperator = false;
    try
    {
        MongoQueryFragmentEvaluator.matches(members[0], { "attributes.name": { $unknownOperator: 1 } });
    }
    catch (thrownError)
    {
        bThrewOnUnknownFieldOperator = true;
    }
    assert(bThrewOnUnknownFieldOperator, "An unrecognised field operator THROWS rather than being skipped");

    let bThrewOnUnknownLogicalOperator = false;
    try
    {
        MongoQueryFragmentEvaluator.matches(members[0], { $where: "true" });
    }
    catch (thrownError)
    {
        bThrewOnUnknownLogicalOperator = true;
    }
    assert(bThrewOnUnknownLogicalOperator, "An unrecognised top-level operator THROWS rather than being skipped");

    assert(MemberAudienceMatcher.matchesMember(members[0], { matchMode: tagMatchModes.EVERYONE, attributeConditions: [{ key: "k", type: 999, field: "attributes.role", value: {} }] }) === false, "A condition that cannot be rebuilt selects NOBODY rather than everybody");
    assert(MemberConditionFilterFactory.create({ key: "k", type: 999, field: "attributes.role" }) === null, "An unknown condition type produces no filter");
    assert(MemberConditionFilterFactory.create({ key: "k", type: paidDeckFilterTypes.NUMBER_RANGE, field: "" }) === null, "A condition with no field produces no filter");

    // ── Type bracketing, which is what keeps a text year out of a number range ──
    const textYearMember = members.find(member => member.id === "m05");
    assert(MongoQueryFragmentEvaluator.matches(textYearMember, { "attributesComparable.joinYear": { $gte: 2021, $lte: 2021 } }) === false, "A year stored as TEXT is outside a numeric range, as it is in Mongo");
    assert(MongoQueryFragmentEvaluator.matches(members[0], { "attributesComparable.joinYear": { $gte: 2024, $lte: 2024 } }) === true, "A year stored as a NUMBER is inside the same range");

    // ── The field allow-list ──────────────────────────────────────────────
    for (const allowedField of ["attributesComparable.joinYear", "attributesNormalised.name", "attributes.role", "tags", "email", "addedAt"])
    {
        assert(OrganizationPermissionRuleQueryEngine.isTargetableField(allowedField) === true, `A rule may read ${allowedField}`);
    }

    for (const refusedField of ["delegatePowers", "userId", "organizationId", "attributes", "attributesComparable.a.b", "attributes.$where", "__proto__", ""])
    {
        assert(OrganizationPermissionRuleQueryEngine.isTargetableField(refusedField) === false, `A rule may NOT read ${JSON.stringify(refusedField)}`);
    }

    const refusedConditions = OrganizationPermissionRuleQueryEngine.validateAttributeConditions([{ key: "k", type: paidDeckFilterTypes.NUMBER_RANGE, field: "delegatePowers", value: { min: 1 } }]);
    assert(refusedConditions.valid === false, "A rule naming a membership-internal field is refused when it is saved");
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

    const collection = database.collection(PROBE_COLLECTION_NAME);
    const members = buildProbeMembers();

    try
    {
        await collection.deleteMany({});
        await collection.insertMany(members.map(member => ({ ...member })));

        // ── The evaluator against a real server ───────────────────────────
        section("Tier 2a — the in-memory evaluator agrees with MongoDB itself");

        const queryFragments =
        [
            ["a numeric range at both ends", { "attributesComparable.joinYear": { $gte: 2019, $lte: 2024 } }],
            ["a numeric range open at the start", { "attributesComparable.joinYear": { $lte: 2020 } }],
            ["a numeric range open at the end", { "attributesComparable.joinYear": { $gte: 2021 } }],
            ["a numeric range against a TEXT-stored year", { "attributesComparable.joinYear": { $gte: 2021, $lte: 2021 } }],
            ["tags $in one value", { tags: { $in: ["first-year"] } }],
            ["tags $in several values", { tags: { $in: ["scholarship", "final-year"] } }],
            ["tags by bare equality", { tags: "first-year" }],
            ["a string range including its end (the \\uFFFF suffix)", { "attributesNormalised.rollNumber": { $gte: "a", $lte: "mz￿" } }],
            ["a string range excluding beyond its end", { "attributesNormalised.rollNumber": { $gte: "a", $lte: "my￿" } }],
            ["a case-insensitive regex", { "attributes.name": { $regex: "rao", $options: "i" } }],
            ["a case-sensitive regex", { "attributes.name": { $regex: "rao" } }],
            ["an $or across fields", { $or: [{ "attributes.name": { $regex: "Khan", $options: "i" } }, { "attributes.name": { $regex: "Iyer", $options: "i" } }] }],
            ["an $and of a range and a tag", { $and: [{ "attributesComparable.joinYear": { $gte: 2020 } }, { tags: { $in: ["first-year"] } }] }],
            ["$exists on a column only some members carry", { "attributes.role": { $exists: true } }],
            ["$exists false on the same column", { "attributes.role": { $exists: false } }],
            ["$exists false on tags", { tags: { $exists: false } }],
            ["$ne against a tag", { tags: { $ne: "first-year" } }],
            ["$nin against tags", { tags: { $nin: ["first-year", "final-year"] } }],
            ["an empty fragment", {}],
            ["a range over a column nobody has", { "attributesComparable.marks": { $gte: 0, $lte: 100 } }]
        ];

        for (const [description, queryFragment] of queryFragments)
        {
            const mongoDocuments = await collection.find(queryFragment, { projection: { _id: 0, id: 1 } }).toArray();
            const mongoIds = mongoDocuments.map(document => document.id).sort();
            const evaluatorIds = members.filter(member => MongoQueryFragmentEvaluator.matches(member, queryFragment)).map(member => member.id).sort();

            assert(JSON.stringify(mongoIds) === JSON.stringify(evaluatorIds), `The evaluator and MongoDB agree on ${description} [${mongoIds.join(",") || "none"}]`);
        }

        // ── The two audience paths against each other ─────────────────────
        section("Tier 2b — the rule preview and the live feature gate name the same people");

        for (const [description, audience] of buildProbeAudiences())
        {
            const audienceQuery = MemberAudienceMatcher.buildAudienceQuery(audience);
            const previewDocuments = await collection.find(audienceQuery, { projection: { _id: 0, id: 1 } }).toArray();
            const previewIds = previewDocuments.map(document => document.id).sort();

            const gateIds = members.filter(member => MemberAudienceMatcher.matchesMember(member, audience)).map(member => member.id).sort();

            assert(JSON.stringify(previewIds) === JSON.stringify(gateIds), `Preview and feature gate agree on "${description}" [${previewIds.join(",") || "none"}]`);
        }
    }
    finally
    {
        try
        {
            await collection.drop();
        }
        catch (cleanupError)
        {
            console.log(`  NOTE  Cleanup of ${PROBE_COLLECTION_NAME} failed: ${cleanupError.message}`);
        }
    }
}


async function main()
{
    console.log("CogniumLearn — organization member audience matching verification\n");

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
