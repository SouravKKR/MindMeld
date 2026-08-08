// Deterministic unit tests for the Dock security / model utility functions.
// No server or database connection is needed -- only the catalogued pure
// functions are exercised. Run with:
//   node Common/Testing/Dock/run_dock_unit_tests.js
// Writes its result JSON to $RESULT_FILE or Common/Reports/.results/dock-unit.json.

const path = require("path");
const crypto = require("crypto");
const { Harness, writeSkipped, assert, assertEqual } = require("./_harness");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOCK_ROOT = path.join(REPOSITORY_ROOT, "Dock");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "dock-unit.json");

// Load Dock's environment BEFORE any Dock module is required.
//
// None of these tests touch a network or a database, but some of the modules
// they pull in build their clients in a STATIC initializer — Persistence
// constructs an S3Client at load time, and derives its region from
// LINODE_S3_ENDPOINT_HOSTNAMES. With no env loaded that is undefined, the S3
// client throws "Region is missing" during require, and the whole suite reported
// itself as SKIPPED. It looked like a missing AWS credential; it was only ever a
// missing dotenv call, and it silently cost the suite every one of its 92 tests.
//
// Failure here is deliberately non-fatal: a checkout with no Dock/.env (CI, a
// fresh clone) falls through to the existing skip path rather than crashing.
try
{
    require(path.join(DOCK_ROOT, "node_modules", "dotenv")).config({ path: path.join(DOCK_ROOT, ".env") });
}
catch (environmentLoadError)
{
    console.warn(`[run_dock_unit_tests] Could not load Dock/.env (${environmentLoadError.message}); continuing with the ambient environment.`);
}

const CATEGORY = "Utility Functions (Node)";
const CATALOGUED = [
    "derivePaidDeckPasswordKek", "computePaidDeckPasswordHash",
    "safeEqualPaidDeckPasswordHash", "generatePaidDeckPasswordSaltBase64",
    "isLicenseActive", "isEncryptedField", "encryptEntityContent",
    "restorePlaintextContent",
    "LicenseClientView.sanitize", "LicenseClientView.sanitizeMany",
    "PaidDeckEntityTooLargeError", "RateLimiter.consume",
    "MaintenanceWindow.isActiveAt", "MaintenanceWindow.isUpcomingWithin",
    "MaintenanceWindow.toJson", "MaintenanceWindow.fromJson",
    "CreditDealPayment.roundTrip", "CreditDealPayment.coercion",
    "PeriodicCreditAssignment.roundTrip", "PeriodicCreditAssignment.coercion",
    "LogFormatter.formatLine", "LogFormatter.severityName", "LogFormatter.renderHtmlLine",
    "DownloadLogs.splitEntries",
    "LicenseExpiryResolver.resolve", "LicenseExpiryResolver.isGrantable",
    "LicenseDurationConfigurationResolver.resolve", "LicenseDurationConfigurationResolver.isImplicitFallback",
    "LicenseFieldPreserver.carryForwardBuyerScopedFields",
    "Sync.PAID_PROTECTED_TYPE_COLLECTIONS",
    "PaidDeckContentFingerprint.compute", "PaidDeckContentUpdatePlanner.plan",
    "LicenseContentVersionResolver.resolveDownloadedVersion", "LicenseContentVersionResolver.isUpdateAvailable",
    "SyncPayloadValidator.isValidId", "SyncPayloadValidator.isValidDeviceId",
    "SyncPayloadValidator.sanitizeChanges", "SyncPayloadValidator.sanitizeLastSync",
    "AiGeneratedDeckFields.isMarked", "AiGeneratedFieldPreserver.restoreMarker",
    "CreditConfiguration.ensureGenerationTaskRules", "PaidDeckGenerationGate.validateSourceTypes",
];

// The Dock modules resolve their own dependencies against Dock/node_modules, so
// load failures (missing driver, etc.) are reported as a skip, never a crash.
let KeyManagementService;
let PaidDeckSyncCrypto;
let LicenseClientView;
let PaidDeckEntityTooLargeError;
let RateLimiter;
let MaintenanceWindow;
let CreditDealPayment;
let PeriodicCreditAssignment;
let deckLicenseStatuses;
let entityTypes;
let creditDealPaymentStatuses;
let periodicAssignmentStatuses;
let LogFormatter;
let splitEntries;
let logLevel;
let LicenseExpiryResolver;
let LicenseDurationConfigurationResolver;
let LicenseFieldPreserver;
let DeckLicense;
let PAID_PROTECTED_TYPE_COLLECTIONS;
let PaidDeckContentFingerprint;
let PaidDeckContentUpdatePlanner;
let LicenseContentVersionResolver;
let SyncPayloadValidator;
let AiGeneratedDeckFields;
let AiGeneratedFieldPreserver;
let CreditConfiguration;
let PaidDeckGenerationGate;
let informationSourceTypes;
let curriculumPlausibility;
let taskTypes;
try
{
    KeyManagementService = require(path.join(DOCK_ROOT, "Globals/Classes/Security/KeyManagementService"));
    PaidDeckSyncCrypto = require(path.join(DOCK_ROOT, "Globals/Classes/Security/PaidDeckSyncCrypto"));
    LicenseClientView = require(path.join(DOCK_ROOT, "Globals/Classes/Security/LicenseClientView"));
    PaidDeckEntityTooLargeError = require(path.join(DOCK_ROOT, "Globals/Classes/Security/PaidDeckEntityTooLargeError"));
    RateLimiter = require(path.join(DOCK_ROOT, "Globals/Classes/Security/RateLimiter"));
    MaintenanceWindow = require(path.join(DOCK_ROOT, "Globals/Model/MaintenanceWindow"));
    CreditDealPayment = require(path.join(DOCK_ROOT, "Globals/Model/CreditDealPayment"));
    PeriodicCreditAssignment = require(path.join(DOCK_ROOT, "Globals/Model/PeriodicCreditAssignment"));
    ({ deckLicenseStatuses } = require(path.join(DOCK_ROOT, "Globals/Enumerations/DeckLicenseStatuses")));
    ({ entityTypes } = require(path.join(DOCK_ROOT, "Globals/Enumerations/EntityTypes")));
    ({ creditDealPaymentStatuses } = require(path.join(DOCK_ROOT, "Globals/Enumerations/CreditDealPaymentStatuses")));
    ({ periodicAssignmentStatuses } = require(path.join(DOCK_ROOT, "Globals/Enumerations/PeriodicAssignmentStatuses")));
    LogFormatter = require(path.join(DOCK_ROOT, "Globals/Classes/Logging/LogFormatter"));
    ({ splitEntries } = require(path.join(DOCK_ROOT, "Endpoints/Admin/Logs/DownloadLogs")));
    ({ logLevel } = require(path.join(DOCK_ROOT, "Globals/Enumerations/LogLevel")));
    LicenseExpiryResolver = require(path.join(DOCK_ROOT, "Globals/Classes/Pricing/LicenseExpiryResolver"));
    LicenseDurationConfigurationResolver = require(path.join(DOCK_ROOT, "Globals/Classes/Pricing/LicenseDurationConfigurationResolver"));
    LicenseFieldPreserver = require(path.join(DOCK_ROOT, "Globals/Classes/Security/LicenseFieldPreserver"));
    DeckLicense = require(path.join(DOCK_ROOT, "Globals/Model/DeckLicense"));
    ({ PAID_PROTECTED_TYPE_COLLECTIONS } = require(path.join(DOCK_ROOT, "Endpoints/Sync/Sync")));
    PaidDeckContentFingerprint = require(path.join(DOCK_ROOT, "Globals/Classes/PaidDeck/PaidDeckContentFingerprint"));
    PaidDeckContentUpdatePlanner = require(path.join(DOCK_ROOT, "Globals/Classes/PaidDeck/PaidDeckContentUpdatePlanner"));
    LicenseContentVersionResolver = require(path.join(DOCK_ROOT, "Globals/Classes/PaidDeck/LicenseContentVersionResolver"));
    SyncPayloadValidator = require(path.join(DOCK_ROOT, "Globals/Classes/Sync/SyncPayloadValidator"));
    AiGeneratedDeckFields = require(path.join(DOCK_ROOT, "Globals/Classes/Security/AiGeneratedDeckFields"));
    AiGeneratedFieldPreserver = require(path.join(DOCK_ROOT, "Globals/Classes/Security/AiGeneratedFieldPreserver"));
    CreditConfiguration = require(path.join(DOCK_ROOT, "Globals/Classes/Credits/CreditConfiguration"));
    PaidDeckGenerationGate = require(path.join(DOCK_ROOT, "Globals/Classes/Generation/PaidDeckGenerationGate"));
    ({ informationSourceTypes } = require(path.join(DOCK_ROOT, "Globals/Enumerations/InformationSourceTypes")));
    ({ curriculumPlausibility } = require(path.join(DOCK_ROOT, "Globals/Enumerations/CurriculumPlausibility")));
    ({ taskTypes } = require(path.join(DOCK_ROOT, "Globals/Enumerations/TaskTypes")));
}
catch (error)
{
    writeSkipped("Dock", CATEGORY, `Could not load Dock modules: ${error.message}`, RESULT_FILE);
    process.exit(0);
}

const harness = new Harness("Dock", CATEGORY, CATALOGUED);

function fakeLicense(status, expiresAt)
{
    return { getStatus: () => status, getExpiresAt: () => expiresAt };
}

// -- Password key derivation --------------------------------------------------

harness.test("derivePaidDeckPasswordKek: deterministic for same password+salt", "derivePaidDeckPasswordKek", () =>
{
    const salt = KeyManagementService.generatePaidDeckPasswordSaltBase64();
    const first = KeyManagementService.derivePaidDeckPasswordKek("correct horse", salt);
    const second = KeyManagementService.derivePaidDeckPasswordKek("correct horse", salt);
    assertEqual(first.length, 32, "KEK length");
    assert(Buffer.compare(first, second) === 0, "same input must derive identical KEK");
});

harness.test("derivePaidDeckPasswordKek: salt-sensitive", "derivePaidDeckPasswordKek", () =>
{
    const kekA = KeyManagementService.derivePaidDeckPasswordKek("pw", KeyManagementService.generatePaidDeckPasswordSaltBase64());
    const kekB = KeyManagementService.derivePaidDeckPasswordKek("pw", KeyManagementService.generatePaidDeckPasswordSaltBase64());
    assert(Buffer.compare(kekA, kekB) !== 0, "different salts must derive different KEKs");
});

