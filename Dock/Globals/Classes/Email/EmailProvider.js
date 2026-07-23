/**
 * Transport abstraction for outbound email. A provider is the only layer that
 * knows how an EmailMessage physically leaves the server (AWS SES, SMTP, …).
 * EmailSender composes messages and hands them here through
 * EmailProviderFactory, so swapping the active transport never touches the
 * content layer or any caller.
 *
 * Mirrors the PaymentProvider abstraction in Classes/Payments/ — same
 * getProviderEnumValue / isConfigured shape, same factory selection.
 */
class EmailProvider
{
    getProviderEnumValue()
    {
        throw new Error("EmailProvider.getProviderEnumValue() must be implemented by subclass");
    }

    /**
     * Whether this provider has every credential / setting it needs to send.
     * Read before dispatch so a misconfigured provider fails with a clear,
     * actionable error instead of a transport-library stack trace.
     */
    isConfigured()
    {
        throw new Error("EmailProvider.isConfigured() must be implemented by subclass");
    }

    /**
     * Dispatches a single EmailMessage. Resolves once the message is accepted
     * by the transport; rejects with a descriptive Error otherwise.
     */
    async sendEmail(emailMessage)
    {
        throw new Error("EmailProvider.sendEmail() must be implemented by subclass");
    }
}

module.exports = EmailProvider;
