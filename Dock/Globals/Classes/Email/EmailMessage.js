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
    /**
     * Any character below the space or at DEL is illegal inside a header value;
     * CR and LF are the dangerous ones, since a newline smuggled into a display
     * name would inject a header of the attacker's choosing.
     */
    static HEADER_CONTROL_CHARACTER_PATTERN = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

    /**
     * Anything outside printable ASCII needs RFC 2047 encoded-word encoding to
     * appear in a display name. SES does not apply it for you, so a name that
     * matches this is dropped rather than sent as mojibake.
     */
    static NON_ASCII_PATTERN = new RegExp("[^\\u0020-\\u007E]");

    constructor(sourceEmail, recipientEmail, subject, plainTextBody, htmlBody, senderName)
    {
        this.sourceEmail = typeof sourceEmail === "string" ? sourceEmail : "";
        this.recipientEmail = typeof recipientEmail === "string" ? recipientEmail : "";
        this.subject = typeof subject === "string" ? subject : "";
        this.plainTextBody = typeof plainTextBody === "string" ? plainTextBody : "";
        this.htmlBody = typeof htmlBody === "string" ? htmlBody : "";
        this.senderName = typeof senderName === "string" ? senderName : "";
    }

    getSourceEmail()
    {
        return this.sourceEmail;
    }

    /**
     * The friendly name shown beside the source address in the recipient's
     * inbox. Empty when the message should be sent with a bare address.
     */
    getSenderName()
    {
        return this.senderName;
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
     * The value every provider puts in the From header: `"Display Name"
     * <address>` when a usable display name is set, and the bare address
     * otherwise. Both SES v2 (FromEmailAddress) and nodemailer (from) accept
     * this form, so the RFC 5322 quoting rules live here once instead of in
     * each transport.
     *
     * The name is always quoted — legal for any name, and it saves testing for
     * the RFC's "specials" — with its own quotes and backslashes escaped so no
     * name can break out of the quoted string.
     */
    getFormattedSourceAddress()
    {
        const sanitizedName = this.senderName.replace(EmailMessage.HEADER_CONTROL_CHARACTER_PATTERN, "").trim();

        if (sanitizedName.length === 0 || EmailMessage.NON_ASCII_PATTERN.test(sanitizedName))
        {
            return this.sourceEmail;
        }

        const escapedName = sanitizedName.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
        return `"${escapedName}" <${this.sourceEmail}>`;
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
            this.htmlBody,
            this.senderName
        );
    }

    /**
     * Returns a copy of this message with the given display name. Used by
     * EmailSender to stamp the platform-default identity on a message whose
     * author did not choose one. Leaves the original untouched.
     */
    withSenderName(senderName)
    {
        return new EmailMessage
        (
            this.sourceEmail,
            this.recipientEmail,
            this.subject,
            this.plainTextBody,
            this.htmlBody,
            senderName
        );
    }

    /**
     * True when the message has everything a provider needs to dispatch it.
     * Providers re-check this so a half-built message fails fast with a clear
     * error rather than a provider-specific one. The display name is optional —
     * a message with none is dispatched from the bare address.
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
