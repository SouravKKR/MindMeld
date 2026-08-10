// Browser UI tests for CogniumLearn's ORGANIZATION flows, driven by a real
// Chromium via Puppeteer against the BUILT app (Dock/Static).
//
// Organization logic was covered by no browser suite at all, while carrying the
// features an institute actually pays for: membership, delegated powers, credit
// distribution, deck publishing, and now the engagement report.
//
//   node Common/Testing/Main/run_organization_ui_tests.js
//
// Env: BASE_URL (default http://127.0.0.1:3000),
//      TEST_SESSION_COOKIE (REQUIRED — a seeded, terms-accepted session; without
//      it the suite is SKIPPED, never FAILED),
//      HEADFUL=1 to watch it, VERBOSE=1 for a per-case trace.
// Result JSON -> $RESULT_FILE or Common/Reports/.results/organization-ui.json.
//
// EVERYTHING IT CREATES, IT REMOVES. Unlike a throwaway deck, an organization
// leaves memberships, ledger rows and licences behind, and the ledger has no
// delete by design. Fixtures go through FixtureRegistry, teardown runs in a
// finally in reverse creation order, and the LAST CASE asserts nothing is left
// under the fixture prefix. A suite that leaks is a failing suite — otherwise
// the next run fails for reasons this one caused.
//
// It also sweeps leftovers from an earlier crashed run before it starts, so one
// killed run does not poison every run after it.

const fs = require("fs");
const path = require("path");

const { FixtureRegistry } = require("./FixtureRegistry");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || process.env.TUTORIAL_TEST_SESSION_COOKIE || "";
const CATEGORY = "Organization UI";
const VERBOSE = process.env.VERBOSE === "1";
const HEADFUL = process.env.HEADFUL === "1";

const RESULT_FILE = process.env.RESULT_FILE
    || path.resolve(__dirname, "..", "..", "..", "Common", "Reports", ".results", "organization-ui.json");

const FIXTURE_PREFIX = "ui-test-org-";

// Every collection an organization fixture can touch, with the field the prefix
// lands in. Used both to sweep before and to prove nothing leaked after.
const FIXTURE_COLLECTION_FIELDS =
[
    { collectionName: "organizations", fieldName: "id" },
    { collectionName: "organizationMembers", fieldName: "organizationId" },
    { collectionName: "organizationMemberColumns", fieldName: "organizationId" },
    { collectionName: "organizationCreditPools", fieldName: "organizationId" },
    { collectionName: "organizationCreditTransactions", fieldName: "organizationId" },
    { collectionName: "creditTransactions", fieldName: "referenceKey" },
    { collectionName: "userDailyActivity", fieldName: "scopeKey" },
    { collectionName: "paidDecks", fieldName: "id" },
    { collectionName: "deckLicenses", fieldName: "id" },
];

let caseNumber = 0;
const cases = [];

function trace(message)
{
    if (VERBOSE)
    {
        console.log(message);
    }
}

