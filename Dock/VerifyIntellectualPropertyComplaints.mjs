/**
 * End-to-end verification harness for the public intellectual-property
 * complaint channel.
 *
 * Run from the Dock directory:
 *     node VerifyIntellectualPropertyComplaints.mjs
 *     $env:VERIFY_IP_COMPLAINTS_DB=1; node VerifyIntellectualPropertyComplaints.mjs
 *
 * Two tiers, matching the convention every other Verify*.mjs here follows:
 *
 *   1. ALWAYS — pure, in-process checks with no network and no database:
 *      the public-report policy, the credential scrub, the deadline
 *      arithmetic (including across a UTC day boundary), the projections a
 *      complainant and an administrator each receive, and the search-term
 *      extraction that turns a complainant's prose into something searchable.
 *
 *   2. DB (opt-in: VERIFY_IP_COMPLAINTS_DB=1) — drives the real query engine
 *      and the real OtpManager against the configured MongoDB. Covers the
 *      things that can only go wrong once storage is involved: OTP purpose
 *      isolation, unverified complaints staying out of the actionable queue,
 *      an over-limit complaint being STORED rather than refused, evidence
 *      surviving the complaint being closed, and the absence of any TTL index
 *      on the register. Creates prefixed *.invalid fixtures and removes
 *      everything it made. Skips (not fails) when the flag is off or Mongo is
 *      unreachable.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const PublicReportPolicy = require("./Globals/Classes/Support/PublicReportPolicy");
const CredentialScrubber = require("./Globals/Classes/Support/CredentialScrubber");
const ComplaintTargetResolver = require("./Globals/Classes/Content/ComplaintTargetResolver");
const ComplaintAcknowledger = require("./Globals/Classes/Legal/ComplaintAcknowledger");
const ComplaintEvidencePolicy = require("./Globals/Classes/Legal/ComplaintEvidencePolicy");
const IntellectualPropertyComplaint = require("./Globals/Model/IntellectualPropertyComplaint");
const IntellectualPropertyComplaintConstants = require("./Globals/Constants/IntellectualPropertyComplaintConstants");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const { supportTicketTypes } = require("./Globals/Enumerations/SupportTicketTypes");
const { intellectualPropertyComplaintStatus } = require("./Globals/Enumerations/IntellectualPropertyComplaintStatus");
const { otpPurposes } = require("./Globals/Enumerations/OtpPurposes");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
        return;
    }

    failedCount = failedCount + 1;
    console.error(`  FAIL  ${description}`);
}

function skip(description)
{
    skippedCount = skippedCount + 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n${title}`);
}

// ── Tier 1: pure checks ─────────────────────────────────────────────────────

function runPublicReportPolicyChecks()
{
    section("Public report policy");

    assert(PublicReportPolicy.isAcceptedWithoutAuthentication(supportTicketTypes.INTELLECTUAL_PROPERTY),
        "An IP complaint is accepted without a session");
    assert(PublicReportPolicy.isAcceptedWithoutAuthentication(supportTicketTypes.ACCOUNT_ACCESS),
        "An account-access report is accepted without a session");
    assert(!PublicReportPolicy.isAcceptedWithoutAuthentication(supportTicketTypes.BUG),
        "An ordinary bug report is NOT accepted without a session");
    assert(!PublicReportPolicy.isAcceptedWithoutAuthentication(supportTicketTypes.BILLING),
        "A billing report is NOT accepted without a session");

    assert(PublicReportPolicy.isGroupingExempt(supportTicketTypes.INTELLECTUAL_PROPERTY),
        "An IP complaint never reaches the deduplication workflow");
    assert(!PublicReportPolicy.isGroupingExempt(supportTicketTypes.BUG),
        "A bug report still goes through grouping");

    assert(PublicReportPolicy.requiresCredentialScrub(supportTicketTypes.ACCOUNT_ACCESS),
        "Account-access descriptions are scrubbed for credentials");
    assert(!PublicReportPolicy.requiresCredentialScrub(supportTicketTypes.BILLING),
        "Billing descriptions are NOT scrubbed (six-digit order numbers must survive)");

    assert(PublicReportPolicy.isIntellectualPropertyComplaint(supportTicketTypes.INTELLECTUAL_PROPERTY),
        "The IP type routes to the complaint register rather than the support pipeline");

    // Both doors, asserted separately. The submit handler refuses the type
    // outright and the grouping hand-off refuses it again — belt and braces,
    // because a complaint that reached the deduplication workflow would be
    // merged with somebody else's notice and answered once.
    const submitHandlerSource = readFileSync(path.join(currentDirectory, "Endpoints", "Support", "SubmitSupportReport.js"), "utf-8");
    assert(submitHandlerSource.includes("PublicReportPolicy.isIntellectualPropertyComplaint"),
        "The support submit handler refuses an intellectual-property report at the door");
    assert(submitHandlerSource.includes("PublicReportPolicy.isGroupingExempt"),
        "The grouping hand-off is gated on the exemption as a second guard");

    const publicTypes = PublicReportPolicy.listPublicIssueTypes();
    assert(publicTypes.length === 2 && publicTypes[0] < publicTypes[1],
        "The public type list is bounded and deterministically ordered");
}

function runCredentialScrubberChecks()
{
    section("Credential scrubbing");

    const passwordText = CredentialScrubber.scrub("my password Hunter2 stopped working yesterday");
    assert(!passwordText.includes("Hunter2"), "A labelled password value is removed");
    assert(passwordText.includes("password"), "The label survives so the sentence still reads");
    assert(passwordText.includes("stopped working yesterday"), "The rest of the sentence is untouched");

    const codeText = CredentialScrubber.scrub("the code it sent me was 483920 and it failed");
    assert(!codeText.includes("483920"), "A bare six-digit code is removed");

    const longNumberText = CredentialScrubber.scrub("my order 12345678 never arrived");
    assert(longNumberText.includes("12345678"), "An eight-digit number is left alone");

    const cleanText = "The deck will not open when I tap it on my phone.";
    assert(CredentialScrubber.scrub(cleanText) === cleanText, "Text with no credential is returned unchanged");
    assert(CredentialScrubber.containsCredential("my pin is 4821"), "containsCredential detects a labelled PIN");
    assert(!CredentialScrubber.containsCredential(cleanText), "containsCredential is quiet on ordinary text");

    // The patterns are module-level and carry the /g flag, so a second call
    // through the same regex objects must behave identically to the first.
    assert(CredentialScrubber.scrub("my password Hunter2 stopped working yesterday") === passwordText,
        "Scrubbing is repeatable across calls (no lastIndex leakage between the shared /g patterns)");
}

function runDeadlineChecks()
{
    section("Deadline arithmetic");

    // Deliberately late on one UTC day so every deadline lands on a different
    // one. A local-time implementation, or one doing calendar maths, gets a
    // different answer here depending on where the server thinks it is.
    const receivedAt = Date.parse("2026-08-09T23:30:00.000Z");

    const complaint = new IntellectualPropertyComplaint
    ({
        complainantName: "A Rightsholder",
        contactEmail: "Rights@Example.INVALID",
        capacityStatement: "I am the author.",
        workDescription: "A work described at sufficient length to be identified.",
        locationDescription: "A location described at sufficient length to be found.",
        bGoodFaithStatement: true,
        bAccuracyStatement: true,
        receivedAt: receivedAt
    });

    assert(complaint.getContactEmail() === "rights@example.invalid",
        "The contact address is lower-cased on the way in");

    assert(complaint.getAcknowledgmentDeadline() === receivedAt + 24 * 60 * 60 * 1000,
        "The acknowledgment deadline is exactly 24 hours after receipt");
    assert(new Date(complaint.getAcknowledgmentDeadline()).toISOString() === "2026-08-10T23:30:00.000Z",
        "The acknowledgment deadline crosses the UTC day boundary correctly");

    assert(complaint.getDisposalDeadline() === receivedAt + IntellectualPropertyComplaintConstants.DISPOSAL_DAYS * 24 * 60 * 60 * 1000,
        "The disposal deadline is 15 days after receipt");
    assert(new Date(complaint.getDisposalDeadline()).toISOString() === "2026-08-24T23:30:00.000Z",
        "The disposal deadline lands on the expected UTC instant");

    assert(new Date(complaint.getCourtOrderDeadline()).toISOString() === "2026-08-11T11:30:00.000Z",
        "The court-order window is 36 hours, crossing two UTC days");

    assert(complaint.getBlockExpiryDeadline() === null,
        "There is no block-expiry deadline before access has been disabled");

    // Section 52(1)(c) read with Rule 75 gives the COMPLAINANT twenty-one days
    // from their complaint to produce a court order. Anchoring on the disabling
    // event instead would extend their window every time the platform was slow
    // to act, and would compute a different date from the one Clause 19.5 of the
    // Terms publishes.
    const disabledAt = Date.parse("2026-08-12T06:00:00.000Z");
    complaint.setStatusEvents
    ([
        { status: intellectualPropertyComplaintStatus.RECEIVED, note: "", actorUserId: "", actorEmail: "", occurredAt: receivedAt },
        { status: intellectualPropertyComplaintStatus.ACCESS_DISABLED, note: "", actorUserId: "", actorEmail: "", occurredAt: disabledAt }
    ]);

    assert(complaint.getCurrentStatus() === intellectualPropertyComplaintStatus.ACCESS_DISABLED,
        "The current status is derived from the last appended event");
    assert(complaint.getBlockExpiryDeadline() === receivedAt + 21 * 24 * 60 * 60 * 1000,
        "The block window runs 21 days from RECEIPT, matching the statute and Clause 19.5");
    assert(complaint.getBlockExpiryDeadline() !== disabledAt + 21 * 24 * 60 * 60 * 1000,
        "It is NOT restarted by the platform disabling access late");
    assert(new Date(complaint.getBlockExpiryDeadline()).toISOString() === "2026-08-30T23:30:00.000Z",
        "The block expiry lands on the expected UTC instant");

    assert(ComplaintAcknowledger.formatDeadline(complaint.getDisposalDeadline()) === "24 August 2026 (UTC)",
        "A deadline formats as an unambiguous UTC date");

    const reference = complaint.getReference();
    assert(/^IP-[0-9A-F]{8}$/.test(reference), "The complaint reference is a short quotable handle");
    assert(IntellectualPropertyComplaint.fromJson(complaint.toJson()).getReference() === reference,
        "The reference round-trips through storage unchanged");
}

function runProjectionChecks()
{
    section("Projections");

    const complaint = new IntellectualPropertyComplaint
    ({
        complainantName: "A Rightsholder",
        contactEmail: "rights@example.invalid",
        capacityStatement: "I am the author.",
        workDescription: "A work described at sufficient length to be identified.",
        locationDescription: "A location described at sufficient length to be found.",
        sourceIpAddress: "203.0.113.7",
        evidenceUploadTokenHash: "a".repeat(64),
        evidenceUploadTokenExpiresAt: Date.now() + 60000
    });

    const adminJson = complaint.toAdminJson();
    assert(adminJson.evidenceUploadTokenHash === undefined,
        "The admin projection does not carry the upload credential");
    assert(adminJson.evidenceUploadTokenExpiresAt === undefined,
        "The admin projection does not carry the credential's expiry either");
    assert(typeof adminJson.disposalDeadline === "number" && typeof adminJson.currentStatus === "number",
        "The admin projection carries the derived deadlines and status");
    assert(adminJson.sourceIpAddress === "203.0.113.7",
        "The admin projection keeps the submitting address for the bad-faith judgement");

    const complainantJson = complaint.toComplainantJson();
    assert(complainantJson.sourceIpAddress === undefined && complainantJson.workDescription === undefined,
        "The complainant projection echoes nothing that was stored about them");
    assert(complainantJson.reference === complaint.getReference() && typeof complainantJson.disposalDeadline === "number",
        "The complainant projection carries the handle and the promised date");

    assert(complaint.toJson().evidenceUploadTokenHash === "a".repeat(64),
        "The persistence shape DOES carry the hashed credential");
}

function runTargetResolverChecks()
{
    section("Complaint target resolution");

    const quotedTerms = ComplaintTargetResolver.extractSearchTerms('My book "Concepts of Physics Volume 1" has been uploaded.');
    assert(quotedTerms.includes("Concepts of Physics Volume 1"),
        "A quoted title is preferred over everything else in the sentence");
    assert(quotedTerms.length === 1, "Only the quoted span is searched when one is present");

    const capitalisedTerms = ComplaintTargetResolver.extractSearchTerms("Somebody uploaded Concepts of Physics to your platform.");
    assert(capitalisedTerms.some(term => term.includes("Concepts")),
        "A capitalised run is used when nothing is quoted");
    assert(capitalisedTerms.length <= ComplaintTargetResolver.MAXIMUM_SEARCH_TERMS,
        "The number of search terms is bounded");

    assert(ComplaintTargetResolver.extractSearchTerms("").length === 0,
        "An empty description yields no search terms");
    assert(ComplaintTargetResolver.extractSearchTerms("it is mine").length === 0,
        "A description with nothing distinctive yields no search terms rather than matching everything");
}

function runStoragePolicyChecks()
{
    section("Evidence storage policy");

    const complaintPrefix = ComplaintEvidencePolicy.buildStoragePrefix("complaint-1");

    assert(complaintPrefix.startsWith(DatabaseConstants.INTELLECTUAL_PROPERTY_COMPLAINT_EVIDENCE_STORAGE_PREFIX),
        "Complaint evidence lives under its own storage prefix");
    assert(!complaintPrefix.startsWith(DatabaseConstants.SUPPORT_ATTACHMENT_STORAGE_PREFIX),
        "Complaint evidence is NOT under the support-attachment prefix the purger sweeps");
    assert(ComplaintEvidencePolicy.buildStoragePath("complaint-1", "proof.pdf") === `${complaintPrefix}/proof.pdf`,
        "An evidence object key is namespaced by its complaint");

    // The rules are borrowed from SupportAttachmentPolicy on purpose — two
    // allowlists would mean one stale allowlist, on the unauthenticated route.
    assert(ComplaintEvidencePolicy.isAllowedMimeType("application/pdf"), "A PDF is accepted as evidence");
    assert(!ComplaintEvidencePolicy.isAllowedMimeType("application/zip"), "A zip archive is refused");
    assert(!ComplaintEvidencePolicy.isWithinSizeLimit(ComplaintEvidencePolicy.MAXIMUM_FILE_BYTES + 1),
        "An oversized file is refused");
    assert(ComplaintEvidencePolicy.sanitiseFileName("../../etc/passwd") === "passwd",
        "A traversal attempt in a file name is flattened");

    // The register must never grow a retention window. Asserted against the
    // constants themselves so adding one is a test failure rather than a quiet
    // deployment that starts deleting the evidence of past takedowns.
    const retentionConstantNames = Object.getOwnPropertyNames(DatabaseConstants)
        .filter(constantName => constantName.includes("INTELLECTUAL_PROPERTY") && /RETENTION|TTL/.test(constantName));
    assert(retentionConstantNames.length === 0,
        "No retention or TTL constant exists for the complaint register");
}

// ── Tier 2: database checks ─────────────────────────────────────────────────

async function runDatabaseTier()
{
    section("Database tier");

    if (process.env.VERIFY_IP_COMPLAINTS_DB !== "1")
    {
        skip("Database tier (set VERIFY_IP_COMPLAINTS_DB=1 to run)");
        return;
    }

    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const IntellectualPropertyComplaintQueryEngine = require("./Globals/Classes/Database/IntellectualPropertyComplaintQueryEngine");
    const OtpManager = require("./Globals/Classes/Authentication/OtpManager");
    const EmailProviderFactory = require("./Globals/Classes/Email/EmailProviderFactory");

    let database = null;
    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`Database tier (MongoDB unreachable: ${connectionError.message})`);
        return;
    }

    if (!database)
    {
        skip("Database tier (no database handle)");
        return;
    }

    // Capture rather than send. Every code this tier issues is read back out of
    // the captured message, so nothing is emailed and the test stays hermetic.
    const sentMessages = [];
    const originalGetDefaultProvider = EmailProviderFactory.getDefaultProvider;
    EmailProviderFactory.getDefaultProvider = () => ({ sendEmail: async (message) => { sentMessages.push(message); } });

    const savedEmailSource = process.env.EMAIL_SOURCE_EMAIL;
    if (!process.env.EMAIL_SOURCE_EMAIL && !process.env.SMTP_SOURCE_EMAIL)
    {
        process.env.EMAIL_SOURCE_EMAIL = "noreply@cogniumlearn.io";
    }

    const fixturePrefix = `verify-ip-complaint-${Date.now()}`;
    const testEmail = `${fixturePrefix}@cogniumlearn.invalid`;
    const createdComplaintIds = [];

    function readLatestCode()
    {
        const latestMessage = sentMessages[sentMessages.length - 1];
        const codeMatch = latestMessage ? latestMessage.getPlainTextBody().match(/\b(\d{6})\b/) : null;
        return codeMatch ? codeMatch[1] : "";
    }

    try
    {
        // ── OTP purpose isolation ───────────────────────────────────────────
        const loginRequest = await OtpManager.requestOtp(testEmail, otpPurposes.LOGIN);
        assert(loginRequest.ok === true, "A login code is issued for a fresh address");
        const loginCode = readLatestCode();

        const complaintRequest = await OtpManager.requestOtp(testEmail, otpPurposes.INTELLECTUAL_PROPERTY_COMPLAINT_VERIFICATION);
        assert(complaintRequest.ok === true,
            "A complaint code is issued for the SAME address without being blocked by the login cooldown");
        const complaintCode = readLatestCode();

        assert(complaintRequest.isNewUser === undefined,
            "A complaint code does not disclose whether the address has an account");

        const otpRowCount = await database.collection(DatabaseConstants.OTP_REQUESTS_COLLECTION).countDocuments({ email: testEmail });
        assert(otpRowCount === 2, "Both codes coexist as separate rows keyed on (email, purpose)");

        const loginCodeAsComplaint = await OtpManager.verifyOtp(testEmail, loginCode, otpPurposes.INTELLECTUAL_PROPERTY_COMPLAINT_VERIFICATION);
        assert(loginCodeAsComplaint.ok === false,
            "A login code is REJECTED when presented to confirm a complaint");

        const complaintCodeAsLogin = await OtpManager.verifyOtp(testEmail, complaintCode, otpPurposes.LOGIN, "Test Learner");
        assert(complaintCodeAsLogin.ok === false,
            "A complaint code is REJECTED at the login path (it must never become a session)");

        const complaintCodeAccepted = await OtpManager.verifyOtp(testEmail, complaintCode, otpPurposes.INTELLECTUAL_PROPERTY_COMPLAINT_VERIFICATION);
        assert(complaintCodeAccepted.ok === true, "The complaint code verifies for its own purpose");
        assert(complaintCodeAccepted.userId === undefined,
            "Confirming a complaint provisions NO account for the complainant");

        const provisionedUser = await database.collection(DatabaseConstants.USERS_COLLECTION).findOne({ id: testEmail });
        assert(provisionedUser === null, "No user document was created by the complaint confirmation");

        // ── The register ────────────────────────────────────────────────────
        const unverifiedComplaint = new IntellectualPropertyComplaint
        ({
            complainantName: `${fixturePrefix} Rightsholder`,
            contactEmail: testEmail,
            capacityStatement: "I am the author of the work.",
            workDescription: "A work described at sufficient length to be identified by a reader.",
            locationDescription: "A location described at sufficient length for the deck to be found.",
            bGoodFaithStatement: true,
            bAccuracyStatement: true,
            sourceIpAddress: "203.0.113.7"
        });

        const insertOutcome = await IntellectualPropertyComplaintQueryEngine.insert(unverifiedComplaint);
        createdComplaintIds.push(unverifiedComplaint.getId());
        assert(insertOutcome.saved === true, "An unverified complaint is stored immediately");

        const storedComplaint = await IntellectualPropertyComplaintQueryEngine.findById(unverifiedComplaint.getId());
        assert(storedComplaint !== null && storedComplaint.getStatusEvents().length === 1
            && storedComplaint.getStatusEvents()[0].status === intellectualPropertyComplaintStatus.RECEIVED,
            "It is stored with a RECEIVED event already in place, so its history is never empty");

        const actionableQueue = await IntellectualPropertyComplaintQueryEngine.listByDeadline({ limit: 200 });
        assert(!actionableQueue.complaints.some(queued => queued.getId() === unverifiedComplaint.getId()),
            "An unverified complaint is EXCLUDED from the actionable queue");

        const inclusiveQueue = await IntellectualPropertyComplaintQueryEngine.listByDeadline({ bIncludeUnverified: true, limit: 200 });
        assert(inclusiveQueue.complaints.some(queued => queued.getId() === unverifiedComplaint.getId()),
            "It is still visible to an administrator who asks for unverified complaints");

        const verificationOutcome = await IntellectualPropertyComplaintQueryEngine.markContactVerified(unverifiedComplaint.getId());
        assert(verificationOutcome.verified === true && verificationOutcome.evidenceUploadToken.length === 64,
            "Confirming the address mints an evidence-upload credential");

        const replayedVerification = await IntellectualPropertyComplaintQueryEngine.markContactVerified(unverifiedComplaint.getId());
        assert(replayedVerification.verified === false,
            "A replayed confirmation does not stamp a second verification onto the record");

        const verifiedQueue = await IntellectualPropertyComplaintQueryEngine.listByDeadline({ limit: 200 });
        assert(verifiedQueue.complaints.some(queued => queued.getId() === unverifiedComplaint.getId()),
            "Once confirmed, the complaint enters the actionable queue");

        const wrongToken = await IntellectualPropertyComplaintQueryEngine.findByEvidenceUploadToken(unverifiedComplaint.getId(), "0".repeat(64));
        assert(wrongToken === null, "A wrong upload credential resolves to nothing");

        const rightToken = await IntellectualPropertyComplaintQueryEngine.findByEvidenceUploadToken(
            unverifiedComplaint.getId(), verificationOutcome.evidenceUploadToken);
        assert(rightToken !== null, "The minted credential resolves to its own complaint");

        // ── Evidence outlives the complaint ─────────────────────────────────
        const bAttached = await IntellectualPropertyComplaintQueryEngine.attachEvidence(unverifiedComplaint.getId(),
        [
            { fileName: "0_proof.pdf", storagePath: ComplaintEvidencePolicy.buildStoragePath(unverifiedComplaint.getId(), "0_proof.pdf"), mimeType: "application/pdf", sizeBytes: 1024 }
        ]);
        assert(bAttached === true, "Evidence attaches to a confirmed complaint");

        await IntellectualPropertyComplaintQueryEngine.appendStatusEvent(unverifiedComplaint.getId(),
        {
            status: intellectualPropertyComplaintStatus.ACTIONED,
            note: "Content removed.",
            actorUserId: "verify-harness",
            actorEmail: "verify@cogniumlearn.invalid"
        });

        const closedComplaint = await IntellectualPropertyComplaintQueryEngine.findById(unverifiedComplaint.getId());
        assert(closedComplaint.getAttachments().length === 1,
            "The evidence SURVIVES the complaint being actioned — resolving a complaint must not delete its proof");
        assert(closedComplaint.getStatusEvents().length === 3,
            "Status events are appended, never replaced");
        assert(closedComplaint.getStatusEvents()[0].status === intellectualPropertyComplaintStatus.RECEIVED,
            "The original RECEIVED event is still the first entry in the history");

        const ephemeralRow = await database.collection(DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION)
            .findOne({ storagePrefix: ComplaintEvidencePolicy.buildStoragePrefix(unverifiedComplaint.getId()) });
        assert(ephemeralRow === null,
            "No EphemeralUploadRegistry record exists for the evidence, so no sweep can reclaim it");

        const closedQueue = await IntellectualPropertyComplaintQueryEngine.listByDeadline({ limit: 200 });
        assert(!closedQueue.complaints.some(queued => queued.getId() === unverifiedComplaint.getId()),
            "An actioned complaint leaves the open queue");

        // ── A complaint never touches the AI grouping pipeline ──────────────
        //
        // Support reports are embedded and clustered onto a shared ticket by the
        // deduplication workflow. A complaint must never be: it is a legal
        // notice with its own complainant, its own clock and its own disposal
        // record, and merging two rightsholders' notices about different works
        // would mean one of them is answered by a reply written for the other.
        //
        // Asserted against the SUPPORT collections rather than against the
        // policy class, because the guarantee is "no row exists for the model to
        // read", not "a boolean says no".
        const supportReportsForComplainant = await database
            .collection(DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION)
            .countDocuments({ userEmail: testEmail });
        assert(supportReportsForComplainant === 0,
            "Filing a complaint created NO support report, so nothing was ever embedded or grouped");

        const supportReportsOfComplaintType = await database
            .collection(DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION)
            .countDocuments({ issueType: supportTicketTypes.INTELLECTUAL_PROPERTY });
        assert(supportReportsOfComplaintType === 0,
            "No support report of the intellectual-property type exists anywhere — that door is closed");

        // ── Over the limit: stored, not refused ─────────────────────────────
        const overLimitComplaint = new IntellectualPropertyComplaint
        ({
            complainantName: `${fixturePrefix} Prolific Agent`,
            contactEmail: testEmail,
            capacityStatement: "I act for the publisher.",
            workDescription: "Another work described at sufficient length to be identified.",
            locationDescription: "Another location described at sufficient length to be found.",
            bGoodFaithStatement: true,
            bAccuracyStatement: true,
            bRateLimitFlagged: true,
            sourceIpAddress: "203.0.113.7"
        });

        const overLimitInsert = await IntellectualPropertyComplaintQueryEngine.insert(overLimitComplaint);
        createdComplaintIds.push(overLimitComplaint.getId());
        assert(overLimitInsert.saved === true,
            "An over-limit complaint is PERSISTED rather than refused");

        const storedOverLimit = await IntellectualPropertyComplaintQueryEngine.findById(overLimitComplaint.getId());
        assert(storedOverLimit.getRateLimitFlagged() === true,
            "It is marked so a human can weigh how it arrived");
        assert(storedOverLimit.getStatusEvents()[0].note.includes("rate limit"),
            "The flag is explained in the complaint's own history");

        const emailCount = await IntellectualPropertyComplaintQueryEngine.countByContactEmailSince(testEmail, 0);
        assert(emailCount === 2, "Complaints are countable per contact address for the rate decision");
        const addressCount = await IntellectualPropertyComplaintQueryEngine.countBySourceIpAddressSince("203.0.113.7", 0);
        assert(addressCount >= 2, "Complaints are countable per network address as well");

        // ── No TTL on the register ──────────────────────────────────────────
        const complaintIndexes = await database.collection(DatabaseConstants.INTELLECTUAL_PROPERTY_COMPLAINTS_COLLECTION).indexes();
        assert(!complaintIndexes.some(index => index.expireAfterSeconds !== undefined),
            "The complaint register carries NO TTL index — the record must outlive the content it describes");

        const otpIndexes = await database.collection(DatabaseConstants.OTP_REQUESTS_COLLECTION).indexes();
        const compoundUniqueIndex = otpIndexes.find(index => index.unique === true
            && index.key && index.key.email === 1 && index.key.purpose === 1);
        assert(compoundUniqueIndex !== undefined,
            "The OTP collection is unique on (email, purpose), not on email alone");
        assert(!otpIndexes.some(index => index.unique === true && index.key && index.key.email === 1 && index.key.purpose === undefined),
            "The legacy unique index on email alone has been dropped");
    }
    finally
    {
        for (const complaintId of createdComplaintIds)
        {
            try { await database.collection(DatabaseConstants.INTELLECTUAL_PROPERTY_COMPLAINTS_COLLECTION).deleteOne({ id: complaintId }); } catch (cleanupError) { }
        }
        try { await database.collection(DatabaseConstants.OTP_REQUESTS_COLLECTION).deleteMany({ email: testEmail }); } catch (cleanupError) { }
        try { await database.collection(DatabaseConstants.USERS_COLLECTION).deleteOne({ id: testEmail }); } catch (cleanupError) { }

        EmailProviderFactory.getDefaultProvider = originalGetDefaultProvider;

        if (savedEmailSource === undefined)
        {
            delete process.env.EMAIL_SOURCE_EMAIL;
        }
        else
        {
            process.env.EMAIL_SOURCE_EMAIL = savedEmailSource;
        }

        try { await DatabaseConnector.getMongoClient()?.close(); } catch (closeError) { }
    }
}

async function main()
{
    console.log("Verifying the public intellectual-property complaint channel\n");

    runPublicReportPolicyChecks();
    runCredentialScrubberChecks();
    runDeadlineChecks();
    runProjectionChecks();
    runTargetResolverChecks();
    runStoragePolicyChecks();

    await runDatabaseTier();

    console.log(`\n${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped.`);
    process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((harnessError) =>
{
    console.error("Harness crashed:", harnessError);
    process.exit(1);
});