// -- Password verification hash ----------------------------------------------

harness.test("computePaidDeckPasswordHash: deterministic and verifies", "computePaidDeckPasswordHash", () =>
{
    const salt = KeyManagementService.generatePaidDeckPasswordSaltBase64();
    const stored = KeyManagementService.computePaidDeckPasswordHash("hunter2", salt);
    const submitted = KeyManagementService.computePaidDeckPasswordHash("hunter2", salt);
    assert(KeyManagementService.safeEqualPaidDeckPasswordHash(submitted, stored), "correct password must verify");
});

harness.test("computePaidDeckPasswordHash: wrong password fails compare", "computePaidDeckPasswordHash", () =>
{
    const salt = KeyManagementService.generatePaidDeckPasswordSaltBase64();
    const stored = KeyManagementService.computePaidDeckPasswordHash("hunter2", salt);
    const wrong = KeyManagementService.computePaidDeckPasswordHash("wrong", salt);
    assert(!KeyManagementService.safeEqualPaidDeckPasswordHash(wrong, stored), "wrong password must not verify");
});

// -- safeEqual ----------------------------------------------------------------

harness.test("safeEqualPaidDeckPasswordHash: malformed input returns false (no throw)", "safeEqualPaidDeckPasswordHash", () =>
{
    assertEqual(KeyManagementService.safeEqualPaidDeckPasswordHash(null, "abc"), false);
    assertEqual(KeyManagementService.safeEqualPaidDeckPasswordHash("abc", undefined), false);
    assertEqual(KeyManagementService.safeEqualPaidDeckPasswordHash("", ""), false);
    assertEqual(KeyManagementService.safeEqualPaidDeckPasswordHash("aa", "aaaa"), false);
});

// -- Salt generation ----------------------------------------------------------

harness.test("generatePaidDeckPasswordSaltBase64: fresh 16-byte salt", "generatePaidDeckPasswordSaltBase64", () =>
{
    const first = KeyManagementService.generatePaidDeckPasswordSaltBase64();
    const second = KeyManagementService.generatePaidDeckPasswordSaltBase64();
    assertEqual(Buffer.from(first, "base64").length, 16, "salt must decode to 16 bytes");
    assert(first !== second, "salts must be random");
});

// -- License activity ---------------------------------------------------------

harness.test("isLicenseActive: ACTIVE with no expiry -> true", "isLicenseActive", () =>
{
    assertEqual(KeyManagementService.isLicenseActive(fakeLicense(deckLicenseStatuses.ACTIVE, null)), true);
});

harness.test("isLicenseActive: ACTIVE with epoch-zero (FOREVER) -> true", "isLicenseActive", () =>
{
    assertEqual(KeyManagementService.isLicenseActive(fakeLicense(deckLicenseStatuses.ACTIVE, new Date(0))), true);
});

harness.test("isLicenseActive: ACTIVE with future expiry -> true", "isLicenseActive", () =>
{
    const future = new Date(Date.now() + 3600 * 1000);
    assertEqual(KeyManagementService.isLicenseActive(fakeLicense(deckLicenseStatuses.ACTIVE, future)), true);
});

harness.test("isLicenseActive: ACTIVE with past expiry -> false", "isLicenseActive", () =>
{
    const past = new Date(Date.now() - 3600 * 1000);
    assertEqual(KeyManagementService.isLicenseActive(fakeLicense(deckLicenseStatuses.ACTIVE, past)), false);
});

harness.test("isLicenseActive: non-ACTIVE status -> false; null -> false", "isLicenseActive", () =>
{
    const someInactive = Object.values(deckLicenseStatuses).find(value => value !== deckLicenseStatuses.ACTIVE);
    assertEqual(KeyManagementService.isLicenseActive(fakeLicense(someInactive, null)), false);
    assertEqual(KeyManagementService.isLicenseActive(null), false);
});

// -- Encrypted-field detection ------------------------------------------------

harness.test("isEncryptedField: recognizes the envelope, rejects others", "isEncryptedField", () =>
{
    assertEqual(PaidDeckSyncCrypto.isEncryptedField({ __enc: 1, ivBase64: "x", ciphertextBase64: "y" }), true);
    assertEqual(PaidDeckSyncCrypto.isEncryptedField("plain string"), false);
    assertEqual(PaidDeckSyncCrypto.isEncryptedField(null), false);
    assertEqual(PaidDeckSyncCrypto.isEncryptedField({ __enc: 1, ivBase64: "x" }), false);
});

// -- Entity content encryption ------------------------------------------------

harness.test("encryptEntityContent: a content overlay passes through untouched", "encryptEntityContent", () =>
{
    // An overlay's `value` is ALREADY a ciphertext envelope, written by the
    // client under the same deck key. The pull hands every paid entity to this
    // function, so the correct behaviour for an overlay is to return an
    // unmodified clone — adding a CONTENT_OVERLAY branch here would
    // double-encrypt it and the learner's edit would never decrypt again.
    const contentKey = crypto.randomBytes(32);
    const overlay =
    {
        id: "card-1::1",
        deckId: "deck-1",
        targetEntityId: "card-1",
        fieldKey: 1,
        value: { __enc: 1, ivBase64: "aXY=", ciphertextBase64: "Y3Q=" }
    };

    const passedThrough = PaidDeckSyncCrypto.encryptEntityContent(entityTypes.CONTENT_OVERLAY, overlay, contentKey);

    assertEqual(passedThrough.value.ciphertextBase64, "Y3Q=", "the envelope must not be re-encrypted");
    assertEqual(passedThrough.value.ivBase64, "aXY=");
    assertEqual(passedThrough.targetEntityId, "card-1");
    assert(passedThrough !== overlay, "a clone is returned, never the caller's object");
});

harness.test("encryptEntityContent: encrypts card content, leaves metadata, no mutation", "encryptEntityContent", () =>
{
    const contentKey = crypto.randomBytes(32);
    const card = { id: "card-1", question: "What is FSRS?", answer: "A scheduler", tags: ["x"], progress: { history: [] } };
    const encrypted = PaidDeckSyncCrypto.encryptEntityContent(entityTypes.CARD, card, contentKey);

    assert(PaidDeckSyncCrypto.isEncryptedField(encrypted.question), "question must be encrypted");
    assert(PaidDeckSyncCrypto.isEncryptedField(encrypted.answer), "answer must be encrypted");
    assertEqual(encrypted.id, "card-1", "id stays plaintext");
    assert(Array.isArray(encrypted.tags), "tags stay plaintext");
    // Source object is untouched.
    assertEqual(card.question, "What is FSRS?", "source object must not be mutated");
});

// -- Restore plaintext on push ------------------------------------------------

harness.test("restorePlaintextContent: server plaintext overrides incoming", "restorePlaintextContent", () =>
{
    const incoming = { id: "card-1", question: { __enc: 1, ivBase64: "a", ciphertextBase64: "b" }, answer: "tampered", progress: { reps: 5 } };
    const existing = { id: "card-1", question: "Authoritative Q", answer: "Authoritative A" };
    const restored = PaidDeckSyncCrypto.restorePlaintextContent(entityTypes.CARD, incoming, existing);

    assertEqual(restored.question, "Authoritative Q", "question restored from server");
    assertEqual(restored.answer, "Authoritative A", "answer restored from server");
    assertEqual(restored.progress.reps, 5, "progress from the push survives");
});

// -- LicenseClientView: strip secret key material -----------------------------

harness.test("LicenseClientView.sanitize: removes _id and every secret field, keeps the rest", "LicenseClientView.sanitize", () =>
{
    const license = {
        _id: "mongo-oid", id: "lic-1", userId: "u1", deckId: "d1", status: 1,
        wrappedKeyBlob: "secret", passwordHash: "h", passwordSalt: "s",
        passwordWrappedContentKeyBase64: "a", passwordWrappedIvBase64: "b",
        serverWrappedContentKeyBase64: "c", serverWrappedIvBase64: "d",
    };
    const safe = LicenseClientView.sanitize(license);
    assertEqual(safe._id, undefined, "_id removed");
    for (const secret of LicenseClientView.SECRET_FIELDS)
    {
        assertEqual(safe[secret], undefined, `${secret} removed`);
    }
    assertEqual(safe.id, "lic-1", "public id kept");
    assertEqual(safe.deckId, "d1", "deckId kept");
    assertEqual(safe.status, 1, "status kept");
    assertEqual(license.wrappedKeyBlob, "secret", "source object not mutated");
});

harness.test("LicenseClientView.sanitize: null / non-object passes through unchanged", "LicenseClientView.sanitize", () =>
{
    assertEqual(LicenseClientView.sanitize(null), null);
    assertEqual(LicenseClientView.sanitize("not-an-object"), "not-an-object");
});

harness.test("LicenseClientView.sanitizeMany: maps sanitize; non-array -> []", "LicenseClientView.sanitizeMany", () =>
{
    const result = LicenseClientView.sanitizeMany([{ id: "1", passwordHash: "x" }, { id: "2", wrappedKeyBlob: "y" }]);
    assertEqual(result.length, 2);
    assertEqual(result[0].passwordHash, undefined, "secret stripped from element 0");
    assertEqual(result[1].wrappedKeyBlob, undefined, "secret stripped from element 1");
    assertEqual(result[0].id, "1");
    assert(Array.isArray(LicenseClientView.sanitizeMany(null)) && LicenseClientView.sanitizeMany(null).length === 0, "null -> []");
    assertEqual(LicenseClientView.sanitizeMany("nope").length, 0, "non-array -> []");
});

// -- PaidDeckEntityTooLargeError ----------------------------------------------

harness.test("PaidDeckEntityTooLargeError: carries name, entityId, sizeBytes and a descriptive message", "PaidDeckEntityTooLargeError", () =>
{
    const error = new PaidDeckEntityTooLargeError("card-9", 20000000);
    assert(error instanceof Error, "is an Error");
    assertEqual(error.name, "PaidDeckEntityTooLargeError");
    assertEqual(error.entityId, "card-9");
    assertEqual(error.sizeBytes, 20000000);
    assert(error.message.includes("card-9") && error.message.includes("20000000"), "message names the entity and size");
});

// -- RateLimiter.consume (fixed-window counter) -------------------------------

