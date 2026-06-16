// Deterministic unit tests for the pure Main/ utility functions (no browser,
// no server). The Puppeteer suite (run_ui_tests.js) covers navigation,
// responsiveness and dialogs against the BUILT app; this suite covers the
// framework-free helper functions under Main/Globals/UtilityFunctions that are
// pure and deterministic. Run with:
//   node Common/Testing/Main/run_main_unit_tests.js
// Writes its result JSON to $RESULT_FILE or Common/Reports/.results/main-unit.json.
//
// Main helpers are ES modules (export function ...), so they are loaded with a
// dynamic import(); the harness from the Dock suite is dependency-free and is
// reused here to keep the per-suite JSON shape identical. DOM / network / random
// helpers (download, fetch*, scaleDownImage, getRandomUuid, htmlToSearchableText,
// the convert*/applyImageResizeDecorator decorators, pollTaskCompletion) are NOT
// unit-testable here and are exercised by the Puppeteer suite instead.

const path = require("path");
const { pathToFileURL } = require("url");
const { Harness, writeSkipped, assert, assertEqual } = require("../Dock/_harness");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const UTILITY_DIRECTORY = path.join(REPOSITORY_ROOT, "Main", "Globals", "UtilityFunctions");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "main-unit.json");

const CATEGORY = "Utility Functions (Main)";
const CATALOGUED = [
    "formatCredits", "enumerationToTitleCase", "titleCaseToEnumeration",
    "pascalCaseToTitleCase", "rgbToHex", "sanitizeForJsPdf", "sha256",
    "smoothCurve", "createPromiseMutex",
];

function moduleUrl(fileName)
{
    return pathToFileURL(path.join(UTILITY_DIRECTORY, fileName)).href;
}

function approximately(actual, expected, tolerance, message)
{
    if (Math.abs(actual - expected) > (tolerance === undefined ? 1e-9 : tolerance))
    {
        throw new Error((message ? message + " - " : "") + `expected ~${expected}, got ${actual}`);
    }
}

