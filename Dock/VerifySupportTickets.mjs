/**
 * End-to-end verification harness for the support-ticket subsystem (the in-app
 * Report Issue flow, AI deduplication, and the resolve / decline fan-out).
 *
 * Run from the Dock directory:
 *     node VerifySupportTickets.mjs
 *
 * Two tiers, so the default run needs no external services:
 *
 *   1. ALWAYS — pure, in-process checks driven through monkeypatched static
 *      seams: the size ceilings and word-boundary clamping, the attachment
 *      policy (MIME allow-list, byte cap, filename sanitisation, storage path),
 *      the model round-trips, the daily submission quota, and — the important
 *      ones — the resolution fan-out's idempotence, its opt-in gating, and its
 *      resumability after an interrupted dispatch.
 *
 *   2. DB (opt-in: VERIFY_SUPPORT_DB=1) — drives the real
 *      SupportTicketQueryEngine against the configured MongoDB: insert a report,
 *      count it against the quota, claim a ticket atomically (and prove the
 *      second claim fails), and summarise reporters. Creates throwaway rows
 *      prefixed "verify-" and deletes them. Skips if the flag is off or Mongo is
 *      unreachable.
 *
 * The scenarios that matter most here are the money-and-mail ones: a ticket must
 * never grant credits twice, and must never email someone who did not ask to be
 * emailed.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const SupportTicketLimits = require("./Globals/Classes/Support/SupportTicketLimits");
const SupportAttachmentPolicy = require("./Globals/Classes/Support/SupportAttachmentPolicy");
const SupportTicketQuota = require("./Globals/Classes/Support/SupportTicketQuota");
const SupportTicketResolutionDispatcher = require("./Globals/Classes/Support/SupportTicketResolutionDispatcher");
const SupportTicketDispatchReconciler = require("./Globals/Classes/Support/SupportTicketDispatchReconciler");
const SupportTicketQueryEngine = require("./Globals/Classes/Database/SupportTicketQueryEngine");
const LogEventQueryEngine = require("./Globals/Classes/Logging/LogEventQueryEngine");
const LogExportService = require("./Globals/Classes/Logging/LogExportService");
const CreditLedger = require("./Globals/Classes/Credits/CreditLedger");
const EmailSender = require("./Globals/Classes/Email/EmailSender");
const EmailTemplate = require("./Globals/Classes/Email/EmailTemplate");
const NotificationDispatcher = require("./Globals/Classes/Notifications/NotificationDispatcher");
const NotificationContent = require("./Globals/Classes/Notifications/NotificationContent");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const SupportTicket = require("./Globals/Model/SupportTicket");
const SupportTicketReport = require("./Globals/Model/SupportTicketReport");
const { supportTicketStatus } = require("./Globals/Enumerations/SupportTicketStatus");
const { supportTicketTypes } = require("./Globals/Enumerations/SupportTicketTypes");
const { supportTicketReportStatus } = require("./Globals/Enumerations/SupportTicketReportStatus");
const { notificationTypes } = require("./Globals/Enumerations/NotificationTypes");
const { creditTransactionTypes } = require("./Globals/Enumerations/CreditTransactionTypes");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

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
 * @param {object} overrides
 * @returns {SupportTicketReport}
 */
function buildReport(overrides = {})
{
    return new SupportTicketReport(Object.assign
    ({
        userId: "user-1",
        userEmail: "reporter@example.com",
        ticketId: "ticket-1",
        issueType: supportTicketTypes.BUG,
        description: "Flashcard generation stalls on scanned PDFs and never finishes.",
        bNotifyOnResolution: true,
        createdAt: Date.now()
    }, overrides));
}

/**
 * @param {object} overrides
 * @returns {SupportTicket}
 */
function buildTicket(overrides = {})
{
    return new SupportTicket(Object.assign
    ({
        id: "ticket-1",
        title: "Flashcard generation stalls on scanned PDFs",
        description: "Generation never completes when the source is a scanned PDF.",
        issueType: supportTicketTypes.BUG,
        status: supportTicketStatus.RESOLVED,
        reportCount: 3,
        resolutionMessage: "Fixed the OCR timeout that stalled the pipeline.",
        creditsPerReporter: 5
    }, overrides));
}

// ── Tier 1 ──────────────────────────────────────────────────────────────────