harness.test("RateLimiter.consume: allows up to the limit then rejects, remaining never negative", "RateLimiter.consume", () =>
{
    // A 1-hour window keeps all synchronous calls inside the same bucket.
    const limiter = new RateLimiter(3, 60 * 60 * 1000);
    const first = limiter.consume("user:a");
    assertEqual(first.allowed, true);
    assertEqual(first.limit, 3);
    assertEqual(first.remaining, 2);
    assertEqual(first.retryAfterSeconds, 0);
    assertEqual(limiter.consume("user:a").remaining, 1);
    assertEqual(limiter.consume("user:a").remaining, 0);
    const fourth = limiter.consume("user:a");
    assertEqual(fourth.allowed, false, "4th request over the limit of 3");
    assertEqual(fourth.remaining, 0, "remaining clamped at 0");
    assert(fourth.retryAfterSeconds >= 1, "retryAfterSeconds is at least 1 once throttled");
});

harness.test("RateLimiter.consume: keys are throttled independently", "RateLimiter.consume", () =>
{
    const limiter = new RateLimiter(1, 60 * 60 * 1000);
    assertEqual(limiter.consume("user:x").allowed, true);
    assertEqual(limiter.consume("user:x").allowed, false, "second hit on x is throttled");
    assertEqual(limiter.consume("user:y").allowed, true, "y has its own independent bucket");
});

// -- MaintenanceWindow (pure date logic + serialization) ----------------------

function makeWindow(startIso, endIso)
{
    return new MaintenanceWindow({ id: "win-1", startDate: startIso, endDate: endIso, title: "Upgrade", message: "Back soon", createdBy: "admin" });
}

