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
}

module.exports = EmailSender;
