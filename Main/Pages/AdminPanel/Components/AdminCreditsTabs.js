import CreditConfigEditor from "./CreditConfigEditor.js";
import CreditGrantPanel from "./CreditGrantPanel.js";
import { creditAdminSections } from "../../../Globals/Enumerations/CreditAdminSections.js";

/**
 * AdminCreditsTabs
 *
 * The sub-tabbed surface of the admin Credits tab. The credit system now has
 * too many aspects for one scroll (pricing & packs, manual grants, per-task
 * rules, storage rules, milestones & globals), so each gets its own sub-tab.
 *
 * Both child panels are created ONCE and switched via style.display — never
 * remounted. A remount would re-fetch /Admin/Credits/Config and discard the
 * editor's unsaved in-memory edits (and the grant panel's staged preview);
 * display-toggling preserves them across sub-tab switches.
 */
class AdminCreditsTabs extends HTMLElement
{
    static #SECTION_LABELS =
    {
        [creditAdminSections.PRICING_AND_PACKS]: "Pricing & Packs",
        [creditAdminSections.GRANTS]: "Grants",
        [creditAdminSections.TASK_RULES]: "Task Rules",
        [creditAdminSections.STORAGE_RULES]: "Storage Rules",
        [creditAdminSections.MILESTONES_AND_GLOBAL]: "Milestones & Global",
    };

    #activeSection = creditAdminSections.PRICING_AND_PACKS;
    #configEditorElement = null;
    #grantPanelElement = null;

    connectedCallback()
    {
        const sectionValues = Object.values(creditAdminSections);

        this.innerHTML = `
            <style>
                admin-credits-tabs { display: block; }

                .credits-subtabs
                {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-bottom: 18px;
                }

                .credits-subtab
                {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 999px;
                    outline: 1px solid var(--outline-color-subtle);
                    outline-offset: -1px;
                    background-color: var(--secondary-background-color);
                    color: var(--secondary-text-color);
                    font-size: 13px;
                    cursor: pointer;
                }

                .credits-subtab-active
                {
                    background: var(--primary-background-gradient);
                    color: var(--primary-text-color);
                    font-weight: 600;
                    outline: none;
                }
            </style>
            <div class="credits-subtabs">
                ${sectionValues.map(sectionValue => `<button class="credits-subtab" data-section="${sectionValue}">${AdminCreditsTabs.#SECTION_LABELS[sectionValue]}</button>`).join("")}
            </div>
            <div class="credits-subtab-panels" data-role="panels"></div>
        `;

        const panelsContainer = this.querySelector('[data-role="panels"]');
        this.#grantPanelElement = document.createElement("credit-grant-panel");
        this.#configEditorElement = document.createElement("credit-config-editor");
        panelsContainer.appendChild(this.#grantPanelElement);
        panelsContainer.appendChild(this.#configEditorElement);

        for (const subTabButton of this.querySelectorAll(".credits-subtab"))
        {
            subTabButton.addEventListener("click", (clickEvent) =>
            {
                this.#activeSection = Number(clickEvent.currentTarget.dataset.section);
                this.#applyActiveSection();
            });
        }

        this.#applyActiveSection();
    }

    #applyActiveSection()
    {
        for (const subTabButton of this.querySelectorAll(".credits-subtab"))
        {
            subTabButton.classList.toggle("credits-subtab-active", Number(subTabButton.dataset.section) === this.#activeSection);
        }

        const isGrantsSection = this.#activeSection === creditAdminSections.GRANTS;
        this.#grantPanelElement.style.display = isGrantsSection ? "" : "none";
        this.#configEditorElement.style.display = isGrantsSection ? "none" : "";

        if (!isGrantsSection)
        {
            this.#configEditorElement.showSection(this.#activeSection);
        }
    }
}

customElements.define("admin-credits-tabs", AdminCreditsTabs);
export default AdminCreditsTabs;
