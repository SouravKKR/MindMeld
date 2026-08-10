const IntellectualPropertyComplaintQueryEngine = require("../Database/IntellectualPropertyComplaintQueryEngine");
const IntellectualPropertyComplaintConstants = require("../../Constants/IntellectualPropertyComplaintConstants");
const RateLimitEventQueryEngine = require("../Database/RateLimitEventQueryEngine");

/**
 * PublicComplaintRateLimit — the durable daily ceiling on infringement
 * complaints from one contact address and from one network address.
 *
 * ── This limiter FLAGS. It does not refuse. ─────────────────────────────────
 *
 * That is the whole design, and it is deliberate. A rightsholder's agent
 * working through a catalogue files twenty complaints in an afternoon, and at
 * the limiter that is indistinguishable from someone abusing the form. One of
 * those two is doing exactly what the channel exists for, and refusing them
 * would mean the platform declined to receive a notice it has committed in its
 * Terms to receiving — with the twenty-one-day and fifteen-day clocks never
 * starting, because nothing was stored.
 *
 * So an over-limit complaint is still written, still acknowledged, and marked
 * so a human can see how it arrived. What the limit actually protects is the
 * OUTBOUND EMAIL: the confirmation code is not sent past the ceiling, because
 * that is the part an abuser can point at a third party's inbox.
 *
 * Counted in MongoDB rather than in the in-process RateLimiter for the same
 * reason SupportTicketQuota is: a daily ceiling held in memory hands out a
 * fresh allowance on every deploy.
 *
 * The window is a rolling 24 hours, so the ceiling does not depend on which
 * time zone the server thinks in and cannot be spent twice across a midnight.
 */
class PublicComplaintRateLimit
{
    static WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

    /**
     * Decides whether this submission is over either ceiling.
     *
     * Both counts are taken, not just the first that trips, because the record
     * should say which limit was crossed — "the same agent filed thirty" and
     * "thirty addresses filed from one machine" are different situations and an
     * administrator will treat them differently.
     *
     * Never throws: a counting failure must not stop a complaint being filed.
     * It resolves to "not flagged", which errs towards treating a complainant
     * as legitimate — the correct direction for a channel whose failure mode is
     * refusing to hear someone.
     *
     * @param {string} contactEmail
     * @param {string} sourceIpAddress
     * @returns {Promise<{bFlagged: boolean, emailCount: number, addressCount: number, reason: string}>}
     */
    static async evaluate(contactEmail, sourceIpAddress)
    {
        const windowStart = Date.now() - PublicComplaintRateLimit.WINDOW_MILLISECONDS;

        let emailCount = 0;
        let addressCount = 0;

        try
        {
            emailCount = await IntellectualPropertyComplaintQueryEngine.countByContactEmailSince(contactEmail, windowStart);
            addressCount = await IntellectualPropertyComplaintQueryEngine.countBySourceIpAddressSince(sourceIpAddress, windowStart);
        }
        catch (countError)
        {
            console.warn(`[PublicComplaintRateLimit] Could not count recent complaints: ${countError?.message || countError}`);
            return { bFlagged: false, emailCount: 0, addressCount: 0, reason: "" };
        }

        const bOverEmailLimit = emailCount >= IntellectualPropertyComplaintConstants.MAXIMUM_COMPLAINTS_PER_EMAIL_PER_DAY;
        const bOverAddressLimit = addressCount >= IntellectualPropertyComplaintConstants.MAXIMUM_COMPLAINTS_PER_ADDRESS_PER_DAY;

        if (!bOverEmailLimit && !bOverAddressLimit)
        {
            return { bFlagged: false, emailCount: emailCount, addressCount: addressCount, reason: "" };
        }

        const reason = [
            bOverEmailLimit ? `${emailCount} complaints from this address in 24 hours` : "",
            bOverAddressLimit ? `${addressCount} complaints from this network address in 24 hours` : ""
        ].filter(part => part.length > 0).join("; ");

        // Logged into the same admin-visible 429 register every other limit
        // writes to, even though no 429 is returned. The event is what makes an
        // over-limit run visible at all — the complaint itself is stored looking
        // like any other, by design.
        RateLimitEventQueryEngine.record
        ({
            endpoint: "/Legal/IntellectualPropertyComplaint",
            method: "POST",
            scope: "IP_COMPLAINT",
            identityType: "EMAIL",
            identityKey: `ip-complaint:${contactEmail}`,
            userId: null,
            ipAddress: sourceIpAddress,
            limit: IntellectualPropertyComplaintConstants.MAXIMUM_COMPLAINTS_PER_EMAIL_PER_DAY,
            windowMilliseconds: PublicComplaintRateLimit.WINDOW_MILLISECONDS,
            retryAfterSeconds: null
        }).catch(() => { });

        return { bFlagged: true, emailCount: emailCount, addressCount: addressCount, reason: reason };
    }
}

module.exports = PublicComplaintRateLimit;
