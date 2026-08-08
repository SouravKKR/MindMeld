import PlanFeatureCatalogue from "./PlanFeatureCatalogue.js";

/**
 * FeatureCheckboxList
 *
 * One checkbox per product feature, rendered identically everywhere features
 * are chosen: the super-admin's create dialog, the same admin's entitlement
 * editor, and an organization's own permission rules.
 *
 * The three screens used to draw their own, and they drifted — different order,
 * different labels, and one of them without the explaining line underneath. A
 * feature matrix is exactly the place where that costs money: an administrator
 * ticking "Generate with AI" on one screen and looking for it under another
 * name on the next has no way to tell whether they have granted it twice or not
 * at all.
 *
 * The selection Set is MUTATED in place rather than returned, because every
 * caller keeps the Set and reads it when its own save button is pressed; a
 * callback that handed back a new array would leave each of them re-deriving
 * the same state.
 */
class FeatureCheckboxList
{
    static #DEFAULT_UNAVAILABLE_NOTE = "Not part of this organization's agreement.";
    static #DEFAULT_FORCED_NOTE = "Included for everyone — this cannot be switched off.";

    /**
     * Renders the list into a host element, replacing whatever it held.
     *
     * @param {HTMLElement} hostElement
     * @param {object} options
     * @param {Set<number>} options.selectedFeatureValues ticked values, mutated as the user ticks
     * @param {Set<number>} [options.forcedFeatureValues] ticked and locked — granted whatever the form says
     * @param {Set<number>} [options.unavailableFeatureValues] unticked and locked — cannot be granted here
     * @param {boolean} [options.bReadOnly] locks every box without changing what it shows
     * @param {string} [options.forcedNote] the line shown under a forced feature
     * @param {string} [options.unavailableNote] the line shown under an unavailable feature
     * @param {Function} [options.onChanged] called with (featureValue, bChecked) after each change
     */
    static render(hostElement, options)
    {
        if (!hostElement)
        {
            return;
        }

        const selectedFeatureValues = options?.selectedFeatureValues instanceof Set ? options.selectedFeatureValues : new Set();
        const forcedFeatureValues = options?.forcedFeatureValues instanceof Set ? options.forcedFeatureValues : new Set();
        const unavailableFeatureValues = options?.unavailableFeatureValues instanceof Set ? options.unavailableFeatureValues : new Set();
        const bReadOnly = options?.bReadOnly === true;
        const forcedNote = typeof options?.forcedNote === "string" ? options.forcedNote : FeatureCheckboxList.#DEFAULT_FORCED_NOTE;
        const unavailableNote = typeof options?.unavailableNote === "string" ? options.unavailableNote : FeatureCheckboxList.#DEFAULT_UNAVAILABLE_NOTE;
        const onChanged = typeof options?.onChanged === "function" ? options.onChanged : () => {};

        hostElement.innerHTML = "";

        for (const featureDescription of PlanFeatureCatalogue.DESCRIPTIONS)
        {
            const bForced = forcedFeatureValues.has(featureDescription.featureValue);
            const bUnavailable = !bForced && unavailableFeatureValues.has(featureDescription.featureValue);

            const featureLabel = document.createElement("label");
            featureLabel.className = "organization-permission-feature";

            const featureCheckbox = document.createElement("input");
            featureCheckbox.type = "checkbox";
            featureCheckbox.checked = bForced || selectedFeatureValues.has(featureDescription.featureValue);
            featureCheckbox.disabled = bForced || bUnavailable || bReadOnly;
            featureCheckbox.addEventListener("change", () =>
            {
                if (featureCheckbox.checked)
                {
                    selectedFeatureValues.add(featureDescription.featureValue);
                }
                else
                {
                    selectedFeatureValues.delete(featureDescription.featureValue);
                }
                onChanged(featureDescription.featureValue, featureCheckbox.checked);
            });

            const featureBody = document.createElement("span");
            featureBody.className = "organization-permission-feature-body";

            const featureTitle = document.createElement("span");
            featureTitle.className = "organization-permission-feature-title";
            featureTitle.textContent = featureDescription.label;

            const featureNote = document.createElement("small");
            featureNote.className = "organization-permission-feature-note";
            if (bForced)
            {
                featureNote.textContent = forcedNote;
            }
            else if (bUnavailable)
            {
                featureNote.textContent = unavailableNote;
            }
            else
            {
                featureNote.textContent = featureDescription.description;
            }

            featureBody.appendChild(featureTitle);
            featureBody.appendChild(featureNote);
            featureLabel.appendChild(featureCheckbox);
            featureLabel.appendChild(featureBody);
            hostElement.appendChild(featureLabel);
        }
    }
}

export default FeatureCheckboxList;
