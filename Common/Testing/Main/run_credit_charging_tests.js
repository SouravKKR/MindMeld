// Browser test for the CREDIT CHARGING path: proves that a user who uploads a
// document and runs a real AI generation is ACTUALLY CHARGED — that token usage
// reaches the ledger, the balance moves, and lifetime spend follows it.
//
// This is the regression it exists for. A generation that completes and charges
// NOTHING is invisible from the app: decks appear, the user is happy, and the
// only evidence is a creditTransactions collection that never grew. Nothing in
// the UI can see that, so every assertion here is read straight from MongoDB,
// taken across a run driven entirely through the real interface.
//
// ON DEMAND ONLY — deliberately NOT a deploy gate. It spends real credits and
// real model tokens, takes minutes, and needs object storage plus the Agent
// venv, so its failures are as often environmental as they are the app's fault,
// and the gate treats SKIPPED as a stop. The cheap gate-safe credit checks live
// in run_critical_flow_tests.js instead.
//
//   node Common/Testing/Main/run_credit_charging_tests.js
//
// Env: BASE_URL (default http://127.0.0.1:3000),
//      TEST_SESSION_COOKIE (REQUIRED — a seeded, terms-accepted session),
//      TEST_ACCOUNT_ID (default browser-suite-test-user — the account whose
//      ledger is read; MUST be the session's user or every assertion is
//      measured against the wrong balance),
//      MONGODB_URL / MONGODB_DATABASE_NAME override Dock/.env,
//      GENERATION_TIMEOUT_MINUTES (default 15),
//      KEEP_FIXTURES=1 to leave the deck and sources behind for inspection,
//      HEADFUL=1 / SLOW_MO_MS / VERBOSE=1 as in the other suites.
// Result JSON -> $RESULT_FILE or Common/Reports/.results/credit-charging.json.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { BrowserSuiteHelpers, EnvironmentUnavailableError } = require("./BrowserSuiteHelpers");
const CreditLedgerProbe = require("./CreditLedgerProbe");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "credit-charging.json");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || "";
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || "browser-suite-test-user";
const CATEGORY = "Credit Charging (Puppeteer)";
const RUN_HEADFUL = process.env.HEADFUL === "1";
const SLOW_MO_MS = Number(process.env.SLOW_MO_MS || 0) || 0;
const VERBOSE = process.env.VERBOSE === "1";
const KEEP_FIXTURES = process.env.KEEP_FIXTURES === "1";

const FIXTURE_PREFIX = "ZZTest";
const RUN_TAG = String(Date.now()).slice(-6);
const FIXTURE_DECK_NAME = `${FIXTURE_PREFIX} Credit Deck ${RUN_TAG}`;
const FIXTURE_DECK_SHORT_NAME = `${FIXTURE_PREFIX}CR${RUN_TAG}`;
const FIXTURE_SOURCE_NAME = `${FIXTURE_PREFIX} Source ${RUN_TAG}`;
const FIXTURE_SUBJECT_NAME = `${FIXTURE_PREFIX} Learning Lifecycle ${RUN_TAG}`;
const FIXTURE_GENERATION_DESCRIPTION =
    "The five phases of the learning lifecycle: Acquire, Encode, Consolidate, Validate and Reflect.";

const FIXTURE_PDF_PATH = path.join(__dirname, "fixtures", "credit-charge-source.pdf");

// The smallest run the form accepts. FlashcardGenerationFields refuses anything
// at or below 5 cards, so 6 is the floor — every credit above that is spent
// proving nothing.
const FIXTURE_CARD_COUNT = 6;

// Plan and balance the account must hold BEFORE the run, applied directly in
// Mongo because both are ledger-owned and have no client path.
const REQUIRED_PLAN_TIER = 2;                     // planTiers.PRO — AUTOMATIC_GENERATION
const MINIMUM_CREDIT_BALANCE_TO_RUN = 20;
const TOPPED_UP_CREDIT_BALANCE = 100;

// The upload response returns fast and the staging/OCR finalize runs in the
// background, so the card can sit on "Processing" for a while.
const UPLOAD_READY_TIMEOUT_MS = 15 * 60 * 1000;

const GENERATION_TIMEOUT_MS = (Number(process.env.GENERATION_TIMEOUT_MINUTES) || 15) * 60 * 1000;
const GENERATION_PROGRESS_TRACE_INTERVAL_MS = 15000;
const LEDGER_SETTLE_TIMEOUT_MS = 90000;

