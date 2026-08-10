const App = require("../App");
const EmailMessage = require("./EmailMessage");
const EmailTemplate = require("./EmailTemplate");
const EmailProviderFactory = require("./EmailProviderFactory");
const EmailSenderIdentities = require("./EmailSenderIdentities");

/**
 * The high-level email API. It composes the message content (subject + branded
 * body via EmailTemplate) and delegates the actual dispatch to whichever
 * EmailProvider is active (EmailProviderFactory.getDefaultProvider() — AWS SES
 * by default). It knows nothing about SES/SMTP internals.
 *
 * Adding a new email type — a notification, a feature-release announcement — is
 * just another method here that builds an EmailMessage and calls send(); the
 * transport, provider selection, and branding are all reused unchanged.
 *
 * Each method also chooses the display name the recipient sees beside the "from"
 * address, from the fixed EmailSenderIdentities set — so a sign-in code reads as
 * coming from CogniumLearn Security and a support reply from CogniumLearn
 * Support, off one shared, verified address.
 */
class EmailSender
{
    /**
     * Generalized dispatch seam. Any caller (current or future) can build an
     * EmailMessage and send it through the active provider. When the message
     * carries no source address — or no display name — the platform defaults
     * are filled in here so individual callers never have to know them.
     */
    static async send(emailMessage)
    {
        let messageToSend = emailMessage;

        if (!messageToSend.getSourceEmail())
        {
            const defaultSourceEmail = App.getEmailSourceEmail();
            if (!defaultSourceEmail)
            {
                throw new Error("No email source address configured — set EMAIL_SOURCE_EMAIL (or SMTP_SOURCE_EMAIL) in Dock/.env");
            }
            messageToSend = messageToSend.withSourceEmail(defaultSourceEmail);
        }

        if (!messageToSend.getSenderName())
        {
            messageToSend = messageToSend.withSenderName(EmailSenderIdentities.DEFAULT);
        }

        await EmailProviderFactory.getDefaultProvider().sendEmail(messageToSend);
    }

