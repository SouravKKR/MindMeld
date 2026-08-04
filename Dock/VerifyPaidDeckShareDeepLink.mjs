/**
 * Verification harness for the paid-deck share QR / deep link.
 *
 * A share link is the one place in this application where an EXTERNAL string
 * decides which page opens and, after sign-in, where the browser is redirected.
 * Everything below exists to keep two properties true:
 *
 *   1. the redirect can only ever point back at this deployment, and
 *   2. the route the QR code encodes is a route the server actually answers.
 *
 * Run from the Dock directory:
 *     node VerifyPaidDeckShareDeepLink.mjs
 *
 * Tiers:
 *   1. Always on, pure in-process. No DB, no network, no Redis. Covers the deck
 *      ID predicate, the composed resume location (the open-redirect property),
 *      the cookie attributes, the packetron route-shape quirk the URL design
 *      depends on, and the legal-acceptance allowlist entries without which the
 *      whole signed-out flow returns raw JSON.
 *   2. VERIFY_PAID_DECK_SHARE_DEEP_LINK_DATABASE=1 — drives the real
 *      GET /PaidDecks/Details handler against MongoDB with a throwaway listing:
 *      published lookup, unpublished lookup, unknown ID and malformed ID. Cleans
 *      up everything it creates and refuses to run against production.
 *
 * Why tier 1 pins the packetron route shape. Registration strips the leading
 * slash and then path.normalize()s, so "/" is stored under ".". Dispatch
 * normalises first and strips the query second, so "/?id=x" becomes "" and
 * matches nothing — the bare root 404s the moment a query string is appended.
 * The deep link therefore uses a non-empty path, where both sides agree. A
 * later rename back to "/" would reintroduce a production-only 404 that no
 * amount of local clicking would surface, so it is asserted here.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

const PaidDeckDeepLinkCookie = require("./Endpoints/Helpers/PaidDeckDeepLinkCookie");
const PaidDeckShareConstants = require("./Globals/Constants/PaidDeckShareConstants");
const App = require("./Globals/Classes/App");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");
const {httpStatus} = require("./Globals/Enumerations/HttpStatus");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

// Every shape a hostile or merely broken value could take. Each one must be
// rejected by the predicate AND produce a null resume location — the second
// assertion is the one that actually matters, because it is the value that
// reaches a Location header.
const REJECTED_DECK_ID_CANDIDATES =
[
    "",
    "   ",
    "../../etc/passwd",
    "//evil.com",
    "\\evil.com",
    "https://evil.com",
    "a@evil.com",
    "deck?x=1",
    "deck#fragment",
    "deck\r\nLocation: https://evil.com",
    "3f2b8c1a-9d4e-4f7a-8b2c-1e5d6a7f0b9",
    "3f2b8c1a-9d4e-4f7a-8b2c-1e5d6a7f0b933",
    "3f2b8c1a-9d4e-4f7a-8b2c-1e5d6a7f0b93 ",
    "3f2b8c1a9d4e4f7a8b2c1e5d6a7f0b93",
    "zzzzzzzz-9d4e-4f7a-8b2c-1e5d6a7f0b93"
];

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

/**
 * Minimal stand-ins for the packetron request / response pair. Only the surface
 * the handlers actually touch is implemented, so a change in what they touch
 * shows up as a crash here rather than a silently-passing test.
 */
function createStubRequest({ queryParameters = {}, cookies = {}, headers = {} } = {})
{
    return {
        headers: headers,
        getQueryParams: async () => queryParameters,
        getCookies: async () => cookies
    };
}

function createStubResponse()
{
    return {
        statusCode: null,
        jsonBody: null,
        setCookieCalls: [],
        clearCookieCalls: [],
        sendJson(payload)
        {
            this.jsonBody = payload;
        },
        setCookie(key, value, options)
        {
            this.setCookieCalls.push({ key: key, value: value, options: options });
        },
        clearCookie(key)
        {
            this.clearCookieCalls.push(key);
        }
    };
}

