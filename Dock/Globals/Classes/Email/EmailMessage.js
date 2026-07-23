/**
 * A single transactional email, transport-agnostic. Any email the platform
 * sends — sign-in codes, org-admin verification, and future notification /
 * feature-release messages — is expressed as an EmailMessage and handed to an
 * EmailProvider, which is the only layer that knows how the bytes leave the
 * server. Keeping the message a plain value object (no transport concerns) is
 * what lets a new email type be added without touching any provider.
 */
class EmailMessage
{
    constructor(sourceEmail, recipientEmail, subject, plainTextBody, htmlBody)
    {
        this.sourceEmail = typeof sourceEmail === "string" ? sourceEmail : "";
        this.recipientEmail = typeof recipientEmail === "string" ? recipientEmail : "";
        this.subject = typeof subject === "string" ? subject : "";
        this.plainTextBody = typeof plainTextBody === "string" ? plainTextBody : "";
        this.htmlBody = typeof htmlBody === "string" ? htmlBody : "";
    }

    getSourceEmail()
    {
        return this.sourceEmail;
    }

    getRecipientEmail()
    {
        return this.recipientEmail;
    }

    getSubject()
    {
        return this.subject;
    }

    getPlainTextBody()
    {
        return this.plainTextBody;
    }

    getHtmlBody()
    {
        return this.htmlBody;
    }

    /**
     * Returns a copy of this message with the given source address, used when
     * a caller composed the message before the platform-default source was
     * resolved. Leaves the original untouched.
     */
    withSourceEmail(sourceEmail)
    {
        return new EmailMessage
        (
            sourceEmail,
            this.recipientEmail,
            this.subject,
            this.plainTextBody,
            this.htmlBody
        );
    }

    /**
     * True when the message has everything a provider needs to dispatch it.
     * Providers re-check this so a half-built message fails fast with a clear
     * error rather than a provider-specific one.
     */
    isDispatchable()
    {
        return this.sourceEmail.length > 0
            && this.recipientEmail.length > 0
            && this.subject.length > 0
            && (this.plainTextBody.length > 0 || this.htmlBody.length > 0);
    }
}

module.exports = EmailMessage;
