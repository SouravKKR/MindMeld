const { planFeatures } = require("../../Enumerations/PlanFeatures");


/**
 * OrganizationFeatureSelection
 *
 * Validation and defaults for the two feature lists a super-admin sets on an
 * organization: `grantableFeatures`, which bounds what its permission rules may
 * hand its members, and `adminAllowedFeatures`, which is what its owner holds
 * inside its view.
 *
 * Both arrive from a client as an array of numbers and both are stored
 * verbatim, so an unchecked value would sit in the database forever matching
 * nothing — a feature the buyer believes they were sold and that no gate will
 * ever recognise. Validation therefore REFUSES an unknown value rather than
 * dropping it silently, because a request that quietly stored less than it was
 * given is the failure mode nobody notices.
 *
 * The two lists share this class because they share the shape and must agree on
 * what a valid value is; they deliberately do NOT clamp against each other. See
 * OrganizationFeatureResolver for why the owner's grant is not bounded by the
 * organization's own allow-list.
 */
class OrganizationFeatureSelection
{
    /**
     * Every feature the product has, in enum order.
     *
     * Derived rather than listed so a feature added to the enumeration is
     * offered to new organizations automatically — a hard-coded list here would
     * quietly withhold it and nothing would fail.
     *
     * @returns {number[]}
     */
    static getAllFeatureValues()
    {
        return Object.values(planFeatures).map(featureValue => Number(featureValue));
    }

    /**
     * Validates a client-supplied feature list.
     *
     * @param {*} rawFeatureValues the value as it arrived in the request body
     * @returns {{ valid: boolean, featureValues: number[], invalidValue: * }}
     *   `featureValues` is de-duplicated and numeric; `invalidValue` names the
     *   entry that failed, so the refusal can say which one.
     */
    static validate(rawFeatureValues)
    {
        if (!Array.isArray(rawFeatureValues))
        {
            return { valid: false, featureValues: [], invalidValue: rawFeatureValues };
        }

        const knownFeatureValues = OrganizationFeatureSelection.getAllFeatureValues();
        const requestedFeatureValues = [];

        for (const rawFeatureValue of rawFeatureValues)
        {
            const featureValue = Number(rawFeatureValue);
            if (!Number.isInteger(featureValue) || !knownFeatureValues.includes(featureValue))
            {
                return { valid: false, featureValues: [], invalidValue: rawFeatureValue };
            }
            requestedFeatureValues.push(featureValue);
        }

        return { valid: true, featureValues: Array.from(new Set(requestedFeatureValues)), invalidValue: null };
    }
}

module.exports = OrganizationFeatureSelection;