function verifyDeckIdPredicate()
{
    section("Deck ID predicate");

    const validDeckId = crypto.randomUUID();
    assert(PaidDeckDeepLinkCookie.isValidDeckId(validDeckId), "a crypto.randomUUID() deck ID is accepted");
    assert(PaidDeckDeepLinkCookie.isValidDeckId(validDeckId.toUpperCase()), "an upper-cased UUID is accepted");

    let allRejected = true;
    for (const rejectedCandidate of REJECTED_DECK_ID_CANDIDATES)
    {
        if (PaidDeckDeepLinkCookie.isValidDeckId(rejectedCandidate))
        {
            allRejected = false;
            console.log(`        unexpectedly accepted: ${JSON.stringify(rejectedCandidate)}`);
        }
    }
    assert(allRejected, `every one of the ${REJECTED_DECK_ID_CANDIDATES.length} malformed / hostile candidates is rejected`);

    assert(!PaidDeckDeepLinkCookie.isValidDeckId(null), "null is rejected");
    assert(!PaidDeckDeepLinkCookie.isValidDeckId(undefined), "undefined is rejected");
    assert(!PaidDeckDeepLinkCookie.isValidDeckId(12345), "a non-string is rejected");
}

function verifyResumeLocationCannotLeaveThisOrigin()
{
    section("Resume location (open-redirect property)");

    const validDeckId = crypto.randomUUID();
    const resumeLocation = PaidDeckDeepLinkCookie.buildResumeLocation(validDeckId);

    assert(typeof resumeLocation === "string" && resumeLocation.length > 0, "a valid deck ID produces a resume location");

    const parsedLocation = new URL(resumeLocation);
    assert(parsedLocation.origin === App.getOrigin(), "the resume location's origin is App.getOrigin(), not anything from the input");
    assert(parsedLocation.pathname === PaidDeckShareConstants.DEEP_LINK_ROUTE_PATH, "the resume location's path is the deep-link route");
    assert
    (
        parsedLocation.searchParams.get(PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER) === validDeckId,
        "the deck ID round-trips through the query string unchanged"
    );

    // The property, not a spot check: no rejected candidate may ever yield a
    // destination at all.
    let allNull = true;
    for (const rejectedCandidate of REJECTED_DECK_ID_CANDIDATES)
    {
        if (PaidDeckDeepLinkCookie.buildResumeLocation(rejectedCandidate) !== null)
        {
            allNull = false;
            console.log(`        unexpectedly produced a location for: ${JSON.stringify(rejectedCandidate)}`);
        }
    }
    assert(allNull, "no malformed / hostile candidate produces any resume location");
    assert(PaidDeckDeepLinkCookie.buildResumeLocation(null) === null, "null produces no resume location");
}

function verifyCookieAttributes()
{
    section("Pending-deck cookie attributes");

    const cookieOptions = PaidDeckDeepLinkCookie.COOKIE_OPTIONS;

    assert(cookieOptions.httpOnly === true, "the cookie is HttpOnly — no client script reads it");
    assert(cookieOptions.secure === true, "the cookie is Secure");
    // Strict would be withheld on the cross-site top-level redirect back from
    // the identity provider, silently breaking the entire signed-out flow.
    assert(cookieOptions.sameSite === "lax", "the cookie is SameSite=Lax so it survives the OAuth callback");
    assert(cookieOptions.path === "/", "the cookie is scoped to / so /Login/Callback receives it");
    assert
    (
        cookieOptions.maxAge === PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_MAX_AGE_SECONDS,
        "the cookie lifetime comes from the shared constant"
    );
    assert(cookieOptions.maxAge > 0 && cookieOptions.maxAge <= 3600, "the cookie lifetime is short-lived (<= 1 hour)");
}

