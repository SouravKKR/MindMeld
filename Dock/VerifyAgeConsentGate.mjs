/**
 * End-to-end verification harness for the age / guardian-consent gate — the
 * control the published Privacy Policy promised and nothing implemented.
 *
 * Run from the Dock directory:
 *     node VerifyAgeConsentGate.mjs
 *     VERIFY_AGE_CONSENT_DB=1 node VerifyAgeConsentGate.mjs
 *
 * What it pins:
 *
 *   A-01  The state machine. An account with no date of birth is blocked; an
 *         adult is allowed; a Child is blocked until a guardian is recorded.
 *         Derived from the stored date of birth on every read, so an account
 *         is released the day it turns 18 with no migration and no cron.
 *
 *   A-02  Age arithmetic on the calendar, not by dividing a duration. The day
 *         before an eighteenth birthday must still be 17 — including across a
 *         leap day, where a milliseconds-per-year division gets it wrong.
 *
 *   A-03  Write-once declaration. A minor who can re-declare has not been
 *         gated, and the block screen is exactly where the incentive is.
 *
 *   A-04  Consent cannot be self-asserted. Every field the service owns is
 *         refused by the generic /UpdateUserAdditionalData merge, and the
 *         guardian write is refused for an account that is not a minor
 *         awaiting consent.
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
    return { getAdditionalData: () => additionalData };
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

/** A date of birth that makes the account holder exactly `years` old today. */
function buildDateOfBirthForAge(years)
{
    const birthDate = new Date();
    birthDate.setUTCFullYear(birthDate.getUTCFullYear() - years);
    // Step back a day so a run exactly on a birthday boundary is unambiguous.
    birthDate.setUTCDate(birthDate.getUTCDate() - 1);
    return birthDate.toISOString().slice(0, 10);
}

console.log("\n[A-01] State machine (always runs)\n");

{
    const undeclared = AgeVerificationService.resolveState(buildUser({}));
    assertThat(undeclared.state === ageConsentStates.UNDECLARED, "no date of birth resolves to UNDECLARED");
    assertThat(undeclared.bProcessingAllowed === false, "an undeclared account is blocked");

    const adult = AgeVerificationService.resolveState(buildUser({ dateOfBirth: buildDateOfBirthForAge(30) }));
    assertThat(adult.state === ageConsentStates.ADULT, "an adult resolves to ADULT");
    assertThat(adult.bProcessingAllowed === true, "an adult is allowed");

    const minor = AgeVerificationService.resolveState(buildUser({ dateOfBirth: buildDateOfBirthForAge(14) }));
    assertThat(minor.state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT, "a Child with no guardian resolves to MINOR_AWAITING_GUARDIAN_CONSENT");
    assertThat(minor.bProcessingAllowed === false, "a Child with no guardian is blocked");

    const consentedMinor = AgeVerificationService.resolveState(buildUser(
    {
        dateOfBirth: buildDateOfBirthForAge(14),
        guardianConsent: Object.assign(buildGuardianDetails(), { recordedAt: new Date().toISOString() })
    }));
    assertThat(consentedMinor.state === ageConsentStates.MINOR_CONSENTED, "a Child with a guardian record resolves to MINOR_CONSENTED");
    assertThat(consentedMinor.bProcessingAllowed === true, "a Child with a guardian record is allowed");

    // A record missing the server-stamped timestamp is a forged or partial
    // write, not a consent.
    const halfConsented = AgeVerificationService.resolveState(buildUser(
    {
        dateOfBirth: buildDateOfBirthForAge(14),
        guardianConsent: buildGuardianDetails()
    }));
    assertThat(halfConsented.bProcessingAllowed === false, "a guardian record with no server timestamp does not unblock");

    const garbageDateOfBirth = AgeVerificationService.resolveState(buildUser({ dateOfBirth: "not-a-date" }));
    assertThat(garbageDateOfBirth.state === ageConsentStates.UNDECLARED, "an unparseable stored date falls back to UNDECLARED rather than allowing");
}