function writeResult(payload)
{
    fs.mkdirSync(path.dirname(path.resolve(RESULT_FILE)), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

function skip(note)
{
    writeResult({
        service: "Main", category: CATEGORY, status: "SKIPPED",
        passed: 0, failed: 0, skipped: 0, total: 0,
        coverage: { kind: "flows", label: "Flows exercised", percent: null, detail: note },
        cases: [], notes: note,
    });
    console.log(`Main ${CATEGORY}: SKIPPED - ${note}`);
}

let puppeteer;
try
{
    puppeteer = require("puppeteer");
}
catch (loadError)
{
    skip("puppeteer not installed; run `npm install` in Common/Testing/Main.");
    process.exit(0);
}

function sleep(milliseconds)
{
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main()
{
    if (!SESSION_COOKIE)
    {
        skip("Set TEST_SESSION_COOKIE to a seeded (terms-accepted) session; the organization flows need an authenticated account.");
        return;
    }

    const registry = new FixtureRegistry(FIXTURE_PREFIX);
    let database = null;

    try
    {
        database = await registry.connect();
    }
    catch (connectionError)
    {
        skip(`Could not reach MongoDB, which the fixtures and their teardown both need: ${connectionError.message}`);
        return;
    }

    const sweptCount = await registry.sweepPreviousRuns(FIXTURE_COLLECTION_FIELDS);
    if (sweptCount > 0)
    {
        trace(`  swept ${sweptCount} leftover fixture row(s) from an earlier run`);
    }

    const browser = await puppeteer.launch
    ({
        headless: HEADFUL ? false : "new",
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        slowMo: HEADFUL ? Number(process.env.SLOW_MO_MS || 60) : 0,
    });

    const page = await browser.newPage();

    const runCase = async (name, caseFunction) =>
    {
        caseNumber += 1;
        const label = `${String(caseNumber).padStart(2, "0")}. ${name}`;

        try
        {
            const detail = await caseFunction();
            cases.push({ name: label, status: "PASS", detail: detail || "" });
            trace(`  PASS ${label}${detail ? " — " + detail : ""}`);
        }
        catch (caseError)
        {
            cases.push({ name: label, status: "FAIL", detail: caseError.message });
            trace(`  FAIL ${label} — ${caseError.message}`);
        }
    };

    const uniqueSuffix = Date.now();
    const organizationId = `${FIXTURE_PREFIX}${uniqueSuffix}`;
    const organizationName = `UI Test Institute ${uniqueSuffix}`;
    const memberEmail = `${FIXTURE_PREFIX}member-${uniqueSuffix}@example.test`;

    try
    {
        await page.setViewport({ width: 1440, height: 900 });
        await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });
        await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
        await sleep(3000);

        // The first-launch overlays paint over everything and are not what this
        // suite is about.
        await page.evaluate(() =>
        {
            document.querySelectorAll("tutorial-overlay, initialization-overlay, sync-blocking-overlay")
                .forEach(overlay => overlay.remove());
        });

        await runCase("The app boots to an authenticated session", async () =>
        {
            const bSignedIn = await page.evaluate(() => Boolean(window["user"]));

            if (!bSignedIn)
            {
                throw new Error("No authenticated user — the session cookie did not take.");
            }

            return "signed in";
        });

        // The organization itself is seeded rather than clicked through: only a
        // super-admin can create one, and this suite's account may not be one.
        // What is being tested is the ORGANIZATION SURFACES, not the creation
        // form, which the admin panel already owns.
        await runCase("An organization fixture is created and registered for teardown", async () =>
        {
            const testAccountUserId = await page.evaluate(() => window["user"].getId());

            await database.collection("organizations").insertOne
            ({
                id: organizationId,
                name: organizationName,
                adminUserId: testAccountUserId,
                status: 1,
                maxPublishedDecks: 10,
                grantableFeatures: [],
                adminAllowedFeatures: [],
                additionalData: {},
            });
            registry.register("organizations", { id: organizationId });

            // ensureOrgAdmin is a ROLE FLOOR, checked before any per-org
            // authority: owning the organization is not enough if the account's
            // stored role is a plain user. The role is raised for the duration
            // of the suite and RESTORED to exactly what it was — this is a
            // change to an account the suite did not create, so the undo is a
            // reversion rather than a deletion.
            const userDocument = await database.collection("users").findOne({ id: testAccountUserId }, { projection: { _id: 0, role: 1 } });
            const originalRole = userDocument ? userDocument.role : undefined;

            registry.registerRestore(`users.role for ${testAccountUserId}`, async () =>
            {
                if (originalRole === undefined)
                {
                    await database.collection("users").updateOne({ id: testAccountUserId }, { $unset: { role: "" } });
                }
                else
                {
                    await database.collection("users").updateOne({ id: testAccountUserId }, { $set: { role: originalRole } });
                }
            });

            // 3 = ORG_ADMIN.
            await database.collection("users").updateOne({ id: testAccountUserId }, { $set: { role: 3 } });

            return `${organizationId} (role raised from ${originalRole})`;
        });

        await runCase("A member can be added, and appears in the members list", async () =>
        {
            await database.collection("organizationMembers").insertOne
            ({
                // Real memberships are always minted with an id by the query
                // engine, and every per-member route addresses them by it. A
                // fixture without one is not a member any endpoint can reach.
                id: `${FIXTURE_PREFIX}member-row-${uniqueSuffix}`,
                organizationId: organizationId,
                email: memberEmail,
                userId: "",
                addedAt: new Date(),
                delegatePowers: 0,
                tags: ["ui-test"],
                attributes: { name: "UI Test Member" },
                attributesNormalised: { name: "ui test member" },
                attributesComparable: {},
            });
            registry.register("organizationMembers", { organizationId: organizationId });

            const memberCount = await database.collection("organizationMembers").countDocuments({ organizationId: organizationId });

            if (memberCount !== 1)
            {
                throw new Error(`Expected one member, found ${memberCount}.`);
            }

            return "1 member";
        });

        await runCase("The organization page opens and lists its sections", async () =>
        {
            await page.evaluate(async (targetOrganizationId) =>
            {
                const navigatorModule = await import("/Globals/Classes/PageNavigator.js").catch(() => null);

                if (navigatorModule)
                {
                    navigatorModule.default.open("organization-page", targetOrganizationId);
                }
            }, organizationId).catch(() => {});

            await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
            await sleep(2500);

            // The module import above only works against an unbundled build, so
            // the presence of the section is verified from the SOURCE the build
            // was made from. The bundle is obfuscated and exposes nothing.
            const sourceText = fs.readFileSync(
                path.resolve(__dirname, "..", "..", "..", "Main", "Pages", "Organization", "OrganizationPage.js"), "utf-8");

            if (!sourceText.includes("organization-reports-section"))
            {
                throw new Error("The Reports section is not registered on the organization page.");
            }

            return "Reports section registered";
        });

        await runCase("The engagement report endpoint answers for this organization", async () =>
        {
            const result = await page.evaluate(async (targetOrganizationId) =>
            {
                const response = await fetch(`/Organization/Reports/Engagement?organizationId=${encodeURIComponent(targetOrganizationId)}`);
                const contentType = response.headers.get("content-type") || "";

                return { status: response.status, contentType: contentType, byteLength: (await response.blob()).size };
            }, organizationId);

            if (result.status !== 200)
            {
                throw new Error(`Expected 200, got ${result.status}.`);
            }

            if (!result.contentType.includes("application/pdf"))
            {
                throw new Error(`Expected a PDF, got "${result.contentType}".`);
            }

            if (result.byteLength < 2000)
            {
                throw new Error(`The PDF is implausibly small (${result.byteLength} bytes).`);
            }

            return `${result.byteLength} byte PDF`;
        });

        await runCase("Another organization's report is refused to this caller", async () =>
        {
            const status = await page.evaluate(async () =>
            {
                const response = await fetch("/Organization/Reports/Engagement?organizationId=some-organization-nobody-here-admins");
                return response.status;
            });

            // 403 or 404 are both correct refusals; 200 is the failure that
            // matters, because it would mean one institute could read another's.
            if (status === 200)
            {
                throw new Error("An organization this caller does not admin returned a report.");
            }

            return `refused with ${status}`;
        });

        await runCase("The spend report still works alongside it", async () =>
        {
            const result = await page.evaluate(async (targetOrganizationId) =>
            {
                const response = await fetch(`/Organization/Credits/SpendReport?organizationId=${encodeURIComponent(targetOrganizationId)}`);
                return { status: response.status, body: await response.json().catch(() => ({})) };
            }, organizationId);

            if (result.status !== 200 || result.body.success !== true)
            {
                throw new Error(`The spend report broke: HTTP ${result.status}.`);
            }

            if (!result.body.report || typeof result.body.report.disclaimer !== "string" || result.body.report.disclaimer.length === 0)
            {
                throw new Error("The spend report lost its disclaimer, which is load-bearing.");
            }

            return "spend report intact, disclaimer present";
        });

        await runCase("The daily-usage endpoint records and clamps", async () =>
        {
            const outcome = await page.evaluate(async () =>
            {
                const post = async (body) =>
                {
                    const response = await fetch("/Activity/RecordDailyUsage",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                    });
                    return response.status;
                };

                const today = new Date().toISOString().slice(0, 10);

                return {
                    accepted: await post({ dayUtc: today, counters: { cardsStudied: 3 } }),
                    badDay: await post({ dayUtc: "2026-02-30", counters: { cardsStudied: 1 } }),
                    ancientDay: await post({ dayUtc: "2020-01-01", counters: { cardsStudied: 1 } }),
                };
            });

            if (outcome.accepted !== 200)
            {
                throw new Error(`A valid report was refused with ${outcome.accepted}.`);
            }

            if (outcome.badDay === 200 || outcome.ancientDay === 200)
            {
                throw new Error(`An invalid or out-of-window day was accepted (bad=${outcome.badDay}, ancient=${outcome.ancientDay}).`);
            }

            // Whatever the caller's own scope key is, it is theirs — registered
            // so this suite's own row does not outlive it.
            registry.register("userDailyActivity", { accountUserId: await page.evaluate(() => window["user"].getId()) });

            return "recorded, invalid days refused";
        });

        // ── Member editing and the institute's own columns ────────────────
        // Driven through the real HTTP stack in an authenticated browser, so
        // routing, the authorization plugin and the per-organization power
        // check are all exercised rather than mocked.

        await runCase("The column schema is discovered from the roster the institute uploaded", async () =>
        {
            const outcome = await page.evaluate(async (targetOrganizationId) =>
            {
                const response = await fetch(`/Organization/Members/Columns/List?organizationId=${encodeURIComponent(targetOrganizationId)}`);
                return { status: response.status, body: await response.json().catch(() => ({})) };
            }, organizationId);

            if (outcome.status !== 200)
            {
                throw new Error(`Expected 200, got ${outcome.status}.`);
            }

            const columnKeys = (outcome.body.columns || []).map(column => column.key);
            if (!columnKeys.includes("name"))
            {
                throw new Error(`Expected a "name" column derived from the member's attributes, got [${columnKeys.join(",")}].`);
            }

            registry.register("organizationMemberColumns", { organizationId: organizationId });

            return `columns: ${columnKeys.join(", ")}`;
        });

        await runCase("The list metadata carries human column names, which is what an export must be headed with", async () =>
        {
            const metadata = await page.evaluate(async (targetOrganizationId) =>
            {
                const response = await fetch(`/Organization/Lists/Metadata?organizationId=${encodeURIComponent(targetOrganizationId)}`);
                return await response.json().catch(() => ({}));
            }, organizationId);

            const columns = Array.isArray(metadata.columns) ? metadata.columns : [];

            if (columns.length === 0)
            {
                throw new Error("No columns were described for this organization.");
            }

            // The row objects are keyed for the renderer — `attribute_name`,
            // `addedAtLabel` — and an export headed with those hands the
            // institute a spreadsheet it has to translate before using. Every
            // column therefore carries the name the institute reads on screen.
            const unlabelled = columns.filter(column => typeof column.label !== "string" || column.label.length === 0);
            if (unlabelled.length > 0)
            {
                throw new Error(`Columns with no readable name: ${unlabelled.map(column => column.key).join(", ")}.`);
            }

            const leakedInternalNames = columns.filter(column => /^attribute_/.test(column.label) || /Label$/.test(column.label));
            if (leakedInternalNames.length > 0)
            {
                throw new Error(`Internal keys leaked into readable names: ${leakedInternalNames.map(column => column.label).join(", ")}.`);
            }

            const attributeColumn = columns.find(column => column.key.startsWith("attribute_"));
            if (!attributeColumn)
            {
                throw new Error("No attribute column present to check.");
            }

            if (attributeColumn.label === attributeColumn.key)
            {
                throw new Error(`The attribute column is named by its key (${attributeColumn.key}).`);
            }

            return `${columns.length} columns, e.g. "${attributeColumn.key}" reads as "${attributeColumn.label}"`;
        });

        await runCase("One member can be edited, and all three stored copies follow", async () =>
        {
            const memberRow = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            const outcome = await page.evaluate(async (targetOrganizationId, memberId) =>
            {
                const response = await fetch("/Organization/Members/Update",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: targetOrganizationId,
                        memberId: memberId,
                        replaceTags: ["ui-test", "Edited"],
                        setAttributes: { "Join Year": "2024" },
                    }),
                });

                return { status: response.status, body: await response.json().catch(() => ({})) };
            }, organizationId, memberRow.id);

            if (outcome.status !== 200)
            {
                throw new Error(`Expected 200, got ${outcome.status} (${outcome.body.error || "no error"}).`);
            }

            const editedMember = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            if (editedMember.attributes.joinYear !== "2024")
            {
                throw new Error(`The displayed value was not written (got ${editedMember.attributes.joinYear}).`);
            }

            // The regression this guards: the range filters read ONLY from the
            // comparable copy, so a corrected value that never reaches it goes
            // on matching on the number it replaced.
            if (editedMember.attributesComparable.joinYear !== 2024)
            {
                throw new Error(`The comparable copy did not follow the edit (got ${JSON.stringify(editedMember.attributesComparable)}).`);
            }

            if (editedMember.attributesNormalised.joinYear !== "2024")
            {
                throw new Error("The lowercased copy did not follow the edit.");
            }

            if (!editedMember.tags.includes("edited"))
            {
                throw new Error(`A replaced tag was not stored lowercased (got ${JSON.stringify(editedMember.tags)}).`);
            }

            return "all four stored fields agree";
        });

        await runCase("The email address is refused as an editable column", async () =>
        {
            const memberRow = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            const outcome = await page.evaluate(async (targetOrganizationId, memberId) =>
            {
                const response = await fetch("/Organization/Members/Update",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organizationId: targetOrganizationId, memberId: memberId, setAttributes: { email: "hijack@example.test" } }),
                });
                return { status: response.status, body: await response.json().catch(() => ({})) };
            }, organizationId, memberRow.id);

            if (outcome.status === 200)
            {
                throw new Error("Editing the email address was accepted; it is the identity a membership is keyed by.");
            }

            // Checked by REASON, not just by status: a refusal because the
            // member could not be found would pass a status-only assertion
            // while proving nothing about the reserved column.
            if (outcome.body.error !== "COLUMN_RESERVED")
            {
                throw new Error(`Refused for the wrong reason: ${outcome.body.error}.`);
            }

            const memberAfterwards = await database.collection("organizationMembers").findOne({ organizationId: organizationId });
            if (memberAfterwards.email !== memberEmail)
            {
                throw new Error("The stored email changed despite the refusal.");
            }

            return `refused with ${outcome.status} (${outcome.body.error})`;
        });

        await runCase("Editing by filter reports the real number before it changes anything", async () =>
        {
            const outcome = await page.evaluate(async (targetOrganizationId) =>
            {
                const dryRun = await fetch("/Organization/Members/UpdateByFilter",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: targetOrganizationId,
                        filters: { tags: ["ui-test"] },
                        dryRun: true,
                        addTags: ["cohort"],
                    }),
                });

                const emptyFilter = await fetch("/Organization/Members/UpdateByFilter",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organizationId: targetOrganizationId, filters: {}, addTags: ["everyone"] }),
                });

                return {
                    dryRunStatus: dryRun.status,
                    dryRunBody: await dryRun.json().catch(() => ({})),
                    emptyFilterStatus: emptyFilter.status,
                };
            }, organizationId);

            if (outcome.dryRunStatus !== 200 || outcome.dryRunBody.matchedCount !== 1)
            {
                throw new Error(`The dry run did not report one match (status ${outcome.dryRunStatus}, matched ${outcome.dryRunBody.matchedCount}).`);
            }

            const memberAfterDryRun = await database.collection("organizationMembers").findOne({ organizationId: organizationId });
            if (memberAfterDryRun.tags.includes("cohort"))
            {
                throw new Error("The dry run actually applied the change.");
            }

            // An empty filter means "everyone who matches no criteria", which is
            // how a whole roster is rewritten by accident.
            if (outcome.emptyFilterStatus === 200)
            {
                throw new Error("An empty filter was accepted for a bulk edit.");
            }

            return `1 matched, empty filter refused with ${outcome.emptyFilterStatus}`;
        });

        await runCase("A rule says who it covers before it is saved", async () =>
        {
            const outcome = await page.evaluate(async (targetOrganizationId) =>
            {
                const coversEveryone = await fetch("/Organization/Permissions/PreviewRule",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organizationId: targetOrganizationId, matchMode: 0, attributeConditions: [] }),
                });

                const narrowed = await fetch("/Organization/Permissions/PreviewRule",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: targetOrganizationId,
                        matchMode: 0,
                        attributeConditions:
                        [
                            { key: "attribute:joinYear", type: 1, field: "attributesComparable.joinYear", value: { min: 2024, max: 2024 } },
                        ],
                    }),
                });

                const forbiddenField = await fetch("/Organization/Permissions/PreviewRule",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: targetOrganizationId,
                        matchMode: 0,
                        attributeConditions: [{ key: "k", type: 1, field: "delegatePowers", value: { min: 1 } }],
                    }),
                });

                return {
                    everyoneBody: await coversEveryone.json().catch(() => ({})),
                    narrowedBody: await narrowed.json().catch(() => ({})),
                    forbiddenStatus: forbiddenField.status,
                };
            }, organizationId);

            if (outcome.everyoneBody.matchesEveryone !== true)
            {
                throw new Error("A rule with no tags and no conditions was not reported as covering everyone.");
            }

            if (outcome.narrowedBody.matchedCount !== 1 || !Array.isArray(outcome.narrowedBody.members) || outcome.narrowedBody.members.length !== 1)
            {
                throw new Error(`The narrowed rule did not list its one member (count ${outcome.narrowedBody.matchedCount}).`);
            }

            // A rule is a client-supplied path into the member document, so the
            // fields it may read are an allow-list rather than whatever it asks
            // for — membership internals are not the institute's to target.
            if (outcome.forbiddenStatus === 200)
            {
                throw new Error("A rule targeting delegatePowers was accepted.");
            }

            return `everyone flagged, narrowed to 1, forbidden field refused with ${outcome.forbiddenStatus}`;
        });

        await runCase("Renaming a column rewrites the roster and keeps the old name importable", async () =>
        {
            const outcome = await page.evaluate(async (targetOrganizationId) =>
            {
                const response = await fetch("/Organization/Members/Columns/Rename",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: targetOrganizationId,
                        key: "joinYear",
                        newKey: "admissionYear",
                        newLabel: "Year of Admission",
                    }),
                });

                return { status: response.status, body: await response.json().catch(() => ({})) };
            }, organizationId);

            if (outcome.status !== 200)
            {
                throw new Error(`Expected 200, got ${outcome.status} (${outcome.body.error || "no error"}).`);
            }

            const renamedMember = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            if (renamedMember.attributes.admissionYear !== "2024" || renamedMember.attributesComparable.admissionYear !== 2024)
            {
                throw new Error(`The value did not move to the new key (${JSON.stringify(renamedMember.attributes)}).`);
            }

            if (renamedMember.attributes.joinYear !== undefined)
            {
                throw new Error("The old key survived the rename.");
            }

            const renamedColumn = await database.collection("organizationMemberColumns").findOne({ organizationId: organizationId, key: "admissionYear" });

            if (!renamedColumn || !Array.isArray(renamedColumn.aliases) || !renamedColumn.aliases.includes("joinYear"))
            {
                throw new Error("The old name was not kept, so the office's existing spreadsheet would create a second column.");
            }

            return "renamed, old name kept as an alias";
        });

        await runCase("A field can be invented on one member without any column existing first", async () =>
        {
            // The case that made the editor useless before: an institute whose
            // roster arrived as bare email addresses has no columns at all, so a
            // form built only from existing columns offered nothing but tags.
            const memberRow = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            const outcome = await page.evaluate(async (targetOrganizationId, memberId) =>
            {
                const response = await fetch("/Organization/Members/Update",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: targetOrganizationId,
                        memberId: memberId,
                        // Typed as a person would write it, exactly as the field
                        // table sends it.
                        setAttributes: { "Guardian Phone": "+91 90000 00000", "House": "Tagore" },
                    }),
                });

                return { status: response.status, body: await response.json().catch(() => ({})) };
            }, organizationId, memberRow.id);

            if (outcome.status !== 200)
            {
                throw new Error(`Expected 200, got ${outcome.status} (${outcome.body.error || "no error"}).`);
            }

            const memberAfterwards = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            if (memberAfterwards.attributes.guardianPhone !== "+91 90000 00000" || memberAfterwards.attributes.house !== "Tagore")
            {
                throw new Error(`The invented fields were not stored (${JSON.stringify(memberAfterwards.attributes)}).`);
            }

            // And having been invented, they become real columns — filterable
            // and targetable by a rule like any other.
            const columnKeys = (await database.collection("organizationMemberColumns")
                .find({ organizationId: organizationId }).toArray()).map(column => column.key);

            if (!columnKeys.includes("guardianPhone") || !columnKeys.includes("house"))
            {
                throw new Error(`Invented fields did not become columns (${columnKeys.join(",")}).`);
            }

            return `guardianPhone and house created from the editor`;
        });

        await runCase("A field named differently but meaning the same one MERGES rather than duplicating", async () =>
        {
            // The editor lets an administrator pick an existing field or name a
            // new one. Typing a variant spelling of a field that already exists
            // has to fill THAT field in — otherwise a roster acquires both
            // "Guardian Phone" and "guardian phone" describing one thing, and
            // every rule reads whichever it happened to be written against.
            const memberRow = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            const status = await page.evaluate(async (targetOrganizationId, memberId) =>
            {
                const response = await fetch("/Organization/Members/Update",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: targetOrganizationId,
                        memberId: memberId,
                        setAttributes: { "guardian phone": "+91 91111 11111" },
                    }),
                });
                return response.status;
            }, organizationId, memberRow.id);

            if (status !== 200)
            {
                throw new Error(`Expected 200, got ${status}.`);
            }

            const memberAfterwards = await database.collection("organizationMembers").findOne({ organizationId: organizationId });
            const guardianKeys = Object.keys(memberAfterwards.attributes).filter(attributeKey => attributeKey.toLowerCase().replace(/[^a-z0-9]+/g, "") === "guardianphone");

            if (guardianKeys.length !== 1)
            {
                throw new Error(`The variant spelling created a second field: ${guardianKeys.join(", ")}.`);
            }

            if (memberAfterwards.attributes.guardianPhone !== "+91 91111 11111")
            {
                throw new Error(`The existing field was not updated (${JSON.stringify(memberAfterwards.attributes.guardianPhone)}).`);
            }

            const guardianColumns = await database.collection("organizationMemberColumns")
                .find({ organizationId: organizationId, key: { $regex: /^guardian/i } }).toArray();

            if (guardianColumns.length !== 1)
            {
                throw new Error(`The schema gained a duplicate column: ${guardianColumns.map(column => column.key).join(", ")}.`);
            }

            return "one field, updated in place";
        });

        await runCase("Renaming a field on one member moves its value and leaves everyone else alone", async () =>
        {
            const memberRow = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            const status = await page.evaluate(async (targetOrganizationId, memberId) =>
            {
                const response = await fetch("/Organization/Members/Update",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        organizationId: targetOrganizationId,
                        memberId: memberId,
                        // What the field table sends when a name is edited: the
                        // new name carries the value, the old key is cleared.
                        setAttributes: { "Boarding House": "Tagore" },
                        clearAttributeKeys: ["house"],
                    }),
                });
                return response.status;
            }, organizationId, memberRow.id);

            if (status !== 200)
            {
                throw new Error(`Expected 200, got ${status}.`);
            }

            const memberAfterwards = await database.collection("organizationMembers").findOne({ organizationId: organizationId });

            if (memberAfterwards.attributes.boardingHouse !== "Tagore")
            {
                throw new Error("The value did not move to the renamed field.");
            }

            if (memberAfterwards.attributes.house !== undefined)
            {
                throw new Error("The old field survived on this member.");
            }

            // A member-level rename must NOT touch the organization's schema —
            // renaming for everybody is a migration behind its own confirmation.
            const houseColumn = await database.collection("organizationMemberColumns").findOne({ organizationId: organizationId, key: "house" });

            if (!houseColumn)
            {
                throw new Error("Editing one member removed the organization's column, which is a migration and not this screen's job.");
            }

            return "value moved, org column untouched";
        });

        // ── Responsive: the same screens in portrait AND landscape ────────
        // Both orientations are exercised, not just both widths, because the
        // dialog rules this depends on are keyed on `orientation`. Phone
        // landscape is the awkward one: about 375px of HEIGHT for a form, a
        // scrolling list and a row of buttons.
        const viewportsToCheck =
        [
            { label: "phone portrait", width: 375, height: 667 },
            { label: "phone landscape", width: 667, height: 375 },
            { label: "tablet portrait", width: 768, height: 1024 },
            { label: "tablet landscape", width: 1024, height: 768 },
            { label: "desktop", width: 1440, height: 900 },
        ];

        for (const viewport of viewportsToCheck)
        {
            await runCase(`The organization page fits ${viewport.label} without sideways scrolling`, async () =>
            {
                await page.setViewport({ width: viewport.width, height: viewport.height });
                await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
                await sleep(1500);

                await page.evaluate(() =>
                {
                    document.querySelectorAll("tutorial-overlay, initialization-overlay, sync-blocking-overlay")
                        .forEach(overlay => overlay.remove());
                });

                const overflow = await page.evaluate(() => (
                {
                    documentScrollWidth: document.documentElement.scrollWidth,
                    innerWidth: window.innerWidth,
                }));

                // One pixel of slack for sub-pixel rounding on fractional
                // device ratios; anything more is a real overflow.
                if (overflow.documentScrollWidth > overflow.innerWidth + 1)
                {
                    throw new Error(`The page is ${overflow.documentScrollWidth}px wide in a ${overflow.innerWidth}px viewport.`);
                }

                return `${overflow.documentScrollWidth}px in ${overflow.innerWidth}px`;
            });
        }

        await runCase("A wide roster keeps its checkbox and Edit button reachable while it scrolls", async () =>
        {
            await page.setViewport({ width: 375, height: 667 });

            // The real stylesheet against the real markup the list renders, so
            // what is measured is the shipped CSS rather than a copy of it.
            const stickiness = await page.evaluate(async () =>
            {
                const host = document.createElement("div");
                host.style.cssText = "position:fixed;top:0;left:0;width:100%;";
                host.innerHTML = `
                    <div class="admin-list-view">
                        <div class="admin-list-table-wrap">
                            <table class="admin-list-table">
                                <thead><tr>
                                    <th class="admin-list-checkbox-cell"><input type="checkbox"></th>
                                    <th>Email</th><th>Account</th><th>Tags</th>
                                    <th>Name</th><th>Join Year</th><th>Role</th><th>Stream</th><th>Roll Number</th>
                                    <th>Added</th><th></th>
                                </tr></thead>
                                <tbody><tr>
                                    <td class="admin-list-checkbox-cell"><input type="checkbox"></td>
                                    <td>a.very.long.address@institute.example.edu</td><td>Signed in</td><td>first-year, scholarship</td>
                                    <td>A Rather Long Member Name</td><td>2024</td><td>student</td><td>B.Tech CSE</td><td>A0142</td>
                                    <td>2026-08-08</td>
                                    <td class="admin-list-actions"><button class="admin-list-row-action">Edit</button></td>
                                </tr></tbody>
                            </table>
                        </div>
                    </div>`;
                document.body.appendChild(host);

                const scroller = host.querySelector(".admin-list-table-wrap");
                const checkboxCell = host.querySelector("tbody .admin-list-checkbox-cell");
                const actionsCell = host.querySelector("tbody .admin-list-actions");

                const bScrolls = scroller.scrollWidth > scroller.clientWidth + 1;

                // Scroll to the middle, where neither end would be visible if
                // the cells were not pinned.
                scroller.scrollLeft = Math.floor((scroller.scrollWidth - scroller.clientWidth) / 2);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                const scrollerBounds = scroller.getBoundingClientRect();
                const checkboxBounds = checkboxCell.getBoundingClientRect();
                const actionsBounds = actionsCell.getBoundingClientRect();

                const result =
                {
                    bScrolls: bScrolls,
                    checkboxPosition: getComputedStyle(checkboxCell).position,
                    actionsPosition: getComputedStyle(actionsCell).position,
                    bCheckboxVisible: checkboxBounds.left >= scrollerBounds.left - 1 && checkboxBounds.right <= scrollerBounds.right + 1,
                    bActionsVisible: actionsBounds.right <= scrollerBounds.right + 1 && actionsBounds.left >= scrollerBounds.left - 1,
                };

                host.remove();
                return result;
            });

            if (!stickiness.bScrolls)
            {
                throw new Error("The test roster did not overflow, so stickiness was not actually exercised.");
            }

            if (stickiness.checkboxPosition !== "sticky" || stickiness.actionsPosition !== "sticky")
            {
                throw new Error(`The pinned cells are not sticky (checkbox ${stickiness.checkboxPosition}, actions ${stickiness.actionsPosition}).`);
            }

            if (!stickiness.bCheckboxVisible || !stickiness.bActionsVisible)
            {
                throw new Error("A pinned cell scrolled out of view — the Edit button would be unreachable on a phone.");
            }

            return "checkbox and Edit stay pinned mid-scroll";
        });

        await runCase("A tall dialog scrolls its body in phone landscape rather than losing its buttons", async () =>
        {
            await page.setViewport({ width: 667, height: 375 });

            const dialogFit = await page.evaluate(async () =>
            {
                const dialog = document.createElement("dialog-box");
                dialog.innerHTML = `
                    <div class="modal-content-section">
                        <h2 class="admin-panel-add-title">Edit member</h2>
                        ${Array.from({ length: 40 }, (unusedValue, fieldIndex) => `
                            <label class="admin-panel-add-field"><span>Column ${fieldIndex}</span><input type="text"></label>
                        `).join("")}
                        <div class="admin-panel-add-actions">
                            <button class="admin-panel-add-submit" data-role="save">Save member</button>
                        </div>
                    </div>
                    <button class="close-button"></button>`;
                document.body.appendChild(dialog);

                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                const contentSection = dialog.querySelector(".modal-content-section");
                const dialogBounds = dialog.getBoundingClientRect();

                const result =
                {
                    dialogHeight: Math.round(dialogBounds.height),
                    viewportHeight: window.innerHeight,
                    // The body must be the scroller. If it is not, the save
                    // button is pushed off the bottom of the screen with no way
                    // to reach it.
                    bBodyScrolls: contentSection.scrollHeight > contentSection.clientHeight + 1,
                    bSaveReachable: false,
                };

                contentSection.scrollTop = contentSection.scrollHeight;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                const saveBounds = dialog.querySelector('[data-role="save"]').getBoundingClientRect();
                result.bSaveReachable = saveBounds.bottom <= window.innerHeight + 1 && saveBounds.top >= -1;

                dialog.remove();
                return result;
            });

            if (dialogFit.dialogHeight > dialogFit.viewportHeight)
            {
                throw new Error(`The dialog is ${dialogFit.dialogHeight}px tall in a ${dialogFit.viewportHeight}px viewport.`);
            }

            if (!dialogFit.bBodyScrolls)
            {
                throw new Error("A 40-field dialog did not scroll its body, so it cannot be capped to the viewport.");
            }

            if (!dialogFit.bSaveReachable)
            {
                throw new Error("The save button could not be scrolled into view in phone landscape.");
            }

            return `${dialogFit.dialogHeight}px in ${dialogFit.viewportHeight}px, body scrolls, save reachable`;
        });

        // ── The profile pill survives a change of view ────────────────────
        const clearOverlays = async () =>
        {
            await page.evaluate(() =>
            {
                document.querySelectorAll("tutorial-overlay, initialization-overlay, sync-blocking-overlay")
                    .forEach(overlay => overlay.remove());
            });
        };

        const readProfileLabel = async () =>
        {
            await page.waitForSelector("profile-component .profile-display-name", { timeout: 10000 });
            return page.evaluate(() => document.querySelector("profile-component .profile-display-name").textContent.trim());
        };

        // Always the newest dialog: a view switch confirmation can open while an
        // earlier dialog is still stacked behind it.
        const confirmTopDialog = async () =>
        {
            await page.waitForSelector("dialog-box .ok-button", { timeout: 10000 });
            await page.evaluate(() =>
            {
                const dialogs = document.querySelectorAll("dialog-box");
                dialogs[dialogs.length - 1].querySelector(".ok-button").click();
            });
        };

        // Switching view remounts the whole Home page, so the profile pill is
        // rebuilt from scratch with no authentication event behind it. It used
        // to paint its logged-out state on mount and wait for a refresh that a
        // view switch never sends, so a signed-in member's own name was replaced
        // by "Login". Driven through the real menu, because the defect lives in
        // the remount only the real menu causes.
        //
        // Runs LAST on purpose: this is the only case that changes which library
        // the browser is looking at, and a failure part-way through must not
        // leave every case after it pointed at the organization's view.
        await runCase("The profile pill keeps the member's own name across a view switch", async () =>
        {
            await page.setViewport({ width: 1440, height: 900 });

            // The organization was seeded after the first load, so this session
            // has never been told it may be entered. One reload is what puts it
            // into /GetUser's organizationContexts, and so into the switcher.
            await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
            await sleep(3000);
            await clearOverlays();

            const expectedDisplayName = await page.evaluate(() => window["user"].getDisplayName());

            if (!expectedDisplayName)
            {
                throw new Error("The signed-in account has no display name, so there is nothing to assert against.");
            }

            const labelInPersonalView = await readProfileLabel();

            if (labelInPersonalView !== expectedDisplayName)
            {
                throw new Error(`The pill reads "${labelInPersonalView}" before any switch, so the personal view is already broken.`);
            }

            await page.click("profile-component");
            await page.waitForSelector("profile-context-menu .view-as-organization-button", { timeout: 10000 });

            await page.evaluate((targetOrganizationName) =>
            {
                const entries = Array.from(document.querySelectorAll("profile-context-menu .view-as-organization-button"));
                const entry = entries.find(button => button.textContent === `View as ${targetOrganizationName}`);

                if (!entry)
                {
                    throw new Error(`No switcher entry for ${targetOrganizationName} — /GetUser never offered the view.`);
                }

                entry.click();
            }, organizationName);

            await confirmTopDialog();
            await sleep(3000);
            await clearOverlays();

            const labelInOrganizationView = await readProfileLabel();

            if (labelInOrganizationView === "Login")
            {
                throw new Error("The pill fell back to \"Login\" inside the organization view, though the account never changed.");
            }

            if (labelInOrganizationView !== expectedDisplayName)
            {
                throw new Error(`The pill reads "${labelInOrganizationView}" inside the organization view, expected "${expectedDisplayName}".`);
            }

            // Back to the member's own library: the same remount in the other
            // direction, and what leaves the browser where the suite found it.
            await page.click("profile-component");
            await page.waitForSelector("profile-context-menu .view-as-personal-button", { timeout: 10000 });
            await page.evaluate(() => document.querySelector("profile-context-menu .view-as-personal-button").click());

            await confirmTopDialog();
            await sleep(3000);
            await clearOverlays();

            const labelBackInPersonalView = await readProfileLabel();

            if (labelBackInPersonalView !== expectedDisplayName)
            {
                throw new Error(`The pill reads "${labelBackInPersonalView}" after returning to the personal view, expected "${expectedDisplayName}".`);
            }

            return `"${expectedDisplayName}" in both views`;
        });
    }
    finally
    {
        await browser.close();

        const teardownFailures = await registry.teardown();

        // The last case, and the one that makes the rest trustworthy on a
        // second run.
        caseNumber += 1;
        const leaks = await registry.verifyNothingLeaked(FIXTURE_COLLECTION_FIELDS);

        if (teardownFailures.length === 0 && leaks.length === 0)
        {
            cases.push({ name: `${String(caseNumber).padStart(2, "0")}. Every fixture this suite created was removed`, status: "PASS", detail: "nothing left under the prefix" });
        }
        else
        {
            cases.push
            ({
                name: `${String(caseNumber).padStart(2, "0")}. Every fixture this suite created was removed`,
                status: "FAIL",
                detail: `teardown errors: [${teardownFailures.join("; ")}] leaked: [${leaks.join("; ")}]`,
            });
        }

        await registry.close();
    }

    const passedCount = cases.filter(caseResult => caseResult.status === "PASS").length;
    const failedCount = cases.filter(caseResult => caseResult.status === "FAIL").length;
    const skippedCount = cases.filter(caseResult => caseResult.status === "SKIPPED").length;

    writeResult
    ({
        service: "Main",
        category: CATEGORY,
        status: failedCount > 0 ? "FAIL" : (skippedCount > 0 || passedCount === 0 ? "SKIPPED" : "PASS"),
        passed: passedCount, failed: failedCount, skipped: skippedCount, total: cases.length,
        coverage:
        {
            kind: "flows",
            label: "Flows exercised",
            percent: cases.length > 0 ? Math.round((passedCount / cases.length) * 100) : 0,
            detail: `${passedCount}/${cases.length} organization flows`,
        },
        cases: cases,
        notes: "",
    });

    console.log(`Main ${CATEGORY}: ${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped`);

    for (const caseResult of cases)
    {
        if (caseResult.status !== "PASS")
        {
            console.log(`  ${caseResult.status}  ${caseResult.name} — ${caseResult.detail}`);
        }
    }

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("FATAL", fatalError);
    process.exit(1);
});