async function verifyCaptureAndTakeBehaviour()
{
    section("Cookie capture / consume behaviour");

    const validDeckId = crypto.randomUUID();

    const signedOutResponse = createStubResponse();
    await PaidDeckDeepLinkCookie.captureOrClear
    (
        createStubRequest({ queryParameters: { [PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER]: validDeckId } }),
        signedOutResponse,
        null
    );
    assert(signedOutResponse.setCookieCalls.length === 1, "a signed-out visitor with a valid deck ID gets the cookie set");
    assert(signedOutResponse.setCookieCalls[0]?.value === validDeckId, "the stored value is the bare deck ID, never a URL");
    assert
    (
        signedOutResponse.setCookieCalls[0]?.key === PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_NAME,
        "the cookie name comes from the shared constant"
    );

    const signedInResponse = createStubResponse();
    await PaidDeckDeepLinkCookie.captureOrClear
    (
        createStubRequest
        ({
            queryParameters: { [PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER]: validDeckId },
            cookies: { [PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_NAME]: validDeckId }
        }),
        signedInResponse,
        { getUserId: () => "someone" }
    );
    assert(signedInResponse.setCookieCalls.length === 0, "a signed-in visitor has nothing stashed");
    assert(signedInResponse.clearCookieCalls.length === 1, "a signed-in visitor has a stale cookie swept");

    // The SPA entry handler also serves "/" and "/index.html", so a needless
    // Set-Cookie on every anonymous page load would be pure header noise.
    const quietResponse = createStubResponse();
    await PaidDeckDeepLinkCookie.captureOrClear(createStubRequest({}), quietResponse, null);
    assert(quietResponse.setCookieCalls.length === 0, "an ordinary page load with no deck ID stores nothing");
    assert(quietResponse.clearCookieCalls.length === 0, "an ordinary page load with no pending cookie emits no Set-Cookie at all");

    const hostileResponse = createStubResponse();
    await PaidDeckDeepLinkCookie.captureOrClear
    (
        createStubRequest({ queryParameters: { [PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER]: "https://evil.com" } }),
        hostileResponse,
        null
    );
    assert(hostileResponse.setCookieCalls.length === 0, "a malformed deck ID is never stored");

    const takeResponse = createStubResponse();
    const takenDeckId = await PaidDeckDeepLinkCookie.takePendingDeckId
    (
        createStubRequest({ cookies: { [PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_NAME]: validDeckId } }),
        takeResponse
    );
    assert(takenDeckId === validDeckId, "a valid pending deck ID is returned");
    assert(takeResponse.clearCookieCalls.length === 1, "reading the pending deck ID also consumes it");

    const tamperedResponse = createStubResponse();
    const tamperedDeckId = await PaidDeckDeepLinkCookie.takePendingDeckId
    (
        createStubRequest({ cookies: { [PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_NAME]: "//evil.com" } }),
        tamperedResponse
    );
    assert(tamperedDeckId === "", "a tampered cookie value is re-validated on read and discarded");
    assert(tamperedResponse.clearCookieCalls.length === 1, "a tampered cookie is consumed too, not left in place");

    const emptyResponse = createStubResponse();
    const noDeckId = await PaidDeckDeepLinkCookie.takePendingDeckId(createStubRequest({}), emptyResponse);
    assert(noDeckId === "", "no cookie yields no deck ID");
    assert(PaidDeckDeepLinkCookie.buildResumeLocation(noDeckId) === null, "no pending deck falls back to the plain origin");
}

function verifyRouteShapeSurvivesPacketronNormalisation()
{
    section("Route shape (packetron registration vs dispatch)");

    const deepLinkRoutePath = PaidDeckShareConstants.DEEP_LINK_ROUTE_PATH;

    // What server.handle() stores the handler under.
    const registeredRouteKey = path.normalize(deepLinkRoutePath.replace(/^\/+/, ""));

    // What the router computes for an incoming query-bearing request: normalise
    // the URL minus its leading slash, then strip the query string.
    const incomingUrl = `${deepLinkRoutePath}?${PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER}=${crypto.randomUUID()}`;
    const dispatchedRouteKey = path.normalize(incomingUrl.substring(1)).split("?")[0].replace(/^\/+/, "");

    assert(deepLinkRoutePath.startsWith("/"), "the deep-link route is an absolute path");
    assert(deepLinkRoutePath.length > 1, "the deep-link route is not the bare root (which 404s once a query string is appended)");
    assert
    (
        registeredRouteKey === dispatchedRouteKey,
        `a query-bearing request resolves to the registered route key ("${registeredRouteKey}")`
    );

    // The failing shape, asserted explicitly so the reason this route exists
    // cannot be forgotten and quietly undone.
    const rootRegisteredKey = path.normalize("");
    const rootDispatchedKey = path.normalize("?id=x").split("?")[0].replace(/^\/+/, "");
    assert(rootRegisteredKey !== rootDispatchedKey, "the bare root genuinely mismatches for a query-bearing request (why this route is not \"/\")");
}

