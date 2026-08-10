const { supportTicketTypes } = require("../../Enumerations/SupportTicketTypes");

/**
 * PublicReportPolicy — the single authority on which kinds of report the
 * platform accepts from someone who is not signed in, and on how each of those
 * kinds is then handled.
 *
 * There are two doors into the reporting subsystem now: the authenticated
 * Report Issue dialog, and the unauthenticated form on the sign-in screen and
 * the /copyright page. Both consult this class rather than carrying their own
 * list, because the two answers have to agree and they are decided in different
 * files. A copy of the rule in each door is a rule that drifts, and the way it
 * drifts is that one door quietly starts accepting something the other refuses.
 *
 * WHY ONLY TWO TYPES ARE PUBLIC.
 *
 * An intellectual-property complaint MUST be reachable without an account. The
 * whole point of the channel is that a rightsholder who has never used the
 * product — and never will — can tell us their work is on it. Requiring them to
 * sign up first would make the channel decorative, and the Terms commit to
 * accepting a complaint from anyone.
 *
 * An account-access report is public for the mirror-image reason: the person
 * who most needs it is by definition the person who cannot log in. Every other
 * type describes something the reporter can only have seen from inside a
 * session, so it stays behind the login where it can be attributed, quota'd and
 * rewarded.
 *
 * WHY IP COMPLAINTS BYPASS GROUPING.
 *
 * Every other report is embedded and clustered onto a shared SupportTicket by
 * the deduplication workflow. A complaint must not be: it is a legal notice
 * with its own clock, its own complainant and its own disposal record, and
 * folding two rightsholders' notices about different works into one ticket
 * would mean one of them is disposed of by an answer written for the other.
 */
class PublicReportPolicy
{
    /**
     * Report types accepted without a session.
     *
     * A Set rather than an array so the membership test at each door is a
     * lookup and cannot be written as a partial scan.
     */
    static PUBLIC_ISSUE_TYPES = new Set
    ([
        supportTicketTypes.INTELLECTUAL_PROPERTY,
        supportTicketTypes.ACCOUNT_ACCESS
    ]);

    /**
     * Report types that must never be handed to the deduplication workflow.
     */
    static GROUPING_EXEMPT_ISSUE_TYPES = new Set
    ([
        supportTicketTypes.INTELLECTUAL_PROPERTY
    ]);

    /**
     * Report types that are stored as intellectual-property complaints rather
     * than as ordinary support reports — a different collection, a different
     * retention posture and a different queue.
     */
    static COMPLAINT_ISSUE_TYPES = new Set
    ([
        supportTicketTypes.INTELLECTUAL_PROPERTY
    ]);

    /**
     * Report types whose description is scrubbed for credentials before it is
     * stored.
     *
     * Only the account-access type, deliberately. That is the one whose reporter
     * is describing a credential failure and therefore likely to quote the
     * credential; everywhere else the same scrub would be a net loss, because
     * its bare-six-digit rule would redact order numbers and amounts out of
     * billing reports to protect against a password nobody was going to type.
     */
    static CREDENTIAL_SCRUB_ISSUE_TYPES = new Set
    ([
        supportTicketTypes.ACCOUNT_ACCESS
    ]);

    /**
     * @param {number} issueType
     * @returns {boolean}
     */
    static requiresCredentialScrub(issueType)
    {
        return PublicReportPolicy.CREDENTIAL_SCRUB_ISSUE_TYPES.has(Number(issueType));
    }

    /**
     * @param {number} issueType
     * @returns {boolean}
     */
    static isAcceptedWithoutAuthentication(issueType)
    {
        return PublicReportPolicy.PUBLIC_ISSUE_TYPES.has(Number(issueType));
    }

    /**
     * @param {number} issueType
     * @returns {boolean}
     */
    static isGroupingExempt(issueType)
    {
        return PublicReportPolicy.GROUPING_EXEMPT_ISSUE_TYPES.has(Number(issueType));
    }

    /**
     * @param {number} issueType
     * @returns {boolean}
     */
    static isIntellectualPropertyComplaint(issueType)
    {
        return PublicReportPolicy.COMPLAINT_ISSUE_TYPES.has(Number(issueType));
    }

    /**
     * The public list, for the unauthenticated dialog to render. Sorted so the
     * order the reporter sees does not depend on Set insertion order changing
     * when a type is added above.
     *
     * @returns {number[]}
     */
    static listPublicIssueTypes()
    {
        return [...PublicReportPolicy.PUBLIC_ISSUE_TYPES].sort((firstType, secondType) => firstType - secondType);
    }
}

module.exports = PublicReportPolicy;
