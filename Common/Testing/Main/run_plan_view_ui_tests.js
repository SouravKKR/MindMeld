// Browser UI tests for CogniumLearn's admin-only "View as Plan" flow, driven by
// a real Chromium via Puppeteer against the BUILT app (Dock/Static).
//
//   node Common/Testing/Main/run_plan_view_ui_tests.js
//
// Env: BASE_URL (default http://127.0.0.1:3000),
//      TEST_SESSION_COOKIE (REQUIRED — a seeded, terms-accepted session; without
//      it the suite is SKIPPED, never FAILED),
//      HEADFUL=1 to watch it, VERBOSE=1 for a per-case trace.
// Result JSON -> $RESULT_FILE or Common/Reports/.results/plan-view-ui.json.
//
// SEPARATE FROM THE ORGANIZATION SUITE, which is built around a MEMBER fixture
// where this needs an ADMINISTRATOR. Mixing them would mean two account states
// in one browser session, and whichever ran second would be testing the other's
// leftovers.
//
// The account's role is PROMOTED for the run and restored in teardown, because
// the whole feature is gated on it and no seeded account is an administrator.
// That mutation is registered with the FixtureRegistry like any other fixture,
// so a crash mid-run still puts the role back.
//
// Sandboxes leave rows behind in the synced collections under their own scope
// key, so those are swept before and proven gone after — a suite that leaks is a
// failing suite, otherwise the next run fails for reasons this one caused.
//
// What is worth driving in a real browser, rather than asserted in
// VerifyPlanView.mjs: that the entries appear at all, that switching actually
// empties the library and gives it back, that the indicator is present on a page
// that is NOT home (the profile menu only exists on home, so this is the only
// exit from a deep page), and that a reload comes back to the same view.

const fs = require("fs");
const path = require("path");

const { FixtureRegistry } = require("./FixtureRegistry");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || process.env.TUTORIAL_TEST_SESSION_COOKIE || "";
const CATEGORY = "Plan View UI";
const VERBOSE = process.env.VERBOSE === "1";
const HEADFUL = process.env.HEADFUL === "1";

const RESULT_FILE = process.env.RESULT_FILE
    || path.resolve(__dirname, "..", "..", "..", "Common", "Reports", ".results", "plan-view-ui.json");

const FIXTURE_PREFIX = "ui-test-plan-view-";

// The administrator role, from Common/Enumerations/UserRoles.json. Restated
// rather than required because this file talks to Mongo directly and has no
// Dock module graph loaded.
const ADMINISTRATOR_ROLE = 2;
const ORDINARY_USER_ROLE = 0;