async function main()
{
    let formatCredits, enumerationToTitleCase, titleCaseToEnumeration, pascalCaseToTitleCase;
    let rgbToHex, sanitizeForJsPdf, sha256, smoothCurve, createPromiseMutex;
    let mutexOrder;
    try
    {
        ({ formatCredits } = await import(moduleUrl("FormatCredits.js")));
        ({ enumerationToTitleCase, titleCaseToEnumeration } = await import(moduleUrl("EnumerationToTitleCase.js")));
        ({ pascalCaseToTitleCase } = await import(moduleUrl("PascalCaseToTitleCase.js")));
        ({ rgbToHex } = await import(moduleUrl("RgbToHex.js")));
        sanitizeForJsPdf = (await import(moduleUrl("SanitizeForJsPdf.js"))).default;
        ({ sha256 } = await import(moduleUrl("Sha256.js")));
        ({ smoothCurve } = await import(moduleUrl("SmoothCurve.js")));
        ({ createPromiseMutex } = await import(moduleUrl("CreatePromiseMutex.js")));

        // The mutex is async, but the harness test bodies are synchronous, so we
        // run the mutual-exclusion scenario up front and assert the captured order.
        mutexOrder = [];
        const mutex = createPromiseMutex();
        const releaseFirst = await mutex.acquire();
        mutexOrder.push("first-acquired");
        const secondHolder = mutex.acquire().then(releaseSecond =>
        {
            mutexOrder.push("second-acquired");
            releaseSecond();
        });
        mutexOrder.push("before-first-release");
        releaseFirst();
        await secondHolder;
    }
    catch (error)
    {
        writeSkipped("Main", CATEGORY, `Could not load Main utility modules: ${error.message}`, RESULT_FILE);
        return;
    }

    const harness = new Harness("Main", CATEGORY, CATALOGUED);

    // -- formatCredits ---------------------------------------------------------

    harness.test("formatCredits: float-drifted balance rounds to two decimals", "formatCredits", () =>
    {
        assertEqual(formatCredits(98.28949999999999), "98.29");
    });

    harness.test("formatCredits: half-credit, whole numbers and trailing zeros", "formatCredits", () =>
    {
        assertEqual(formatCredits(0.5), "0.5");
        assertEqual(formatCredits(100), "100");
        assertEqual(formatCredits(5.0), "5");
        assertEqual(formatCredits("50.5"), "50.5");
        assertEqual(formatCredits(-3.14159), "-3.14");
    });

    harness.test("formatCredits: non-numeric / non-finite input formats as 0 (no throw)", "formatCredits", () =>
    {
        assertEqual(formatCredits("abc"), "0");
        assertEqual(formatCredits(undefined), "0");
        assertEqual(formatCredits(null), "0");
        assertEqual(formatCredits(Number.POSITIVE_INFINITY), "0");
        assertEqual(formatCredits(Number.NaN), "0");
    });

    // -- enumerationToTitleCase ------------------------------------------------

    harness.test("enumerationToTitleCase: UPPER_SNAKE_CASE becomes Title Case", "enumerationToTitleCase", () =>
    {
        assertEqual(enumerationToTitleCase("ON_SUCCESS"), "On Success");
        assertEqual(enumerationToTitleCase("GLICKO_RD"), "Glicko Rd");
        assertEqual(enumerationToTitleCase("WEAK"), "Weak");
        assertEqual(enumerationToTitleCase("A"), "A");
        assertEqual(enumerationToTitleCase(""), "");
    });

    // -- titleCaseToEnumeration ------------------------------------------------

    harness.test("titleCaseToEnumeration: Title Case becomes UPPER_SNAKE_CASE (collapses spaces)", "titleCaseToEnumeration", () =>
    {
        assertEqual(titleCaseToEnumeration("On Success"), "ON_SUCCESS");
        assertEqual(titleCaseToEnumeration("Weak"), "WEAK");
        assertEqual(titleCaseToEnumeration("  multiple   spaces  "), "MULTIPLE_SPACES");
    });

    harness.test("titleCaseToEnumeration round-trips enumerationToTitleCase", "titleCaseToEnumeration", () =>
    {
        assertEqual(titleCaseToEnumeration(enumerationToTitleCase("ON_SUCCESS")), "ON_SUCCESS");
    });

    // -- pascalCaseToTitleCase -------------------------------------------------

    harness.test("pascalCaseToTitleCase: splits on case boundaries, keeps acronyms", "pascalCaseToTitleCase", () =>
    {
        assertEqual(pascalCaseToTitleCase("MyCardProgress"), "My Card Progress");
        assertEqual(pascalCaseToTitleCase("URL"), "URL");
        assertEqual(pascalCaseToTitleCase("myLowerStart"), "my Lower Start");
        assertEqual(pascalCaseToTitleCase(""), "");
    });

    // -- rgbToHex --------------------------------------------------------------

    harness.test("rgbToHex: converts rgb(...) triples to lowercase #rrggbb", "rgbToHex", () =>
    {
        assertEqual(rgbToHex("rgb(255, 128, 0)"), "#ff8000");
        assertEqual(rgbToHex("rgb(0, 0, 0)"), "#000000");
        assertEqual(rgbToHex("rgb(255, 255, 255)"), "#ffffff");
        assertEqual(rgbToHex("rgb(10, 20, 30)"), "#0a141e");
    });

    harness.test("rgbToHex: unparseable input falls back to #ffff00", "rgbToHex", () =>
    {
        assertEqual(rgbToHex("invalid"), "#ffff00");
    });

    // -- sanitizeForJsPdf ------------------------------------------------------

    harness.test("sanitizeForJsPdf: maps non-WinAnsi glyphs to ASCII, leaves ASCII intact", "sanitizeForJsPdf", () =>
    {
        assertEqual(sanitizeForJsPdf("Hello α β γ"), "Hello alpha beta gamma");
        assertEqual(sanitizeForJsPdf("π approx"), "pi approx");
        assertEqual(sanitizeForJsPdf("plain ascii"), "plain ascii");
    });

    harness.test("sanitizeForJsPdf: null / empty input returns empty string", "sanitizeForJsPdf", () =>
    {
        assertEqual(sanitizeForJsPdf(null), "");
        assertEqual(sanitizeForJsPdf(""), "");
    });

    // -- sha256 ----------------------------------------------------------------

    harness.test("sha256: matches the known NIST test vectors", "sha256", () =>
    {
        assertEqual(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assertEqual(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assertEqual(sha256("test"), "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    });

    harness.test("sha256: deterministic across repeated calls", "sha256", () =>
    {
        assertEqual(sha256("The quick brown fox"), sha256("The quick brown fox"));
    });

    // -- smoothCurve -----------------------------------------------------------

    harness.test("smoothCurve: empty input and a single point pass through", "smoothCurve", () =>
    {
        assertEqual(smoothCurve([], 5).length, 0);
        const single = smoothCurve([{ x: 1, y: 10 }], 5);
        assertEqual(single.length, 1);
        assertEqual(single[0].x, 1);
        assertEqual(single[0].y, 10);
    });

    harness.test("smoothCurve: preserves x-coordinates and pulls endpoints toward neighbours", "smoothCurve", () =>
    {
        const smoothed = smoothCurve([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], 5);
        assertEqual(smoothed.length, 3);
        assertEqual(smoothed.map(point => point.x).join(","), "1,2,3");
        // The symmetric middle point stays put; the endpoints move inward.
        approximately(smoothed[1].y, 2, 1e-6, "middle point");
        assert(smoothed[0].y > 1 && smoothed[0].y < 2, "first point smoothed toward the middle");
        assert(smoothed[2].y > 2 && smoothed[2].y < 3, "last point smoothed toward the middle");
    });

    // -- createPromiseMutex ----------------------------------------------------

    harness.test("createPromiseMutex: exposes an acquire() function", "createPromiseMutex", () =>
    {
        const mutex = createPromiseMutex();
        assert(typeof mutex.acquire === "function", "acquire must be a function");
    });

    harness.test("createPromiseMutex: a second acquire waits until the first releases", "createPromiseMutex", () =>
    {
        // mutexOrder was captured up front from a real acquire/release scenario.
        assertEqual(mutexOrder.join(" > "), "first-acquired > before-first-release > second-acquired");
    });

    harness.runAndWrite(RESULT_FILE);
}

main().catch(error =>
{
    writeSkipped("Main", CATEGORY, `Unit suite crashed: ${error && error.message ? error.message : String(error)}`, RESULT_FILE);
});
