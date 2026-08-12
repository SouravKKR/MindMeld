/**
 * End-to-end verification harness for the age / guardian-consent gate — the
 * control the published Privacy Policy promised and nothing implemented.
 *
 * Run from the Dock directory:
 *     node VerifyAgeConsentGate.mjs
 *     VERIFY_AGE_CONSENT_DB=1 node VerifyAgeConsentGate.mjs
 *
 * The two-stage guardian consent flow (code emailed to the guardian, promoted
 * only on confirmation) has its own harness: VerifyGuardianConsentOtp.mjs. This
 * one owns the declaration and the gate around it.
 *
 * What it pins:
 *
 *   A-01  The state machine. An account with no declaration is blocked; an
 *         adult is allowed; a Child is blocked until a CONFIRMED guardian
 *         record exists. Derived on every read, so an account is released the
 *         day it turns 18 with no migration and no cron.
 *
 *   A-02  Age arithmetic on the calendar, not by dividing a duration — for both
 *         the declared-age model and the legacy date-of-birth rows still in the
 *         collection. The day before an eighteenth birthday must still be 17,
 *         including across a leap day.
 *
 *   A-03  Write-once declaration. A minor who can re-declare has not been
 *         gated, and the block screen is exactly where the incentive is.
 *
 *   A-04  Consent cannot be self-asserted. Every field the service owns is
 *         refused by the generic /UpdateUserAdditionalData merge — including
 *         the legacy dateOfBirth, which would otherwise override a declared age.
 *
 *   A-05  The gate's allowlist actually contains the endpoints that clear it.
 *         A gate that blocks the route out of itself is a lockout.
 *
 * Two tiers:
 *
 *   1. ALWAYS — pure algebra against the real AgeVerificationService with the
 *      persistence seam stubbed. No database, no network.
 *
 *   2. DB (opt-in: VERIFY_AGE_CONSENT_DB=1) — drives the real query engine
 *      against the configured MongoDB with a throwaway *.invalid account, and
 *      removes it afterwards.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const AgeVerificationService = require("./Globals/Classes/Authentication/AgeVerificationService");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const AgeVerificationConstants = require("./Globals/Constants/AgeVerificationConstants");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");
const { ageConsentStates } = require("./Globals/Enumerations/AgeConsentStates");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assertThat(condition, description)
{
    if (condition)
    {
        passedCount++;
        console.log(`  PASS  ${description}`);
        return;
    }

    failedCount++;
    console.error(`  FAIL  ${description}`);
}

function skip(description)
{
    skippedCount++;
    console.log(`  SKIP  ${description}`);
}

/** Minimal stand-in for the User model — resolveState only reads additionalData. */
function buildUser(additionalData)
{
    return {
        getAdditionalData: () => additionalData,
        getDisplayName: () => "Fixture Student"
    };
}

function buildGuardianDetails(overrides = {})
{
    return Object.assign(
    {
        guardianName: "A Guardian",
        guardianRelationship: "Mother",
        guardianEmail: "guardian@example.invalid",
        guardianContactNumber: "+911234567890"
    }, overrides);
}

/** A confirmed consent record, as confirmGuardianConsent writes it. */
function buildConfirmedConsent()
{
    return Object.assign(buildGuardianDetails(),
    {
        recordedAt: new Date().toISOString(),
        verificationMethod: "EMAIL_CODE"
    });
}

/** An age declaration made `agoYears` ago, as recordDeclaredAge writes it. */
function buildAgeDeclaration(declaredAgeYears, agoYears = 0)
{
    const declaredAt = new Date();
    declaredAt.setUTCFullYear(declaredAt.getUTCFullYear() - agoYears);
    // Step back a day so a run landing exactly on the anniversary is unambiguous.
    declaredAt.setUTCDate(declaredAt.getUTCDate() - 1);

    return { declaredAgeYears: declaredAgeYears, ageDeclaredAt: declaredAt.toISOString() };
}

/** A date of birth that makes the account holder exactly `years` old today. */
function buildDateOfBirthForAge(years)
{
    const birthDate = new Date();
    birthDate.setUTCFullYear(birthDate.getUTCFullYear() - years);
    birthDate.setUTCDate(birthDate.getUTCDate() - 1);
    return birthDate.toISOString().slice(0, 10);
}

