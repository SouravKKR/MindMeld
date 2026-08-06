/**
 * SettlementAmountGuard
 *
 * The last check before a verified payment becomes a granted entitlement:
 * does what the provider says was paid match what this server recorded as
 * owed?
 *
 * A valid signature proves the payment REFERENCE is authentic. It says nothing
 * about the VALUE. Those are different questions, and conflating them is how a
 * pricing-catalogue defect, a stale currency-conversion cache or a mis-wired
 * environment turns into a full-price entitlement granted for a fraction of the
 * price — with every cryptographic control passing cleanly on the way through.
 *
 * This is defence in depth rather than a live exploit path: the provider
 * enforces the amount recorded on the order it created, so a buyer cannot
 * simply pay less. Its real job is to make OUR OWN bugs loud. A mismatch here
 * means either an attack or a serious defect, and the handbook is explicit that
 * it must alert rather than fail quietly.
 *
 * Deliberately provider-agnostic. It takes the two numbers and two strings
 * rather than a Razorpay payload, so any future provider settles under exactly
 * the same rule — an asymmetry between providers is how a gap survives an audit.
 *
 * Comparison rules, and why each is what it is:
 *
 *   Amount    Exact integer equality in minor units. No tolerance: money is
 *             integers here by construction (Part 0.5), so any difference at
 *             all is a defect and not a rounding artefact.
 *   Currency  Case-insensitive, because providers are inconsistent about it,
 *             but otherwise exact. 49900 of one currency is not 49900 of
 *             another (A2).
 *   Order id  Exact. Guards against a payload whose payment belongs to a
 *             different order than the one we looked up.
 *
 * Absent fields are NOT treated as a mismatch. Some events legitimately carry
 * no payment entity (an `order.paid` with no nested payment), and refusing to
 * settle a genuine payment because the provider omitted a field we wanted to
 * cross-check would trade a real customer outcome for a theoretical one. Those
 * cases return `comparable: false` so the caller can settle while recording
 * that the assertion could not run.
 */
class SettlementAmountGuard
{
    static OUTCOME_MATCHED = "MATCHED";
    static OUTCOME_MISMATCHED = "MISMATCHED";
    static OUTCOME_NOT_COMPARABLE = "NOT_COMPARABLE";

    static #isFiniteNumber(value)
    {
        return typeof value === "number" && Number.isFinite(value);
    }

    static #normalizeCurrency(value)
    {
        return typeof value === "string" ? value.trim().toUpperCase() : "";
    }

    /**
     * @param {{amountMinor: *, currency: *, providerOrderId: *}} reported — what the provider says was paid
     * @param {{amountMinor: *, currency: *, providerOrderId: *}} expected — what this server recorded as owed
     * @returns {{outcome: string, comparable: boolean, matched: boolean, mismatches: Array<object>}}
     */
    static compare(reported, expected)
    {
        const reportedValues = reported || {};
        const expectedValues = expected || {};
        const mismatches = [];
        let comparedFieldCount = 0;

        const reportedAmount = Number(reportedValues.amountMinor);
        const expectedAmount = Number(expectedValues.amountMinor);
        if (SettlementAmountGuard.#isFiniteNumber(reportedAmount) && SettlementAmountGuard.#isFiniteNumber(expectedAmount))
        {
            comparedFieldCount = comparedFieldCount + 1;
            if (reportedAmount !== expectedAmount)
            {
                mismatches.push({ field: "amountMinor", reported: reportedAmount, expected: expectedAmount });
            }
        }

        const reportedCurrency = SettlementAmountGuard.#normalizeCurrency(reportedValues.currency);
        const expectedCurrency = SettlementAmountGuard.#normalizeCurrency(expectedValues.currency);
        if (reportedCurrency.length > 0 && expectedCurrency.length > 0)
        {
            comparedFieldCount = comparedFieldCount + 1;
            if (reportedCurrency !== expectedCurrency)
            {
                mismatches.push({ field: "currency", reported: reportedCurrency, expected: expectedCurrency });
            }
        }

        const reportedOrderId = typeof reportedValues.providerOrderId === "string" ? reportedValues.providerOrderId : "";
        const expectedOrderId = typeof expectedValues.providerOrderId === "string" ? expectedValues.providerOrderId : "";
        if (reportedOrderId.length > 0 && expectedOrderId.length > 0)
        {
            comparedFieldCount = comparedFieldCount + 1;
            if (reportedOrderId !== expectedOrderId)
            {
                mismatches.push({ field: "providerOrderId", reported: reportedOrderId, expected: expectedOrderId });
            }
        }

        if (mismatches.length > 0)
        {
            return { outcome: SettlementAmountGuard.OUTCOME_MISMATCHED, comparable: true, matched: false, mismatches: mismatches };
        }

        if (comparedFieldCount === 0)
        {
            return { outcome: SettlementAmountGuard.OUTCOME_NOT_COMPARABLE, comparable: false, matched: false, mismatches: [] };
        }

        return { outcome: SettlementAmountGuard.OUTCOME_MATCHED, comparable: true, matched: true, mismatches: [] };
    }

    /**
     * Whether settlement may proceed. A mismatch is the ONLY refusal — an
     * uncomparable event still settles, because the pending row remains the
     * authoritative record of what was bought regardless.
     */
    static permitsSettlement(comparison)
    {
        return Boolean(comparison) && comparison.outcome !== SettlementAmountGuard.OUTCOME_MISMATCHED;
    }

    /**
     * A one-line, log-safe summary of what differed. Contains only amounts,
     * currencies and order ids — never buyer identity or contact details.
     */
    static describe(comparison)
    {
        if (!comparison || !Array.isArray(comparison.mismatches) || comparison.mismatches.length === 0)
        {
            return "";
        }

        return comparison.mismatches
            .map(mismatch => `${mismatch.field}: provider reported ${mismatch.reported}, server expected ${mismatch.expected}`)
            .join("; ");
    }
}

module.exports = SettlementAmountGuard;