harness.test("MaintenanceWindow.isActiveAt: inclusive start, exclusive end, false outside", "MaintenanceWindow.isActiveAt", () =>
{
    const window = makeWindow("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    assertEqual(window.isActiveAt(new Date("2026-01-01T00:00:00.000Z")), true, "inclusive start");
    assertEqual(window.isActiveAt(new Date("2026-01-01T12:00:00.000Z")), true, "within range");
    assertEqual(window.isActiveAt(new Date("2026-01-02T00:00:00.000Z")), false, "exclusive end");
    assertEqual(window.isActiveAt(new Date("2025-12-31T23:59:59.000Z")), false, "before start");
});

harness.test("MaintenanceWindow.isActiveAt: a window with no/invalid dates is never active", "MaintenanceWindow.isActiveAt", () =>
{
    const window = new MaintenanceWindow({ startDate: "not-a-date", endDate: null });
    assertEqual(window.isActiveAt(new Date("2026-01-01T00:00:00.000Z")), false);
});

harness.test("MaintenanceWindow.isUpcomingWithin: start in the future and within the lead window", "MaintenanceWindow.isUpcomingWithin", () =>
{
    const window = makeWindow("2026-01-01T01:00:00.000Z", "2026-01-01T02:00:00.000Z");
    const now = new Date("2026-01-01T00:30:00.000Z");          // 30 minutes before start
    assertEqual(window.isUpcomingWithin(now, 60 * 60 * 1000), true, "30min start is within a 60min lead");
    assertEqual(window.isUpcomingWithin(now, 10 * 60 * 1000), false, "30min start exceeds a 10min lead");
    assertEqual(window.isUpcomingWithin(new Date("2026-01-01T01:30:00.000Z"), 60 * 60 * 1000), false, "already started -> not upcoming");
});

harness.test("MaintenanceWindow.toJson / fromJson: round-trip preserves the fields", "MaintenanceWindow.toJson", () =>
{
    const window = makeWindow("2026-03-01T00:00:00.000Z", "2026-03-01T03:00:00.000Z");
    const json = window.toJson();
    assertEqual(json.id, "win-1");
    assertEqual(json.startDate, "2026-03-01T00:00:00.000Z");
    assertEqual(json.endDate, "2026-03-01T03:00:00.000Z");
    assertEqual(json.title, "Upgrade");
    const restored = MaintenanceWindow.fromJson(json);
    assertEqual(restored.getId(), "win-1");
    assertEqual(restored.getStartDate().toISOString(), "2026-03-01T00:00:00.000Z");
    assertEqual(restored.isActiveAt(new Date("2026-03-01T01:00:00.000Z")), true, "restored window still computes activity");
});

harness.test("MaintenanceWindow.fromJson: null input returns null", "MaintenanceWindow.fromJson", () =>
{
    assertEqual(MaintenanceWindow.fromJson(null), null);
});

// -- CreditDealPayment (credit-ledger payment record) -------------------------
// Unlike the random-UUID models excluded from this catalog, fromJson restores
// the stored id (via _restoreId_id), so a fromJson(toJson()) round-trip IS
// bit-for-bit deterministic and the money-field coercion is worth asserting.

function fullDealPaymentJson()
{
    return {
        id: "cdp-1",
        targetType: Object.values(require(path.join(DOCK_ROOT, "Globals/Enumerations/CreditDealTargetTypes")).creditDealTargetTypes)[0],
        targetId: "org-9",
        label: "Q1 enterprise deal",
        mode: Object.values(require(path.join(DOCK_ROOT, "Globals/Enumerations/CreditDealPaymentModes")).creditDealPaymentModes)[0],
        status: Object.values(creditDealPaymentStatuses)[0],
        amountMinor: 500000,
        currency: "INR",
        paymentProvider: Object.values(require(path.join(DOCK_ROOT, "Globals/Enumerations/PaymentProviders")).paymentProviders)[0],
        providerOrderId: "order_abc",
        providerPaymentId: "pay_abc",
        invoiceFileName: "invoice.pdf",
        invoiceMimeType: "application/pdf",
        invoiceBucketPath: "deals/cdp-1/invoice.pdf",
        invoiceSizeBytes: 20480,
        invoiceUploadedAt: "2026-03-01T00:00:00.000Z",
        hasInvoice: true,
        createdByUserId: "admin-1",
        createdAt: "2026-02-01T00:00:00.000Z",
        additionalData: { note: "negotiated" },
    };
}

harness.test("CreditDealPayment: fromJson(toJson()) round-trip preserves id and every field", "CreditDealPayment.roundTrip", () =>
{
    const original = CreditDealPayment.fromJson(fullDealPaymentJson());
    const restored = CreditDealPayment.fromJson(original.toJson());
    assertEqual(restored.getId(), "cdp-1", "stored id is restored, not regenerated");
    assertEqual(JSON.stringify(restored.toJson()), JSON.stringify(original.toJson()), "round-trip is stable");
});

harness.test("CreditDealPayment: amountMinor coercion clamps negatives and parses to an integer", "CreditDealPayment.coercion", () =>
{
    assertEqual(new CreditDealPayment({ amountMinor: -100 }).getAmountMinor(), 0, "negative -> 0");
    assertEqual(new CreditDealPayment({ amountMinor: "abc" }).getAmountMinor(), 0, "non-numeric -> 0");
    assertEqual(new CreditDealPayment({ amountMinor: "150.9" }).getAmountMinor(), 150, "string float -> integer minor units");
});

harness.test("CreditDealPayment: currency truncates to 8 chars and status coerces an invalid enum", "CreditDealPayment.coercion", () =>
{
    assertEqual(new CreditDealPayment({ currency: "TOOLONGCURRENCY" }).getCurrency(), "TOOLONGC", "currency capped at 8");
    const coercedStatus = new CreditDealPayment({ status: 9999 }).getStatus();
    assert(Object.values(creditDealPaymentStatuses).includes(coercedStatus), "out-of-range status falls back to a valid enum member");
    assertEqual(coercedStatus, Object.values(creditDealPaymentStatuses)[0], "invalid enum coerces to the first member");
});

// -- PeriodicCreditAssignment (recurring credit grant rule) -------------------

function fullPeriodicJson()
{
    return {
        id: "pca-1",
        name: "Weekly team top-up",
        scopeType: Object.values(require(path.join(DOCK_ROOT, "Globals/Enumerations/PeriodicScopeTypes")).periodicScopeTypes)[0],
        organizationId: "org-9",
        peopleEmails: ["a@example.com", "b@example.com"],
        amount: 50,
        amountMode: Object.values(require(path.join(DOCK_ROOT, "Globals/Enumerations/CreditGrantAmountModes")).creditGrantAmountModes)[0],
        scheduleType: Object.values(require(path.join(DOCK_ROOT, "Globals/Enumerations/PeriodicScheduleTypes")).periodicScheduleTypes)[0],
        intervalDays: 7,
        dayOfWeek: 1,
        dayOfMonth: 15,
        onJoinMode: Object.values(require(path.join(DOCK_ROOT, "Globals/Enumerations/PeriodicOnJoinModes")).periodicOnJoinModes)[0],
        startAt: "2026-03-01T00:00:00.000Z",
        hasValidUntil: true,
        validUntil: "2026-12-31T00:00:00.000Z",
        status: Object.values(periodicAssignmentStatuses)[0],
        terminatedAt: "2026-06-01T00:00:00.000Z",
        createdByUserId: "admin-1",
        createdAt: "2026-02-01T00:00:00.000Z",
        additionalData: { source: "console" },
    };
}

harness.test("PeriodicCreditAssignment: fromJson(toJson()) round-trip preserves id and every field", "PeriodicCreditAssignment.roundTrip", () =>
{
    const original = PeriodicCreditAssignment.fromJson(fullPeriodicJson());
    const restored = PeriodicCreditAssignment.fromJson(original.toJson());
    assertEqual(restored.getId(), "pca-1", "stored id is restored, not regenerated");
    assertEqual(JSON.stringify(restored.toJson()), JSON.stringify(original.toJson()), "round-trip is stable");
});

harness.test("PeriodicCreditAssignment: amount clamps negatives/NaN to 0 and name empties to null, truncates at 256", "PeriodicCreditAssignment.coercion", () =>
{
    assertEqual(new PeriodicCreditAssignment({ amount: -5 }).getAmount(), 0, "negative amount -> 0");
    assertEqual(new PeriodicCreditAssignment({ amount: "abc" }).getAmount(), 0, "non-numeric amount -> 0");
    assertEqual(new PeriodicCreditAssignment({ name: "" }).getName(), null, "empty name -> null");
    assertEqual(new PeriodicCreditAssignment({ name: "x".repeat(300) }).getName().length, 256, "name truncated to 256");
});

harness.test("PeriodicCreditAssignment: dayOfWeek clamps to [0,6], dayOfMonth to [1,31], intervalDays >= 0", "PeriodicCreditAssignment.coercion", () =>
{
    assertEqual(new PeriodicCreditAssignment({ dayOfWeek: 99 }).getDayOfWeek(), 6, "dayOfWeek upper-clamped to 6");
    assertEqual(new PeriodicCreditAssignment({ dayOfWeek: -3 }).getDayOfWeek(), 0, "dayOfWeek lower-clamped to 0");
    assertEqual(new PeriodicCreditAssignment({ dayOfMonth: 99 }).getDayOfMonth(), 31, "dayOfMonth upper-clamped to 31");
    assertEqual(new PeriodicCreditAssignment({ dayOfMonth: 0 }).getDayOfMonth(), 1, "dayOfMonth lower-clamped to 1");
    assertEqual(new PeriodicCreditAssignment({ intervalDays: -10 }).getIntervalDays(), 0, "intervalDays clamped to >= 0");
    const coercedStatus = new PeriodicCreditAssignment({ status: 9999 }).getStatus();
    assertEqual(coercedStatus, Object.values(periodicAssignmentStatuses)[0], "invalid status coerces to the first enum member");
});

// -- LogFormatter (central log line format + HTML escaping) -------------------

harness.test("LogFormatter.formatLine: exact <SEVERITY>:[iso]:<Title>: <message> format with extras", "LogFormatter.formatLine", () =>
{
    const line = LogFormatter.formatLine({ level: logLevel.ERROR, title: "AI_ASK", message: "hello", timestampIsoString: "2026-07-05T14:32:10.123456Z", accountId: "u1", errorCode: "X" });
    assertEqual(line, 'ERROR:[2026-07-05T14:32:10.123456Z]:AI_ASK: hello {"accountId":"u1","errorCode":"X"}');
});

harness.test("LogFormatter.formatLine: no trailing extras object when none present", "LogFormatter.formatLine", () =>
{
    const line = LogFormatter.formatLine({ level: logLevel.INFO, title: "LOGIN", message: "ok", timestampIsoString: "2026-07-05T00:00:00.000Z" });
    assertEqual(line, "INFO:[2026-07-05T00:00:00.000Z]:LOGIN: ok");
});

harness.test("LogFormatter.severityName: maps every level; unknown -> INFO", "LogFormatter.severityName", () =>
{
    assertEqual(LogFormatter.severityName(logLevel.DEBUG), "DEBUG");
    assertEqual(LogFormatter.severityName(logLevel.WARNING), "WARNING");
    assertEqual(LogFormatter.severityName(9999), "INFO");
});

harness.test("LogFormatter.renderHtmlLine: escapes markup so log content cannot break the document", "LogFormatter.renderHtmlLine", () =>
{
    const html = LogFormatter.renderHtmlLine({ level: logLevel.ERROR, title: "T", message: "<script>alert(1)</script>", timestampIsoString: "2026-07-05T00:00:00.000Z" });
    assert(html.includes("log-level-error"), "carries the severity class for colouring");
    assert(!html.includes("<script>"), "raw markup must be escaped");
    assert(html.includes("&lt;script&gt;"), "escaped form present");
});

// -- DownloadLogs.splitEntries (download splitting boundaries) -----------------

function logEntryAt(isoString)
{
    return { level: logLevel.INFO, title: "T", message: "m", timestamp: isoString, timestampIsoString: isoString, sequence: 0 };
}

harness.test("splitEntries: 'none' returns a single segment with all entries", "DownloadLogs.splitEntries", () =>
{
    const segments = splitEntries([logEntryAt("2026-07-05T00:00:00.000Z"), logEntryAt("2026-07-05T05:00:00.000Z")], "none");
    assertEqual(segments.length, 1);
    assertEqual(segments[0].entries.length, 2);
});

harness.test("splitEntries: 'lines:1' produces one segment per entry", "DownloadLogs.splitEntries", () =>
{
    const segments = splitEntries([logEntryAt("2026-07-05T00:00:00.000Z"), logEntryAt("2026-07-05T01:00:00.000Z"), logEntryAt("2026-07-05T02:00:00.000Z")], "lines:1");
    assertEqual(segments.length, 3);
    assert(segments.every(segment => segment.entries.length === 1), "each split holds one line");
    assert(segments[0].name.startsWith("logs_part_1_"), "split name keeps the part number");
    assert(segments[0].name.includes("_to_"), "split name carries the covered date range");
});

harness.test("splitEntries: 'hours:1' buckets entries by hour window", "DownloadLogs.splitEntries", () =>
{
    const segments = splitEntries([logEntryAt("2026-07-05T00:10:00.000Z"), logEntryAt("2026-07-05T00:50:00.000Z"), logEntryAt("2026-07-05T02:05:00.000Z")], "hours:1");
    assertEqual(segments.length, 2, "two distinct hour buckets (00:00 and 02:00)");
    assertEqual(segments[0].entries.length, 2, "both 00:xx entries land in the first bucket");
    assertEqual(segments[1].entries.length, 1);
});

// -- LicenseExpiryResolver: explicit-duration semantics -----------------------

const FIXED_NOW = new Date("2026-07-12T00:00:00.000Z");

harness.test("LicenseExpiryResolver.resolve: positive durationDays -> FINITE at now + days", "LicenseExpiryResolver.resolve", () =>
{
    const resolution = LicenseExpiryResolver.resolve({ durationDays: 365, isPerpetual: false }, FIXED_NOW);
    assertEqual(resolution.status, LicenseExpiryResolver.STATUS_FINITE);
    assertEqual(resolution.expiresAt.getTime(), FIXED_NOW.getTime() + 365 * 86_400_000, "expiry is now + durationDays");
});

harness.test("LicenseExpiryResolver.resolve: durationDays wins over isPerpetual", "LicenseExpiryResolver.resolve", () =>
{
    const resolution = LicenseExpiryResolver.resolve({ durationDays: 30, isPerpetual: true }, FIXED_NOW);
    assertEqual(resolution.status, LicenseExpiryResolver.STATUS_FINITE, "a positive duration is never silently perpetual");
});

harness.test("LicenseExpiryResolver.resolve: isPerpetual true -> PERPETUAL (FOREVER sentinel)", "LicenseExpiryResolver.resolve", () =>
{
    const resolution = LicenseExpiryResolver.resolve({ durationDays: 0, isPerpetual: true }, FIXED_NOW);
    assertEqual(resolution.status, LicenseExpiryResolver.STATUS_PERPETUAL);
    assertEqual(resolution.expiresAt.getTime(), 0, "perpetual uses the epoch-zero FOREVER sentinel");
});

harness.test("LicenseExpiryResolver.resolve: neither set -> UNSPECIFIED (grant refused)", "LicenseExpiryResolver.resolve", () =>
{
    assertEqual(LicenseExpiryResolver.resolve({ durationDays: 0, isPerpetual: false }, FIXED_NOW).status, LicenseExpiryResolver.STATUS_UNSPECIFIED);
    assertEqual(LicenseExpiryResolver.resolve({}, FIXED_NOW).status, LicenseExpiryResolver.STATUS_UNSPECIFIED);
    assertEqual(LicenseExpiryResolver.resolve(undefined, FIXED_NOW).status, LicenseExpiryResolver.STATUS_UNSPECIFIED);
});

harness.test("LicenseExpiryResolver.resolve: non-integer / negative durationDays is not finite", "LicenseExpiryResolver.resolve", () =>
{
    assertEqual(LicenseExpiryResolver.resolve({ durationDays: -5, isPerpetual: false }, FIXED_NOW).status, LicenseExpiryResolver.STATUS_UNSPECIFIED);
    assertEqual(LicenseExpiryResolver.resolve({ durationDays: 1.5, isPerpetual: false }, FIXED_NOW).status, LicenseExpiryResolver.STATUS_UNSPECIFIED);
});

harness.test("LicenseExpiryResolver.isGrantable: true only for finite or explicit perpetual", "LicenseExpiryResolver.isGrantable", () =>
{
    assertEqual(LicenseExpiryResolver.isGrantable({ durationDays: 10 }, FIXED_NOW), true);
    assertEqual(LicenseExpiryResolver.isGrantable({ isPerpetual: true }, FIXED_NOW), true);
    assertEqual(LicenseExpiryResolver.isGrantable({ durationDays: 0, isPerpetual: false }, FIXED_NOW), false);
});

// -- LicenseDurationConfigurationResolver: which duration applies -------------

harness.test("LicenseDurationConfigurationResolver.resolve: an explicit regional row wins", "LicenseDurationConfigurationResolver.resolve", () =>
{
    const resolution = LicenseDurationConfigurationResolver.resolve({ durationDays: 90, isPerpetual: false }, { isPerpetual: true }, 49900);
    assertEqual(resolution.durationDays, 90, "the regional rental length is used");
    assertEqual(resolution.isPerpetual, false);
    assertEqual(resolution.durationSource, LicenseDurationConfigurationResolver.SOURCE_REGIONAL_PRICING);
});

harness.test("LicenseDurationConfigurationResolver.resolve: a blank regional row inherits the deck default", "LicenseDurationConfigurationResolver.resolve", () =>
{
    const resolution = LicenseDurationConfigurationResolver.resolve({ durationDays: 0, isPerpetual: false }, { durationDays: 0, isPerpetual: true }, 49900);
    assertEqual(resolution.isPerpetual, true, "the deck-level perpetual flag is inherited, not ignored");
    assertEqual(resolution.durationSource, LicenseDurationConfigurationResolver.SOURCE_DECK_DEFAULT);
});

harness.test("LicenseDurationConfigurationResolver.resolve: a free deck is perpetual with nothing configured", "LicenseDurationConfigurationResolver.resolve", () =>
{
    const resolution = LicenseDurationConfigurationResolver.resolve(null, { durationDays: 0, isPerpetual: false }, 0);
    assertEqual(resolution.isPerpetual, true, "a zero-price acquisition is never refused for a missing term");
    assertEqual(resolution.durationSource, LicenseDurationConfigurationResolver.SOURCE_FREE_IMPLICIT_PERPETUAL);
    assertEqual(LicenseExpiryResolver.isGrantable(resolution), true, "and it is grantable at the expiry gate");
});

harness.test("LicenseDurationConfigurationResolver.resolve: an unconfigured priced deck falls back to perpetual", "LicenseDurationConfigurationResolver.resolve", () =>
{
    delete process.env.PAID_DECK_REQUIRE_EXPLICIT_LICENSE_DURATION;

    const resolution = LicenseDurationConfigurationResolver.resolve(null, null, 49900);
    assertEqual(resolution.isPerpetual, true, "the legacy catalogue stays purchasable");
    assertEqual(resolution.durationSource, LicenseDurationConfigurationResolver.SOURCE_LEGACY_IMPLICIT_PERPETUAL);
    assertEqual(LicenseDurationConfigurationResolver.isImplicitFallback(resolution.durationSource), true, "and is reported as an implicit fallback");
});

harness.test("LicenseDurationConfigurationResolver.resolve: the strict flag refuses a priced deck but not a free one", "LicenseDurationConfigurationResolver.resolve", () =>
{
    process.env.PAID_DECK_REQUIRE_EXPLICIT_LICENSE_DURATION = "true";
    try
    {
        const pricedResolution = LicenseDurationConfigurationResolver.resolve(null, null, 49900);
        assertEqual(pricedResolution.durationSource, LicenseDurationConfigurationResolver.SOURCE_UNSPECIFIED);
        assertEqual(LicenseExpiryResolver.isGrantable(pricedResolution), false, "a priced deck with no term is refused");

        const freeResolution = LicenseDurationConfigurationResolver.resolve(null, null, 0);
        assertEqual(freeResolution.durationSource, LicenseDurationConfigurationResolver.SOURCE_FREE_IMPLICIT_PERPETUAL, "free decks are never gated by the flag");
    }
    finally
    {
        delete process.env.PAID_DECK_REQUIRE_EXPLICIT_LICENSE_DURATION;
    }
});

harness.test("LicenseDurationConfigurationResolver.resolve: malformed duration fields are normalized away", "LicenseDurationConfigurationResolver.resolve", () =>
{
    const resolution = LicenseDurationConfigurationResolver.resolve({ durationDays: 1.5, isPerpetual: "yes" }, { durationDays: 30, isPerpetual: false }, 49900);
    assertEqual(resolution.durationDays, 30, "a fractional regional window is not explicit, so the deck default applies");
    assertEqual(resolution.isPerpetual, false, "a truthy non-boolean never becomes perpetual");
});

harness.test("LicenseDurationConfigurationResolver.isImplicitFallback: only the implicit sources", "LicenseDurationConfigurationResolver.isImplicitFallback", () =>
{
    assertEqual(LicenseDurationConfigurationResolver.isImplicitFallback(LicenseDurationConfigurationResolver.SOURCE_REGIONAL_PRICING), false);
    assertEqual(LicenseDurationConfigurationResolver.isImplicitFallback(LicenseDurationConfigurationResolver.SOURCE_DECK_DEFAULT), false);
    assertEqual(LicenseDurationConfigurationResolver.isImplicitFallback(LicenseDurationConfigurationResolver.SOURCE_UNSPECIFIED), false);
    assertEqual(LicenseDurationConfigurationResolver.isImplicitFallback(undefined), false, "an org-perk entry carries no duration source");
    assertEqual(LicenseDurationConfigurationResolver.isImplicitFallback(LicenseDurationConfigurationResolver.SOURCE_FREE_IMPLICIT_PERPETUAL), true);
    assertEqual(LicenseDurationConfigurationResolver.isImplicitFallback(LicenseDurationConfigurationResolver.SOURCE_LEGACY_IMPLICIT_PERPETUAL), true);
});

// -- LicenseFieldPreserver: what a master-key rotation may NOT change ---------

// A license as it looks after a purchase, an UnlockSession and a second copy:
// every buyer-scoped field populated. issueLicenseForUser rebuilds none of
// these, and persistLicense writes the whole document, so any field the
// preserver misses is silently destroyed by the next rotation.
function buildFullyPopulatedLicenseDocument()
{
    return {
        userId: "user-1",
        deckId: "deck-1",
        status: 1,
        keyVersion: 3,
        wrappedKeyBlob: "{\"ivBase64\":\"old-iv\",\"ciphertextBase64\":\"old-blob\"}",
        issuedAt: new Date("2026-01-05T00:00:00.000Z"),
        rotatedAt: new Date("2026-05-01T00:00:00.000Z"),
        serverWrappedContentKeyBase64: "server-wrapped-content-key",
        serverWrappedIvBase64: "server-wrapped-iv",
        passwordWrappedContentKeyBase64: "password-wrapped-content-key",
        passwordWrappedIvBase64: "password-wrapped-iv",
        contentKeyVersion: 4,
        passwordHash: "stored-password-hash",
        passwordSalt: "stored-password-salt",
        downloadedContentVersion: 7,
        additionalData: { instances: [{ instanceId: "1", label: "Copy 1" }, { instanceId: "abc", label: "Copy 2" }] }
    };
}

harness.test("LicenseFieldPreserver.carryForwardBuyerScopedFields: the per-license content key survives a rotation", "LicenseFieldPreserver.carryForwardBuyerScopedFields", () =>
{
    const storedDocument = buildFullyPopulatedLicenseDocument();
    const reissued = new DeckLicense({ userId: "user-1", deckId: "deck-1", keyVersion: 4 });

    LicenseFieldPreserver.carryForwardBuyerScopedFields(reissued, storedDocument);

    assertEqual(reissued.getServerWrappedContentKeyBase64(), "server-wrapped-content-key", "without this the server resolves no content key and withholds every paid entity from the pull");
    assertEqual(reissued.getServerWrappedIvBase64(), "server-wrapped-iv");
    assertEqual(reissued.getPasswordWrappedContentKeyBase64(), "password-wrapped-content-key", "without this the buyer can never unlock the deck again");
    assertEqual(reissued.getPasswordWrappedIvBase64(), "password-wrapped-iv");
    assertEqual(reissued.getContentKeyVersion(), 4, "the content key is untouched by a master-key rotation, so its version must not move");
});

harness.test("LicenseFieldPreserver.carryForwardBuyerScopedFields: password material and seeded version survive", "LicenseFieldPreserver.carryForwardBuyerScopedFields", () =>
{
    const storedDocument = buildFullyPopulatedLicenseDocument();
    const reissued = new DeckLicense({ userId: "user-1", deckId: "deck-1", keyVersion: 4 });

    LicenseFieldPreserver.carryForwardBuyerScopedFields(reissued, storedDocument);

    assertEqual(reissued.getPasswordHash(), "stored-password-hash");
    assertEqual(reissued.getPasswordSalt(), "stored-password-salt");
    assertEqual(reissued.getDownloadedContentVersion(), 7, "the content version the buyer's copies were seeded from is not a rotation concern");
});

harness.test("LicenseFieldPreserver.carryForwardBuyerScopedFields: the manage-copies registry survives", "LicenseFieldPreserver.carryForwardBuyerScopedFields", () =>
{
    const storedDocument = buildFullyPopulatedLicenseDocument();
    const reissued = new DeckLicense({ userId: "user-1", deckId: "deck-1", keyVersion: 4 });

    LicenseFieldPreserver.carryForwardBuyerScopedFields(reissued, storedDocument);

    const carriedInstances = reissued.getAdditionalData().instances;
    assertEqual(Array.isArray(carriedInstances), true, "additionalData.instances is the copy registry — losing it orphans every extra copy");
    assertEqual(carriedInstances.length, 2);
    assertEqual(carriedInstances[1].instanceId, "abc");
});

harness.test("LicenseFieldPreserver.carryForwardBuyerScopedFields: the rotated fields are left alone", "LicenseFieldPreserver.carryForwardBuyerScopedFields", () =>
{
    const storedDocument = buildFullyPopulatedLicenseDocument();
    const reissued = new DeckLicense
    ({
        userId: "user-1",
        deckId: "deck-1",
        keyVersion: 4,
        wrappedKeyBlob: "{\"ivBase64\":\"new-iv\",\"ciphertextBase64\":\"new-blob\"}"
    });

    LicenseFieldPreserver.carryForwardBuyerScopedFields(reissued, storedDocument);

    assertEqual(reissued.getKeyVersion(), 4, "the new master key version is what the rotation exists to write");
    assertEqual(reissued.getWrappedKeyBlob().includes("new-blob"), true, "the freshly wrapped master key must not be reverted");
    assertEqual(reissued.getIssuedAt().getTime(), new Date("2026-01-05T00:00:00.000Z").getTime(), "a rotation is not a new grant — issuedAt stays at the acquisition date");
});

harness.test("LicenseFieldPreserver.carryForwardBuyerScopedFields: a legacy document with no buyer fields yields model defaults", "LicenseFieldPreserver.carryForwardBuyerScopedFields", () =>
{
    const reissued = new DeckLicense({ userId: "user-1", deckId: "deck-1", keyVersion: 2 });

    LicenseFieldPreserver.carryForwardBuyerScopedFields(reissued, { userId: "user-1", deckId: "deck-1" });

    assertEqual(reissued.getServerWrappedContentKeyBase64(), "", "an absent field becomes the model default, never undefined");
    assertEqual(reissued.getContentKeyVersion(), 0);
    assertEqual(reissued.getDownloadedContentVersion(), 0);
    assertEqual(typeof reissued.getAdditionalData(), "object");
});

harness.test("LicenseFieldPreserver.carryForwardBuyerScopedFields: a malformed additionalData becomes an empty object", "LicenseFieldPreserver.carryForwardBuyerScopedFields", () =>
{
    const reissuedFromString = new DeckLicense({ userId: "user-1", deckId: "deck-1" });
    LicenseFieldPreserver.carryForwardBuyerScopedFields(reissuedFromString, { additionalData: "not-an-object" });
    assertEqual(Object.keys(reissuedFromString.getAdditionalData()).length, 0);

    const reissuedFromArray = new DeckLicense({ userId: "user-1", deckId: "deck-1" });
    LicenseFieldPreserver.carryForwardBuyerScopedFields(reissuedFromArray, { additionalData: ["instances"] });
    assertEqual(Array.isArray(reissuedFromArray.getAdditionalData()), false, "an array would serialise into the document as a broken registry");
});

harness.test("LicenseFieldPreserver.carryForwardBuyerScopedFields: every preserved field is one persistLicense would overwrite", "LicenseFieldPreserver.carryForwardBuyerScopedFields", () =>
{
    // persistLicense writes `$set: license.toJson()`. This asserts the premise
    // that makes the preserver load-bearing: each buyer-scoped field really is
    // emitted by toJson, so a whole-document $set would clobber it. If someone
    // later narrows persistLicense to a targeted $set, this test still holds.
    const emittedJson = new DeckLicense({ userId: "user-1", deckId: "deck-1" }).toJson();
    const buyerScopedFieldNames =
    [
        "serverWrappedContentKeyBase64", "serverWrappedIvBase64",
        "passwordWrappedContentKeyBase64", "passwordWrappedIvBase64",
        "contentKeyVersion", "passwordHash", "passwordSalt",
        "downloadedContentVersion", "additionalData"
    ];

    for (const fieldName of buyerScopedFieldNames)
    {
        assert(Object.prototype.hasOwnProperty.call(emittedJson, fieldName), `toJson emits ${fieldName}, so a whole-document $set overwrites it`);
    }
});

// -- Sync: which entity types the server protects on push --------------------

harness.test("Sync.PAID_PROTECTED_TYPE_COLLECTIONS: content overlays are NOT server-protected", "Sync.PAID_PROTECTED_TYPE_COLLECTIONS", () =>
{
    // A protected type has its stored content overlaid back onto every incoming
    // push, so a client can never change it. A content overlay is the learner's
    // OWN edit to their own copy — adding it to this list would silently revert
    // every edit on the next sync, which is exactly the class of bug the
    // overlay feature exists to fix. This test is the tripwire.
    const protectedEntityTypes = PAID_PROTECTED_TYPE_COLLECTIONS.map(entry => entry.entityType);
    assertEqual(protectedEntityTypes.includes(entityTypes.CONTENT_OVERLAY), false, "an overlay is buyer-authored and must survive the push");
});

harness.test("Sync.PAID_PROTECTED_TYPE_COLLECTIONS: the seller-authored types stay protected", "Sync.PAID_PROTECTED_TYPE_COLLECTIONS", () =>
{
    const protectedEntityTypes = PAID_PROTECTED_TYPE_COLLECTIONS.map(entry => entry.entityType);
    for (const sellerAuthoredType of [entityTypes.DECK, entityTypes.CARD, entityTypes.STUDY_MATERIAL, entityTypes.MOCK_TEST])
    {
        assertEqual(protectedEntityTypes.includes(sellerAuthoredType), true, `entity type ${sellerAuthoredType} must stay server-protected`);
    }
});

// -- Paid-deck content updates -----------------------------------------------

harness.test("PaidDeckContentFingerprint.compute: identical content yields an identical fingerprint", "PaidDeckContentFingerprint.compute", () =>
{
    const firstCard = { id: "a", question: "What is FSRS?", answer: "A scheduler", progress: { history: [1] } };
    const secondCard = { id: "b", question: "What is FSRS?", answer: "A scheduler", progress: { history: [] } };
    assertEqual(PaidDeckContentFingerprint.compute(firstCard, "CARD"), PaidDeckContentFingerprint.compute(secondCard, "CARD"),
        "ids and progress must not affect the fingerprint - they differ between master and buyer copy");
});

harness.test("PaidDeckContentFingerprint.compute: changed content changes the fingerprint", "PaidDeckContentFingerprint.compute", () =>
{
    const before = PaidDeckContentFingerprint.compute({ question: "What is FSRS?", answer: "A scheduler" }, "CARD");
    const after = PaidDeckContentFingerprint.compute({ question: "What is FSRS?", answer: "A spaced-repetition scheduler" }, "CARD");
    assert(before !== after, "a real edit by the publisher must be detected");
});

harness.test("PaidDeckContentFingerprint.compute: whitespace reflow is not a content change", "PaidDeckContentFingerprint.compute", () =>
{
    const compact = PaidDeckContentFingerprint.compute({ question: "<p>What is FSRS?</p>", answer: "<p>A scheduler</p>" }, "CARD");
    const reflowed = PaidDeckContentFingerprint.compute({ question: "<p>What is   FSRS?</p>\n", answer: "  <p>A scheduler</p>  " }, "CARD");
    assertEqual(compact, reflowed, "reflowing HTML must not cost the buyer their progress");
});

harness.test("PaidDeckContentFingerprint.compute: buyer-authored Ask AI markup is stripped", "PaidDeckContentFingerprint.compute", () =>
{
    const sellerOnly = PaidDeckContentFingerprint.compute({ question: "Q", answer: "<p>A scheduler</p>" }, "CARD");
    const withBuyerNote = PaidDeckContentFingerprint.compute
    ({
        question: "Q",
        answer: "<p>A scheduler</p><button class=\"ask-ai-popup-link\" data-popup-id=\"x\">View Mnemonic</button>"
    }, "CARD");
    assertEqual(sellerOnly, withBuyerNote, "the learner own inserted note is not a publisher edit");
});

harness.test("PaidDeckContentFingerprint.compute: study materials fingerprint their content field", "PaidDeckContentFingerprint.compute", () =>
{
    const first = PaidDeckContentFingerprint.compute({ content: "<h1>Lesson</h1>" }, "STUDY_MATERIAL");
    const second = PaidDeckContentFingerprint.compute({ content: "<h1>Lesson</h1>" }, "STUDY_MATERIAL");
    const third = PaidDeckContentFingerprint.compute({ content: "<h1>Lesson 2</h1>" }, "STUDY_MATERIAL");
    assertEqual(first, second);
    assert(first !== third);
});

harness.test("PaidDeckContentFingerprint.compute: an unfingerprintable type returns empty", "PaidDeckContentFingerprint.compute", () =>
{
    assertEqual(PaidDeckContentFingerprint.compute({ items: [] }, "MOCK_TEST"), "");
    assertEqual(PaidDeckContentFingerprint.compute(null, "CARD"), "");
});

harness.test("PaidDeckContentUpdatePlanner.plan: unchanged entities carry progress, changed ones reset", "PaidDeckContentUpdatePlanner.plan", () =>
{
    const existingRows =
    [
        { id: "entity-1", fingerprint: "aaaa" },
        { id: "entity-2", fingerprint: "bbbb" }
    ];
    const incomingEntities =
    [
        { id: "entity-1", fingerprint: "aaaa" },
        { id: "entity-2", fingerprint: "cccc" }
    ];

    const plan = PaidDeckContentUpdatePlanner.plan(existingRows, incomingEntities);

    assertEqual(plan.counts.carried, 1, "the untouched card keeps its progress");
    assertEqual(plan.counts.reset, 1, "the edited card resets");
    assertEqual(plan.carried[0].existingRow.id, "entity-1");
    assertEqual(plan.reset[0].existingRow.id, "entity-2");
});

harness.test("PaidDeckContentUpdatePlanner.plan: new and removed entities are classified", "PaidDeckContentUpdatePlanner.plan", () =>
{
    const plan = PaidDeckContentUpdatePlanner.plan
    (
        [{ id: "kept", fingerprint: "aaaa" }, { id: "gone", fingerprint: "bbbb" }],
        [{ id: "kept", fingerprint: "aaaa" }, { id: "brand-new", fingerprint: "dddd" }]
    );

    assertEqual(plan.counts.added, 1);
    assertEqual(plan.added[0].id, "brand-new");
    assertEqual(plan.counts.removed, 1);
    assertEqual(plan.removed[0].id, "gone", "an entity the publisher deleted is removed, cascading its overlays");
});

harness.test("PaidDeckContentUpdatePlanner.plan: a missing fingerprint resets rather than carries", "PaidDeckContentUpdatePlanner.plan", () =>
{
    // A row seeded before fingerprints existed cannot be proven unchanged.
    // Resetting costs progress; carrying would attach scheduling state to
    // unverified text, which is worse.
    const plan = PaidDeckContentUpdatePlanner.plan
    (
        [{ id: "legacy" }],
        [{ id: "legacy", fingerprint: "aaaa" }]
    );
    assertEqual(plan.counts.reset, 1);
    assertEqual(plan.counts.carried, 0);
});

harness.test("PaidDeckContentUpdatePlanner.plan: empty inputs are handled", "PaidDeckContentUpdatePlanner.plan", () =>
{
    const plan = PaidDeckContentUpdatePlanner.plan(null, undefined);
    assertEqual(plan.counts.carried + plan.counts.reset + plan.counts.added + plan.counts.removed, 0);
});

harness.test("LicenseContentVersionResolver: a legacy license is never told to update", "LicenseContentVersionResolver.isUpdateAvailable", () =>
{
    // Every license issued before this feature has downloadedContentVersion 0
    // while every deck has contentVersion >= 1. Comparing naively would show
    // "Update available" to every existing buyer on day one.
    const legacyLicense = { downloadedContentVersion: 0, additionalData: {} };
    assertEqual(LicenseContentVersionResolver.isUpdateAvailable(legacyLicense, "1", 3), false);
    assertEqual(LicenseContentVersionResolver.needsBackfill(legacyLicense, "1", 3), true, "it is backfilled instead, so the next comparison is meaningful");
});

harness.test("LicenseContentVersionResolver: a genuinely older copy is offered the update", "LicenseContentVersionResolver.isUpdateAvailable", () =>
{
    const license = { downloadedContentVersion: 2, additionalData: {} };
    assertEqual(LicenseContentVersionResolver.isUpdateAvailable(license, "1", 3), true);
    assertEqual(LicenseContentVersionResolver.isUpdateAvailable(license, "1", 2), false, "a current copy is not nagged");
    assertEqual(LicenseContentVersionResolver.needsBackfill(license, "1", 3), false);
});

harness.test("LicenseContentVersionResolver: a per-copy version beats the license-level one", "LicenseContentVersionResolver.resolveDownloadedVersion", () =>
{
    // Copies are updated independently, so one can lag behind another.
    const license =
    {
        downloadedContentVersion: 3,
        additionalData: { instances: [{ instanceId: "1", contentVersion: 3 }, { instanceId: "second", contentVersion: 1 }] }
    };

    assertEqual(LicenseContentVersionResolver.resolveDownloadedVersion(license, "second"), 1);
    assertEqual(LicenseContentVersionResolver.isUpdateAvailable(license, "second", 3), true, "the stale copy is offered an update");
    assertEqual(LicenseContentVersionResolver.isUpdateAvailable(license, "1", 3), false, "the current copy is not");
});

harness.test("LicenseContentVersionResolver.resolveDownloadedVersion: falls back and rejects junk", "LicenseContentVersionResolver.resolveDownloadedVersion", () =>
{
    assertEqual(LicenseContentVersionResolver.resolveDownloadedVersion({ downloadedContentVersion: 5 }, "1"), 5, "no instances array -> license-level value");
    assertEqual(LicenseContentVersionResolver.resolveDownloadedVersion({ downloadedContentVersion: -2 }, "1"), 0);
    assertEqual(LicenseContentVersionResolver.resolveDownloadedVersion({ downloadedContentVersion: "abc" }, "1"), 0);
    assertEqual(LicenseContentVersionResolver.resolveDownloadedVersion(null, "1"), 0);
});

// -- SyncPayloadValidator: NoSQL-operator injection defence --------------------

harness.test("SyncPayloadValidator.isValidId: non-empty bounded string only", "SyncPayloadValidator.isValidId", () =>
{
    assertEqual(SyncPayloadValidator.isValidId("deck-123"), true);
    assertEqual(SyncPayloadValidator.isValidId(""), false);
    assertEqual(SyncPayloadValidator.isValidId({ $ne: null }), false, "an operator object must be rejected");
    assertEqual(SyncPayloadValidator.isValidId(42), false);
    assertEqual(SyncPayloadValidator.isValidId(null), false);
    assertEqual(SyncPayloadValidator.isValidId("x".repeat(SyncPayloadValidator.MAX_ID_LENGTH + 1)), false);
});

harness.test("SyncPayloadValidator.isValidDeviceId: non-empty bounded string only", "SyncPayloadValidator.isValidDeviceId", () =>
{
    assertEqual(SyncPayloadValidator.isValidDeviceId("device-abc"), true);
    assertEqual(SyncPayloadValidator.isValidDeviceId({ $gt: "" }), false);
    assertEqual(SyncPayloadValidator.isValidDeviceId(""), false);
});

harness.test("SyncPayloadValidator.sanitizeLastSync: coerces to safe epoch millis", "SyncPayloadValidator.sanitizeLastSync", () =>
{
    assertEqual(SyncPayloadValidator.sanitizeLastSync(1_700_000_000_000), 1_700_000_000_000);
    assertEqual(SyncPayloadValidator.sanitizeLastSync(0), 0);
    assertEqual(SyncPayloadValidator.sanitizeLastSync(-1), 0, "negative collapses to 0");
    assertEqual(SyncPayloadValidator.sanitizeLastSync({ $gt: 0 }), 0, "an operator object collapses to 0");
    assertEqual(SyncPayloadValidator.sanitizeLastSync(NaN), 0);
});

harness.test("SyncPayloadValidator.sanitizeChanges: drops injected id fields, keeps valid ones", "SyncPayloadValidator.sanitizeChanges", () =>
{
    const changes =
    [
        { entityType: 1, data: { id: "card-1", question: "q" } },        // valid upsert
        { entityType: 1, data: { id: { $ne: null } } },                  // injected data.id
        { deleted: true, entityId: "deck-9", entityType: 0 },            // valid deletion
        { deleted: true, entityId: { $ne: null }, entityType: 0 },       // injected entityId
        { entityType: 1 },                                               // missing data
        "not-an-object"                                                  // junk
    ];
    const { validChanges, droppedCount } = SyncPayloadValidator.sanitizeChanges(changes);
    assertEqual(validChanges.length, 2, "only the two well-formed changes survive");
    assertEqual(droppedCount, 4, "the four malformed changes are dropped");
    assertEqual(validChanges[0].data.id, "card-1");
    assertEqual(validChanges[1].entityId, "deck-9");
});

harness.test("SyncPayloadValidator.sanitizeChanges: non-array input yields empty result", "SyncPayloadValidator.sanitizeChanges", () =>
{
    const { validChanges, droppedCount } = SyncPayloadValidator.sanitizeChanges({ $where: "1==1" });
    assertEqual(validChanges.length, 0);
    assertEqual(droppedCount, 0);
});

// -- AI-generated deck marker --------------------------------------------------

harness.test("AiGeneratedDeckFields.isMarked: reads both the current and legacy keys", "AiGeneratedDeckFields.isMarked", () =>
{
    assert(AiGeneratedDeckFields.isMarked({ aiGenerated: true }), "current key");
    assert(AiGeneratedDeckFields.isMarked({ protected: true }), "legacy key survives until the migration has run everywhere");
    assert(!AiGeneratedDeckFields.isMarked({ aiGenerated: false }));
    assert(!AiGeneratedDeckFields.isMarked({}));
    assert(!AiGeneratedDeckFields.isMarked(null), "null tolerated so call sites need no guard");
    assert(!AiGeneratedDeckFields.isMarked("not-an-object"));
    assert(!AiGeneratedDeckFields.isMarked({ aiGenerated: "true" }), "only a real boolean counts");
});

harness.test("AiGeneratedFieldPreserver.restoreMarker: a push that omits the marker cannot erase it", "AiGeneratedFieldPreserver.restoreMarker", () =>
{
    const incomingDeckData = { id: "deck-1", additionalData: { syllabusPosition: 3 } };
    const bRestored = AiGeneratedFieldPreserver.restoreMarker(incomingDeckData, { additionalData: { aiGenerated: true } });

    assert(bRestored, "reports that it had to restore");
    assertEqual(incomingDeckData.additionalData.aiGenerated, true);
    assertEqual(incomingDeckData.additionalData.syllabusPosition, 3, "unrelated fields are left alone");
});

harness.test("AiGeneratedFieldPreserver.restoreMarker: the marker is NON-CLEARABLE from a device", "AiGeneratedFieldPreserver.restoreMarker", () =>
{
    // The distinguishing case against the auto-analysis fields, which DO honour
    // an explicit client clear. Un-marking generated content is never a
    // legitimate client action, so an explicit false must be overridden.
    const incomingDeckData = { id: "deck-1", additionalData: { aiGenerated: false } };
    const bRestored = AiGeneratedFieldPreserver.restoreMarker(incomingDeckData, { additionalData: { aiGenerated: true } });

    assert(bRestored);
    assertEqual(incomingDeckData.additionalData.aiGenerated, true, "an explicit clear is refused");
});

harness.test("AiGeneratedFieldPreserver.restoreMarker: a legacy-keyed server row still forces the current key", "AiGeneratedFieldPreserver.restoreMarker", () =>
{
    const incomingDeckData = { id: "deck-1", additionalData: {} };
    const bRestored = AiGeneratedFieldPreserver.restoreMarker(incomingDeckData, { additionalData: { protected: true } });

    assert(bRestored, "a pre-migration server row is still a marked deck");
    assertEqual(incomingDeckData.additionalData.aiGenerated, true);
});

harness.test("AiGeneratedFieldPreserver.restoreMarker: creates additionalData when the push has none", "AiGeneratedFieldPreserver.restoreMarker", () =>
{
    const incomingDeckData = { id: "deck-1" };
    assert(AiGeneratedFieldPreserver.restoreMarker(incomingDeckData, { additionalData: { aiGenerated: true } }));
    assertEqual(incomingDeckData.additionalData.aiGenerated, true);
});

harness.test("AiGeneratedFieldPreserver.restoreMarker: never marks a deck the server has not marked", "AiGeneratedFieldPreserver.restoreMarker", () =>
{
    // A one-way ratchet. It must not invent the marker, or an ordinary push
    // could silently strip a user's own deck of its export capability.
    const incomingDeckData = { id: "deck-1", additionalData: {} };

    assert(!AiGeneratedFieldPreserver.restoreMarker(incomingDeckData, { additionalData: {} }));
    assert(!AiGeneratedFieldPreserver.restoreMarker(incomingDeckData, null), "no stored row at all");
    assertEqual(incomingDeckData.additionalData.aiGenerated, undefined);
});

harness.test("AiGeneratedFieldPreserver.restoreMarker: a client over-claim is left alone", "AiGeneratedFieldPreserver.restoreMarker", () =>
{
    // Setting the marker only ever removes capability, so it is harmless and
    // is not second-guessed.
    const incomingDeckData = { id: "deck-1", additionalData: { aiGenerated: true } };

    assert(!AiGeneratedFieldPreserver.restoreMarker(incomingDeckData, { additionalData: {} }), "nothing to restore");
    assertEqual(incomingDeckData.additionalData.aiGenerated, true, "the client's claim survives");
});

// -- Generation credit policy --------------------------------------------------

harness.test("CreditConfiguration.ensureGenerationTaskRules: seeds every metered generation task", "CreditConfiguration.ensureGenerationTaskRules", () =>
{
    const configuration = new CreditConfiguration({});
    assert(configuration.ensureGenerationTaskRules(), "reports that it added rules");

    for (const taskTypeValue of [taskTypes.FLASHCARD_GENERATION_WORKER, taskTypes.STUDY_MATERIAL_GENERATION_WORKER, taskTypes.MOCK_TEST_GENERATION_WORKER])
    {
        const rule = configuration.getRuleForTask(taskTypeValue);
        assert(rule, "a rule exists");
        assert(rule.getEnabled(), "seeded rules are enabled");
        assertEqual(rule.getTerms().length, 2, "one term per token dimension — a combined term would MULTIPLY them");
    }

    assert(configuration.getRuleForTask(taskTypes.PREPARE_FOR_SIMILARITY_SEARCH), "duration-metered prep task is seeded");
    assert(configuration.getRuleForTask(taskTypes.ENHANCE_IMAGES), "image enhancement is seeded");
});

harness.test("CreditConfiguration.ensureGenerationTaskRules: never overwrites an existing rule", "CreditConfiguration.ensureGenerationTaskRules", () =>
{
    const configuration = new CreditConfiguration({});
    configuration.ensureGenerationTaskRules();

    // An admin who deliberately disabled a task, or left it free, must survive
    // the next boot — this is the same contract ensureAskAiTaskRules honours.
    const flashcardRule = configuration.getRuleForTask(taskTypes.FLASHCARD_GENERATION_WORKER);
    flashcardRule.setEnabled(false);
    flashcardRule.setTerms([]);

    assert(!configuration.ensureGenerationTaskRules(), "a second pass adds nothing");
    assert(!configuration.getRuleForTask(taskTypes.FLASHCARD_GENERATION_WORKER).getEnabled(), "the admin's disable survives");
    assertEqual(configuration.getRuleForTask(taskTypes.FLASHCARD_GENERATION_WORKER).getTerms().length, 0, "the admin's empty terms survive");
});

// -- Paid-deck source admission ------------------------------------------------

function paidDeckSource(sourceType, verdict, reason = "")
{
    return {
        getInformationSource: () => (
        {
            getSourceType: () => sourceType,
            getCurriculumPlausibility: () => verdict,
            getCurriculumPlausibilityReason: () => reason,
        })
    };
}

harness.test("PaidDeckGenerationGate.validateSourceTypes: the row's declared type is what counts", "PaidDeckGenerationGate.validateSourceTypes", () =>
{
    // Everything is stored as a provided document; the generation page decides
    // the role. A source declared Curriculum must be accepted whatever slot it
    // happened to be uploaded into.
    PaidDeckGenerationGate.validateSourceTypes([paidDeckSource(informationSourceTypes.CURRICULUM_OR_SYLLABUS, curriculumPlausibility.PLAUSIBLE)]);

    // Never measured (uploaded before the check existed) is not a failure.
    PaidDeckGenerationGate.validateSourceTypes([paidDeckSource(informationSourceTypes.CURRICULUM_OR_SYLLABUS, curriculumPlausibility.UNKNOWN)]);
});

harness.test("PaidDeckGenerationGate.validateSourceTypes: a measured textbook overrides the declaration", "PaidDeckGenerationGate.validateSourceTypes", () =>
{
    // The declaration is the user's, so on its own it would make this gate
    // self-certifying. The structural verdict is what keeps it meaningful.
    let thrownMessage = "";
    try
    {
        PaidDeckGenerationGate.validateSourceTypes([paidDeckSource(informationSourceTypes.CURRICULUM_OR_SYLLABUS, curriculumPlausibility.IMPLAUSIBLE, "600 pages")]);
    }
    catch (refusal)
    {
        thrownMessage = refusal.message;
    }

    assert(thrownMessage.includes("does not read as a curriculum"), "refused on the measurement");
    assert(thrownMessage.includes("600 pages"), "the measured reason reaches the user");
});

harness.test("PaidDeckGenerationGate.validateSourceTypes: refuses other types and names the position", "PaidDeckGenerationGate.validateSourceTypes", () =>
{
    let thrownMessage = "";
    try
    {
        PaidDeckGenerationGate.validateSourceTypes(
        [
            paidDeckSource(informationSourceTypes.CURRICULUM_OR_SYLLABUS, curriculumPlausibility.PLAUSIBLE),
            paidDeckSource(informationSourceTypes.PROVIDED_DOCUMENTS, curriculumPlausibility.PLAUSIBLE),
        ]);
    }
    catch (refusal)
    {
        thrownMessage = refusal.message;
    }

    assert(thrownMessage.includes("Information source #2"), "identifies which source is wrong");
    assert(thrownMessage.includes("Set this source's type to Curriculum Or Syllabus"), "says how to fix it");
});

// ── Content refinement ─────────────────────────────────────────────────────

const RefinedEntityWriter = require("../../../Dock/Globals/Classes/Generation/RefinedEntityWriter");
const RefinementTargetLocator = require("../../../Dock/Globals/Classes/Generation/RefinementTargetLocator");
const SourceRetentionPolicy = require("../../../Dock/Globals/Classes/Content/SourceRetentionPolicy");
const { refinementTargetKinds } = require("../../../Dock/Globals/Enumerations/RefinementTargetKinds");

harness.test("RefinedEntityWriter.computeContentHash: a whitespace-only change is a different version", "RefinedEntityWriter.computeContentHash", () =>
{
    const originalContent = "<p>The gas constant is 8.314 J/(mol K).</p>";

    assert(
        RefinedEntityWriter.computeContentHash(originalContent) === RefinedEntityWriter.computeContentHash(originalContent),
        "stable across calls",
    );
    assert(
        RefinedEntityWriter.computeContentHash(originalContent) !== RefinedEntityWriter.computeContentHash(`${originalContent} `),
        "whitespace counts — the proposal did not see that version",
    );
});

harness.test("RefinedEntityWriter.isWritableTargetKind: a figure is not written directly", "RefinedEntityWriter.isWritableTargetKind", () =>
{
    assert(RefinedEntityWriter.isWritableTargetKind(refinementTargetKinds.STUDY_MATERIAL), "study material is writable");
    assert(!RefinedEntityWriter.isWritableTargetKind(refinementTargetKinds.FIGURE), "a figure must be resolved to its holding field first");
    assert(
        RefinedEntityWriter.describeTargetKind(refinementTargetKinds.CARD_QUESTION).contentFieldName === "question"
            && RefinedEntityWriter.describeTargetKind(refinementTargetKinds.CARD_ANSWER).contentFieldName === "answer",
        "question and answer are separate fields",
    );
});

harness.test("RefinementTargetLocator.normalizeForMatching: markup and entities do not defeat a match", "RefinementTargetLocator.normalizeForMatching", () =>
{
    assert(
        RefinementTargetLocator.normalizeForMatching("<p>The <strong>value</strong> is 8.314</p>") === "the value is 8.314",
        "markup stripped and case folded",
    );
    assert(RefinementTargetLocator.normalizeForMatching("a&nbsp;b") === "a b", "entities resolved");
    assert(RefinementTargetLocator.normalizeForMatching(null) === "", "a non-string normalises rather than throwing");
});

harness.test("SourceRetentionPolicy.isSourceUnderLegalHold: only a cited hash is held", "SourceRetentionPolicy.isSourceUnderLegalHold", () =>
{
    const buildSource = (contentHash) => ({ getHash: () => contentHash, getExpiresAt: () => 0, getUploadedAt: () => 1000 });
    const referencedProofHashes = new Set(["cited"]);

    assert(SourceRetentionPolicy.isSourceUnderLegalHold(buildSource("cited"), referencedProofHashes), "a cited hash is held");
    assert(!SourceRetentionPolicy.isSourceUnderLegalHold(buildSource("other"), referencedProofHashes), "an uncited hash is not");
    assert(!SourceRetentionPolicy.isSourceUnderLegalHold(buildSource("cited"), null), "a skipped lookup does not silently hold everything");
});

harness.test("SourceRetentionPolicy.isSourceDue: a held proof survives, an unheld one is still reaped", "SourceRetentionPolicy.isSourceDue (with legal hold)", () =>
{
    const buildSource = (contentHash) => ({ getHash: () => contentHash, getExpiresAt: () => 0, getUploadedAt: () => 1000 });
    const referencedProofHashes = new Set(["cited"]);
    const lapsedPolicy = { bRetained: false, deleteBeforeMilliseconds: null };

    assert(
        SourceRetentionPolicy.isSourceDue(buildSource("other"), lapsedPolicy, 10000, referencedProofHashes) === true,
        "the hold does not over-block",
    );
    assert(
        SourceRetentionPolicy.isSourceDue(buildSource("cited"), lapsedPolicy, 10000, referencedProofHashes) === false,
        "the proof survives a lapsed subscription",
    );
});

harness.test("CreditConfiguration.ensureContentRefinementTaskRules: seeds both, prices them apart", "CreditConfiguration.ensureContentRefinementTaskRules", () =>
{
    const configuration = new CreditConfiguration({});

    assert(configuration.ensureContentRefinementTaskRules() === true, "both rules seeded");
    assert(configuration.ensureContentRefinementTaskRules() === false, "a second call overwrites nothing");

    const contentRule = configuration.getRuleForTask(taskTypes.REFINE_CONTENT);
    const visualRule = configuration.getRuleForTask(taskTypes.REFINE_VISUAL);

    assert(contentRule !== null && contentRule.getEnabled(), "an absent rule would be free");
    assert(visualRule.evaluate({}) > contentRule.evaluate({}), "a diagram costs more than a sentence");
});

// ── Organization engagement report ─────────────────────────────────────────

const UserDailyActivityQueryEngine = require("../../../Dock/Globals/Classes/Database/UserDailyActivityQueryEngine");
const CreditSpendCategoryNamer = require("../../../Dock/Globals/Classes/Organization/CreditSpendCategoryNamer");
const { creditTransactionTypes } = require("../../../Dock/Globals/Enumerations/CreditTransactionTypes");

harness.test("UserDailyActivityQueryEngine.isValidDayUtc: a day that is half of an upsert key is checked, not trusted", "UserDailyActivityQueryEngine.isValidDayUtc", () =>
{
    assert(UserDailyActivityQueryEngine.isValidDayUtc("2026-08-07"), "a real day is accepted");
    assert(!UserDailyActivityQueryEngine.isValidDayUtc("2026-02-30"), "the 30th of February is refused — a Date would roll it silently to March");
    assert(!UserDailyActivityQueryEngine.isValidDayUtc("07-08-2026"), "a non-ISO ordering is refused");
    assert(!UserDailyActivityQueryEngine.isValidDayUtc(20260807), "a number is refused");
});

harness.test("UserDailyActivityQueryEngine.toDayUtc: buckets in UTC, and refuses to guess", "UserDailyActivityQueryEngine.toDayUtc", () =>
{
    assert(UserDailyActivityQueryEngine.toDayUtc("2026-08-07T23:59:59.000Z") === "2026-08-07", "late in the UTC day stays that day");
    assert(UserDailyActivityQueryEngine.toDayUtc("2026-08-08T00:00:01.000Z") === "2026-08-08", "just after midnight is the next day");
    assert(UserDailyActivityQueryEngine.toDayUtc("not a date") === "", "an unparseable value buckets to nothing rather than to today");
});

harness.test("CreditSpendCategoryNamer.describe: one naming, so two tables cannot disagree", "CreditSpendCategoryNamer.describe", () =>
{
    assert(CreditSpendCategoryNamer.describe({ type: creditTransactionTypes.TASK_CHARGE, metadata: { source: "AskAi" } }) === "Ask AI", "Ask AI by its source marker");
    assert(CreditSpendCategoryNamer.describe({ type: creditTransactionTypes.STORAGE_CHARGE }) === "Storage", "storage recognised");
    assert(
        CreditSpendCategoryNamer.describe({ type: creditTransactionTypes.TASK_CHARGE, metadata: { taskType: 999999 } }) === "Other AI usage",
        "an unrecognised task is named rather than dropped from the total",
    );
});

harness.test("CreditSpendCategoryNamer.isInvokedAiFeature: storage is priced but not counted", "CreditSpendCategoryNamer.isInvokedAiFeature", () =>
{
    assert(!CreditSpendCategoryNamer.isInvokedAiFeature("Storage"), "storage is billed periodically — counting it reports billing ticks as things the student did");
    assert(CreditSpendCategoryNamer.isInvokedAiFeature("Ask AI"), "an invoked feature counts");
    assert(CreditSpendCategoryNamer.isInvokedAiFeature("Other AI usage"), "including one whose name we did not recognise");
});

harness.runAndWrite(RESULT_FILE);