function runLimitChecks()
{
    section("Tier 1 — size ceilings and clamping");

    assert(SupportTicketLimits.MINIMUM_DESCRIPTION_LENGTH < SupportTicketLimits.MAXIMUM_DESCRIPTION_LENGTH, "The description floor is below its ceiling");
    assert(SupportTicketLimits.MAXIMUM_TICKET_DESCRIPTION_LENGTH >= SupportTicketLimits.MAXIMUM_DESCRIPTION_LENGTH,
        "A merged ticket may hold at least as much text as one report (otherwise the first merge would truncate)");

    const shortText = "already short enough";
    assert(SupportTicketLimits.clampToWordBoundary(shortText, 100) === shortText, "Text within the limit is returned untouched");

    const clamped = SupportTicketLimits.clampToWordBoundary("alpha beta gamma delta epsilon", 20);
    assert(clamped.length <= 20, "Clamped text respects the ceiling");
    assert(!clamped.endsWith(" ") && clamped.split(" ").every(word => "alpha beta gamma delta epsilon".includes(word)), "Clamped text ends on a whole word");

    // A single unbroken token has no word boundary to honour; it must still be
    // cut rather than collapsing to an empty string.
    const singleToken = SupportTicketLimits.clampToWordBoundary("A".repeat(50), 10);
    assert(singleToken.length === 10, "A single long token is hard-truncated rather than emptied");

    // Model-level clamping is the last line of defence for values read back from
    // storage or produced by the LLM.
    const overlongTicket = new SupportTicket({ title: "T".repeat(500), description: "D".repeat(20000) });
    assert(overlongTicket.getTitle().length <= SupportTicketLimits.MAXIMUM_TITLE_LENGTH, "SupportTicket clamps an overlong title");
    assert(overlongTicket.getDescription().length <= SupportTicketLimits.MAXIMUM_TICKET_DESCRIPTION_LENGTH, "SupportTicket clamps an overlong description");

    const saturatedAspects = Array.from({ length: 80 }, (unusedValue, aspectIndex) => ({ text: `aspect ${aspectIndex}`, addedAt: Date.now(), reportId: "r" }));
    const saturatedTicket = new SupportTicket({ aspects: saturatedAspects });
    assert(saturatedTicket.getAspects().length === SupportTicketLimits.MAXIMUM_ASPECTS_PER_TICKET, "Aspects are capped at the per-ticket ceiling");
    assert(saturatedTicket.isAspectSaturated() === true, "A ticket at the aspect ceiling reports itself as saturated");
    assert(saturatedTicket.toClientJson().bAspectSaturated === true, "Saturation is surfaced to the admin client");
}

function runAttachmentPolicyChecks()
{
    section("Tier 1 — attachment policy");

    assert(SupportAttachmentPolicy.isAllowedMimeType("image/png"), "PNG is allowed");
    assert(SupportAttachmentPolicy.isAllowedMimeType("application/pdf"), "PDF is allowed");
    assert(SupportAttachmentPolicy.isAllowedMimeType("IMAGE/JPEG"), "MIME matching is case-insensitive");
    assert(!SupportAttachmentPolicy.isAllowedMimeType("application/x-msdownload"), "An executable MIME type is refused");
    assert(!SupportAttachmentPolicy.isAllowedMimeType("text/html"), "HTML is refused");
    assert(!SupportAttachmentPolicy.isAllowedMimeType(""), "A missing MIME type is refused rather than defaulted");

    // An executable renamed to .png declares no usable type, so the extension
    // fallback resolves image/png — which is exactly why the server must not
    // trust the browser. The policy's job here is only to be deterministic.
    assert(SupportAttachmentPolicy.resolveMimeType("", "payload.png") === "image/png", "A blank declared type falls back to the extension");
    assert(SupportAttachmentPolicy.resolveMimeType("image/png; charset=binary", "x.png") === "image/png", "Charset parameters are stripped from the declared type");
    assert(SupportAttachmentPolicy.resolveMimeType("", "payload.exe") === "", "An unmapped extension resolves to nothing (and is therefore refused)");

    assert(SupportAttachmentPolicy.isWithinSizeLimit(1024), "A small file is within the size limit");
    assert(!SupportAttachmentPolicy.isWithinSizeLimit(SupportAttachmentPolicy.MAXIMUM_FILE_BYTES + 1), "An 11 MB file exceeds the size limit");
    assert(!SupportAttachmentPolicy.isWithinSizeLimit(0), "A zero-byte file is refused");

    assert(SupportAttachmentPolicy.sanitiseFileName("../../etc/passwd") === "passwd", "Directory traversal is stripped from the file name");
    assert(SupportAttachmentPolicy.sanitiseFileName("C:\\Users\\me\\shot.png") === "shot.png", "A Windows path is reduced to its base name");
    assert(SupportAttachmentPolicy.sanitiseFileName("a b;c&d.png") === "a_b_c_d.png", "Unsafe characters are replaced");
    assert(SupportAttachmentPolicy.sanitiseFileName("") === "attachment", "A blank name falls back to a constant");
    assert(SupportAttachmentPolicy.sanitiseFileName("x".repeat(400)).length <= SupportAttachmentPolicy.MAXIMUM_FILE_NAME_LENGTH, "A very long name is truncated");

    const storagePath = SupportAttachmentPolicy.buildStoragePath("report-9", "0_shot.png");
    assert(storagePath === "SupportAttachments/report-9/0_shot.png", "The storage path is namespaced by report id");
}