console.log("\n[A-01] State machine (always runs)\n");

{
    const undeclared = AgeVerificationService.resolveState(buildUser({}));
    assertThat(undeclared.state === ageConsentStates.UNDECLARED, "no declaration resolves to UNDECLARED");
    assertThat(undeclared.bProcessingAllowed === false, "an undeclared account is blocked");

    const adult = AgeVerificationService.resolveState(buildUser(buildAgeDeclaration(30)));
    assertThat(adult.state === ageConsentStates.ADULT, "a declared adult resolves to ADULT");
    assertThat(adult.bProcessingAllowed === true, "an adult is allowed");

    const minor = AgeVerificationService.resolveState(buildUser(buildAgeDeclaration(14)));
    assertThat(minor.state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT, "a Child with no guardian resolves to MINOR_AWAITING_GUARDIAN_CONSENT");
    assertThat(minor.bProcessingAllowed === false, "a Child with no guardian is blocked");

    const consentedMinor = AgeVerificationService.resolveState(buildUser(
        Object.assign(buildAgeDeclaration(14), { guardianConsent: buildConfirmedConsent() })));
    assertThat(consentedMinor.state === ageConsentStates.MINOR_CONSENTED, "a Child with a confirmed guardian record resolves to MINOR_CONSENTED");
    assertThat(consentedMinor.bProcessingAllowed === true, "a Child with a confirmed guardian record is allowed");

    // The security property of the two-stage flow: the details a child types are
    // stored as pending and unblock nothing on their own.
    const pendingOnly = AgeVerificationService.resolveState(buildUser(
        Object.assign(buildAgeDeclaration(14),
        {
            guardianConsentPending: Object.assign(buildGuardianDetails(), { requestedAt: new Date().toISOString() })
        })));
    assertThat(pendingOnly.state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT, "pending guardian details leave the account awaiting consent");
    assertThat(pendingOnly.bProcessingAllowed === false, "pending guardian details do NOT unblock the account");

    // A record missing the server-stamped timestamp is a forged or partial
    // write, not a consent.
    const halfConsented = AgeVerificationService.resolveState(buildUser(
        Object.assign(buildAgeDeclaration(14), { guardianConsent: buildGuardianDetails() })));
    assertThat(halfConsented.bProcessingAllowed === false, "a guardian record with no server timestamp does not unblock");

    const garbageDeclaration = AgeVerificationService.resolveState(buildUser({ declaredAgeYears: "sixteen", ageDeclaredAt: new Date().toISOString() }));
    assertThat(garbageDeclaration.state === ageConsentStates.UNDECLARED, "an unparseable declared age falls back to UNDECLARED rather than allowing");

    const undatedDeclaration = AgeVerificationService.resolveState(buildUser({ declaredAgeYears: 30 }));
    assertThat(undatedDeclaration.state === ageConsentStates.UNDECLARED, "an age with no declaration date is unusable rather than trusted");

    // Legacy rows written by the date-of-birth flow must keep working untouched.
    const legacyAdult = AgeVerificationService.resolveState(buildUser({ dateOfBirth: buildDateOfBirthForAge(30) }));
    assertThat(legacyAdult.state === ageConsentStates.ADULT, "a legacy date-of-birth adult still resolves to ADULT");

    const legacyMinor = AgeVerificationService.resolveState(buildUser({ dateOfBirth: buildDateOfBirthForAge(14) }));
    assertThat(legacyMinor.state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT, "a legacy date-of-birth Child still resolves to MINOR_AWAITING_GUARDIAN_CONSENT");

    const legacyGarbage = AgeVerificationService.resolveState(buildUser({ dateOfBirth: "not-a-date" }));
    assertThat(legacyGarbage.state === ageConsentStates.UNDECLARED, "an unparseable legacy date falls back to UNDECLARED rather than allowing");
}

console.log("\n[A-02] Age arithmetic (always runs)\n");