console.log("\n[A-02] Age arithmetic (always runs)\n");

{
    const eighteenthBirthday = Date.UTC(2026, 5, 15);
    assertThat(
        AgeVerificationService.computeAgeYears("2008-06-15", eighteenthBirthday) === 18,
        "on the eighteenth birthday the age is 18",
    );
    assertThat(
        AgeVerificationService.computeAgeYears("2008-06-16", eighteenthBirthday) === 17,
        "the day before the eighteenth birthday the age is still 17",
    );

    // Born on a leap day. A milliseconds-per-year division drifts here; counting
    // completed calendar years does not.
    assertThat(
        AgeVerificationService.computeAgeYears("2008-02-29", Date.UTC(2026, 1, 28)) === 17,
        "a leap-day birth is 17 the day before its 2026 birthday",
    );
    assertThat(
        AgeVerificationService.computeAgeYears("2008-02-29", Date.UTC(2026, 2, 1)) === 18,
        "a leap-day birth is 18 the day after its 2026 birthday",
    );

    assertThat(AgeVerificationService.computeAgeYears(null, Date.now()) === null, "a null date of birth has no age");
    assertThat(AgeVerificationService.computeAgeYears("", Date.now()) === null, "an empty date of birth has no age");
    assertThat(
        AgeVerificationService.computeAgeYears("2099-01-01", Date.UTC(2026, 0, 1)) === null,
        "a future date of birth has no age rather than a negative one",
    );
}

console.log("\n[A-03] Declaration validation (always runs)\n");

{
    const validDeclaration = AgeVerificationService.validateDateOfBirth("2005-03-12", Date.UTC(2026, 7, 8));
    assertThat(validDeclaration.bValid === true, "a plausible date is accepted");
    assertThat(validDeclaration.ageYears === 21, "the accepted date yields the right age");

    assertThat(AgeVerificationService.validateDateOfBirth("12-03-2005", Date.now()).bValid === false, "a non-ISO format is rejected");
    assertThat(AgeVerificationService.validateDateOfBirth("2011-02-31", Date.now()).bValid === false, "a date the calendar does not have is rejected");
    assertThat(AgeVerificationService.validateDateOfBirth("", Date.now()).bValid === false, "an empty string is rejected");
    assertThat(AgeVerificationService.validateDateOfBirth(null, Date.now()).bValid === false, "null is rejected");
    assertThat(AgeVerificationService.validateDateOfBirth("1823-01-01", Date.now()).bValid === false, "an implausibly old date is rejected");
    assertThat(AgeVerificationService.validateDateOfBirth("2099-01-01", Date.now()).bValid === false, "a future date is rejected");

    assertThat(
        AgeVerificationService.validateDateOfBirth("2011-02-31", Date.now()).reason === ErrorCodes.INVALID_DATE_OF_BIRTH,
        "a rejection carries the enumerated reason rather than a bare false",
    );
}

console.log("\n[A-04] Self-assertion defences (always runs)\n");

{
    assertThat(AgeVerificationService.isReservedAgeKey("dateOfBirth") === true, "dateOfBirth is reserved from the generic merge");
    assertThat(AgeVerificationService.isReservedAgeKey("guardianConsent") === true, "guardianConsent is reserved from the generic merge");
    assertThat(AgeVerificationService.isReservedAgeKey("dateOfBirthRecordedAt") === true, "the declaration timestamp is reserved");
    assertThat(AgeVerificationService.isReservedAgeKey("displayName") === false, "an ordinary profile field is not reserved");

    const handlerSource = require("fs").readFileSync(
        path.join(currentDirectory, "Endpoints", "Authentication", "HandleUpdateUserAdditionalData.js"),
        "utf8",
    );
    assertThat(
        handlerSource.includes("AgeVerificationService.isReservedAgeKey"),
        "the generic additionalData merge actually calls the reserved-key check",
    );

    const guardianForAdult = AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails());
    assertThat(guardianForAdult !== null, "complete guardian details normalize");
    assertThat(AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails({ guardianName: "  " })) === null, "a blank guardian name is refused");
    assertThat(AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails({ guardianEmail: "not-an-email" })) === null, "an unusable guardian email is refused");
    assertThat(AgeVerificationService.normalizeGuardianDetails(null) === null, "a missing guardian payload is refused");
    assertThat(
        AgeVerificationService.normalizeGuardianDetails(buildGuardianDetails({ guardianName: "x".repeat(AgeVerificationConstants.GUARDIAN_NAME_MAXIMUM_LENGTH + 1) })) === null,
        "an over-length guardian name is refused",
    );
}

