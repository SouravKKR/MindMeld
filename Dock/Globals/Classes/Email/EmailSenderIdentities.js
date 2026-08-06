/**
 * The fixed set of display names that may appear beside the platform's "from"
 * address — the "CogniumLearn Security" in `CogniumLearn Security
 * <noreply@cogniumlearn.io>`. The address itself never changes (it has to stay
 * the verified SES identity); only the name beside it varies, so a recipient
 * can tell a sign-in code apart from a support reply before opening either.
 *
 * These are static members rather than strings typed at each call site so the
 * set stays small and auditable: mail clients thread and group by display name,
 * and a unique name per message would scatter one conversation across many
 * groups in the recipient's inbox.
 *
 * Names must be printable ASCII. A display name carrying non-ASCII characters
 * needs RFC 2047 encoded-word encoding, which SES does not apply for you —
 * EmailMessage.getFormattedSourceAddress() therefore drops such a name rather
 * than shipping a mojibake From header.
 */
class EmailSenderIdentities
{
    /**
     * Anything that does not name an identity of its own — and the fallback
     * EmailSender.send() fills in for externally composed messages.
     */
    static DEFAULT = "CogniumLearn";

    /**
     * Authentication and account-integrity mail: sign-in codes, org-admin
     * verification codes. Deliberately distinct from the everyday product name
     * so a code that arrives unrequested reads as a security event.
     */
    static SECURITY = "CogniumLearn Security";

    /**
     * Replies to something the user raised with us — support-ticket outcomes.
     */
    static SUPPORT = "CogniumLearn Support";

    /**
     * Product notifications the user opted into: finished generations, study
     * reminders. The plain product name, because this is ordinary app traffic.
     */
    static NOTIFICATIONS = EmailSenderIdentities.DEFAULT;
}

module.exports = EmailSenderIdentities;
