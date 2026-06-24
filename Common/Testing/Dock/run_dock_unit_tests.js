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

harness.runAndWrite(RESULT_FILE);