{
    // Declared age ages forward on the calendar.
    const declaredAt = "2026-06-15T00:00:00.000Z";
    assertThat(
        AgeVerificationService.computeCurrentAgeYears(17, declaredAt, Date.UTC(2026, 5, 15)) === 17,
        "on the day of declaration the age is what was declared",
    );
    assertThat(
        AgeVerificationService.computeCurrentAgeYears(17, declaredAt, Date.UTC(2027, 5, 14)) === 17,
        "the day before the declaration's anniversary the age has not advanced",
    );
    assertThat(
        AgeVerificationService.computeCurrentAgeYears(17, declaredAt, Date.UTC(2027, 5, 15)) === 18,
        "on the declaration's anniversary a declared 17 becomes 18",
    );
    assertThat(
        AgeVerificationService.computeCurrentAgeYears(14, declaredAt, Date.UTC(2030, 5, 15)) === 18,
        "four years after declaring 14 the account holder is 18",
    );

    assertThat(AgeVerificationService.computeCurrentAgeYears(null, declaredAt, Date.now()) === null, "a null age has no reading");
    assertThat(AgeVerificationService.computeCurrentAgeYears(17, null, Date.now()) === null, "an age with no declaration date has no reading");
    assertThat(AgeVerificationService.computeCurrentAgeYears(17, "not-a-date", Date.now()) === null, "an unparseable declaration date has no reading");
    assertThat(
        AgeVerificationService.computeCurrentAgeYears(17, "2099-01-01T00:00:00.000Z", Date.UTC(2026, 0, 1)) === null,
        "a declaration stamped in the future is unusable rather than aged backwards",
    );

    // Legacy date-of-birth arithmetic, unchanged.
    const eighteenthBirthday = Date.UTC(2026, 5, 15);
    assertThat(
        AgeVerificationService.computeAgeYearsFromDateOfBirth("2008-06-15", eighteenthBirthday) === 18,
        "on the eighteenth birthday the legacy age is 18",
    );
    assertThat(
        AgeVerificationService.computeAgeYearsFromDateOfBirth("2008-06-16", eighteenthBirthday) === 17,
        "the day before the eighteenth birthday the legacy age is still 17",
    );
    assertThat(
        AgeVerificationService.computeAgeYearsFromDateOfBirth("2008-02-29", Date.UTC(2026, 1, 28)) === 17,
        "a leap-day birth is 17 the day before its 2026 birthday",
    );
    assertThat(
        AgeVerificationService.computeAgeYearsFromDateOfBirth("2008-02-29", Date.UTC(2026, 2, 1)) === 18,
        "a leap-day birth is 18 the day after its 2026 birthday",
    );
    assertThat(
        AgeVerificationService.computeAgeYearsFromDateOfBirth("2099-01-01", Date.UTC(2026, 0, 1)) === null,
        "a future date of birth has no age rather than a negative one",
    );
}

console.log("\n[A-03] Declaration validation (always runs)\n");

{
    const validDeclaration = AgeVerificationService.validateDeclaredAge(21);
    assertThat(validDeclaration.bValid === true, "a plausible age is accepted");
    assertThat(validDeclaration.normalizedAgeYears === 21, "the accepted age is returned normalized");

    assertThat(AgeVerificationService.validateDeclaredAge("17").bValid === true, "a numeric string is accepted");
    assertThat(AgeVerificationService.validateDeclaredAge("17").normalizedAgeYears === 17, "a numeric string normalizes to a number");

    assertThat(AgeVerificationService.validateDeclaredAge("").bValid === false, "an empty string is rejected");
    assertThat(AgeVerificationService.validateDeclaredAge(null).bValid === false, "null is rejected");
    assertThat(AgeVerificationService.validateDeclaredAge("seventeen").bValid === false, "a word is rejected");
    assertThat(AgeVerificationService.validateDeclaredAge(17.5).bValid === false, "a fractional age is rejected");
    assertThat(AgeVerificationService.validateDeclaredAge(-3).bValid === false, "a negative age is rejected");
    assertThat(
        AgeVerificationService.validateDeclaredAge(AgeVerificationConstants.MINIMUM_PLAUSIBLE_AGE_YEARS - 1).bValid === false,
        "an implausibly low age is rejected",
    );
    assertThat(
        AgeVerificationService.validateDeclaredAge(AgeVerificationConstants.MAXIMUM_PLAUSIBLE_AGE_YEARS + 1).bValid === false,
        "an implausibly high age is rejected",
    );

    // The lenient-coercion guard: Number(true) is 1 and Number([17]) is 17, and
    // an age coerced out of either is not a declaration anybody made.
    assertThat(AgeVerificationService.validateDeclaredAge(true).bValid === false, "a boolean is rejected rather than coerced");
    assertThat(AgeVerificationService.validateDeclaredAge([21]).bValid === false, "an array is rejected rather than coerced");
    assertThat(AgeVerificationService.validateDeclaredAge({}).bValid === false, "an object is rejected");

    assertThat(
        AgeVerificationService.validateDeclaredAge("seventeen").reason === ErrorCodes.INVALID_AGE,
        "a rejection carries the enumerated reason rather than a bare false",
    );
}

