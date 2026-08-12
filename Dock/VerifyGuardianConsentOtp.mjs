/**
 * Verification harness for the two-stage guardian-consent flow — the step that
 * turns "a child typed a parent's name into a form" into "somebody reading that
 * parent's inbox supplied a code we sent there".
 *
 * Run from the Dock directory:
 *     node VerifyGuardianConsentOtp.mjs
 *     VERIFY_GUARDIAN_CONSENT_DB=1 node VerifyGuardianConsentOtp.mjs
 *
 * The declaration and the gate around it are pinned by VerifyAgeConsentGate.mjs.
 * This one owns the consent itself.
 *
 * What it pins:
 *
 *   G-01  The notice is IN the email. The guardian never visits the app, so
 *         everything they need in order to decide has to be in the body they
 *         receive: what the product is, what is processed, what supplying the
 *         code means, that it is not a sign-in code, and how to refuse.
 *
 *   G-02  Purpose scoping. A guardian-consent code must not be accepted by the
 *         login endpoint, and a login code must not confirm a consent. This is
 *         the failure that would turn "prove you can read this inbox" into
 *         "here is a session".
 *
 *   G-03  Stage one unblocks nothing. Pending details are inert no matter how
 *         many times they are submitted.
 *
 *   G-04  Stage two verifies against the STORED address, not one supplied in
 *         the request — otherwise a caller could confirm a code issued for one
 *         inbox and have the consent filed against another.
 *
 *   G-05  A child cannot nominate their own address as their guardian's.
 *
 *   G-06  The promotion is complete and one-way: the confirmed record carries
 *         the server's stamp and the method, and the pending record is cleared
 *         so it cannot be promoted twice.
 *
 * Two tiers:
 *
 *   1. ALWAYS — the email body, purpose scoping and wiring, with no database.
 *
 *   2. DB (opt-in: VERIFY_GUARDIAN_CONSENT_DB=1) — drives the real service and
 *      query engine against the configured MongoDB with a throwaway *.invalid
 *      account, and removes it afterwards. The mail send is stubbed throughout
 *      so a verification run never delivers to a real address.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const AgeVerificationService = require("./Globals/Classes/Authentication/AgeVerificationService");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const OtpManager = require("./Globals/Classes/Authentication/OtpManager");
const EmailSender = require("./Globals/Classes/Email/EmailSender");
const EmailTemplate = require("./Globals/Classes/Email/EmailTemplate");
const EmailSenderIdentities = require("./Globals/Classes/Email/EmailSenderIdentities");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");
const { ageConsentStates } = require("./Globals/Enumerations/AgeConsentStates");
const { otpPurposes } = require("./Globals/Enumerations/OtpPurposes");

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

// ── The mail seam ────────────────────────────────────────────────────────────
//
// OtpManager looks EmailSender.sendGuardianConsentCodeEmail up on the shared
// module object at call time, so replacing it here intercepts every send for
// the rest of the run. Two things depend on that: no verification run may put
// mail on the wire, and the plaintext code is only ever visible here — the
// collection stores a sha256 hash, exactly as it should.
const capturedMessages = [];
const capturedGuardianCodes = [];

const realSend = EmailSender.send;
EmailSender.send = async (emailMessage) =>
{
    capturedMessages.push(emailMessage);
};

const realSendGuardianConsentCodeEmail = EmailSender.sendGuardianConsentCodeEmail;
EmailSender.sendGuardianConsentCodeEmail = async (toEmailAddress, sixDigitCode, childDisplayName, expiryMinutes) =>
{
    capturedGuardianCodes.push({ toEmailAddress: toEmailAddress, code: sixDigitCode });
    // Still compose the real message, so the body assertions below are made
    // against what production would actually send rather than against a stub.
    await realSendGuardianConsentCodeEmail.call(EmailSender, toEmailAddress, sixDigitCode, childDisplayName, expiryMinutes);
};

function buildUser(additionalData, displayName = "Fixture Student")
{
    return {
        getAdditionalData: () => additionalData,
        getDisplayName: () => displayName
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

function buildMinorAdditionalData(overrides = {})
{
    const declaredAt = new Date();
    declaredAt.setUTCDate(declaredAt.getUTCDate() - 1);

    return Object.assign(
    {
        declaredAgeYears: 14,
        ageDeclaredAt: declaredAt.toISOString(),
        email: "student@example.invalid"
    }, overrides);
}

console.log("\n[G-01] The consent notice is in the email (always runs)\n");

{
    capturedMessages.length = 0;
    await realSendGuardianConsentCodeEmail.call(EmailSender, "guardian@example.invalid", "123456", "Asha Kumar", 10);

    assertThat(capturedMessages.length === 1, "composing the guardian email produces exactly one message");

    const message = capturedMessages[0];
    const plainTextBody = message.getPlainTextBody ? message.getPlainTextBody() : message.plainTextBody;
    const htmlBody = message.getHtmlBody ? message.getHtmlBody() : message.htmlBody;
    const subject = message.getSubject ? message.getSubject() : message.subject;
    const senderName = message.getSenderName ? message.getSenderName() : message.senderName;

    assertThat(plainTextBody.includes("123456"), "the code is in the plain-text body");
    assertThat(htmlBody.includes("123456"), "the code is in the HTML body");
    assertThat(plainTextBody.includes("Asha Kumar"), "the child is named, so the guardian knows who this is about");

    // The disclosure. Each of these is a thing the guardian cannot find out any
    // other way, because they will never see the app.
    assertThat(/study app|flashcards/i.test(plainTextBody), "the body says what CogniumLearn actually is");
    assertThat(/under 18|data-protection law/i.test(plainTextBody), "the body says why consent is being asked for");
    assertThat(/records your consent|supplying it records/i.test(plainTextBody), "the body says that supplying the code IS the consent");
    assertThat(/NOT a sign-in code/i.test(plainTextBody), "the body distinguishes itself from a sign-in code");
    assertThat(/do nothing/i.test(plainTextBody), "the body states the do-nothing default, so silence is a safe refusal");
    assertThat(/withdraw consent/i.test(plainTextBody), "the body says how to withdraw consent later");
    assertThat(plainTextBody.includes("support@cogniumlabs.io"), "the body carries a working contact address");
    assertThat(/expires in 10 minutes/i.test(plainTextBody), "the body quotes the expiry it was given rather than a hardcoded duplicate");

    assertThat(!/sign-in code is/i.test(subject) && /consent/i.test(subject), "the subject reads as a consent request, not a login");
    assertThat(senderName === EmailSenderIdentities.GUARDIAN_CONSENT, "it is sent under the parental-consent identity, not Security");
    assertThat(senderName !== EmailSenderIdentities.SECURITY, "it is NOT sent under the Security identity, which reads as a break-in attempt");

    // Reuses the shared chrome rather than inventing an email layout: the same
    // brand header, code block and company signature every other code email
    // carries. Asserted against what EmailTemplate itself produces, so a change
    // to the shared template cannot silently leave this email behind.
    assertThat(htmlBody.includes(EmailTemplate.brandHeader()), "the shared brand header is used");
    assertThat(htmlBody.includes(EmailTemplate.codeBlock("123456")), "the shared code block is used");
    assertThat(htmlBody.includes(EmailTemplate.companySignature()), "the shared company signature is used");
    assertThat(
        htmlBody.includes(EmailTemplate.heading("A parent's or guardian's consent is needed")),
        "the heading names what is being asked for",
    );
}

console.log("\n[G-02] Purpose scoping and wiring (always runs)\n");

{
    assertThat(typeof otpPurposes.GUARDIAN_CONSENT_VERIFICATION === "number", "the guardian-consent purpose is enumerated");
    assertThat(
        otpPurposes.GUARDIAN_CONSENT_VERIFICATION !== otpPurposes.LOGIN
        && otpPurposes.GUARDIAN_CONSENT_VERIFICATION !== otpPurposes.INTELLECTUAL_PROPERTY_COMPLAINT_VERIFICATION,
        "it is distinct from every other purpose, so codes cannot be crossed between them",
    );

    const otpManagerSource = require("fs").readFileSync(
        path.join(currentDirectory, "Globals", "Classes", "Authentication", "OtpManager.js"),
        "utf8",
    );
    assertThat(
        otpManagerSource.includes("sendGuardianConsentCodeEmail"),
        "OtpManager routes the guardian purpose to the guardian email rather than the sign-in one",
    );
    // The login signup path must stay behind the LOGIN check, or confirming a
    // consent would provision an account for the parent.
    assertThat(
        otpManagerSource.includes("if (effectivePurpose !== otpPurposes.LOGIN)"),
        "only the LOGIN purpose runs the account-provisioning path",
    );

    const serviceSource = require("fs").readFileSync(
        path.join(currentDirectory, "Globals", "Classes", "Authentication", "AgeVerificationService.js"),
        "utf8",
    );
    assertThat(
        serviceSource.includes("otpPurposes.GUARDIAN_CONSENT_VERIFICATION"),
        "the service issues and checks codes under the guardian purpose",
    );
    assertThat(
        !serviceSource.includes("otpPurposes.LOGIN"),
        "the service never touches the LOGIN purpose",
    );

    const verifyEndpointSource = require("fs").readFileSync(
        path.join(currentDirectory, "Endpoints", "Age", "VerifyGuardianConsentCode.js"),
        "utf8",
    );
    assertThat(
        !verifyEndpointSource.includes("guardianEmail"),
        "the verify endpoint accepts no address from the request body — only the code",
    );
}

console.log("\n[G-03] Eligibility, before any database (always runs)\n");

{
    const adult = buildUser({ declaredAgeYears: 30, ageDeclaredAt: new Date().toISOString() });
    const adultRequest = await AgeVerificationService.recordPendingGuardianDetails("someone", adult, buildGuardianDetails());
    assertThat(adultRequest.ok === false, "an adult cannot request a guardian consent code");
    assertThat(adultRequest.reason === ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE, "the refusal names the state mismatch");

    const undeclared = buildUser({});
    const undeclaredRequest = await AgeVerificationService.recordPendingGuardianDetails("someone", undeclared, buildGuardianDetails());
    assertThat(undeclaredRequest.ok === false, "an undeclared account cannot request a guardian consent code");
    assertThat(undeclaredRequest.reason === ErrorCodes.AGE_DECLARATION_REQUIRED, "the refusal points back at the declaration step");

    // G-05: the laziest bypass there is.
    const minor = buildUser(buildMinorAdditionalData());
    const selfNominated = await AgeVerificationService.recordPendingGuardianDetails("someone", minor,
        buildGuardianDetails({ guardianEmail: "student@example.invalid" }));
    assertThat(selfNominated.ok === false, "a child cannot nominate their own address as their guardian's");
    assertThat(selfNominated.reason === ErrorCodes.GUARDIAN_EMAIL_SAME_AS_ACCOUNT, "the refusal says which rule was hit");

    const selfNominatedDifferentCase = await AgeVerificationService.recordPendingGuardianDetails("someone", minor,
        buildGuardianDetails({ guardianEmail: "Student@Example.Invalid" }));
    assertThat(selfNominatedDifferentCase.ok === false, "the self-nomination check is case-insensitive");

    // Confirming with nothing pending must not fall through to a success.
    const noPending = await AgeVerificationService.confirmGuardianConsent("someone", minor, "123456");
    assertThat(noPending.ok === false, "confirming with no pending request is refused");
    assertThat(noPending.reason === ErrorCodes.GUARDIAN_CONSENT_CODE_NOT_REQUESTED, "the refusal says no code was requested");
}

console.log("\n[G-04] Full two-stage flow against MongoDB (opt-in)\n");

if ((process.env.VERIFY_GUARDIAN_CONSENT_DB || "") !== "1")
{
    skip("VERIFY_GUARDIAN_CONSENT_DB is not 1 — database tier not run");
}
else
{
    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

    const fixtureUserId = "verify-guardian-consent-user.invalid";
    const fixtureGuardianEmail = "verify-guardian-consent-guardian@example.invalid";
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
        const otpRequests = database.collection(DatabaseConstants.OTP_REQUESTS_COLLECTION);

        try
        {
            await users.insertOne(
            {
                id: fixtureUserId,
                displayName: "Fixture Student",
                additionalData: buildMinorAdditionalData({ email: `${fixtureUserId}@example.invalid` })
            });

            const minorUser = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            assertThat(
                AgeVerificationService.resolveState(minorUser).state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT,
                "the fixture account starts awaiting guardian consent",
            );

            // ── Stage one ────────────────────────────────────────────────────
            capturedGuardianCodes.length = 0;
            const requestResult = await AgeVerificationService.recordPendingGuardianDetails(
                fixtureUserId, minorUser, buildGuardianDetails({ guardianEmail: fixtureGuardianEmail }));

            assertThat(requestResult.ok === true, "stage one is accepted for a Child awaiting consent");
            assertThat(capturedGuardianCodes.length === 1, "exactly one code was emailed");
            assertThat(capturedGuardianCodes[0].toEmailAddress === fixtureGuardianEmail, "the code went to the guardian's address");

            const issuedCode = capturedGuardianCodes[0].code;
            assertThat(/^\d{6}$/.test(issuedCode), "the issued code is six digits");

            const storedOtp = await otpRequests.findOne({ email: fixtureGuardianEmail, purpose: otpPurposes.GUARDIAN_CONSENT_VERIFICATION });
            assertThat(storedOtp !== null, "the code is filed under the guardian purpose");
            assertThat(storedOtp.codeHash !== issuedCode, "the plaintext code is NOT stored — only its hash");

            // G-03: the whole point of the split.
            const afterRequest = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            const afterRequestState = AgeVerificationService.resolveState(afterRequest);
            assertThat(afterRequestState.state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT, "stage one leaves the account awaiting consent");
            assertThat(afterRequestState.bProcessingAllowed === false, "stage one does NOT unblock the account");
            assertThat(afterRequest.getAdditionalData().guardianConsent === undefined, "stage one writes no confirmed consent record");
            assertThat(
                afterRequest.getAdditionalData().guardianConsentPending.guardianEmail === fixtureGuardianEmail,
                "stage one stores the details as pending",
            );

            // G-02: the code must not be usable as a login.
            const crossPurposeLogin = await OtpManager.verifyOtp(fixtureGuardianEmail, issuedCode, otpPurposes.LOGIN);
            assertThat(crossPurposeLogin.ok === false, "a guardian-consent code is refused by the LOGIN purpose");
            assertThat(crossPurposeLogin.userId === undefined, "the refused cross-purpose attempt provisioned no account");

            const guardianAccount = await users.findOne({ id: fixtureGuardianEmail });
            assertThat(!guardianAccount, "no account was created for the guardian");

            // ── Stage two ────────────────────────────────────────────────────
            const wrongCode = await AgeVerificationService.confirmGuardianConsent(fixtureUserId, afterRequest, issuedCode === "000000" ? "111111" : "000000");
            assertThat(wrongCode.ok === false, "a wrong code is refused");
            assertThat(wrongCode.reason === ErrorCodes.INVALID_CODE, "the refusal names the bad code");
            assertThat(typeof wrongCode.attemptsRemaining === "number", "the refusal reports the attempts left");

            const stillBlocked = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            assertThat(
                AgeVerificationService.resolveState(stillBlocked).bProcessingAllowed === false,
                "a failed confirmation leaves the account blocked",
            );

            const confirmResult = await AgeVerificationService.confirmGuardianConsent(fixtureUserId, stillBlocked, issuedCode);
            assertThat(confirmResult.ok === true, "the correct code is accepted");
            assertThat(confirmResult.state === ageConsentStates.MINOR_CONSENTED, "the account moves to MINOR_CONSENTED");

            const afterConfirm = await AuthenticationQueryEngine.getUserById(fixtureUserId);
            const confirmedState = AgeVerificationService.resolveState(afterConfirm);
            assertThat(confirmedState.state === ageConsentStates.MINOR_CONSENTED, "the stored record reads back as consented");
            assertThat(confirmedState.bProcessingAllowed === true, "processing is allowed after confirmation");

            // G-06
            const storedConsent = afterConfirm.getAdditionalData().guardianConsent;
            assertThat(storedConsent.guardianEmail === fixtureGuardianEmail, "the confirmed record names the address the code was sent to");
            assertThat(typeof storedConsent.recordedAt === "string" && storedConsent.recordedAt.length > 0, "the consent carries a server-stamped timestamp");
            assertThat(storedConsent.verificationMethod === "EMAIL_CODE", "the consent records HOW it was obtained, not just that it was");

            const clearedPending = afterConfirm.getAdditionalData().guardianConsentPending;
            assertThat(!clearedPending, "the pending record is cleared, so it cannot be promoted twice");

            const burnedOtp = await otpRequests.findOne({ email: fixtureGuardianEmail, purpose: otpPurposes.GUARDIAN_CONSENT_VERIFICATION });
            assertThat(!burnedOtp, "the code is consumed on success and cannot be replayed");

            const replay = await AgeVerificationService.confirmGuardianConsent(fixtureUserId, afterConfirm, issuedCode);
            assertThat(replay.ok === false, "confirming again is refused");
            assertThat(replay.reason === ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE, "the replay refusal names the state mismatch");
        }
        finally
        {
            await users.deleteMany({ id: fixtureUserId });
            await otpRequests.deleteMany({ email: fixtureGuardianEmail });
            console.log("  ....  fixtures removed");
        }
    }
}

EmailSender.send = realSend;
EmailSender.sendGuardianConsentCodeEmail = realSendGuardianConsentCodeEmail;

console.log(`\n${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped\n`);
process.exit(failedCount === 0 ? 0 : 1);