// A sandbox writes into the ordinary synced collections under its own scope key.
const SANDBOX_SCOPE_SEPARATOR = "::plan:";

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
        skip("Set TEST_SESSION_COOKIE to a seeded (terms-accepted) session; the plan-view flow needs an authenticated administrator.");
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
        skip(`Could not reach MongoDB, which the role promotion and its restore both need: ${connectionError.message}`);
        return;
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

    const clearOverlays = async () =>
    {
        await page.evaluate(() =>
        {
            document.querySelectorAll("tutorial-overlay, initialization-overlay, sync-blocking-overlay")
                .forEach(overlay => overlay.remove());
        });
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

    const reloadApplication = async (querySuffix = "") =>
    {
        await page.goto(`${BASE_URL}/index.html${querySuffix}`, { waitUntil: "networkidle2", timeout: 60000 });
        await sleep(3000);
        await clearOverlays();
    };

    const readActiveViewTierName = async () =>
    {
        return await page.evaluate(() =>
        {
            const indicator = document.querySelector("view-context-indicator");
            return indicator ? (indicator.getAttribute("data-view-kind") || "") : "";
        });
    };

    const openPlanView = async (tierLabel) =>
    {
        await page.click("profile-component");
        await page.waitForSelector("profile-context-menu .view-as-plan-button", { timeout: 10000 });

        await page.evaluate((targetLabel) =>
        {
            const entries = Array.from(document.querySelectorAll("profile-context-menu .view-as-plan-button"));
            const entry = entries.find(button => button.textContent === `View as a ${targetLabel} user`);

            if (!entry)
            {
                throw new Error(`No switcher entry for ${targetLabel}.`);
            }

            entry.click();
        }, tierLabel);

        await confirmTopDialog();
        await sleep(3000);
        await clearOverlays();
    };

    let testAccountUserId = "";

    try
    {
        await page.setViewport({ width: 1440, height: 900 });
        await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });
        await reloadApplication();

        await runCase("The app boots to an authenticated session", async () =>
        {
            const bSignedIn = await page.evaluate(() => Boolean(window["user"]));

            if (!bSignedIn)
            {
                throw new Error("No authenticated user — the session cookie did not take.");
            }

            testAccountUserId = await page.evaluate(() => window["user"].getId());
            return `signed in as ${testAccountUserId}`;
        });

        // The feature is administrator-only and no seeded account is one, so the
        // suite promotes and restores rather than asserting a role it cannot
        // have. Registered BEFORE the write, so a crash between the two still
        // runs the restore.
        await runCase("A non-administrator is offered no plan views at all", async () =>
        {
            const storedUser = await database.collection("users").findOne({ id: testAccountUserId });
            const originalRole = storedUser ? storedUser.role : ORDINARY_USER_ROLE;

            registry.registerRestore("the test account's role", async () =>
            {
                await database.collection("users").updateOne({ id: testAccountUserId }, { $set: { role: originalRole } });
            });

            await database.collection("users").updateOne({ id: testAccountUserId }, { $set: { role: ORDINARY_USER_ROLE } });
            await reloadApplication();

            await page.click("profile-component");
            await page.waitForSelector("profile-context-menu", { timeout: 10000 });
            await sleep(500);

            const entryCount = await page.evaluate(() => document.querySelectorAll("profile-context-menu .view-as-plan-button").length);

            // Close the menu again so the next case starts from a clean page.
            await page.evaluate(() => document.querySelectorAll("profile-context-menu").forEach(menu => menu.remove()));

            if (entryCount !== 0)
            {
                throw new Error(`An ordinary account was offered ${entryCount} plan view(s).`);
            }

            return "no entries for an ordinary account";
        });

        await runCase("An administrator is offered one entry per plan", async () =>
        {
            await database.collection("users").updateOne({ id: testAccountUserId }, { $set: { role: ADMINISTRATOR_ROLE } });
            await reloadApplication();

            await page.click("profile-component");
            await page.waitForSelector("profile-context-menu .view-as-plan-button", { timeout: 10000 });

            const labels = await page.evaluate(() =>
                Array.from(document.querySelectorAll("profile-context-menu .view-as-plan-button")).map(button => button.textContent.trim()));

            await page.evaluate(() => document.querySelectorAll("profile-context-menu").forEach(menu => menu.remove()));

            // Four tiers, minus the active one — and nothing is active yet.
            if (labels.length !== 4)
            {
                throw new Error(`Expected 4 plan entries, saw ${labels.length}: ${labels.join(", ")}`);
            }

            return labels.join(" | ");
        });

        await runCase("Switching to the Free view opens a separate, empty library", async () =>
        {
            const personalDeckCount = await page.evaluate(() => document.querySelectorAll("deck-tile").length);

            await openPlanView("Free");

            const viewKind = await readActiveViewTierName();

            if (viewKind !== "PLAN")
            {
                throw new Error(`The indicator reports "${viewKind}" rather than PLAN after switching.`);
            }

            const identity = await page.evaluate(() => window["user"] ? document.querySelector("view-context-indicator").textContent : "");

            if (!identity.includes("Free"))
            {
                throw new Error(`The indicator does not name the simulated plan: "${identity}"`);
            }

            const sandboxDeckCount = await page.evaluate(() => document.querySelectorAll("deck-tile").length);

            if (sandboxDeckCount >= personalDeckCount && personalDeckCount > 0)
            {
                throw new Error(`The sandbox shows ${sandboxDeckCount} deck(s) against ${personalDeckCount} personal — it is not a separate library.`);
            }

            return `personal ${personalDeckCount} → sandbox ${sandboxDeckCount}`;
        });

        // Driven through the SERVER rather than by reaching into the client gate.
        // The app ships bundled and obfuscated, so there are no per-module URLs
        // to import — but the more valuable assertion was the server one anyway:
        // it proves the header is really being stamped from a real browser and
        // that the server honours the simulation, which a client-side read of
        // AiFeatureGate would have told us nothing about.
        await runCase("The server refuses a Pro feature inside the Free view, whatever the account really has", async () =>
        {
            const refusal = await page.evaluate(async () =>
            {
                // Refused at the entitlement gate, which runs BEFORE the credit
                // preflight and before any model call — so this costs nothing
                // and cannot reach the worker.
                const response = await fetch("/Refine/Content/Proposal",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ entityId: "plan-view-suite-no-such-entity", targetKind: 0, instruction: "n/a" }),
                });

                const body = await response.json().catch(() => ({}));
                return { status: response.status, error: body.error || "", requiredTier: body.requiredTier };
            });

            if (refusal.status !== 403)
            {
                throw new Error(`A Pro-gated endpoint answered ${refusal.status} inside the Free view, expected 403 — the simulation only grants, it does not withhold.`);
            }

            if (refusal.error !== "FEATURE_NOT_IN_PLAN")
            {
                throw new Error(`Refused with "${refusal.error}" rather than FEATURE_NOT_IN_PLAN.`);
            }

            if (typeof refusal.requiredTier !== "number")
            {
                throw new Error("No requiredTier came back, so the client cannot show the upgrade prompt a real Free user would see.");
            }

            return `403 FEATURE_NOT_IN_PLAN, requiredTier ${refusal.requiredTier}`;
        });

        await runCase("The storage meter reports the simulated tier's cap", async () =>
        {
            const limitBytes = await page.evaluate(async () =>
            {
                const response = await fetch("/GetUser");
                const body = await response.json().catch(() => ({}));
                return body.storageUsage ? body.storageUsage.limitBytes : null;
            });

            // 20 MB, the Free allowance in Common/Constants/PlanMetadataConstants.json.
            if (limitBytes !== 20971520)
            {
                throw new Error(`The meter reports ${limitBytes} bytes inside the Free view, expected the 20 MB Free allowance.`);
            }

            return "20 MB, the Free allowance";
        });

        await runCase("The exit is mounted outside the page stack and survives it being torn down", async () =>
        {
            // What this case CANNOT do: navigate to a deep page and look. Neither
            // a context menu nor the options sidebar navigates under Puppeteer —
            // a pre-existing harness limitation that run_refinement_ui_checks.js
            // documents too, affecting Insights, Browse and Edit identically. So
            // the claim is proved the two ways that are available, which between
            // them are the reason it holds:
            //
            //   1. STRUCTURAL — the indicator is a direct child of the document,
            //      not of any page. That is what makes it independent of which
            //      page is mounted, and a page that failed to render could not
            //      take it down with it.
            //   2. BEHAVIOURAL — it survives the page stack being cleared and
            //      rebuilt, which is exactly what PageNavigator.clearAndOpen does
            //      on every view switch and the most violent thing that happens
            //      to the stack in normal use.
            const placementBefore = await page.evaluate(() =>
            {
                const indicator = document.querySelector("view-context-indicator");
                return {
                    bPresent: Boolean(indicator),
                    bOutsidePageStack: Boolean(indicator) && indicator.parentElement === document.body && indicator.closest("[page]") === null,
                    bHasExit: Boolean(indicator && indicator.querySelector(".view-context-indicator-exit")),
                };
            });

            if (!placementBefore.bPresent || !placementBefore.bHasExit)
            {
                throw new Error("The indicator or its exit is missing inside a plan view.");
            }

            if (!placementBefore.bOutsidePageStack)
            {
                throw new Error("The indicator is mounted inside the page stack, so a page that fails to render would take the only exit with it.");
            }

            // Tear the stack down and rebuild it by switching sandboxes, then
            // look again. A page-owned banner would not be here afterwards.
            const homePageBefore = await page.evaluate(() => document.querySelectorAll("home-page").length);

            await page.click("profile-component");
            await page.waitForSelector("profile-context-menu .view-as-plan-button", { timeout: 10000 });
            await page.evaluate(() =>
            {
                const entry = Array.from(document.querySelectorAll("profile-context-menu .view-as-plan-button"))
                    .find(button => button.textContent === "View as a Pro Plus user");
                entry.click();
            });
            await confirmTopDialog();
            await sleep(3000);
            await clearOverlays();

            const survived = await page.evaluate(() =>
            {
                const indicator = document.querySelector("view-context-indicator");
                return {
                    bHasExit: Boolean(indicator && indicator.querySelector(".view-context-indicator-exit")),
                    label: indicator ? indicator.textContent : "",
                    bStillOutsidePageStack: Boolean(indicator) && indicator.parentElement === document.body,
                };
            });

            if (!survived.bHasExit || !survived.bStillOutsidePageStack)
            {
                throw new Error("The indicator did not survive the page stack being cleared and rebuilt.");
            }

            if (!survived.label.includes("Pro Plus"))
            {
                throw new Error(`The indicator still reads "${survived.label}" after switching sandboxes, so it is not tracking the active view.`);
            }

            return `outside the page stack, survived a rebuild (${homePageBefore} home page(s) replaced)`;
        });

        await runCase("The exit button returns to the personal library without a confirmation", async () =>
        {
            await page.evaluate(() => document.querySelector("view-context-indicator .view-context-indicator-exit").click());
            await sleep(3000);
            await clearOverlays();

            const dialogCount = await page.evaluate(() => document.querySelectorAll("dialog-box").length);

            if (dialogCount > 0)
            {
                throw new Error("Leaving a simulation asked for a confirmation — the exit must have nothing to get past.");
            }

            const viewKind = await readActiveViewTierName();

            if (viewKind !== "")
            {
                throw new Error(`Still in a "${viewKind}" view after clicking exit.`);
            }

            return "one click, no dialog";
        });

        await runCase("A reload comes back to the plan view that was active", async () =>
        {
            await openPlanView("Pro");
            await reloadApplication();

            const viewKind = await readActiveViewTierName();
            const label = await page.evaluate(() =>
            {
                const indicator = document.querySelector("view-context-indicator");
                return indicator ? indicator.textContent : "";
            });

            if (viewKind !== "PLAN" || !label.includes("Pro"))
            {
                throw new Error(`A reload landed in "${viewKind}" / "${label}" rather than back in the Pro sandbox.`);
            }

            return "restored the Pro sandbox";
        });

        await runCase("`?view=personal` forces the personal library even from inside a sandbox", async () =>
        {
            // The escape hatch of last resort: it has to work without any of the
            // in-app exits, because its whole reason to exist is a view that
            // will not render.
            await reloadApplication("?view=personal");

            const viewKind = await readActiveViewTierName();

            if (viewKind !== "")
            {
                throw new Error(`The escape hatch left the browser in a "${viewKind}" view.`);
            }

            // ...and it must STICK: a reload without the parameter must not fall
            // back into the sandbox it just rescued the user from.
            await reloadApplication();

            const viewKindAfterPlainReload = await readActiveViewTierName();

            if (viewKindAfterPlainReload !== "")
            {
                throw new Error(`A plain reload fell back into a "${viewKindAfterPlainReload}" view, so the escape only lasted one page load.`);
            }

            return "escaped, and it stuck";
        });

        await runCase("A demoted administrator is collapsed out of a sandbox rather than left in it", async () =>
        {
            await openPlanView("Basic");

            if (await readActiveViewTierName() !== "PLAN")
            {
                throw new Error("Could not enter the Basic sandbox to begin with.");
            }

            await database.collection("users").updateOne({ id: testAccountUserId }, { $set: { role: ORDINARY_USER_ROLE } });
            await reloadApplication();

            const viewKind = await readActiveViewTierName();

            if (viewKind !== "")
            {
                throw new Error(`A demoted account is still inside a "${viewKind}" view, and its client is still pushing that sandbox.`);
            }

            return "collapsed to personal on the next boot";
        });
    }
    finally
    {
        // Sandboxes write into the ordinary synced collections under their own
        // scope key, so anything this run created there is removed by scope
        // rather than by a name prefix.
        if (testAccountUserId.length > 0 && database !== null)
        {
            const sandboxOwnerFilter = { userId: { $regex: `^${testAccountUserId}${SANDBOX_SCOPE_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } };

            for (const collectionName of ["decks", "cards", "studyMaterials", "mockTests", "askAiPopupLinks", "contentOverlays", "userDailyActivity"])
            {
                try
                {
                    await database.collection(collectionName).deleteMany(sandboxOwnerFilter);
                }
                catch (cleanupError)
                {
                    trace(`  cleanup of ${collectionName} failed: ${cleanupError.message}`);
                }
            }
        }

        await browser.close();

        const teardownFailures = await registry.teardown();

        caseNumber += 1;
        const teardownLabel = `${String(caseNumber).padStart(2, "0")}. Everything the suite created or changed is put back`;

        if (teardownFailures.length === 0)
        {
            cases.push({ name: teardownLabel, status: "PASS", detail: "role restored, sandbox rows removed" });
        }
        else
        {
            cases.push({ name: teardownLabel, status: "FAIL", detail: teardownFailures.join("; ") });
        }

        await registry.close();
    }

    const passedCount = cases.filter(entry => entry.status === "PASS").length;
    const failedCount = cases.filter(entry => entry.status === "FAIL").length;

    writeResult({
        service: "Main", category: CATEGORY,
        status: failedCount > 0 ? "FAILED" : "PASSED",
        passed: passedCount, failed: failedCount, skipped: 0, total: cases.length,
        coverage: { kind: "flows", label: "Flows exercised", percent: null, detail: `${cases.length} plan-view cases` },
        cases: cases, notes: "",
    });

    console.log(`Main ${CATEGORY}: ${failedCount > 0 ? "FAILED" : "PASSED"} - ${passedCount}/${cases.length}`);

    for (const entry of cases)
    {
        console.log(`  ${entry.status}  ${entry.name}${entry.detail ? " — " + entry.detail : ""}`);
    }

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((runError) =>
{
    console.error(runError);
    process.exit(1);
});