function runMultipartContractChecks()
{
    section("Tier 1 — multipart contract (the shape packetron actually delivers)");

    const require2 = createRequire(import.meta.url);
    const { PacketronHandlerFlags } = require2("@gamiumgamers/packetron");

    // The submit route MUST use MULTIPART_FORM_DATA, not the FILE_UPLOAD flag the
    // information-source upload uses. FILE_UPLOAD's handler ignores multipart
    // field events entirely (so issueType / description would never arrive),
    // overwrites files[fieldname] instead of accumulating repeated names (so only
    // the last attachment would survive), and ignores multipartOptions (so no
    // limits would be enforced). This assertion pins that choice.
    const handleSupportSource = require2("fs").readFileSync(path.join(currentDirectory, "Endpoints/HandleSupportEndpoints.js"), "utf-8");
    assert(handleSupportSource.includes("PacketronHandlerFlags.MULTIPART_FORM_DATA"), "The submit route uses MULTIPART_FORM_DATA (fields + repeated files + limits)");
    assert(!handleSupportSource.includes("flags: PacketronHandlerFlags.FILE_UPLOAD"), "The submit route does NOT use FILE_UPLOAD (which would silently drop every form field)");
    assert(PacketronHandlerFlags.MULTIPART_FORM_DATA !== PacketronHandlerFlags.FILE_UPLOAD, "The two multipart flags are genuinely distinct");

    // Multipart parts arrive as objects carrying their own name/type/size, and a
    // repeated field name collapses to an array while a single one does not.
    const submitModule = require2("./Endpoints/Support/SubmitSupportReport.js");
    assert(typeof submitModule.submitSupportReport === "function", "The submit handler is exported");

    const submitSource = require2("fs").readFileSync(path.join(currentDirectory, "Endpoints/Support/SubmitSupportReport.js"), "utf-8");
    assert(submitSource.includes("uploadedFile.path"), "Attachments are read from the entry's .path (packetron stores an object, not a bare string)");
    assert(submitSource.includes("uploadedFile.filename") && submitSource.includes("uploadedFile.mimeType"),
        "The file name and MIME type come from the multipart part headers, not from parallel form fields correlated by index");
    assert(submitSource.includes("Array.isArray(fieldValue)"), "Both the single-file and repeated-file shapes are handled");
}

function runModelChecks()
{
    section("Tier 1 — model round-trips");

    const report = buildReport();
    const roundTripped = SupportTicketReport.fromJson(report.toJson());
    assert(roundTripped.getId() === report.getId(), "Report id survives a JSON round-trip");
    assert(roundTripped.getUserEmail() === report.getUserEmail(), "Snapshotted reporter email survives a round-trip");
    assert(roundTripped.getNotifyOnResolution() === true, "The notify flag survives a round-trip");
    assert(typeof report.toJson().createdAtIsoString === "string", "createdAtIsoString is denormalised for the admin date filter");

    // The checkbox arrives from a multipart form as a string, not a boolean.
    assert(new SupportTicketReport({ bNotifyOnResolution: "true" }).getNotifyOnResolution() === true, "The string \"true\" from a form field is coerced to true");
    assert(new SupportTicketReport({ bNotifyOnResolution: "false" }).getNotifyOnResolution() === false, "The string \"false\" from a form field is coerced to false");
    assert(new SupportTicketReport({ bNotifyOnResolution: undefined }).getNotifyOnResolution() === false, "A missing notify flag defaults to NOT notifying");

    const ticket = buildTicket();
    assert(SupportTicket.fromJson(ticket.toJson()).getReportCount() === 3, "Reporter count survives a JSON round-trip");
    assert(ticket.toClientJson().embedding === undefined, "The 768-float embedding is stripped from the client projection");
    assert(new SupportTicket({ status: supportTicketStatus.ACTIVE }).isActive() === true, "An ACTIVE ticket reports itself as active");
    assert(new SupportTicket({ reportCount: -5 }).getReportCount() === 0, "A negative reporter count is floored at zero");
}

