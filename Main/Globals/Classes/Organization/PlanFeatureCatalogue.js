import { planFeatures } from "../../Enumerations/PlanFeatures.js";

/**
 * PlanFeatureCatalogue
 *
 * The product's features, in the order they are sold, with the wording a person
 * buying or granting them would use.
 *
 * This list used to exist twice — once in the super-admin's organization dialog
 * and once in the organization's own permissions editor — with different labels
 * and a different order, so the same checkbox meant two things depending on
 * which screen you were looking at. It is a catalogue rather than a derivation
 * from the enumeration because the enumeration's names are identifiers
 * ("MOCK_TEST_EVALUATION") and a person ticking a box needs a capability
 * ("Mock-test evaluation", and what it does).
 *
 * A feature added to the enumeration and not added here simply does not appear
 * on any of those screens, which is the safe direction: an unlabelled checkbox
 * granting something nobody can name would be worse.
 */
class PlanFeatureCatalogue
{
    static DESCRIPTIONS =
    [
        { featureValue: planFeatures.ASK_AI, label: "Ask AI", description: "Ask a question about anything on screen" },
        { featureValue: planFeatures.CHAT, label: "Chat with a deck", description: "Ask questions against the deck's own content" },
        { featureValue: planFeatures.AUTOMATIC_GENERATION, label: "Generate with AI", description: "Build decks and study material from uploaded documents" },
        { featureValue: planFeatures.CURATED_STUDY, label: "Curated study material", description: "Auto-written lessons targeting weak topics" },
        { featureValue: planFeatures.MOCK_TEST_EVALUATION, label: "Mock-test evaluation", description: "AI marking and feedback on written answers" },
        { featureValue: planFeatures.IMAGE_GENERATION, label: "Image generation", description: "Diagrams and illustrations inside generated material" },
        { featureValue: planFeatures.MONTHLY_FREE_DECK, label: "Monthly free deck", description: "One marketplace deck a month at no cost" }
    ];

    /**
     * Every feature value the catalogue describes — the "tick everything"
     * default for a new organization's owner.
     *
     * @returns {number[]}
     */
    static getAllFeatureValues()
    {
        return PlanFeatureCatalogue.DESCRIPTIONS.map(featureDescription => featureDescription.featureValue);
    }

    /**
     * The label for one feature value, or the raw value when it has no entry —
     * so an unlisted feature reads as something support can trace rather than
     * as a blank.
     *
     * @param {number} featureValue a PlanFeatures value
     * @returns {string}
     */
    static getLabel(featureValue)
    {
        const featureDescription = PlanFeatureCatalogue.DESCRIPTIONS.find(entry => entry.featureValue === Number(featureValue));
        return featureDescription ? featureDescription.label : String(featureValue);
    }
}

export default PlanFeatureCatalogue;