    static async sendOtpEmail(toEmailAddress, sixDigitCode)
    {
        const subject = "Your CogniumLearn sign-in code";
        const plainTextBody =
            `Your CogniumLearn sign-in code is: ${sixDigitCode}\n\n` +
            `This code expires in 10 minutes. If you didn't request this, you can ignore this email.`;

        const htmlBody = EmailTemplate.buildCodeEmail
        (
            "Your CogniumLearn sign-in code",
            "Enter this code to finish signing in:",
            sixDigitCode,
            "This code expires in 10 minutes. If you didn't request this, you can safely ignore this email."
        );

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody, EmailSenderIdentities.SECURITY);
        await EmailSender.send(emailMessage);
    }

    /**
     * Sends a user notification as email — the channel that still reaches
     * someone who closed the tab, which is the whole point of telling users they
     * can walk away from a long generation.
     *
     * Chooses no copy of its own: the content arrives pre-resolved from
     * NotificationContent.toEmailContent(...) so the notification catalogue
     * stays the single place wording lives. This method only composes and
     * dispatches.
     *
     * @param {{subject: string, headingText: string, introText: string, highlightText: string, callToActionLabel: string, footerText: string}} emailContent
     * @returns {Promise<void>}
     */
    static async sendNotificationEmail(toEmailAddress, emailContent)
    {
        const callToActionLabel = String(emailContent?.callToActionLabel ?? "").trim();

        // The URL goes in the plain-text body too — a client that strips the
        // styled anchor would otherwise leave a "come back and study" message
        // with nothing to act on.
        const plainTextBody = [
            String(emailContent?.introText ?? ""),
            String(emailContent?.highlightText ?? ""),
            callToActionLabel.length > 0 ? `${callToActionLabel}: ${EmailTemplate.CALL_TO_ACTION_URL}` : "",
            String(emailContent?.footerText ?? "")
        ].filter(section => section.trim().length > 0).join("\n\n");

        const htmlBody = EmailTemplate.buildNotificationEmail
        (
            String(emailContent?.headingText ?? ""),
            String(emailContent?.introText ?? ""),
            String(emailContent?.highlightText ?? ""),
            callToActionLabel,
            EmailTemplate.CALL_TO_ACTION_URL,
            String(emailContent?.footerText ?? "")
        );

        const emailMessage = new EmailMessage("", toEmailAddress, String(emailContent?.subject ?? ""), plainTextBody, htmlBody, EmailSenderIdentities.NOTIFICATIONS);
        await EmailSender.send(emailMessage);
    }

    /**
     * The code that confirms the contact address on an intellectual-property
     * complaint.
     *
     * Deliberately worded so it cannot be mistaken for a sign-in code. The
     * recipient is usually not a user of the product, and a message that reads
     * like an account login attempt would either alarm them or be dismissed as
     * phishing — and either way the complaint stalls unconfirmed. It also says
     * plainly that the complaint is already recorded, because the clock started
     * when it was filed and a complainant should not believe otherwise.
     *
     * @param {string} toEmailAddress
     * @param {string} sixDigitCode
     * @returns {Promise<void>}
     */
    static async sendIntellectualPropertyComplaintCodeEmail(toEmailAddress, sixDigitCode)
    {
        const subject = "Confirm your CogniumLearn copyright complaint";
        const plainTextBody =
            `We've received a copyright / intellectual property complaint from this address and it is already recorded.\n\n` +
            `To confirm it came from you, enter this code on the complaint form: ${sixDigitCode}\n\n` +
            `This code expires in 10 minutes. This is NOT a sign-in code and it will not give anyone access to a ` +
            `CogniumLearn account. If you did not submit a complaint, you can ignore this email and nothing further will happen.`;

        const htmlBody = EmailTemplate.buildCodeEmail
        (
            "Confirm your copyright complaint",
            "We've recorded a copyright / intellectual property complaint from this address. Enter this code on the complaint form to confirm that it came from you:",
            sixDigitCode,
            "This code expires in 10 minutes. It is not a sign-in code and grants no access to any CogniumLearn account. "
                + "If you did not submit a complaint, you can safely ignore this email."
        );

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody, EmailSenderIdentities.GRIEVANCE);
        await EmailSender.send(emailMessage);
    }

    /**
     * The acknowledgment the platform owes a complainant, sent the moment the
     * complaint is durable rather than on any later sweep.
     *
     * Clause 19.2 of the Terms commits to acknowledging within 24 hours. Sending
     * this off the successful insert is what actually satisfies that: a job that
     * acknowledges in arrears could only ever be late, and would be silently
     * skipped for the one complaint whose row failed to reach a queue.
     *
     * The reference is quoted because it is the only handle either side has on
     * the complaint afterwards, and the disposal date is stated outright so the
     * commitment is on the record in the complainant's own inbox.
     *
     * @param {string} toEmailAddress
     * @param {string} complaintReference
     * @param {string} disposalDateText human-readable date the complaint will be disposed of by
     * @returns {Promise<void>}
     */
    static async sendIntellectualPropertyComplaintAcknowledgmentEmail(toEmailAddress, complaintReference, disposalDateText)
    {
        const subject = `We've received your copyright complaint (${complaintReference})`;
        const plainTextBody =
            `Thank you — we've received your copyright / intellectual property complaint and recorded it.\n\n` +
            `Your reference: ${complaintReference}\n\n` +
            `Our Grievance Officer will review it and respond by ${disposalDateText}, within the 15 days our Terms of ` +
            `Service commit to. If we need anything further to identify the material, we'll write to you at this address.\n\n` +
            `Please quote your reference in any reply. You can reach the Grievance Officer directly at copyright@cogniumlabs.io.`;

        const htmlBody = EmailTemplate.buildSupportTicketEmail
        (
            "We've received your copyright complaint",
            "Thank you — your copyright / intellectual property complaint has been recorded and passed to our Grievance Officer.",
            `Your reference: ${complaintReference}`,
            `We will respond by ${disposalDateText}, within the 15 days our Terms of Service commit to.`,
            "Please quote your reference in any reply. You can reach the Grievance Officer directly at copyright@cogniumlabs.io."
        );

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody, EmailSenderIdentities.GRIEVANCE);
        await EmailSender.send(emailMessage);
    }

    static async sendOrgAdminVerificationEmail(toEmailAddress, sixDigitCode, organizationName)
    {
        // Distinct subject + body from sendOtpEmail so the recipient knows
        // this is a one-shot admin appointment, NOT a login attempt to
        // their account. The CogniumLearn super-admin shares this code with
        // the appointed admin verbally / out-of-band, then types it back
        // into the admin panel — the appointed admin does NOT enter the
        // code themselves anywhere in this flow.
        const orgLine = organizationName
            ? ` for the organization "${organizationName}"`
            : "";

        const subject = "Your CogniumLearn organization-admin verification code";
        const plainTextBody =
            `CogniumLearn has been asked to appoint you as the administrator${orgLine}.\n\n` +
            `Your one-time verification code is: ${sixDigitCode}\n\n` +
            `Share this code only with the CogniumLearn team member who is setting up your organization. ` +
            `This code expires in 60 minutes. ` +
            `If you weren't expecting this, you can safely ignore this email.`;

        const htmlBody = EmailTemplate.buildCodeEmail
        (
            "Organization-admin verification code",
            `CogniumLearn has been asked to appoint you as the administrator${orgLine}. Share this one-time code with the CogniumLearn team member who is setting up your organization:`,
            sixDigitCode,
            "This code expires in 60 minutes. If you weren't expecting this, you can safely ignore this email."
        );

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody, EmailSenderIdentities.SECURITY);
        await EmailSender.send(emailMessage);
    }

    /**
     * Tells a reporter that the issue they raised has been fixed, quoting what the
     * admin wrote and naming any credit reward that came with it.
     *
     * Only sent to reporters who asked to be notified. Everyone who reported the
     * problem is still granted the credits — the checkbox governs being written
     * to, not being compensated.
     *
     * @param {string} toEmailAddress
     * @param {string} ticketTitle
     * @param {string} resolutionMessage
     * @param {number} creditsGranted
     * @returns {Promise<void>}
     */
    static async sendSupportTicketResolvedEmail(toEmailAddress, ticketTitle, resolutionMessage, creditsGranted)
    {
        const subject = "Resolved: the issue you reported on CogniumLearn";
        const rewardLine = creditsGranted > 0
            ? `As a thank you for taking the time to report it, we've added ${creditsGranted} credits to your account.`
            : "";

        const plainTextBody =
            `Good news — the issue you reported has been resolved.\n\n` +
            `Issue: ${ticketTitle}\n\n` +
            `${resolutionMessage}\n\n` +
            (rewardLine ? `${rewardLine}\n\n` : "") +
            `Thank you for helping us make CogniumLearn better.`;

        const htmlBody = EmailTemplate.buildSupportTicketEmail
        (
            "The issue you reported is fixed",
            `Good news — the issue you reported ("${ticketTitle}") has been resolved. Here's what changed:`,
            resolutionMessage,
            rewardLine,
            "Thank you for helping us make CogniumLearn better. You're receiving this because you asked to be notified when this issue was resolved."
        );

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody, EmailSenderIdentities.SUPPORT);
        await EmailSender.send(emailMessage);
    }

    /**
     * Tells a reporter that their issue will not be actioned. The admin's note is
     * optional — when they leave it blank the generic explanation below stands on
     * its own, so a decline is never a silent dead end.
     *
     * @param {string} toEmailAddress
     * @param {string} ticketTitle
     * @param {string} declineMessage may be empty
     * @returns {Promise<void>}
     */
    static async sendSupportTicketDeclinedEmail(toEmailAddress, ticketTitle, declineMessage)
    {
        const subject = "Update on the issue you reported on CogniumLearn";
        const genericExplanation =
            "After reviewing it, we've decided not to make a change for this one right now — it may be working as intended, " +
            "already covered elsewhere, or outside what we can support at the moment.";
        const introText = String(declineMessage ?? "").trim().length > 0
            ? `We've finished reviewing the issue you reported ("${ticketTitle}"). Here's what we found:`
            : `We've finished reviewing the issue you reported ("${ticketTitle}"). ${genericExplanation}`;

        const plainTextBody =
            `We've finished reviewing the issue you reported.\n\n` +
            `Issue: ${ticketTitle}\n\n` +
            `${String(declineMessage ?? "").trim().length > 0 ? declineMessage : genericExplanation}\n\n` +
            `We're still grateful you took the time to tell us — please keep the reports coming.`;

        const htmlBody = EmailTemplate.buildSupportTicketEmail
        (
            "Update on the issue you reported",
            introText,
            declineMessage,
            "",
            "We're still grateful you took the time to tell us. You're receiving this because you asked to be notified about this issue."
        );

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody, EmailSenderIdentities.SUPPORT);
        await EmailSender.send(emailMessage);
    }
}

module.exports = EmailSender;