async function runQuotaChecks()
{
    section("Tier 1 — daily submission quota");

    const originalCount = SupportTicketQueryEngine.countReportsForUserSince;
    const originalList = SupportTicketQueryEngine.listReportsForUser;

    try
    {
        SupportTicketQueryEngine.countReportsForUserSince = async () => 0;
        const freshOutcome = await SupportTicketQuota.check("user-1");
        assert(freshOutcome.allowed === true, "A user with no reports today is allowed");
        assert(freshOutcome.remaining === SupportTicketQuota.MAXIMUM_REPORTS_PER_DAY, "A fresh allowance reports the full remaining count");

        SupportTicketQueryEngine.countReportsForUserSince = async () => SupportTicketQuota.MAXIMUM_REPORTS_PER_DAY - 1;
        const lastSlotOutcome = await SupportTicketQuota.check("user-1");
        assert(lastSlotOutcome.allowed === true, "The final slot in the window is still allowed");
        assert(lastSlotOutcome.remaining === 1, "One slot remaining is reported accurately");

        // The third report of the day is the rejection that actually matters.
        SupportTicketQueryEngine.countReportsForUserSince = async () => SupportTicketQuota.MAXIMUM_REPORTS_PER_DAY;
        const oldestCreatedAt = Date.now() - (2 * 60 * 60 * 1000);
        SupportTicketQueryEngine.listReportsForUser = async () =>
        [
            { createdAt: Date.now() - (1 * 60 * 60 * 1000) },
            { createdAt: oldestCreatedAt }
        ];

        const exceededOutcome = await SupportTicketQuota.check("user-1");
        assert(exceededOutcome.allowed === false, "A third report in the window is refused");
        assert(exceededOutcome.remaining === 0, "An exhausted allowance reports zero remaining");
        assert(exceededOutcome.retryAfterSeconds > 0, "A refusal reports when a slot frees up");

        // The retry hint must point at the OLDEST report leaving the window, not
        // a full window from now — otherwise it over-states the wait.
        const expectedRetrySeconds = Math.ceil((oldestCreatedAt + SupportTicketQuota.WINDOW_MILLISECONDS - Date.now()) / 1000);
        assert(Math.abs(exceededOutcome.retryAfterSeconds - expectedRetrySeconds) <= 2, "The retry delay is measured from the oldest report in the window");
    }
    finally
    {
        SupportTicketQueryEngine.countReportsForUserSince = originalCount;
        SupportTicketQueryEngine.listReportsForUser = originalList;
    }
}