BrowserSuiteHelpers.configure({ bVerbose: VERBOSE });

const sleep = BrowserSuiteHelpers.sleep;
const trace = BrowserSuiteHelpers.trace;

function writeResult(payload)
{
    fs.mkdirSync(path.dirname(path.resolve(RESULT_FILE)), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

function skip(note)
{
    writeResult({
        service: "Main", category: CATEGORY, status: "SKIPPED",
        passed: 0, failed: 0, skipped: 1, total: 0,
        coverage: { kind: "flows", label: "Credit-charging stages proven", percent: null, detail: note },
        cases: [], notes: note,
    });
    console.log(`Main ${CATEGORY}: SKIPPED - ${note}`);
}

let puppeteer;
try
{
    puppeteer = require("puppeteer");
}
catch (requireError)
{
    skip("puppeteer not installed; run `npm install` in Common/Testing/Main.");
    process.exit(0);
}

if (!SESSION_COOKIE)
{
    skip("TEST_SESSION_COOKIE is not set; run seed_browser_test_account.js and export the printed cookie.");
    process.exit(0);
}

/**
 * A per-run copy of the committed fixture, written to the OS temp directory
 * with a unique trailing comment.
 *
 * The server refuses a re-upload of bytes this account already holds with a 409,
 * so a fixture uploaded verbatim works exactly once and every run after it dies
 * on the second attempt — surfacing as "the source card went red", which looks
 * nothing like the deduplication it really is. A PDF comment after %%EOF changes
 * the content hash while leaving the document byte-for-byte readable.
 *
 * The temp file's basename becomes the source's display name, because the file
 * selector fills the name field from file.name minus its extension — so naming
 * the copy with the fixture prefix gets that prefix onto the stored row for
 * free, which is what the cleanup sweeps on.
 */
function writeRunUniqueFixtureCopy()
{
    if (!fs.existsSync(FIXTURE_PDF_PATH))
    {
        throw new EnvironmentUnavailableError(
            `Fixture document missing at ${FIXTURE_PDF_PATH} — see fixtures/README.md for how to regenerate it.`);
    }

    const fixtureBytes = fs.readFileSync(FIXTURE_PDF_PATH);
    const uniqueTrailer = Buffer.from(`\n% cogniumlearn-credit-suite-run ${RUN_TAG}\n`, "utf-8");
    const runCopyPath = path.join(os.tmpdir(), `${FIXTURE_SOURCE_NAME}.pdf`);

    fs.writeFileSync(runCopyPath, Buffer.concat([fixtureBytes, uniqueTrailer]));
    return runCopyPath;
}

/**
 * Waits for the run to reach a TERMINAL state on the progress page and reports
 * which one. ProgressPage raises .progress-page-status-banner exactly once, from
 * its own onTerminated, and the modifier class carries the verdict — so this is
 * the app's own completion signal rather than a guess about the task tree.
 *
 * Progress is traced as it goes, because a run that is going to take twelve
 * minutes and a run that is wedged look identical from a silent wait.
 */
async function waitForGenerationToFinish(page)
{
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    let lastTracedAt = 0;

    while (Date.now() < deadline)
    {
        const terminalState = await page.evaluate(() =>
        {
            const banner = Array.from(document.querySelectorAll(".progress-page-status-banner"))
                .find(element => element.getClientRects().length > 0);
            if (!banner)
            {
                return null;
            }
            const text = (banner.textContent || "").trim();
            if (text.length === 0)
            {
                return null;
            }
            return {
                text: text,
                bSuccess: banner.classList.contains("progress-page-status-banner--success"),
                bWarning: banner.classList.contains("progress-page-status-banner--warning"),
                bError: banner.classList.contains("progress-page-status-banner--error"),
            };
        }).catch(() => null);

        if (terminalState)
        {
            return terminalState;
        }

        if (Date.now() - lastTracedAt >= GENERATION_PROGRESS_TRACE_INTERVAL_MS)
        {
            lastTracedAt = Date.now();
            const liveProgress = await page.evaluate(() =>
            {
                const readText = (selector) =>
                {
                    const element = Array.from(document.querySelectorAll(selector))
                        .find(candidate => candidate.getClientRects().length > 0);
                    return element ? element.textContent.trim() : "?";
                };
                return {
                    percentage: readText(".overall-progress-percentage"),
                    status: readText(".overall-progress-status-label"),
                };
            }).catch(() => ({ percentage: "?", status: "?" }));

            trace(`    (generating: ${liveProgress.percentage} — ${liveProgress.status})`);
        }

        await sleep(2000);
    }

    throw new Error(
        `The generation did not reach a terminal state within ${Math.round(GENERATION_TIMEOUT_MS / 60000)} minutes. `
        + "The progress page never raised its status banner, so the pipeline is still running or has stalled. "
        + "Check Dock's console for the worker subprocess. Raise GENERATION_TIMEOUT_MINUTES if this environment is "
        + "simply slow — but a stalled run usually means the Agent venv could not start, or the model API is "
        + "refusing the credentials.");
}

// -- Main ---------------------------------------------------------------------

(async () =>
{
    const cases = [];
    const scriptErrors = [];
    let caseNumber = 0;
    let environmentBlockedReason = "";

    let browser = null;
    let page = null;
    let runCopyPath = "";

    const ledgerProbe = new CreditLedgerProbe(TEST_ACCOUNT_ID);

    // Carried between cases and into the final report.
    let creditStateBefore = null;
    let snapshotDate = null;
    let appliedCharges = [];
    let meteredCharge = null;
    let totalChargedForReport = 0;
    let generationSecondsForReport = 0;

    const runCase = async (name, caseFunction) =>
    {
        caseNumber += 1;
        const label = `${String(caseNumber).padStart(2, "0")}. ${name}`;

        if (environmentBlockedReason)
        {
            cases.push({ name: label, status: "SKIPPED", detail: environmentBlockedReason });
            return;
        }

        try
        {
            if (page)
            {
                await BrowserSuiteHelpers.dismissBadgeCelebrationIfPresent(page);
            }
            const detail = await caseFunction();
            cases.push({ name: label, status: "PASS", detail: detail || "" });
            trace(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
        }
        catch (caseError)
        {
            if (caseError instanceof EnvironmentUnavailableError)
            {
                // An environment that cannot run the test has not proved the app
                // wrong. Block the rest of the run rather than reporting a cascade
                // of failures that all share one cause.
                environmentBlockedReason = caseError.message;
                cases.push({ name: label, status: "SKIPPED", detail: caseError.message });
                trace(`  SKIP ${label} — ${caseError.message}`);
                return;
            }

            const pageTag = page ? await BrowserSuiteHelpers.currentPageTag(page).catch(() => "?") : "?";
            const dialogText = page ? await page.evaluate(BrowserSuiteHelpers.dialogTextInPage).catch(() => "") : "";
            const diagnosticsStem = page
                ? await BrowserSuiteHelpers.captureFailureDiagnostics(page, RESULT_FILE, caseNumber, caseError.message)
                : "(no page)";

            cases.push({
                name: label,
                status: "FAIL",
                detail: `${caseError.message}${dialogText ? ` | open dialog: "${dialogText}"` : ""} | on <${pageTag}> | diagnostics: ${diagnosticsStem}`,
            });
            console.log(`  FAIL ${label} — ${caseError.message}`);
        }
    };

    try
    {
        // ── Environment: the ledger must be readable before anything is spent ──
        const bConnected = await ledgerProbe.connect(REPOSITORY_ROOT);
        if (!bConnected)
        {
            skip("MongoDB is not configured or unreachable (MONGODB_URL / MONGODB_DATABASE_NAME in Dock/.env); "
                + "the credit ledger cannot be read, so nothing this suite asserts is observable.");
            process.exit(0);
        }

        browser = await puppeteer.launch({
            headless: RUN_HEADFUL ? false : "new",
            slowMo: SLOW_MO_MS,
            defaultViewport: BrowserSuiteHelpers.VIEWPORT,
            args: ["--no-sandbox", "--disable-setuid-sandbox", `--window-size=${BrowserSuiteHelpers.VIEWPORT.width},${BrowserSuiteHelpers.VIEWPORT.height}`],
        });

        page = await browser.newPage();
        page.on("pageerror", pageError => scriptErrors.push(`pageerror: ${pageError.message}`));
        await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });

        await runCase("The app boots, sync settles, and the account can run a generation", async () =>
        {
            const readiness = await ledgerProbe.ensureCanRunGeneration(
                REQUIRED_PLAN_TIER, MINIMUM_CREDIT_BALANCE_TO_RUN, TOPPED_UP_CREDIT_BALANCE);

            if (!readiness.bReady)
            {
                throw new EnvironmentUnavailableError(
                    `${readiness.detail} — run seed_browser_test_account.js first.`);
            }

            await page.goto(`${BASE_URL}/index.html?tutorialE2E=1`, { waitUntil: "networkidle2", timeout: 60000 });
            await BrowserSuiteHelpers.waitForPage(page, "home-page");

            const bSettled = await BrowserSuiteHelpers.waitForSyncToSettle(page);
            if (!bSettled)
            {
                throw new EnvironmentUnavailableError(
                    "The blocking sync dialog never cleared, so the app never became usable. "
                    + "Check that Dock is serving the current build and that Mongo/Redis are responsive.");
            }

            await BrowserSuiteHelpers.waitForVisible(page, "new-deck-tile");

            const state = await ledgerProbe.readCreditState();
            return `account ready (${readiness.detail}); balance ${state.balance}, lifetime spent ${state.lifetimeSpent}`;
        });

        await runCase("Create the fixture deck", async () =>
        {
            // The + tile either raises the "what would you like to do?" chooser
            // or goes straight to the editor, depending on
            // DeckCreationChoiceAvailability — so wait for EITHER and branch,
            // rather than assuming the chooser and timing out on a perfectly
            // healthy app that simply skipped it.
            //
            // clickUntil rather than clickVisible because case 01 just wrote the
            // plan and balance to Mongo: the client pulls that changed user
            // document moments later, and the sync overlay it raises can swallow
            // this exact click.
            const tileOutcome = await BrowserSuiteHelpers.clickUntil(page, "new-deck-tile", () =>
            {
                const bChooser = Array.from(document.querySelectorAll(".create-deck-choice-create"))
                    .some(element => element.getClientRects().length > 0);
                if (bChooser)
                {
                    return "chooser";
                }
                const bEditor = Array.from(document.querySelectorAll("deck-editor-page"))
                    .some(element => element.getClientRects().length > 0);
                return bEditor ? "editor" : null;
            }, null, "the deck chooser or the deck editor");

            if (tileOutcome === "chooser")
            {
                await BrowserSuiteHelpers.clickVisible(page, ".create-deck-choice-create");
            }

            await BrowserSuiteHelpers.waitForPage(page, "deck-editor-page");

            await BrowserSuiteHelpers.typeIntoInput(page, ".deck-name-input", FIXTURE_DECK_NAME);
            await BrowserSuiteHelpers.typeIntoInput(page, ".deck-short-name-input", FIXTURE_DECK_SHORT_NAME);
            await BrowserSuiteHelpers.clickVisible(page, ".deck-save-input");

            await BrowserSuiteHelpers.waitForPage(page, "home-page");
            const tileSelector = await BrowserSuiteHelpers.waitUntil(
                page, BrowserSuiteHelpers.deckTileSelectorInPage, FIXTURE_DECK_SHORT_NAME,
                `the new deck tile "${FIXTURE_DECK_SHORT_NAME}" on Home`);

            return `saved and returned to Home; tile ${tileSelector}`;
        });

        await runCase("Open Generate With AI from the deck's options menu", async () =>
        {
            await BrowserSuiteHelpers.openDeckOptionsMenu(page, FIXTURE_DECK_SHORT_NAME);
            await BrowserSuiteHelpers.clickUntil(page, "deck-options-context-menu .generate-with-ai-button", () =>
            {
                return Array.from(document.querySelectorAll("automatic-generation-page"))
                    .some(element => element.getClientRects().length > 0) ? "open" : null;
            }, null, "the automatic-generation page");

            await BrowserSuiteHelpers.waitForPage(page, "automatic-generation-page");
            await BrowserSuiteHelpers.waitForVisible(page, ".subject-name-input");
            return "automatic-generation-page mounted with the general fields rendered";
        });

        await runCase("Attach the fixture document as an information source", async () =>
        {
            runCopyPath = writeRunUniqueFixtureCopy();

            // Scoped to the information-source container: the page mounts a
            // SECOND selector for image sources, and although it is hidden while
            // Capture Images is off, an unscoped selector would start matching the
            // wrong one the moment that default changes.
            await page.select(".information-sources-selector-container .information-source-add-select", "PROVIDED_DOCUMENTS");
            await BrowserSuiteHelpers.clickVisible(page, ".information-sources-selector-container .information-source-upload-new-button");
            await BrowserSuiteHelpers.waitForVisible(page, ".upload-new-modal-upload-button");

            // uploadFile rather than a click: the file input is display:none by
            // design (the drop zone is the affordance), and Puppeteer sets the
            // files directly and fires the input/change pair the component listens
            // for.
            const fileInput = await page.$(".file-selector-hidden-file-input");
            if (!fileInput)
            {
                throw new Error("The upload dialog rendered without a file input");
            }
            await fileInput.uploadFile(runCopyPath);
            await sleep(BrowserSuiteHelpers.SETTLE_MS);

            // Both options are CHECKED by default. Unticking retention keeps the
            // stored blob temporary, so a run leaves no permanent footprint even
            // if its cleanup never gets to run; unticking OCR skips ocrmypdf,
            // which would add minutes and a native-binary dependency for a fixture
            // that already carries a text layer.
            await BrowserSuiteHelpers.clickVisible(page, ".upload-new-modal-keep-permanently");
            await BrowserSuiteHelpers.clickVisible(page, ".upload-new-modal-run-ocr");

            await BrowserSuiteHelpers.clickVisible(page, ".upload-new-modal-upload-button");

            const uploadOutcome = await BrowserSuiteHelpers.waitUntil(page, () =>
            {
                const card = Array.from(document.querySelectorAll("information-source-card"))
                    .find(element => element.getClientRects().length > 0);
                if (!card)
                {
                    return null;
                }
                if (card.classList.contains("state-error"))
                {
                    const message = card.querySelector(".information-source-card-error-message");
                    return `error:${message ? message.textContent.trim() : "(no message)"}`;
                }
                return card.classList.contains("state-complete") ? "ready" : null;
            }, null, "the uploaded source to finish processing", UPLOAD_READY_TIMEOUT_MS);

            if (uploadOutcome.startsWith("error:"))
            {
                // A 409 here is the fixture-uniqueness guard having failed, and a
                // storage error is object storage being unreachable. Neither is an
                // application bug, and both read identically on screen without this.
                throw new EnvironmentUnavailableError(
                    `The document upload failed: ${uploadOutcome.slice(6)}. `
                    + "Check that Dock can reach object storage (LINODE_STORAGE_BUCKET_ACCESS_KEY / "
                    + "LINODE_S3_ENDPOINT_HOSTNAMES in Dock/.env) and that the Agent venv can run the upload workers.");
            }

            return "source uploaded, processed and attached";
        });

        await runCase("Configure the cheapest generation the form accepts", async () =>
        {
            await BrowserSuiteHelpers.typeIntoInput(page, ".subject-name-input", FIXTURE_SUBJECT_NAME);

            // A description is REQUIRED unless one of the attached sources is
            // declared a syllabus/textbook: the pipeline derives the topic tree
            // from one or the other, and with neither it fails outright with
            // "Could not derive a syllabus". The attached PDF is a content
            // source, not a syllabus, so the description is what gives the run
            // its shape — which is also the realistic pairing a user produces
            // when they attach reading material and say what to make from it.
            await BrowserSuiteHelpers.typeIntoInput(page, ".description-input", FIXTURE_GENERATION_DESCRIPTION);

            // SIMPLE hides the three artifact containers while leaving all three
            // ENABLED, so the run would produce flashcards, study material AND
            // mock tests. Advanced is the only mode in which they can be switched
            // off, and every artifact this run does not need is credits spent
            // proving nothing.
            await page.select(".generation-mode-select", "ADVANCED");
            await BrowserSuiteHelpers.waitForVisible(page, "flashcard-generation-fields");

            await BrowserSuiteHelpers.clickVisible(page, ".study-material-generation-container .generation-enabled-checkbox");
            await BrowserSuiteHelpers.clickVisible(page, ".mock-test-generation-container .generation-enabled-checkbox");

            await page.select(".flashcard-generation-num-cards-method-select", "MANUAL");
            await BrowserSuiteHelpers.typeIntoInput(page, ".flashcard-generation-num-cards-input", String(FIXTURE_CARD_COUNT));

            // Assert the image switches are OFF rather than clicking them off.
            // Images are the most expensive part of a run AND are gated on a
            // higher plan tier, so a default that quietly flipped would turn this
            // suite into a permanent 403 with a confusing message.
            const imageSettings = await page.evaluate(() =>
            {
                const readChecked = (selector) =>
                {
                    const element = Array.from(document.querySelectorAll(selector))
                        .find(candidate => candidate.getClientRects().length > 0);
                    return Boolean(element && element.checked);
                };
                return { bCapture: readChecked(".capture-images-checkbox"), bEnhance: readChecked(".enhance-images-checkbox") };
            });

            if (imageSettings.bCapture || imageSettings.bEnhance)
            {
                throw new Error(
                    `Image generation defaults changed (capture=${imageSettings.bCapture}, enhance=${imageSettings.bEnhance}). `
                    + "This run would need the Pro Plus tier and would cost several extra credits — switch them off "
                    + "explicitly here before letting the suite spend money.");
            }

            return `flashcards only, ${FIXTURE_CARD_COUNT} cards, no images`;
        });

        await runCase("Snapshot the ledger and start the generation", async () =>
        {
            // Taken immediately before the click so nothing unrelated can land
            // inside the measured window.
            creditStateBefore = await ledgerProbe.readCreditState();
            snapshotDate = new Date();

            await BrowserSuiteHelpers.clickVisible(page, ".automatic-generation-start-button");

            // Start no longer submits: it prices the run first and waits for a
            // confirmation inside the estimate dialog, which also carries the
            // one-way loss-of-Export warning. Exactly ONE dialog is expected —
            // read its text into the case detail so a future EXTRA dialog is
            // obvious rather than a bare timeout. The longer wait covers the
            // /Generate/EstimateCost round-trip that now precedes it.
            const confirmText = await BrowserSuiteHelpers.waitForValidationDialogText(page, "the cost-estimate confirmation", 20000);

            // The shortfall warning is a WARNING, not a refusal — the run would
            // start and then stop partway, leaving no complete run to assert
            // charges against. Match the dialog's own wording; the old
            // "insufficient credits" phrasing belongs to the server's 402 and
            // never appears here.
            if (/stop partway|not enough credits|insufficient credits/i.test(confirmText))
            {
                throw new Error(`The run is underfunded: "${confirmText.slice(0, 200)}" — the pre-run top-up did not apply.`);
            }
            if (/upgrade|plan/i.test(confirmText) && !/export/i.test(confirmText))
            {
                throw new Error(`The run was refused by the plan gate: "${confirmText.slice(0, 160)}" — the Pro plan write did not apply.`);
            }
            if (!/credit/i.test(confirmText))
            {
                throw new Error(`The estimate dialog showed no cost at all: "${confirmText.slice(0, 200)}"`);
            }

            await BrowserSuiteHelpers.clickVisible(page, "dialog-box .ok-button");
            await BrowserSuiteHelpers.waitForPage(page, "progress-page");

            // The suite account is a normal user, so the progress page must show
            // the overall bar and the "you'll be notified" note — never the
            // internal task tree, which is administrators-only.
            const progressView = await page.evaluate(() =>
            {
                const visible = (selector) => Array.from(document.querySelectorAll(selector))
                    .filter(element => element.getClientRects().length > 0).length;
                return { taskNodes: visible(".task-node"), summaryNotes: visible(".task-tree-summary-note") };
            });

            if (progressView.taskNodes > 0)
            {
                throw new Error(`The progress page exposed ${progressView.taskNodes} internal task rows to a non-administrator.`);
            }
            if (progressView.summaryNotes === 0)
            {
                throw new Error("The progress page showed neither the task tree nor the summary note — the user is told nothing about what happens next.");
            }

            return `started; balance before ${creditStateBefore.balance}, confirmation "${confirmText.slice(0, 70)}"`;
        });

        await runCase("The generation runs to completion", async () =>
        {
            const startedAt = Date.now();
            const terminalState = await waitForGenerationToFinish(page);
            generationSecondsForReport = Math.round((Date.now() - startedAt) / 1000);

            if (terminalState.bWarning)
            {
                // Paused, out of credits mid-run, or image preparation failed.
                // None of these leave a complete run to assert charges against.
                throw new EnvironmentUnavailableError(
                    `The generation did not finish cleanly: "${terminalState.text.slice(0, 200)}"`);
            }

            if (!terminalState.bSuccess)
            {
                throw new Error(terminalState.text.slice(0, 250));
            }

            return `completed in ${generationSecondsForReport}s — "${terminalState.text.slice(0, 90)}"`;
        });

        await runCase("The run is charged: ledger rows, token usage, balance and lifetime spend", async () =>
        {
            appliedCharges = await ledgerProbe.waitForAppliedCharges(snapshotDate, LEDGER_SETTLE_TIMEOUT_MS, 1);

            // (a) Something was charged at all.
            if (appliedCharges.length === 0)
            {
                throw new Error(
                    "THE GENERATION WAS FREE. It completed and produced content, but not one applied "
                    + `creditTransactions row exists for "${TEST_ACCOUNT_ID}" since the run started. `
                    + "Either no spend rule is configured for the generation workers "
                    + "(CreditConfiguration.ensureGenerationTaskRules), or the Agent's TaskCreditCharger never ran.");
            }

            const nonDebitCharges = appliedCharges.filter(charge => charge.amount >= 0);
            if (nonDebitCharges.length > 0)
            {
                throw new Error(`${nonDebitCharges.length} TASK_CHARGE row(s) carry a non-negative amount — a charge must debit.`);
            }

            // (b) THE regression. A token-metered worker must have recorded the
            // tokens its charge was computed from. Zero usage means the meter saw
            // nothing, which means the amount was computed from nothing.
            const tokenMeteredCharges = appliedCharges.filter(charge =>
                CreditLedgerProbe.TOKEN_METERED_TASK_TYPES.includes(charge.metadata && charge.metadata.taskType));

            if (tokenMeteredCharges.length === 0)
            {
                throw new Error(
                    "No charge from a token-metered worker (FLASHCARD_GENERATION_WORKER 17, "
                    + "STUDY_MATERIAL_GENERATION_WORKER 18, MOCK_TEST_GENERATION_WORKER 19). "
                    + `Charged task types were: ${appliedCharges.map(charge => charge.metadata && charge.metadata.taskType).join(", ")}. `
                    + "The pipeline's model work was not billed.");
            }

            meteredCharge = tokenMeteredCharges.find(charge =>
            {
                const usage = (charge.metadata && charge.metadata.usage) || {};
                return usage.inputTokens > 0 && usage.outputTokens > 0;
            });

            if (!meteredCharge)
            {
                const observed = tokenMeteredCharges
                    .map(charge => `type ${charge.metadata.taskType}: ${JSON.stringify((charge.metadata && charge.metadata.usage) || null)}`)
                    .join(" | ");
                throw new Error(
                    "A token-metered worker was charged, but NOT ONE of its charges recorded real token usage. "
                    + `Observed: ${observed}. This is the regression this suite exists for: the credit meter is not `
                    + "seeing the model calls, so the amount was computed from zeroes and the user is not paying for "
                    + "what they used. Start at Agent/Globals/Classes/Credits/CreditMeter.py and the call sites that "
                    + "record into it — including the ResponseCache hit path in AutomationCaller.call.");
            }

            // (c) The balance actually moved by the sum of the charges. The rows
            // and the balance are written by two separate operations, so a suite
            // that only checked the rows would pass while nothing was debited.
            totalChargedForReport = CreditLedgerProbe.sumChargedCredits(appliedCharges);
            const creditStateAfter = await ledgerProbe.readCreditState();
            const observedBalanceDrop = Math.round((creditStateBefore.balance - creditStateAfter.balance) * 10000) / 10000;

            if (!CreditLedgerProbe.creditsAreEqual(observedBalanceDrop, totalChargedForReport))
            {
                throw new Error(
                    `The ledger says ${totalChargedForReport} credit(s) were charged, but the balance moved by `
                    + `${observedBalanceDrop} (${creditStateBefore.balance} -> ${creditStateAfter.balance}). `
                    + "The rows and the balance disagree.");
            }

            // (d) Lifetime spend follows the same amount — it is moved by the same
            // $inc, so a divergence means something wrote the balance behind the
            // ledger's back.
            const observedLifetimeIncrease = Math.round((creditStateAfter.lifetimeSpent - creditStateBefore.lifetimeSpent) * 10000) / 10000;
            if (!CreditLedgerProbe.creditsAreEqual(observedLifetimeIncrease, totalChargedForReport))
            {
                throw new Error(
                    `lifetimeCreditsSpent rose by ${observedLifetimeIncrease} but ${totalChargedForReport} credit(s) were charged.`);
            }

            const usage = meteredCharge.metadata.usage;
            return `${appliedCharges.length} charge(s) totalling ${totalChargedForReport} cr; `
                + `task type ${meteredCharge.metadata.taskType} metered ${usage.inputTokens} in / ${usage.outputTokens} out tokens; `
                + `balance ${creditStateBefore.balance} -> ${creditStateAfter.balance}; lifetime spend +${observedLifetimeIncrease}`;
        });

        await runCase("The credit summary shown to the user agrees with the ledger", async () =>
        {
            // ProgressPage appends this table from /Activity/Tasks/CreditSummary
            // on every terminal generation. It is the one place the user is told
            // what they were charged, and it must not be a separate, drifting
            // truth from the ledger.
            await BrowserSuiteHelpers.waitForVisible(page, ".progress-page-credit-summary", "the credit-usage summary");

            const summaryTotal = await page.evaluate(() =>
            {
                const totalRow = document.querySelector(".progress-page-credit-table .progress-page-credit-total");
                if (!totalRow)
                {
                    return null;
                }
                const cells = Array.from(totalRow.querySelectorAll("td")).map(cell => cell.textContent.trim());
                const numeric = cells.map(text => Number(text.replace(/[^0-9.]/g, ""))).filter(value => Number.isFinite(value) && value > 0);
                return numeric.length > 0 ? numeric[0] : null;
            });

            if (summaryTotal === null)
            {
                throw new Error("The credit-usage table rendered without a readable total row.");
            }

            if (!CreditLedgerProbe.creditsAreEqual(summaryTotal, totalChargedForReport))
            {
                throw new Error(
                    `The user is shown a total of ${summaryTotal} credit(s) but the ledger charged ${totalChargedForReport}. `
                    + "The number on screen and the money taken disagree.");
            }

            return `summary shows ${summaryTotal} cr, matching the ledger`;
        });

        await runCase("No uncaught client script errors during the run", async () =>
        {
            if (scriptErrors.length > 0)
            {
                throw new Error(`${scriptErrors.length} uncaught client error(s): ${scriptErrors.slice(0, 3).join(" | ")}`);
            }
            return "no pageerror events";
        });
    }
    catch (fatalError)
    {
        cases.push({ name: "00. Suite harness", status: "FAIL", detail: `Unhandled: ${fatalError.message}` });
        console.log(`  FAIL 00. Suite harness — ${fatalError.message}`);
    }
    finally
    {
        if (page && !KEEP_FIXTURES)
        {
            try
            {
                await BrowserSuiteHelpers.returnToHome(page);
                const deletedSources = await ledgerProbe.deleteFixtureInformationSources(FIXTURE_PREFIX).catch(() => 0);
                trace(`  (cleanup: removed ${deletedSources} fixture information source row(s))`);
            }
            catch (cleanupError)
            {
                trace(`  (cleanup failed: ${cleanupError.message})`);
            }
        }

        if (runCopyPath && !KEEP_FIXTURES)
        {
            try { fs.unlinkSync(runCopyPath); } catch (unlinkError) { /* the temp directory is swept anyway */ }
        }

        if (browser)
        {
            await browser.close().catch(() => {});
        }

        await ledgerProbe.close();
    }

    const passed = cases.filter(entry => entry.status === "PASS").length;
    const failed = cases.filter(entry => entry.status === "FAIL").length;
    const skipped = cases.filter(entry => entry.status === "SKIPPED").length;

    const stageCases = cases.filter(entry => /^\d\d\./.test(entry.name));
    const stagesPassed = stageCases.filter(entry => entry.status === "PASS").length;
    const percent = stageCases.length > 0 ? Math.round((stagesPassed / stageCases.length) * 100) : null;

    const meteredUsage = (meteredCharge && meteredCharge.metadata && meteredCharge.metadata.usage) || {};

    writeResult({
        service: "Main",
        category: CATEGORY,
        status: failed > 0 ? "FAIL" : (skipped > 0 || passed === 0 ? "SKIPPED" : "PASS"),
        passed, failed, skipped, total: cases.length,
        coverage: {
            kind: "flows",
            label: "Credit-charging stages proven",
            percent,
            covered: stagesPassed,
            total: stageCases.length,
            detail: `${stagesPassed}/${stageCases.length} stages of the upload -> generate -> charge path proved end to end`,
        },
        // Reported so the numbers themselves become the pricing-calibration data
        // CreditConfiguration's own comments ask for: run this periodically and
        // the credits-per-run trend is right here.
        metrics: {
            label: "Credits",
            creditsChargedThisRun: totalChargedForReport,
            ledgerRowsWritten: appliedCharges.length,
            inputTokensMetered: meteredUsage.inputTokens || 0,
            outputTokensMetered: meteredUsage.outputTokens || 0,
            generationSeconds: generationSecondsForReport,
        },
        cases,
        notes: `${stagesPassed}/${stageCases.length} stages passed; ${totalChargedForReport} credit(s) charged.`,
    });

    console.log(`Main ${CATEGORY}: ${failed > 0 ? "FAIL" : (skipped > 0 ? "SKIPPED" : "PASS")} `
        + `(${passed} passed, ${failed} failed, ${skipped} skipped) — ${totalChargedForReport} credit(s) charged`);
})();
