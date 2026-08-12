/**
 * run_offline_ui_tests — the app with the network taken away.
 *
 * The desktop and mobile shells are meant to keep working offline: the same
 * user still signed in, their decks still readable, only the server-backed
 * features missing. Every part of that is built — a service worker caching the
 * shell, an offline session cache, local persistence — and none of it was
 * exercised by anything, because the suites all run against a live Dock.
 *
 * That is the gap this closes. Each case does the same shape of thing: load
 * online so the caches fill, CUT THE NETWORK, reload, and assert the app still
 * behaves. A regression here is invisible online and total offline, which is
 * the worst combination to leave untested.
 *
 * The service worker is registered explicitly rather than by loading as the
 * native shell. In the real app OfflineCacheManager registers it only when
 * Platform.get() is APP, which needs window.__TAURI__; faking that global would
 * send Persistence down the Tauri filesystem path, which does not exist here.
 * Registering by hand exercises the same worker with the same scope — the
 * subject under test is the worker's caching, not who asked for it.
 *
 *     node Common/Testing/Main/seed_browser_test_account.js
 *     TEST_SESSION_COOKIE=browser-suite-test-session node Common/Testing/Main/run_offline_ui_tests.js
 *
 * Run it ALONE. Puppeteer suites started back to back in one shell interfere
 * with each other's fixtures and report failures that do not reproduce.
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(__dirname, "node_modules", "puppeteer"));

const APPLICATION_ORIGIN = process.env.TEST_ORIGIN || "http://127.0.0.1:3000";
const SESSION_COOKIE_VALUE = process.env.TEST_SESSION_COOKIE || "browser-suite-test-session";
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(__dirname, "..", "..", "Reports", ".results", "offline-ui.json");

let passedCount = 0;
let failedCount = 0;
const recordedCases = [];

function check(description, bCondition, detail)
{
    if (bCondition)
    {
        passedCount++;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount++;
        console.log(`  FAIL  ${description}${detail ? ` — ${detail}` : ""}`);
    }
    recordedCases.push({ name: description, passed: Boolean(bCondition), detail: detail || "" });
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

async function waitForServiceWorkerControl(page)
{
    // registration.active is not enough: a worker can be active without yet
    // controlling this page, and an uncontrolled page goes straight to the
    // network — which offline means straight to a failure.
    await page.evaluate(async () =>
    {
        const registration = await navigator.serviceWorker.register("/service-worker.js");
        await navigator.serviceWorker.ready;

        if (!navigator.serviceWorker.controller)
        {
            await new Promise((resolve) =>
            {
                navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
                if (registration.active) { registration.active.postMessage("claim"); }
                setTimeout(resolve, 3000);
            });
        }
    });
}

async function run()
{
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        protocolTimeout: 180000,
    });

    const page = await browser.newPage();
    await page.setCookie({
        name: "sessionId",
        value: SESSION_COOKIE_VALUE,
        domain: new URL(APPLICATION_ORIGIN).hostname,
        path: "/",
    });

    section("Online first — the caches have to be filled before they can be read");

    await page.goto(`${APPLICATION_ORIGIN}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const bMountedOnline = await page.evaluate(() => Boolean(document.querySelector("home-page")));
    check("the app reaches Home while online", bMountedOnline);

    const onlineUserName = await page.evaluate(() => (document.body.innerText.match(/Browser Suite Test/) || [""])[0]);
    check("and the signed-in user is shown", onlineUserName.length > 0, `read "${onlineUserName}"`);

    await waitForServiceWorkerControl(page);
    const bControlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    check("the offline service worker is controlling the page", bControlled);

    // A controlled reload is what actually populates the cache: the worker only
    // sees requests made while it is in control.
    await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const cachedEntryCount = await page.evaluate(async () =>
    {
        const cacheNames = await caches.keys();
        let total = 0;
        for (const cacheName of cacheNames)
        {
            total += (await (await caches.open(cacheName)).keys()).length;
        }
        return total;
    });
    check("the shell and its assets are in the cache", cachedEntryCount > 0, `${cachedEntryCount} entries`);

    // The weights have to actually be REQUESTED for their exclusion to mean
    // anything. Asserting "nothing under /Assets/Models/ was cached" after a
    // run that never asked for a model file is a test that cannot fail, and it
    // would go on passing after the exclusion was deleted.
    const bModelAssetFetched = await page.evaluate(async () =>
    {
        try
        {
            const manifestResponse = await fetch("/LocalLlm/Manifest", { credentials: "include" });
            if (!manifestResponse.ok) { return false; }

            const manifest = await manifestResponse.json();

            // A SMALL file, fetched WHOLE. Both matter. A ranged request comes
            // back 206, and the worker only stores 200s — so a Range header
            // would sail past the caching path entirely and the assertion
            // below would pass whether the exclusion existed or not. (It did:
            // removing the exclusion left this green, which is how the vacuum
            // was found.) Every model directory carries a few-kilobyte config
            // or tokenizer file, so this costs nothing to transfer in full.
            const smallServedFile = (manifest.models || [])
                .flatMap((servedModel) => (servedModel.files || [])
                    .map((file) => ({ url: `${servedModel.baseUrl}${file.path}`, sizeBytes: file.sizeBytes })))
                .filter((candidate) => candidate.sizeBytes > 0 && candidate.sizeBytes < 512 * 1024)
                .sort((first, second) => first.sizeBytes - second.sizeBytes)[0];

            if (!smallServedFile) { return false; }

            const assetResponse = await fetch(smallServedFile.url);
            return assetResponse.status === 200;
        }
        catch (fetchError) { return false; }
    });
    check("a real model asset was requested, so the exclusion below is actually exercised",
        bModelAssetFetched);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // The whole point of the exclusion: model weights must not be duplicated
    // here. They have their own store, and a second copy is a silent gigabyte.
    const cachedModelEntryCount = await page.evaluate(async () =>
    {
        const cacheNames = await caches.keys();
        let total = 0;
        for (const cacheName of cacheNames)
        {
            const requests = await (await caches.open(cacheName)).keys();
            total += requests.filter((request) => new URL(request.url).pathname.startsWith("/Assets/Models/")).length;
        }
        return total;
    });
    check("no model weights were cached by the service worker", cachedModelEntryCount === 0,
        `${cachedModelEntryCount} model file(s) cached`);

    section("Offline — the network is gone and the app must still work");

    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const bShellLoadedOffline = await page.evaluate(() => document.querySelectorAll("script, home-page, login-page").length > 0);
    check("the shell loads from cache with no network at all", bShellLoadedOffline);

    const offlineState = await page.evaluate(() =>
    ({
        bHomeMounted: Boolean(document.querySelector("home-page")),
        bLoginShown: Boolean(document.querySelector("login-page")),
        bUserVisible: /Browser Suite Test/.test(document.body.innerText),
        deckTileCount: document.querySelectorAll("deck-tile").length,
        bodyPreview: document.body.innerText.slice(0, 120).replace(/\s+/g, " "),
    }));

    check("it boots to Home rather than bouncing to the login page",
        offlineState.bHomeMounted && !offlineState.bLoginShown, offlineState.bodyPreview);
    check("THE SAME USER IS STILL SIGNED IN with no server to ask",
        offlineState.bUserVisible, offlineState.bodyPreview);
    check("their decks are still readable from local storage",
        offlineState.deckTileCount > 0, `${offlineState.deckTileCount} deck tile(s)`);

    section("Back online — the session revalidates rather than staying stale");

    await page.setOfflineMode(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const bStillSignedIn = await page.evaluate(() => /Browser Suite Test/.test(document.body.innerText));
    check("the user survives the transition back to online", bStillSignedIn);

    await browser.close();

    fs.mkdirSync(path.dirname(path.resolve(RESULT_FILE)), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify({
        service: "Main",
        category: "offline",
        passed: passedCount,
        failed: failedCount,
        total: passedCount + failedCount,
        cases: recordedCases,
    }, null, 2), "utf-8");

    console.log(`\nOffline (Puppeteer): ${passedCount} passed, ${failedCount} failed`);
    process.exit(failedCount === 0 ? 0 : 1);
}

run().catch((unexpectedError) =>
{
    console.error(unexpectedError);
    process.exit(1);
});