async function runFanOutChecks()
{
    section("Tier 1 — resolution fan-out (credits, opt-in gating, resumability)");

    const originalSummarise = SupportTicketQueryEngine.summariseReporters;
    const originalListUndispatched = SupportTicketQueryEngine.listUndispatchedReports;
    const originalMarkDispatched = SupportTicketQueryEngine.markReportDispatched;
    const originalUpdateDispatchState = SupportTicketQueryEngine.updateDispatchState;
    const originalGrant = CreditLedger.grant;
    const originalResolvedEmail = EmailSender.sendSupportTicketResolvedEmail;
    const originalDeclinedEmail = EmailSender.sendSupportTicketDeclinedEmail;
    const originalDispatch = NotificationDispatcher.dispatch;

    try
    {
        const optedIn = buildReport({ id: "report-optin", userId: "user-optin", userEmail: "optin@example.com", bNotifyOnResolution: true });
        const optedOut = buildReport({ id: "report-optout", userId: "user-optout", userEmail: "optout@example.com", bNotifyOnResolution: false });

        let remainingReports = [optedIn, optedOut];
        const grantReferenceKeys = [];
        const emailedAddresses = [];
        const notifiedUserIds = [];
        let lastDispatchState = null;

        SupportTicketQueryEngine.summariseReporters = async () => ({ reporterCount: 2, notifyOptInCount: 1, reportRowCount: 2 });
        SupportTicketQueryEngine.listUndispatchedReports = async () =>
        {
            const batch = remainingReports;
            remainingReports = [];
            return batch;
        };
        SupportTicketQueryEngine.markReportDispatched = async () => true;
        SupportTicketQueryEngine.updateDispatchState = async (ticketId, dispatchState) => { lastDispatchState = dispatchState; };
        CreditLedger.grant = async (userId, amount, transactionType, referenceKey) =>
        {
            grantReferenceKeys.push({ referenceKey, transactionType, amount });
            return { applied: true, alreadyApplied: false, amount: amount };
        };
        EmailSender.sendSupportTicketResolvedEmail = async (toEmailAddress) => { emailedAddresses.push(toEmailAddress); };
        NotificationDispatcher.dispatch = async (userId) => { notifiedUserIds.push(userId); return {}; };

        const outcome = await SupportTicketResolutionDispatcher.dispatch(buildTicket());

        assert(outcome.processedCount === 2, "Every reporter is processed");
        assert(outcome.creditedCount === 2, "BOTH reporters are credited, including the one who declined notification");
        assert(emailedAddresses.length === 1 && emailedAddresses[0] === "optin@example.com", "ONLY the opt-in reporter is emailed");
        assert(!emailedAddresses.includes("optout@example.com"), "The opt-out reporter is never emailed");
        assert(notifiedUserIds.length === 1 && notifiedUserIds[0] === "user-optin", "Only the opt-in reporter receives an in-app notification");

        // The reference key is what makes a replay safe — it must be scoped to
        // the (ticket, user) pair so CreditLedger refuses a second application.
        assert(grantReferenceKeys.every(entry => entry.referenceKey.startsWith("supportTicket:ticket-1:")), "Credit grants are keyed on ticket + user for idempotence");
        assert(new Set(grantReferenceKeys.map(entry => entry.referenceKey)).size === 2, "Each reporter gets a distinct reference key");
        assert(grantReferenceKeys.every(entry => entry.transactionType === creditTransactionTypes.SUPPORT_TICKET_GRANT), "Grants are recorded as SUPPORT_TICKET_GRANT");
        assert(lastDispatchState !== null && lastDispatchState.completedAt !== null, "A completed fan-out stamps completedAt so the reconciler skips it");

        // Declining must not pay anybody.
        remainingReports = [optedIn, optedOut];
        grantReferenceKeys.length = 0;
        const declinedEmails = [];
        EmailSender.sendSupportTicketDeclinedEmail = async (toEmailAddress) => { declinedEmails.push(toEmailAddress); };

        const declineOutcome = await SupportTicketResolutionDispatcher.dispatch(buildTicket({ status: supportTicketStatus.DECLINED, creditsPerReporter: 0, declineMessage: "Working as intended." }));
        assert(declineOutcome.creditedCount === 0, "A declined ticket grants no credits");
        assert(grantReferenceKeys.length === 0, "A declined ticket never calls the credit ledger");
        assert(declinedEmails.length === 1 && declinedEmails[0] === "optin@example.com", "Only the opt-in reporter receives the decline note");

        // Resumability: a reporter already stamped notifiedAt is not returned by
        // listUndispatchedReports, so a replay reaches nobody twice.
        remainingReports = [];
        const replayOutcome = await SupportTicketResolutionDispatcher.dispatch(buildTicket());
        assert(replayOutcome.processedCount === 0, "Re-dispatching a fully-notified ticket reaches nobody a second time");

        // A zero-credit resolution is still a valid resolution.
        remainingReports = [optedIn];
        grantReferenceKeys.length = 0;
        const freeOutcome = await SupportTicketResolutionDispatcher.dispatch(buildTicket({ creditsPerReporter: 0 }));
        assert(freeOutcome.processedCount === 1 && freeOutcome.creditedCount === 0, "A resolution with no reward still notifies without granting credits");

        // A failed email must not cost the reporter their credits, nor stall the
        // rest of the ticket.
        remainingReports = [optedIn, optedOut];
        grantReferenceKeys.length = 0;
        EmailSender.sendSupportTicketResolvedEmail = async () => { throw new Error("SES unavailable"); };
        const degradedOutcome = await SupportTicketResolutionDispatcher.dispatch(buildTicket());
        assert(degradedOutcome.processedCount === 2, "An email failure does not abort the fan-out");
        assert(degradedOutcome.creditedCount === 2, "An email failure does not cost reporters their credits");

        // ── One person, two reports on the same ticket ──────────────────────
        // The daily quota allows two submissions and deduplication is designed to
        // merge them, so this is a normal case — not an edge one. They must be
        // paid and written to exactly ONCE.
        EmailSender.sendSupportTicketResolvedEmail = async (toEmailAddress) => { emailedAddresses.push(toEmailAddress); };
        const firstReport = buildReport({ id: "report-a", userId: "user-repeat", userEmail: "repeat@example.com", bNotifyOnResolution: true });
        const secondReport = buildReport({ id: "report-b", userId: "user-repeat", userEmail: "repeat@example.com", bNotifyOnResolution: true });
        remainingReports = [firstReport, secondReport];
        grantReferenceKeys.length = 0;
        emailedAddresses.length = 0;
        notifiedUserIds.length = 0;

        const repeatOutcome = await SupportTicketResolutionDispatcher.dispatch(buildTicket());
        assert(repeatOutcome.processedCount === 2, "Both report rows from one person are marked dispatched");
        assert(repeatOutcome.creditedCount === 1, "A person who reported twice is credited ONCE, not twice");
        assert(grantReferenceKeys.length === 1, "Only one credit grant is attempted for a repeat reporter");
        assert(emailedAddresses.length === 1, "A person who reported twice receives ONE email, not two");
        assert(notifiedUserIds.length === 1, "A person who reported twice receives ONE notification");

        // ── The batch bound must not be mistaken for completion ─────────────
        // Claiming completion here would hide the ticket from the reconciler
        // forever, permanently stranding every reporter it never reached.
        const neverDispatchedReport = buildReport({ id: "report-stuck", userId: "user-stuck" });
        SupportTicketQueryEngine.listUndispatchedReports = async () => [neverDispatchedReport];
        SupportTicketQueryEngine.markReportDispatched = async () => false;
        lastDispatchState = null;

        const boundedOutcome = await SupportTicketResolutionDispatcher.dispatch(buildTicket());
        assert(boundedOutcome.bComplete === false, "Exhausting the batch bound is reported as INCOMPLETE");
        assert(lastDispatchState !== null && lastDispatchState.completedAt === null, "Exhausting the batch bound leaves completedAt null so the reconciler retries");

        SupportTicketQueryEngine.markReportDispatched = async () => true;
        SupportTicketQueryEngine.listUndispatchedReports = async () =>
        {
            const batch = remainingReports;
            remainingReports = [];
            return batch;
        };

        // ── A resumed dispatch reports total coverage, not just its own slice ──
        remainingReports = [optedIn];
        const resumedTicket = buildTicket({ dispatchState: { startedAt: Date.now() - 60000, completedAt: null, processedCount: 295, totalCount: 296 } });
        const resumedOutcome = await SupportTicketResolutionDispatcher.dispatch(resumedTicket);
        assert(resumedOutcome.processedCount === 296, "A resumed dispatch carries forward the prior progress (296, not 1)");

        // ── An already-applied grant against a rejected transaction ─────────
        // CreditLedger reports alreadyApplied for a previously-seen key even when
        // that transaction was REJECTED (deleted user). Treating it as success
        // would tell someone they were paid when nothing moved.
        remainingReports = [buildReport({ id: "report-ghost", userId: "user-deleted", userEmail: "ghost@example.com", bNotifyOnResolution: true })];
        CreditLedger.grant = async () => ({ applied: false, alreadyApplied: true, amount: 0 });
        const ghostOutcome = await SupportTicketResolutionDispatcher.dispatch(buildTicket());
        assert(ghostOutcome.creditedCount === 0, "An alreadyApplied-but-not-applied grant is NOT counted as credited");
    }
    finally
    {
        SupportTicketQueryEngine.summariseReporters = originalSummarise;
        SupportTicketQueryEngine.listUndispatchedReports = originalListUndispatched;
        SupportTicketQueryEngine.markReportDispatched = originalMarkDispatched;
        SupportTicketQueryEngine.updateDispatchState = originalUpdateDispatchState;
        CreditLedger.grant = originalGrant;
        EmailSender.sendSupportTicketResolvedEmail = originalResolvedEmail;
        EmailSender.sendSupportTicketDeclinedEmail = originalDeclinedEmail;
        NotificationDispatcher.dispatch = originalDispatch;
    }
}

