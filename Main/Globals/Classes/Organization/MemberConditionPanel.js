import AdminListFilterInputFactory from "../../../CommonComponents/AdminListFilterInputFactory.js";

/**
 * MemberConditionPanel
 *
 * The condition builder inside one permission rule — "admitted between 2022 and
 * 2024", "role is teacher" — rendered from the very filter metadata the member
 * roster is filtered by.
 *
 * Building it from that metadata rather than from a hand-written form is the
 * whole point. The roster already knows which columns this institute keeps and
 * how each one reads, so a rule automatically gains a control for every column
 * the institute uploads, labelled the way the institute named it, and a rule
 * condition and a roster filter cannot come to mean different things.
 *
 * Tags are deliberately NOT offered here. They have their own picker on the rule
 * card with an any/all choice that a checkbox list cannot express, and offering
 * two ways to say "tagged scholarship" in one card would leave the reader
 * guessing which one the rule actually used.
 */
class MemberConditionPanel
{
    // Handled by the rule's own tag picker, which can say ANY or ALL.
    static EXCLUDED_FILTER_KEYS = ["tags"];

    #hostElement;
    #onChangedCallback;
    #filterInputs = [];
    #metadataByKey = new Map();

    constructor(hostElement, onChangedCallback)
    {
        if (!hostElement)
        {
            throw new Error("MemberConditionPanel requires a host element");
        }

        this.#hostElement = hostElement;
        this.#onChangedCallback = typeof onChangedCallback === "function" ? onChangedCallback : () => {};
    }

    /**
     * @param {Array<object>} filterMetadataList as served by /Organization/Permissions
     * @param {Array<object>} savedConditions the rule's stored conditions
     * @param {boolean} bReadOnly
     */
    render(filterMetadataList, savedConditions, bReadOnly)
    {
        this.#hostElement.innerHTML = "";
        this.#filterInputs = [];
        this.#metadataByKey = new Map();

        const offeredMetadata = (Array.isArray(filterMetadataList) ? filterMetadataList : [])
            .filter(metadata => !MemberConditionPanel.EXCLUDED_FILTER_KEYS.includes(metadata.key));

        if (offeredMetadata.length === 0)
        {
            const noticeElement = document.createElement("p");
            noticeElement.className = "admin-panel-add-subtitle";
            noticeElement.textContent = "This organization has no member columns yet. Import a roster with columns such as a name, a joining year or a role, and they will be offered here.";
            this.#hostElement.appendChild(noticeElement);
            return;
        }

        const savedValueByKey = new Map();
        for (const condition of (Array.isArray(savedConditions) ? savedConditions : []))
        {
            savedValueByKey.set(condition.key, condition.value);
        }

        for (const metadata of offeredMetadata)
        {
            const fieldElement = document.createElement("div");
            fieldElement.className = "organization-condition-field";

            const filterInput = AdminListFilterInputFactory.create(metadata, () => this.#onChangedCallback());
            if (filterInput === null)
            {
                continue;
            }

            filterInput.render(fieldElement);

            if (savedValueByKey.has(metadata.key))
            {
                filterInput.setValue(savedValueByKey.get(metadata.key));
            }

            if (bReadOnly)
            {
                for (const controlElement of fieldElement.querySelectorAll("input, select, textarea"))
                {
                    controlElement.disabled = true;
                }
            }

            this.#hostElement.appendChild(fieldElement);
            this.#filterInputs.push(filterInput);
            this.#metadataByKey.set(metadata.key, metadata);
        }
    }

    /**
     * The conditions as they are stored on a rule.
     *
     * Each carries the type and field alongside its key, so deciding whether a
     * member matches needs nothing but the rule and the member — which is what
     * lets the per-request feature check answer without a database lookup.
     *
     * @returns {Array<{key: string, type: number, field: string, value: *}>}
     */
    getConditions()
    {
        const conditions = [];

        for (const filterInput of this.#filterInputs)
        {
            const value = filterInput.getValue();
            if (value === undefined)
            {
                // An untouched control is not a condition. Storing it would turn
                // "I did not narrow by joining year" into a clause the server
                // has to interpret.
                continue;
            }

            const metadata = this.#metadataByKey.get(filterInput.getKey());
            if (!metadata || typeof metadata.field !== "string" || metadata.field.length === 0)
            {
                continue;
            }

            conditions.push
            ({
                key: filterInput.getKey(),
                type: metadata.type,
                field: metadata.field,
                value: value
            });
        }

        return conditions;
    }

    clearAll()
    {
        for (const filterInput of this.#filterInputs)
        {
            filterInput.clear();
        }
        this.#onChangedCallback();
    }
}

export default MemberConditionPanel;