console.log("\n[A-05] Gate allowlist (always runs)\n");

{
    const pluginSource = require("fs").readFileSync(
        path.join(currentDirectory, "Endpoints", "Plugins", "EnsureAgeConsent.js"),
        "utf8",
    );

    for (const requiredPath of ["/age/state", "/age/declaredateofbirth", "/age/guardianconsent", "/logout", "/getuser"])
    {
        assertThat(pluginSource.includes(`"${requiredPath}"`), `the gate allowlists ${requiredPath} so a blocked account can reach it`);
    }

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
            await users.insertOne({ id: fixtureUserId, additionalData: {} });

            const freshUser = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            assertThat(freshUser !== null, "the fixture account is readable through the query engine");

            const minorDateOfBirth = buildDateOfBirthForAge(13);
            const declaration = await AgeVerificationService.recordDateOfBirth(fixtureUserId, freshUser, minorDateOfBirth);
            assertThat(declaration.ok === true, "a first declaration is accepted");
            assertThat(declaration.state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT, "a Child's declaration lands in MINOR_AWAITING_GUARDIAN_CONSENT");

            const afterDeclaration = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            const secondDeclaration = await AgeVerificationService.recordDateOfBirth(fixtureUserId, afterDeclaration, buildDateOfBirthForAge(25));
            assertThat(secondDeclaration.ok === false, "a second declaration is refused");
            assertThat(secondDeclaration.reason === ErrorCodes.DATE_OF_BIRTH_ALREADY_DECLARED, "the refusal names the write-once rule");

            const stillMinor = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            assertThat(
                AgeVerificationService.resolveState(stillMinor).state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT,
                "the refused re-declaration did not age the account up",
            );

            const consentResult = await AgeVerificationService.recordGuardianConsent(fixtureUserId, stillMinor, buildGuardianDetails());
            assertThat(consentResult.ok === true, "guardian consent is accepted for a Child awaiting it");

            const afterConsent = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            const consentedState = AgeVerificationService.resolveState(afterConsent);
            assertThat(consentedState.state === ageConsentStates.MINOR_CONSENTED, "the account is released after consent");
            assertThat(consentedState.bProcessingAllowed === true, "processing is allowed after consent");

            const storedConsent = afterConsent.getAdditionalData().guardianConsent;
            assertThat(typeof storedConsent.recordedAt === "string" && storedConsent.recordedAt.length > 0, "the consent carries a server-stamped timestamp");

            const duplicateConsent = await AgeVerificationService.recordGuardianConsent(fixtureUserId, afterConsent, buildGuardianDetails());
            assertThat(duplicateConsent.ok === false, "consent is refused for an account that is no longer awaiting it");
            assertThat(duplicateConsent.reason === ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE, "the refusal names the state mismatch");

            const consentBeforeDeclaration = await AgeVerificationService.recordGuardianConsent(fixtureUserId, buildUser({}), buildGuardianDetails());
            assertThat(consentBeforeDeclaration.ok === false, "consent before any declaration is refused");
            assertThat(consentBeforeDeclaration.reason === ErrorCodes.AGE_DECLARATION_REQUIRED, "the refusal points back at the declaration step");
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