async function runReconcilerChecks()
{
    section("Tier 1 — boot reconciler");

    const originalList = SupportTicketQueryEngine.listTicketsWithIncompleteDispatch;
    const originalDispatch = SupportTicketResolutionDispatcher.dispatch;

    try
    {
        let requestedClosedBefore = null;
        SupportTicketQueryEngine.listTicketsWithIncompleteDispatch = async (closedBefore) =>
        {
            requestedClosedBefore = closedBefore;
            return [];
        };

        const emptyCount = await SupportTicketDispatchReconciler.reconcile();
        assert(emptyCount === 0, "Reconciling with nothing stranded is a no-op");

        // The grace period is what stops a dispatch that is running RIGHT NOW
        // from being picked up and run a second time in parallel.
        assert(requestedClosedBefore <= Date.now() - SupportTicketDispatchReconciler.GRACE_PERIOD_MILLISECONDS + 1000,
            "The reconciler only considers tickets closed before the grace period");

        const dispatchedTicketIds = [];
        SupportTicketQueryEngine.listTicketsWithIncompleteDispatch = async () => [buildTicket({ id: "stranded-1" }), buildTicket({ id: "stranded-2" })];
        SupportTicketResolutionDispatcher.dispatch = async (ticket) => { dispatchedTicketIds.push(ticket.getId()); return {}; };

        const reconciledCount = await SupportTicketDispatchReconciler.reconcile();
        assert(reconciledCount === 2, "Both stranded tickets are re-dispatched");
        assert(dispatchedTicketIds.join(",") === "stranded-1,stranded-2", "Each stranded ticket is handed to the dispatcher");

        // One bad ticket must not stop the rest being recovered.
        SupportTicketResolutionDispatcher.dispatch = async (ticket) =>
        {
            if (ticket.getId() === "stranded-1")
            {
                throw new Error("dispatch exploded");
            }
            return {};
        };
        const partialCount = await SupportTicketDispatchReconciler.reconcile();
        assert(partialCount === 1, "A failing ticket does not prevent the others from being reconciled");
    }
    finally
    {
        SupportTicketQueryEngine.listTicketsWithIncompleteDispatch = originalList;
        SupportTicketResolutionDispatcher.dispatch = originalDispatch;
    }
}

