import PaidDeckFilterInput from "./PaidDeckFilterInput.js";
import SearchableDropdown from "../../../CommonComponents/SearchableDropdown.js";

/**
 * InstituteSelectFilterInput
 *
 * Renders a trigger button that opens a multi-select SearchableDropdown
 * over the live institute list served with the filter metadata. Each
 * institute row offers its canonical name, location, and alternate
 * names so a user query like "BIT" matches "Bangalore Institute of
 * Technology" via the alternate-name array even when the alts aren't
 * in the rendered label.
 *
 * Value contract: array of canonical institute names. Empty array
 * (`undefined` from getValue) means "no institute filter applied".
 */
class InstituteSelectFilterInput extends PaidDeckFilterInput
{
    #selectedInstituteNames = [];
    #triggerElement = null;
    #labelElement = null;
    #institutes = [];

    render(container)
    {
        const metadata = this.getMetadata();
        this.#institutes = Array.isArray(metadata.institutes) ? metadata.institutes : [];

        if (this.#institutes.length === 0)
        {
            container.innerHTML = `
                <label class="paid-deck-filter-label">${this.getLabel()}</label>
                <div class="paid-deck-filter-empty">No institutes available yet.</div>
            `;
            this.#triggerElement = null;
            this.#labelElement = null;
            return;
        }

        container.innerHTML = `
            <label class="paid-deck-filter-label">${this.getLabel()}</label>
            <button type="button" class="searchable-dropdown-trigger paid-deck-filter-institute-trigger">
                <span class="searchable-dropdown-trigger-label paid-deck-filter-institute-trigger-label">Any institute</span>
                <span class="searchable-dropdown-trigger-chevron" aria-hidden="true"></span>
            </button>
        `;

        this.#triggerElement = container.querySelector(".paid-deck-filter-institute-trigger");
        this.#labelElement = container.querySelector(".paid-deck-filter-institute-trigger-label");

        this.#triggerElement.addEventListener("click", () => this.#openPicker());
    }

    async #openPicker()
    {
        const dropdownItems = this.#institutes.map(institute =>
        {
            return {
                key: institute.name,
                label: institute.location && institute.location.length > 0
                    ? `${institute.name} — ${institute.location}`
                    : institute.name,
                sublabel: Array.isArray(institute.alternateNames) && institute.alternateNames.length > 0
                    ? institute.alternateNames.join(", ")
                    : ""
            };
        });

        const pickedKeys = await SearchableDropdown.show
        ({
            title: "Filter by institute",
            searchPlaceholder: "Search by name, alternate, or location...",
            items: dropdownItems,
            multiSelect: true,
            initialKeys: this.#selectedInstituteNames.slice(),
            applyButtonLabel: "Apply"
        });

        if (pickedKeys === null)
        {
            return;
        }

        this.#selectedInstituteNames = Array.isArray(pickedKeys) ? pickedKeys : [];
        this.#refreshTriggerLabel();
        this.emitChange();
    }

    #refreshTriggerLabel()
    {
        if (!this.#labelElement)
        {
            return;
        }

        if (this.#selectedInstituteNames.length === 0)
        {
            this.#labelElement.textContent = "Any institute";
            return;
        }

        if (this.#selectedInstituteNames.length === 1)
        {
            this.#labelElement.textContent = this.#selectedInstituteNames[0];
            return;
        }

        this.#labelElement.textContent = `${this.#selectedInstituteNames.length} institutes selected`;
    }

    getValue()
    {
        return this.#selectedInstituteNames.length > 0 ? this.#selectedInstituteNames.slice() : undefined;
    }

    clear()
    {
        this.#selectedInstituteNames = [];
        this.#refreshTriggerLabel();
    }
}

export default InstituteSelectFilterInput;
