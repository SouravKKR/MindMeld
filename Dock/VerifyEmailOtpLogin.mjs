/**
 * End-to-end verification harness for the email-OTP sign-in flow and its new
 * provider-style email architecture (AWS SES active, SMTP fallback).
 *
 * Run from the Dock directory:
 *     node VerifyEmailOtpLogin.mjs
 *
 * Three tiers, each self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — pure, in-process checks of the new code: provider selection,
 *      SES SendEmailCommand mapping, EmailTemplate escaping, and that
 *      EmailSender composes + dispatches OTP / org-admin messages through the
 *      active provider. No network, no DB.
 *
 *   2. DB (opt-in: VERIFY_EMAIL_OTP_DB=1) — drives the real OtpManager
 *      request -> verify path against the configured MongoDB, with the email
 *      provider stubbed by a capturing fake so the plaintext code can be read
 *      back and no real email is sent. Creates a throwaway *.invalid user and
 *      cleans it up. Skips (not fails) when the flag is off or Mongo is down.
 *
 *   3. LIVE SES (opt-in: VERIFY_EMAIL_OTP_SES_LIVE=1 + VERIFY_EMAIL_OTP_TO=...)
 *      — actually sends one OTP email through the real SES client. Use this
 *      once the SES_* keys are filled in. Skips by default.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

// Load Dock/.env exactly like the server does, so the DB / SES tiers see the
// same configuration. Missing file is fine — the always-on tier sets its own.
require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const EmailMessage = require("./Globals/Classes/Email/EmailMessage");
const EmailTemplate = require("./Globals/Classes/Email/EmailTemplate");
const EmailProvider = require("./Globals/Classes/Email/EmailProvider");
const EmailProviderFactory = require("./Globals/Classes/Email/EmailProviderFactory");
const SesEmailProvider = require("./Globals/Classes/Email/SesEmailProvider");
const SmtpEmailProvider = require("./Globals/Classes/Email/SmtpEmailProvider");
const EmailSender = require("./Globals/Classes/Email/EmailSender");
const EmailSenderIdentities = require("./Globals/Classes/Email/EmailSenderIdentities");
const { emailProviderTypes } = require("./Globals/Enumerations/EmailProviderTypes");

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

// A capturing provider used to observe exactly what EmailSender dispatches
// without any transport. Registered by monkeypatching the factory's selection
// seam — the same seam EmailSender relies on in production.
class CapturingEmailProvider extends EmailProvider
{
    constructor()
    {
        super();
        this.sentMessages = [];
    }

    getProviderEnumValue()
    {
        return emailProviderTypes.SES;
    }

    isConfigured()
    {
        return true;
    }

    async sendEmail(emailMessage)
    {
        this.sentMessages.push(emailMessage);
    }
}

async function runAlwaysOnTier()
{
    section("Tier 1 — provider architecture (always on)");

    // Provider selection resolves to SES by default and honours the env name.
    const originalDefaultProvider = process.env.DEFAULT_EMAIL_PROVIDER;

    delete process.env.DEFAULT_EMAIL_PROVIDER;
    assert(EmailProviderFactory.getDefaultProvider() instanceof SesEmailProvider, "Default provider is SES when DEFAULT_EMAIL_PROVIDER is unset");

    process.env.DEFAULT_EMAIL_PROVIDER = "SMTP";
    assert(EmailProviderFactory.getDefaultProvider() instanceof SmtpEmailProvider, "DEFAULT_EMAIL_PROVIDER=SMTP selects the SMTP provider");

    process.env.DEFAULT_EMAIL_PROVIDER = "not-a-real-provider";
    assert(EmailProviderFactory.getDefaultProvider() instanceof SesEmailProvider, "Unknown DEFAULT_EMAIL_PROVIDER falls back to SES");

    if (originalDefaultProvider === undefined)
    {
        delete process.env.DEFAULT_EMAIL_PROVIDER;
    }
    else
    {
        process.env.DEFAULT_EMAIL_PROVIDER = originalDefaultProvider;
    }

    assert(EmailProviderFactory.getProvider(emailProviderTypes.SES) === EmailProviderFactory.getProvider(emailProviderTypes.SES), "Factory caches a single provider instance");
    assert(new SesEmailProvider().getProviderEnumValue() === emailProviderTypes.SES, "SesEmailProvider reports the SES enum value");
    assert(new SmtpEmailProvider().getProviderEnumValue() === emailProviderTypes.SMTP, "SmtpEmailProvider reports the SMTP enum value");

    // SES isConfigured reflects presence of all three credentials.
    const sesProvider = new SesEmailProvider();
    const savedRegion = process.env.SES_REGION;
    const savedAccessKeyId = process.env.SES_ACCESS_KEY_ID;
    const savedSecretAccessKey = process.env.SES_SECRET_ACCESS_KEY;

    delete process.env.SES_REGION;
    delete process.env.SES_ACCESS_KEY_ID;
    delete process.env.SES_SECRET_ACCESS_KEY;
    assert(sesProvider.isConfigured() === false, "SES isConfigured() is false with no credentials");

    process.env.SES_REGION = "us-east-1";
    process.env.SES_ACCESS_KEY_ID = "AKIAEXAMPLE";
    process.env.SES_SECRET_ACCESS_KEY = "secretExample";
    assert(sesProvider.isConfigured() === true, "SES isConfigured() is true with all credentials set");

    // SESv2 command mapping is correct and complete (verified against the AWS
    // @aws-sdk/client-sesv2 SendEmailCommandInput shape).
    const message = new EmailMessage("from@cogniumlearn.io", "user@example.com", "Subject line", "plain body", "<b>html body</b>");
    const commandInput = sesProvider.buildSendEmailCommandInput(message);
    assert(commandInput.FromEmailAddress === "from@cogniumlearn.io", "SESv2 command FromEmailAddress maps from message source");
    assert(Array.isArray(commandInput.Destination.ToAddresses) && commandInput.Destination.ToAddresses[0] === "user@example.com", "SESv2 command ToAddresses maps the recipient");
    assert(commandInput.Content.Simple.Subject.Data === "Subject line" && commandInput.Content.Simple.Subject.Charset === "UTF-8", "SESv2 command Content.Simple.Subject maps with UTF-8 charset");
    assert(commandInput.Content.Simple.Body.Text.Data === "plain body" && commandInput.Content.Simple.Body.Html.Data === "<b>html body</b>", "SESv2 command Content.Simple.Body carries both text and HTML");

    // The From display name — what the recipient actually sees in their inbox.
    // The address stays the verified SES identity; only the name beside it
    // varies per email type, so the formatting + safety rules are checked here
    // rather than trusted to each transport.
    const namedMessage = new EmailMessage("from@cogniumlearn.io", "user@example.com", "Subject line", "plain body", "", EmailSenderIdentities.SECURITY);
    assert(namedMessage.getFormattedSourceAddress() === `"CogniumLearn Security" <from@cogniumlearn.io>`, "A display name formats as a quoted name beside the address");
    assert(message.getFormattedSourceAddress() === "from@cogniumlearn.io", "A message with no display name sends from the bare address");
    assert(sesProvider.buildSendEmailCommandInput(namedMessage).FromEmailAddress === `"CogniumLearn Security" <from@cogniumlearn.io>`, "SESv2 command FromEmailAddress carries the formatted display name");
    assert(new SmtpEmailProvider().buildSendMailOptions(namedMessage).from === `"CogniumLearn Security" <from@cogniumlearn.io>`, "SMTP from field carries the formatted display name");

    // Header injection: a newline in the name would let the name author append
    // headers of their own, so control characters never survive.
    const injectedNameMessage = namedMessage.withSenderName("Evil\r\nBcc: attacker@example.com");
    assert(!injectedNameMessage.getFormattedSourceAddress().includes("\n") && !injectedNameMessage.getFormattedSourceAddress().includes("\r"), "Control characters are stripped from the display name");

    // A quote in the name must not close the quoted string early.
    const quotedNameMessage = namedMessage.withSenderName(`He said "hi" \\ bye`);
    assert(quotedNameMessage.getFormattedSourceAddress() === `"He said \\"hi\\" \\\\ bye" <from@cogniumlearn.io>`, "Quotes and backslashes in the display name are escaped");

    // Non-ASCII needs RFC 2047 encoding SES will not apply — drop the name
    // rather than ship a garbled From header.
    assert(namedMessage.withSenderName("CogniumLearn Sécurité").getFormattedSourceAddress() === "from@cogniumlearn.io", "A non-ASCII display name falls back to the bare address");

    // Every identity is plain ASCII, so none of them can hit that fallback.
    const allIdentities = [EmailSenderIdentities.DEFAULT, EmailSenderIdentities.SECURITY, EmailSenderIdentities.SUPPORT, EmailSenderIdentities.NOTIFICATIONS];
    assert(allIdentities.every(identity => namedMessage.withSenderName(identity).getFormattedSourceAddress().includes("<")), "Every EmailSenderIdentities name survives formatting");

    // withSourceEmail is how EmailSender fills the platform address in — it must
    // not drop the identity the calling method already chose.
    assert(namedMessage.withSourceEmail("other@cogniumlearn.io").getSenderName() === EmailSenderIdentities.SECURITY, "withSourceEmail preserves the display name");

    // Restore SES env.
    restoreEnv("SES_REGION", savedRegion);
    restoreEnv("SES_ACCESS_KEY_ID", savedAccessKeyId);
    restoreEnv("SES_SECRET_ACCESS_KEY", savedSecretAccessKey);

    // EmailMessage dispatchability guard.
    assert(new EmailMessage("f@x.io", "t@x.io", "s", "text", "").isDispatchable() === true, "EmailMessage with a source, recipient, subject and text is dispatchable");
    assert(new EmailMessage("", "t@x.io", "s", "text", "html").isDispatchable() === false, "EmailMessage with no source is not dispatchable");
    assert(new EmailMessage("f@x.io", "t@x.io", "s", "", "").isDispatchable() === false, "EmailMessage with no body is not dispatchable");

    // Template escapes dynamic values (no HTML injection through name/code).
    const escapedHtml = EmailTemplate.buildCodeEmail("Heading", "Intro <script>", "123456", "Footer & note");
    assert(escapedHtml.includes("&lt;script&gt;"), "EmailTemplate escapes injected HTML in the intro");
    assert(escapedHtml.includes("Footer &amp; note"), "EmailTemplate escapes ampersands in the footer");
    assert(escapedHtml.includes("123456"), "EmailTemplate renders the code");

    // Branding: both marks are present, they point at absolute public URLs
    // (relative paths would be dead links in a mail client), and the code can
    // never wrap onto a second line.
    assert(escapedHtml.includes(EmailTemplate.PRODUCT_LOGO_URL), "Email carries the CogniumLearn logo");
    assert(escapedHtml.includes(EmailTemplate.COMPANY_LOGO_URL), "Email carries the Cognium Labs logo");
    assert(EmailTemplate.PRODUCT_LOGO_URL.startsWith("https://") && EmailTemplate.COMPANY_LOGO_URL.startsWith("https://"), "Logo URLs are absolute https URLs");
    assert(escapedHtml.includes('alt="CogniumLearn"') && escapedHtml.includes('alt="Cognium Labs"'), "Both logos carry alt text for image-blocking clients");
    assert(EmailTemplate.codeBlock("123456").includes("white-space: nowrap"), "Code block is pinned to a single line");

    // The notification email (generation complete, and every notification of
    // that shape). It has to be the SAME brand as the sign-in code email — that
    // is the whole reason it goes through EmailTemplate rather than being
    // hand-rolled at the call site.
    const notificationHtml = EmailTemplate.buildNotificationEmail(
        "Your study set is ready",
        "The generation you started has finished.",
        "",
        "Open CogniumLearn",
        EmailTemplate.CALL_TO_ACTION_URL,
        "You're receiving this because you started an AI generation.");
    assert(notificationHtml.includes(EmailTemplate.PRODUCT_LOGO_URL), "Notification email carries the CogniumLearn logo");
    assert(notificationHtml.includes(EmailTemplate.COMPANY_LOGO_URL), "Notification email carries the Cognium Labs logo");
    assert(notificationHtml.includes('alt="CogniumLearn"') && notificationHtml.includes('alt="Cognium Labs"'), "Notification email logos carry alt text");
    assert(notificationHtml.includes(`href="${EmailTemplate.CALL_TO_ACTION_URL}"`), "Notification email links its action button at the app");
    assert(EmailTemplate.CALL_TO_ACTION_URL.startsWith("https://") && !EmailTemplate.CALL_TO_ACTION_URL.includes("?"), "Action URL is absolute and carries no query string (the root route 404s with one)");

    // An empty action label omits the button rather than rendering an empty one.
    const buttonlessHtml = EmailTemplate.buildNotificationEmail("Heading", "Intro", "", "", "", "Footer");
    assert(!buttonlessHtml.includes("<a href"), "Notification email omits the action button when no label is given");

    // The action button is markup built from caller-supplied strings, so both
    // the label and the href must be escaped.
    const hostileButton = EmailTemplate.callToActionButton('Click "me" & <b>win</b>', 'https://x/?a="onmouseover=alert(1)');
    assert(!hostileButton.includes("<b>") && hostileButton.includes("&lt;b&gt;"), "Action button escapes HTML in its label");
    assert(!/href="[^"]*"onmouseover/.test(hostileButton), "Action button escapes quotes in its URL so it cannot break out of the href");

    // EmailSender composes + dispatches through the active provider. Swap the
    // selection seam for a capturing provider (the DI point EmailSender uses).
    const originalGetDefaultProvider = EmailProviderFactory.getDefaultProvider;
    const capturingProvider = new CapturingEmailProvider();
    EmailProviderFactory.getDefaultProvider = () => capturingProvider;

    const savedEmailSource = process.env.EMAIL_SOURCE_EMAIL;
    const savedSmtpSource = process.env.SMTP_SOURCE_EMAIL;
    process.env.EMAIL_SOURCE_EMAIL = "noreply@cogniumlearn.io";

    try
    {
        await EmailSender.sendOtpEmail("learner@example.com", "654321");
        const otpMessage = capturingProvider.sentMessages[capturingProvider.sentMessages.length - 1];
        assert(otpMessage !== undefined, "sendOtpEmail dispatched a message through the active provider");
        assert(otpMessage.getRecipientEmail() === "learner@example.com", "OTP email is addressed to the requesting learner");
        assert(otpMessage.getSourceEmail() === "noreply@cogniumlearn.io", "OTP email source is filled from EMAIL_SOURCE_EMAIL");
        assert(otpMessage.getSubject() === "Your CogniumLearn sign-in code", "OTP email carries the sign-in subject");
        assert(otpMessage.getSenderName() === EmailSenderIdentities.SECURITY, "OTP email is sent under the Security identity");
        assert(otpMessage.getFormattedSourceAddress() === `"CogniumLearn Security" <noreply@cogniumlearn.io>`, "OTP email's From header pairs the Security name with the platform address");
        assert(otpMessage.getPlainTextBody().includes("654321") && otpMessage.getHtmlBody().includes("654321"), "OTP email contains the code in both bodies");

        await EmailSender.sendNotificationEmail("learner@example.com",
        {
            subject: "Your CogniumLearn study set is ready",
            headingText: "Your study set is ready",
            introText: "The generation you started has finished.",
            highlightText: "",
            callToActionLabel: "Open CogniumLearn",
            footerText: "You're receiving this because you started an AI generation."
        });
        const notificationMessage = capturingProvider.sentMessages[capturingProvider.sentMessages.length - 1];
        assert(notificationMessage.getSubject() === "Your CogniumLearn study set is ready", "Notification email carries the supplied subject");
        assert(notificationMessage.getRecipientEmail() === "learner@example.com", "Notification email is addressed to the given learner");
        // A client that strips the styled anchor must still get somewhere to go.
        assert(notificationMessage.getPlainTextBody().includes(EmailTemplate.CALL_TO_ACTION_URL), "Notification email repeats the action URL in the plain-text body");
        assert(notificationMessage.getHtmlBody().includes(EmailTemplate.PRODUCT_LOGO_URL), "Dispatched notification email carries the branded HTML body");
        assert(notificationMessage.getSenderName() === EmailSenderIdentities.NOTIFICATIONS, "Notification email is sent under the product identity");

        await EmailSender.sendOrgAdminVerificationEmail("admin@example.com", "111222", "Acme Institute");
        const orgMessage = capturingProvider.sentMessages[capturingProvider.sentMessages.length - 1];
        assert(orgMessage.getSubject().includes("organization-admin"), "Org-admin email carries the distinct verification subject");
        assert(orgMessage.getHtmlBody().includes("Acme Institute"), "Org-admin email includes the organization name");
        assert(orgMessage.getSenderName() === EmailSenderIdentities.SECURITY, "Org-admin verification email is sent under the Security identity");

        // Support outcomes come from Support, not Security — the two must never
        // collapse onto one name, or the inbox stops distinguishing them.
        await EmailSender.sendSupportTicketResolvedEmail("reporter@example.com", "Cards not syncing", "Fixed in today's release.", 50);
        const resolvedMessage = capturingProvider.sentMessages[capturingProvider.sentMessages.length - 1];
        assert(resolvedMessage.getSenderName() === EmailSenderIdentities.SUPPORT, "Support-resolved email is sent under the Support identity");

        await EmailSender.sendSupportTicketDeclinedEmail("reporter@example.com", "Cards not syncing", "");
        const declinedMessage = capturingProvider.sentMessages[capturingProvider.sentMessages.length - 1];
        assert(declinedMessage.getSenderName() === EmailSenderIdentities.SUPPORT, "Support-declined email is sent under the Support identity");
        assert(EmailSenderIdentities.SECURITY !== EmailSenderIdentities.SUPPORT, "Security and Support identities are distinct names");

        // An externally composed message that names no identity still gets one,
        // so nothing ever goes out with a bare, unlabelled address.
        await EmailSender.send(new EmailMessage("", "someone@example.com", "Ad-hoc subject", "body", ""));
        const adHocMessage = capturingProvider.sentMessages[capturingProvider.sentMessages.length - 1];
        assert(adHocMessage.getSenderName() === EmailSenderIdentities.DEFAULT, "A message with no identity is stamped with the default one");

        // No source anywhere -> a clear, actionable error rather than a silent send.
        delete process.env.EMAIL_SOURCE_EMAIL;
        delete process.env.SMTP_SOURCE_EMAIL;
        let threwOnMissingSource = false;
        try
        {
            await EmailSender.send(new EmailMessage("", "x@example.com", "s", "t", "h"));
        }
        catch (missingSourceError)
        {
            threwOnMissingSource = true;
        }
        assert(threwOnMissingSource, "EmailSender.send throws when no source address is configured");
    }
    finally
    {
        EmailProviderFactory.getDefaultProvider = originalGetDefaultProvider;
        restoreEnv("EMAIL_SOURCE_EMAIL", savedEmailSource);
        restoreEnv("SMTP_SOURCE_EMAIL", savedSmtpSource);
    }
}

function restoreEnv(name, savedValue)
{
    if (savedValue === undefined)
    {
        delete process.env[name];
    }
    else
    {
        process.env[name] = savedValue;
    }
}

async function runDatabaseTier()
{
    section("Tier 2 — OtpManager request -> verify (opt-in: VERIFY_EMAIL_OTP_DB=1)");

    if (process.env.VERIFY_EMAIL_OTP_DB !== "1")
    {
        skip("DB tier disabled (set VERIFY_EMAIL_OTP_DB=1 to run the real OTP flow)");
        return;
    }

    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const database = await DatabaseConnector.getDatabase();

    if (!database)
    {
        skip("MongoDB is not reachable (MONGODB_URL not set / server down) — DB tier skipped");
        return;
    }

    console.log(`  info  Using database "${process.env.MONGODB_DATABASE_NAME}" — creating a throwaway *.invalid user`);

    const OtpManager = require("./Globals/Classes/Authentication/OtpManager");
    const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

    // Capture the emitted code by swapping the selection seam. This keeps the
    // test hermetic — the OTP path runs for real, but nothing is emailed.
    const originalGetDefaultProvider = EmailProviderFactory.getDefaultProvider;
    const capturingProvider = new CapturingEmailProvider();
    EmailProviderFactory.getDefaultProvider = () => capturingProvider;

    const savedEmailSource = process.env.EMAIL_SOURCE_EMAIL;
    if (!process.env.EMAIL_SOURCE_EMAIL && !process.env.SMTP_SOURCE_EMAIL)
    {
        process.env.EMAIL_SOURCE_EMAIL = "noreply@cogniumlearn.io";
    }

    const testEmail = `verify-email-otp-${Date.now()}@cogniumlearn.invalid`;

    try
    {
        const requestResult = await OtpManager.requestOtp(testEmail);
        assert(requestResult.ok === true, "requestOtp succeeds for a fresh email");
        assert(requestResult.isNewUser === true, "requestOtp reports a new user for an unseen email");

        // Recover the plaintext code from the captured OTP email body.
        const otpMessage = capturingProvider.sentMessages[capturingProvider.sentMessages.length - 1];
        const codeMatch = otpMessage ? otpMessage.getPlainTextBody().match(/\b(\d{6})\b/) : null;
        const emittedCode = codeMatch ? codeMatch[1] : "";
        assert(/^\d{6}$/.test(emittedCode), "A 6-digit code was emitted through the provider");

        // A wrong code is rejected but does not consume the record.
        const wrongResult = await OtpManager.verifyOtp(testEmail, emittedCode === "000000" ? "111111" : "000000", "Test Learner");
        assert(wrongResult.ok === false, "verifyOtp rejects an incorrect code");

        // The correct code creates the user and returns their id.
        const verifyResult = await OtpManager.verifyOtp(testEmail, emittedCode, "Test Learner");
        assert(verifyResult.ok === true, "verifyOtp accepts the correct code");
        assert(verifyResult.userId === testEmail, "verifyOtp returns the new user's id (their email)");

        const createdUser = await database.collection(DatabaseConstants.USERS_COLLECTION).findOne({ id: testEmail });
        assert(createdUser !== null, "A user document was created for the verified email");

        const otpDocumentAfter = await database.collection(DatabaseConstants.OTP_REQUESTS_COLLECTION).findOne({ email: testEmail });
        assert(otpDocumentAfter === null, "The OTP request is consumed (deleted) after successful verification");
    }
    finally
    {
        // Best-effort cleanup of every artifact this test created.
        try { await database.collection(DatabaseConstants.OTP_REQUESTS_COLLECTION).deleteOne({ email: testEmail }); } catch (cleanupError) { }
        try { await database.collection(DatabaseConstants.USERS_COLLECTION).deleteOne({ id: testEmail }); } catch (cleanupError) { }
        try { await database.collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION).deleteMany({ referenceKey: `signup:${testEmail}` }); } catch (cleanupError) { }
        EmailProviderFactory.getDefaultProvider = originalGetDefaultProvider;
        restoreEnv("EMAIL_SOURCE_EMAIL", savedEmailSource);
        try { await DatabaseConnector.getMongoClient()?.close(); } catch (closeError) { }
    }
}

async function runLiveSesTier()
{
    section("Tier 3 — live SES send (opt-in: VERIFY_EMAIL_OTP_SES_LIVE=1)");

    if (process.env.VERIFY_EMAIL_OTP_SES_LIVE !== "1")
    {
        skip("Live SES tier disabled (set VERIFY_EMAIL_OTP_SES_LIVE=1 + VERIFY_EMAIL_OTP_TO=you@domain to send a real email)");
        return;
    }

    const recipient = process.env.VERIFY_EMAIL_OTP_TO || "";
    if (!recipient)
    {
        skip("VERIFY_EMAIL_OTP_TO is not set — cannot send a live SES email");
        return;
    }

    const sesProvider = new SesEmailProvider();
    if (!sesProvider.isConfigured())
    {
        skip("SES credentials are incomplete (SES_REGION / SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY) — live send skipped");
        return;
    }

    try
    {
        await EmailSender.sendOtpEmail(recipient, "246810");
        assert(true, `Live SES send to ${recipient} completed without error (check the inbox for code 246810)`);
    }
    catch (liveSendError)
    {
        assert(false, `Live SES send failed: ${liveSendError.message}`);
    }
}

async function main()
{
    console.log("CogniumLearn — Email OTP + SES provider verification\n");

    await runAlwaysOnTier();
    await runDatabaseTier();
    await runLiveSesTier();

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
