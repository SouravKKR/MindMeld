const App = require("../App");
const EmailMessage = require("./EmailMessage");
const EmailTemplate = require("./EmailTemplate");
const EmailProviderFactory = require("./EmailProviderFactory");

/**
 * The high-level email API. It composes the message content (subject + branded
 * body via EmailTemplate) and delegates the actual dispatch to whichever
 * EmailProvider is active (EmailProviderFactory.getDefaultProvider() — AWS SES
 * by default). It knows nothing about SES/SMTP internals.
 *
 * Adding a new email type — a notification, a feature-release announcement — is
 * just another method here that builds an EmailMessage and calls send(); the
 * transport, provider selection, and branding are all reused unchanged.
 */
class EmailSender
{
    /**
     * Generalized dispatch seam. Any caller (current or future) can build an
     * EmailMessage and send it through the active provider. When the message
     * carries no source address, the platform default is filled in here so
     * individual callers never have to know it.
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

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody);
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

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody);
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

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody);
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

        const emailMessage = new EmailMessage("", toEmailAddress, subject, plainTextBody, htmlBody);
        await EmailSender.send(emailMessage);
    }
}

module.exports = EmailSender;
