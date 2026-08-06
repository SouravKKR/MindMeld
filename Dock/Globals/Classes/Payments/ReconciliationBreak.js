const { reconciliationBreakTypes } = require("../../Enumerations/ReconciliationBreakTypes");

/**
 * ReconciliationBreak
 *
 * One thing that did not add up on one day.
 *
 * A break is deliberately a value object rather than a free-form string: the
 * whole point of reconciliation is that the same discrepancy is recognisable
 * across days, so it has to carry a TYPE from a fixed set and a stable
 * REFERENCE (the order, payment or refund id) that a human can search the
 * provider dashboard for. A prose message alone would be unsearchable and
 * uncountable, which is how a recurring break turns into background noise.
 *
 * `amountMinor` is the money at stake — the figure that decides whether a break
 * is a rounding curiosity or a day that must not be signed off. It is zero for
 * breaks that are about missing entitlement rather than a missing amount.
 */
class ReconciliationBreak
{
    #type;
    #reference;
    #detail;
    #amountMinor;
    #currency;

    /**
     * @param {{type: number, reference: string, detail: string, amountMinor?: number, currency?: string}} fields
     */
    constructor({ type, reference, detail, amountMinor, currency } = {})
    {
        this.#type = Number(type) || reconciliationBreakTypes.NONE;
        this.#reference = typeof reference === "string" ? reference : "";
        this.#detail = typeof detail === "string" ? detail : "";
        this.#amountMinor = Number(amountMinor) || 0;
        this.#currency = typeof currency === "string" ? currency : "";
    }

    getType()
    {
        return this.#type;
    }

    getReference()
    {
        return this.#reference;
    }

    getDetail()
    {
        return this.#detail;
    }

    getAmountMinor()
    {
        return this.#amountMinor;
    }

    getCurrency()
    {
        return this.#currency;
    }

    /**
     * The name of the break type, for the stored document and the alert. Stored
     * ALONGSIDE the numeric type rather than instead of it: the number is what
     * code compares, the name is what makes a stored report readable years
     * later without the enum to hand.
     */
    getTypeName()
    {
        const matchingEntry = Object.entries(reconciliationBreakTypes)
            .find(([, enumValue]) => enumValue === this.#type);

        return matchingEntry ? matchingEntry[0] : "UNKNOWN";
    }

    toJson()
    {
        return {
            type: this.#type,
            typeName: this.getTypeName(),
            reference: this.#reference,
            detail: this.#detail,
            amountMinor: this.#amountMinor,
            currency: this.#currency
        };
    }

    static fromJson(json)
    {
        return new ReconciliationBreak(json || {});
    }
}

module.exports = ReconciliationBreak;