function verifyLegalAcceptanceAllowlist()
{
    section("Legal-acceptance allowlist");

    const legalAcceptanceSource = require("fs").readFileSync
    (
        path.join(currentDirectory, "Endpoints", "Plugins", "EnsureLegalAcceptance.js"),
        "utf8"
    );

    const deepLinkAllowlistEntry = `"${PaidDeckShareConstants.DEEP_LINK_ROUTE_PATH.toLowerCase()}"`;
    const detailsAllowlistEntry = `"${PaidDeckShareConstants.DETAILS_ENDPOINT_PATH.toLowerCase()}"`;

    // Without these, a user who still owes legal acceptance follows a scanned
    // link and receives a raw 403 JSON body in the address bar instead of the
    // app — and that is exactly the freshly-signed-up user the flow targets.
    assert(legalAcceptanceSource.includes(deepLinkAllowlistEntry), `the deep-link route ${deepLinkAllowlistEntry} is allowlisted`);
    assert(legalAcceptanceSource.includes(detailsAllowlistEntry), `the listing endpoint ${detailsAllowlistEntry} is allowlisted`);
}

async function verifyDetailsEndpointAgainstDatabase()
{
    section("GET /PaidDecks/Details against MongoDB");

    if (process.env.VERIFY_PAID_DECK_SHARE_DEEP_LINK_DATABASE !== "1")
    {
        skip("listing lookup round-trip (set VERIFY_PAID_DECK_SHARE_DEEP_LINK_DATABASE=1 to run)");
        return;
    }

    // This tier WRITES a throwaway listing, so it must never be pointed at
    // production. Dock only falls back to Dock/.env for the "local"
    // environment, but the explicit refusal makes that a guarantee rather than
    // an accident of file naming.
    const configuredEnvironmentName = String(process.env.COGNIUMLEARN_ENVIRONMENT || "local").trim().toLowerCase();
    if (configuredEnvironmentName === "production")
    {
        skip("listing lookup round-trip — refusing to run against production (COGNIUMLEARN_ENVIRONMENT=production)");
        return;
    }

    require("dotenv").config({ path: path.join(currentDirectory, ".local.env") });
    require("dotenv").config({ path: path.join(currentDirectory, ".env") });

    if (!process.env.MONGODB_URL)
    {
        skip("listing lookup round-trip — MONGODB_URL is not set in Dock/.local.env or Dock/.env");
        return;
    }

    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
    const { getPaidDeckDetails } = require("./Endpoints/PaidDeck/GetPaidDeckDetails");

    let database = null;
    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`listing lookup round-trip — database unreachable: ${connectionError.message}`);
        return;
    }

    if (!database)
    {
        skip("listing lookup round-trip — database unreachable");
        return;
    }

    const throwawayDeckId = crypto.randomUUID();

    try
    {
        await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .insertOne
            ({
                id: throwawayDeckId,
                title: "Verify share deep-link deck",
                description: "Throwaway listing created by VerifyPaidDeckShareDeepLink.mjs",
                category: "Verification",
                tags: [],
                basePriceMinor: 0,
                currency: "INR",
                keyVersion: 1,
                isPublished: true,
                publishedAt: 0,
                contentSummary: { contentVersion: 1, totalCards: 0, totalStudyMaterials: 0, totalMockTests: 0, treeSnapshot: [] }
            });

        const publishedResponse = createStubResponse();
        await getPaidDeckDetails(createStubRequest({ queryParameters: { deckId: throwawayDeckId } }), publishedResponse);

        assert(publishedResponse.statusCode === httpStatus.OK, "a published listing returns 200");
        assert(publishedResponse.jsonBody?.deck?.id === throwawayDeckId, "the response carries the requested deck");
        assert(publishedResponse.jsonBody?.deck?.computedPrice !== undefined, "the listing is price-enriched like a library row");
        assert(publishedResponse.jsonBody?.deck?._id === undefined, "the raw Mongo _id is stripped");
        assert(typeof publishedResponse.jsonBody?.region === "string", "the resolved region is returned alongside the deck");

        await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .updateOne({ id: throwawayDeckId }, { $set: { isPublished: false } });

        const unpublishedResponse = createStubResponse();
        await getPaidDeckDetails(createStubRequest({ queryParameters: { deckId: throwawayDeckId } }), unpublishedResponse);

        assert(unpublishedResponse.statusCode === httpStatus.NOT_FOUND, "an unpublished listing returns 404");
        assert(unpublishedResponse.jsonBody?.error === ErrorCodes.PAID_DECK_NOT_FOUND, "the unpublished response is PAID_DECK_NOT_FOUND");

        const unknownResponse = createStubResponse();
        await getPaidDeckDetails(createStubRequest({ queryParameters: { deckId: crypto.randomUUID() } }), unknownResponse);

        assert(unknownResponse.statusCode === httpStatus.NOT_FOUND, "an unknown deck ID returns 404");
        // Identical, deliberately: distinguishing "no such deck" from "still a
        // draft" would turn this public route into an enumeration oracle for
        // unpublished deck IDs.
        assert
        (
            JSON.stringify(unknownResponse.jsonBody) === JSON.stringify(unpublishedResponse.jsonBody),
            "an unknown deck and an unpublished deck are indistinguishable in the response"
        );

        const malformedResponse = createStubResponse();
        await getPaidDeckDetails(createStubRequest({ queryParameters: { deckId: "../../etc/passwd" } }), malformedResponse);

        assert(malformedResponse.statusCode === httpStatus.BAD_REQUEST, "a malformed deck ID returns 400");
        assert(malformedResponse.jsonBody?.error === ErrorCodes.INVALID_DECK_ID, "the malformed response is INVALID_DECK_ID");

        const missingResponse = createStubResponse();
        await getPaidDeckDetails(createStubRequest({ queryParameters: {} }), missingResponse);
        assert(missingResponse.statusCode === httpStatus.BAD_REQUEST, "a missing deckId returns 400 without touching the database");
    }
    finally
    {
        try
        {
            await database.collection(DatabaseConstants.PAID_DECKS_COLLECTION).deleteOne({ id: throwawayDeckId });
        }
        catch (cleanupError)
        {
            console.error("Cleanup failed; a throwaway listing may remain:", cleanupError);
        }

        try
        {
            // DatabaseConnector exposes no close(); the client it holds does.
            await DatabaseConnector.getMongoClient()?.close();
        }
        catch (closeError)
        {
            // Nothing to do — the process is about to exit.
        }
    }
}

async function main()
{
    verifyDeckIdPredicate();
    verifyResumeLocationCannotLeaveThisOrigin();
    verifyCookieAttributes();
    await verifyCaptureAndTakeBehaviour();
    verifyRouteShapeSurvivesPacketronNormalisation();
    verifyLegalAcceptanceAllowlist();
    await verifyDetailsEndpointAgainstDatabase();

    console.log("\n=== Summary ===");
    console.log(`  passed:  ${passedCount}`);
    console.log(`  failed:  ${failedCount}`);
    console.log(`  skipped: ${skippedCount}`);

    process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((fatalError) =>
{
    console.error("Verification harness crashed:", fatalError);
    process.exit(1);
});