console.log("\n[A-04] Self-assertion defences (always runs)\n");

{
    assertThat(AgeVerificationService.isReservedAgeKey("declaredAgeYears") === true, "declaredAgeYears is reserved from the generic merge");
    assertThat(AgeVerificationService.isReservedAgeKey("ageDeclaredAt") === true, "the declaration timestamp is reserved");
    assertThat(AgeVerificationService.isReservedAgeKey("guardianConsent") === true, "guardianConsent is reserved from the generic merge");
    assertThat(AgeVerificationService.isReservedAgeKey("guardianConsentPending") === true, "the pending guardian record is reserved");
    // Reserved even though it is never written any more: a client able to plant
    // one would override its own declared age, since the legacy field wins in
    // #resolveAgeYears.
    assertThat(AgeVerificationService.isReservedAgeKey("dateOfBirth") === true, "the legacy dateOfBirth is still reserved");
    assertThat(AgeVerificationService.isReservedAgeKey("dateOfBirthRecordedAt") === true, "the legacy declaration timestamp is still reserved");
    assertThat(AgeVerificationService.isReservedAgeKey("displayName") === false, "an ordinary profile field is not reserved");

    const handlerSource = require("fs").readFileSync(
        path.join(currentDirectory, "Endpoints", "Authentication", "HandleUpdateUserAdditionalData.js"),
        "utf8",
    );
    assertThat(
        handlerSource.includes("AgeVerificationService.isReservedAgeKey"),
        "the generic additionalData merge actually calls the reserved-key check",
    );

    const guardianDetails = AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails());
    assertThat(guardianDetails !== null, "complete guardian details normalize");
    assertThat(
        AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails({ guardianEmail: "Guardian@Example.INVALID" })).guardianEmail === "guardian@example.invalid",
        "the guardian email is lower-cased so it matches the key OtpManager files the code under",
    );
    assertThat(AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails({ guardianName: "  " })) === null, "a blank guardian name is refused");
    assertThat(AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails({ guardianEmail: "not-an-email" })) === null, "an unusable guardian email is refused");
    assertThat(AgeVerificationService.normalizeGuardianDetails(null) === null, "a missing guardian payload is refused");
    assertThat(
        AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails({ guardianName: "x".repeat(AgeVerificationConstants.GUARDIAN_NAME_MAXIMUM_LENGTH + 1) })) === null,
        "an over-length guardian name is refused",
    );

    // The single-shot write that used to record consent without any confirmation
    // must be gone, not merely unused — a surviving export is a bypass.
    assertThat(
        typeof AgeVerificationService.recordGuardianConsent === "undefined",
        "the old unverified recordGuardianConsent entry point no longer exists",
    );
}

console.log("\n[A-05] Gate allowlist (always runs)\n");