function runEmailAndNotificationChecks()
{
    section("Tier 1 — email composition and notification content");

    const html = EmailTemplate.buildSupportTicketEmail("Fixed", "Intro text", "The <b>admin</b> wrote this & that", "5 credits added", "Footer");
    assert(html.includes("&lt;b&gt;"), "Admin-authored text is HTML-escaped in the email body");
    assert(html.includes("&amp;"), "Ampersands in admin text are escaped");
    assert(html.includes("5 credits added"), "The reward highlight is rendered when supplied");
    assert(!EmailTemplate.buildSupportTicketEmail("H", "I", "", "", "F").includes("border-left"), "The quote block is omitted when there is no admin message");

    const resolvedContent = NotificationContent.supportTicketResolved("ticket-9", 5);
    assert(resolvedContent.type === notificationTypes.SUPPORT, "The resolution notification is typed SUPPORT");
    assert(resolvedContent.data.ticketId === "ticket-9" && resolvedContent.data.target === "support", "The resolution notification carries deep-link data");
    assert(resolvedContent.body.includes("5 credits"), "The reward is mentioned when credits were granted");
    assert(!NotificationContent.supportTicketResolved("ticket-9", 0).body.includes("credits"), "No reward sentence when no credits were granted");

    const declinedContent = NotificationContent.supportTicketDeclined("ticket-9");
    assert(declinedContent.type === notificationTypes.SUPPORT, "The decline notification is typed SUPPORT");
}

function runLogScopingChecks()
{
    section("Tier 1 — log export scoping");

    assert(LogExportService.UNATTRIBUTED_ACCOUNT_ID === "", "Unattributed log entries are identified by an empty accountId");
    assert(typeof LogExportService.collectEntries === "function", "LogExportService exposes the shared hot/cold collector");
    assert(typeof LogExportService.renderSegment === "function", "LogExportService exposes the shared renderer");
    assert(LogExportService.resolveExtension("html") === "html" && LogExportService.resolveExtension("log") === "log", "Format resolves to the right file extension");

    // The scoping guarantee: an export restricted to a reporter must never carry
    // another identifiable user's entries. Verified at the filter level, which is
    // where the guarantee is actually implemented.
    const originalFind = LogEventQueryEngine.queryRange;
    let capturedAccountIds = undefined;

    try
    {
        LogEventQueryEngine.queryRange = async (queryArguments) =>
        {
            capturedAccountIds = queryArguments.accountIds;
            return [];
        };

        // findOverlapping would hit Mongo; the archive half is exercised in the DB tier.
        const originalArchive = require("./Globals/Classes/Logging/LogArchiveQueryEngine").findOverlapping;
        require("./Globals/Classes/Logging/LogArchiveQueryEngine").findOverlapping = async () => [];

        return LogExportService.collectEntries
        ({
            fromDate: new Date(Date.now() - 86400000),
            toDate: new Date(),
            accountIds: ["reporter-1", LogExportService.UNATTRIBUTED_ACCOUNT_ID]
        }).then(() =>
        {
            assert(Array.isArray(capturedAccountIds) && capturedAccountIds.length === 2, "A scoped export passes exactly two account ids to the query");
            assert(capturedAccountIds.includes("reporter-1"), "The scoped export includes the reporter's own entries");
            assert(capturedAccountIds.includes(""), "The scoped export includes unattributed system entries");
            assert(!capturedAccountIds.includes("some-other-user"), "The scoped export carries no other identifiable user");

            require("./Globals/Classes/Logging/LogArchiveQueryEngine").findOverlapping = originalArchive;
            LogEventQueryEngine.queryRange = originalFind;
        });
    }
    catch (scopingError)
    {
        LogEventQueryEngine.queryRange = originalFind;
        assert(false, `Log scoping check crashed: ${scopingError.message}`);
        return Promise.resolve();
    }
}

// ── Tier 2 ──────────────────────────────────────────────────────────────────