{
    const pluginSource = require("fs").readFileSync(
        path.join(currentDirectory, "Endpoints", "Plugins", "EnsureAgeConsent.js"),
        "utf8",
    );

    const requiredPaths =
    [
        "/age/state",
        "/age/declareage",
        "/age/guardianconsent/requestcode",
        "/age/guardianconsent/verify",
        "/logout",
        "/getuser"
    ];

    for (const requiredPath of requiredPaths)
    {
        assertThat(pluginSource.includes(`"${requiredPath}"`), `the gate allowlists ${requiredPath} so a blocked account can reach it`);
    }

    const routeSource = require("fs").readFileSync(path.join(currentDirectory, "Endpoints", "HandleAgeEndpoints.js"), "utf8");
    for (const registeredPath of ["/Age/State", "/Age/DeclareAge", "/Age/GuardianConsent/RequestCode", "/Age/GuardianConsent/Verify"])
    {
        assertThat(routeSource.includes(`\`${registeredPath}\``), `${registeredPath} is actually registered`);
    }

    // Sending an email to a caller-chosen address is the shape the per-IP OTP cap
    // exists for; the per-(email, purpose) cooldown only bounds ONE address.
    assertThat(routeSource.includes("ensureOtpRateLimit"), "the guardian code endpoints carry the per-IP OTP rate limit");

    const indexSource = require("fs").readFileSync(path.join(currentDirectory, "index.js"), "utf8");
    assertThat(indexSource.includes("insertGlobalPlugin(ageConsentPlugin)"), "the gate is actually registered as a global plugin");
    assertThat(indexSource.includes("handleAgeEndpoints(server)"), "the age endpoints are actually registered");
    assertThat(
        indexSource.indexOf("insertGlobalPlugin(legalAcceptancePlugin)") < indexSource.indexOf("insertGlobalPlugin(ageConsentPlugin)"),
        "the legal gate is registered before the age gate, so terms clear first",
    );
}

console.log("\n[A-06] Write paths against MongoDB (opt-in)\n");

if ((process.env.VERIFY_AGE_CONSENT_DB || "") !== "1")
{
    skip("VERIFY_AGE_CONSENT_DB is not 1 — database tier not run");
}
else
{
    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

    const fixtureUserId = "verify-age-consent-user.invalid";
    let database = null;

    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`MongoDB unreachable (${connectionError.message}) — database tier not run`);
    }

    if (database !== null)
    {
        const users = database.collection(DatabaseConstants.USERS_COLLECTION);

        try
        {
            await users.insertOne({ id: fixtureUserId, displayName: "Fixture Student", additionalData: {} });

            const freshUser = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            assertThat(freshUser !== null, "the fixture account is readable through the query engine");

            const declaration = await AgeVerificationService.recordDeclaredAge(fixtureUserId, freshUser, 13);
            assertThat(declaration.ok === true, "a first declaration is accepted");
            assertThat(declaration.state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT, "a Child's declaration lands in MINOR_AWAITING_GUARDIAN_CONSENT");

            const afterDeclaration = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            const storedDeclaration = afterDeclaration.getAdditionalData();
            assertThat(storedDeclaration.declaredAgeYears === 13, "the declared age is stored as a number");
            assertThat(
                typeof storedDeclaration.ageDeclaredAt === "string" && storedDeclaration.ageDeclaredAt.length > 0,
                "the declaration carries a server-stamped date, so the age can age forward",
            );
            assertThat(storedDeclaration.dateOfBirth === undefined, "no date of birth is written by the new flow");

            const secondDeclaration = await AgeVerificationService.recordDeclaredAge(fixtureUserId, afterDeclaration, 25);
            assertThat(secondDeclaration.ok === false, "a second declaration is refused");
            assertThat(secondDeclaration.reason === ErrorCodes.AGE_ALREADY_DECLARED, "the refusal names the write-once rule");

            const stillMinor = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            assertThat(
                AgeVerificationService.resolveState(stillMinor).state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT,
                "the refused re-declaration did not age the account up",
            );

            // A legacy account has already answered; letting it also declare an
            // age would give it two answers for #resolveAgeYears to choose between.
            const legacyUser = buildUser({ dateOfBirth: buildDateOfBirthForAge(15) });
            const legacyRedeclaration = await AgeVerificationService.recordDeclaredAge(fixtureUserId, legacyUser, 25);
            assertThat(legacyRedeclaration.ok === false, "an account holding a legacy date of birth cannot also declare an age");
            assertThat(legacyRedeclaration.reason === ErrorCodes.AGE_ALREADY_DECLARED, "the legacy refusal names the write-once rule too");
        }
        finally
        {
            await users.deleteMany({ id: fixtureUserId });
            console.log("  ....  fixtures removed");
        }
    }
}

console.log(`\n${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped\n`);
process.exit(failedCount === 0 ? 0 : 1);