async function runDatabaseTier()
{
    section("Tier 2 — MongoDB (opt-in: VERIFY_SUPPORT_DB=1)");

    if (process.env.VERIFY_SUPPORT_DB !== "1")
    {
        skip("Database tier disabled (set VERIFY_SUPPORT_DB=1 to run it)");
        return;
    }

    const database = await DatabaseConnector.getDatabase();

    if (!database)
    {
        skip("MongoDB is not reachable — database tier skipped");
        return;
    }

    const ticketsCollection = database.collection(DatabaseConstants.SUPPORT_TICKETS_COLLECTION);
    const reportsCollection = database.collection(DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION);

    const verificationTicketId = `verify-ticket-${Date.now()}`;
    const verificationUserId = `verify-user-${Date.now()}`;

    try
    {
        await ticketsCollection.insertOne(buildTicket({ id: verificationTicketId, status: supportTicketStatus.ACTIVE, reportCount: 2 }).toJson());

        const notifyingReport = buildReport({ ticketId: verificationTicketId, userId: verificationUserId, bNotifyOnResolution: true });
        const silentReport = buildReport({ ticketId: verificationTicketId, userId: `${verificationUserId}-b`, bNotifyOnResolution: false });
        await SupportTicketQueryEngine.insertReport(notifyingReport);
        await SupportTicketQueryEngine.insertReport(silentReport);

        const loadedTicket = await SupportTicketQueryEngine.getTicket(verificationTicketId);
        assert(loadedTicket !== null && loadedTicket.getId() === verificationTicketId, "A ticket round-trips through MongoDB");

        const ticketReports = await SupportTicketQueryEngine.listReportsForTicket(verificationTicketId);
        assert(ticketReports.length === 2, "Both reports are found for the ticket");

        const summary = await SupportTicketQueryEngine.summariseReporters(verificationTicketId);
        assert(summary.reporterCount === 2, "The reporter count aggregates correctly");
        assert(summary.notifyOptInCount === 1, "The notify opt-in count aggregates correctly");

        const quotaCount = await SupportTicketQueryEngine.countReportsForUserSince(verificationUserId, Date.now() - SupportTicketQuota.WINDOW_MILLISECONDS);
        assert(quotaCount === 1, "The durable quota counts the user's report in the rolling window");

        const userReports = await SupportTicketQueryEngine.listReportsForUser(verificationUserId);
        assert(userReports.length === 1 && userReports[0].ticketStatus === supportTicketStatus.ACTIVE, "\"Your reports\" joins each report to its ticket status");

        // The double-resolve guard: the FIRST claim wins, the second must fail.
        const firstClaim = await SupportTicketQueryEngine.claimActiveTicket(verificationTicketId,
        {
            status: supportTicketStatus.RESOLVED,
            resolvedAt: Date.now(),
            resolutionMessage: "Verified fix.",
            creditsPerReporter: 1
        });
        assert(firstClaim !== null && firstClaim.getStatus() === supportTicketStatus.RESOLVED, "The first claim resolves the ticket");

        const secondClaim = await SupportTicketQueryEngine.claimActiveTicket(verificationTicketId, { status: supportTicketStatus.DECLINED });
        assert(secondClaim === null, "A second claim on the same ticket fails — this is what makes a double-clicked Resolve safe");

        const undispatched = await SupportTicketQueryEngine.listUndispatchedReports(verificationTicketId, 100);
        assert(undispatched.length === 2, "Both reports start out undispatched");

        await SupportTicketQueryEngine.markReportDispatched(notifyingReport.getId(), { bCreditGranted: true, creditAmount: 1 });
        const stillUndispatched = await SupportTicketQueryEngine.listUndispatchedReports(verificationTicketId, 100);
        assert(stillUndispatched.length === 1, "A dispatched report drops out of the undispatched batch (fan-out resumability)");
    }
    catch (databaseError)
    {
        assert(false, `Database tier failed: ${databaseError.message}`);
    }
    finally
    {
        await ticketsCollection.deleteMany({ id: verificationTicketId });
        await reportsCollection.deleteMany({ ticketId: verificationTicketId });
    }
}

async function main()
{
    console.log("CogniumLearn — Support ticket (Report Issue + AI deduplication) verification\n");

    runLimitChecks();
    runAttachmentPolicyChecks();
    runMultipartContractChecks();
    runModelChecks();
    await runQuotaChecks();
    await runFanOutChecks();
    await runReconcilerChecks();
    runEmailAndNotificationChecks();
    await runLogScopingChecks();
    await runDatabaseTier();

    console.log(`\n---------------------------------------------`);
    console.log(`Passed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("\nFATAL — verification harness crashed:");
    console.error(fatalError);
    process.exit(1);
});
