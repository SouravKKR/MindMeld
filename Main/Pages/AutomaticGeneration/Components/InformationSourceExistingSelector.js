import InformationSource from "../../../Globals/Model/InformationSource.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";
import { informationSourceTypes } from "../../../Globals/Enumerations/InformationSourceTypes.js";

class InformationSourceExistingSelector extends HTMLElement
{
    static tagName = "information-source-existing-selector";

    connectedCallback()
    {
        this.innerHTML =
        `
            <style>
                information-source-existing-selector
                {
                    display: flex;
                    flex-direction: column;
                    width: 500px;
                }

                .existing-selector-list
                {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    max-height: 420px;
                    overflow-y: auto;
                    padding-right: 4px;
                }

                .existing-selector-list::-webkit-scrollbar
                {
                    width: 4px;
                }

                .existing-selector-list::-webkit-scrollbar-track
                {
                    background: transparent;
                }

                .existing-selector-list::-webkit-scrollbar-thumb
                {
                    background-color: #333333;
                    border-radius: 4px;
                }

                .existing-selector-loading,
                .existing-selector-empty
                {
                    font-size: 0.85rem;
                    opacity: 0.4;
                    text-align: center;
                    padding: 30px 0;
                }

                .existing-selector-item
                {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px 14px;
                    border-radius: 10px;
                    border: 1px solid #2c2c2c;
                    background-color: #1a1a1a;
                    cursor: pointer;
                    transition: border-color 0.15s ease-in-out, background-color 0.15s ease-in-out;
                }

                .existing-selector-item:hover
                {
                    border-color: #0098C4;
                    background-color: rgba(0, 152, 196, 0.05);
                }

                .existing-selector-item-icon
                {
                    width: 16px;
                    height: 16px;
                    flex-shrink: 0;
                    opacity: 0.5;
                }

                .existing-selector-item-details
                {
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    flex: 1;
                    min-width: 0;
                }

                .existing-selector-item-name
                {
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: #ffffff;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .existing-selector-item-meta
                {
                    font-size: 0.75rem;
                    opacity: 0.4;
                }

                .existing-selector-item-tags
                {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                    flex-shrink: 0;
                }

                .existing-selector-item-tag
                {
                    font-size: 0.7rem;
                    font-weight: 500;
                    color: #0098C4;
                    background-color: rgba(0, 152, 196, 0.1);
                    border: 1px solid rgba(0, 152, 196, 0.25);
                    border-radius: 4px;
                    padding: 1px 6px;
                }
            </style>

            <div class="existing-selector-list">
                <div class="existing-selector-loading">Loading sources...</div>
            </div>
        `;

        this.#loadSources();
    }

    async #loadSources()
    {
        const list = this.querySelector(".existing-selector-list");

        try
        {
            const response = await fetch("/InformationSource/List");
            const sourcesJson = await response.json();
            const informationSources = sourcesJson.map(sourceJson => InformationSource.fromJson(sourceJson));

            list.innerHTML = "";

            if (informationSources.length === 0)
            {
                const emptyMessage = document.createElement("div");
                emptyMessage.classList.add("existing-selector-empty");
                emptyMessage.textContent = "No sources uploaded yet.";
                list.appendChild(emptyMessage);
                return;
            }

            for (const informationSource of informationSources)
            {
                list.appendChild(this.#buildSourceItem(informationSource));
            }
        }
        catch (error)
        {
            list.innerHTML = "";

            const errorMessage = document.createElement("div");
            errorMessage.classList.add("existing-selector-empty");
            errorMessage.textContent = "Failed to load sources.";
            list.appendChild(errorMessage);
        }
    }

    #buildSourceItem(informationSource)
    {
        const item = document.createElement("div");
        item.classList.add("existing-selector-item");

        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("fill", "none");
        icon.classList.add("existing-selector-item-icon");
        icon.innerHTML =
        `
            <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M14 2V8H20" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        `;

        const details = document.createElement("div");
        details.classList.add("existing-selector-item-details");

        const name = document.createElement("div");
        name.classList.add("existing-selector-item-name");
        name.textContent = informationSource.getName() ?? "Unnamed Source";

        const meta = document.createElement("div");
        meta.classList.add("existing-selector-item-meta");
        const sourceTypeKey = Object.keys(informationSourceTypes).find(
            key => informationSourceTypes[key] === informationSource.getSourceType()
        ) ?? "";

        meta.textContent = sourceTypeKey.length > 0 ? enumerationToTitleCase(sourceTypeKey) : "";

        details.appendChild(name);
        details.appendChild(meta);

        const tags = informationSource.getTags() ?? [];
        const tagsContainer = document.createElement("div");
        tagsContainer.classList.add("existing-selector-item-tags");

        for (const tag of tags)
        {
            const tagElement = document.createElement("span");
            tagElement.classList.add("existing-selector-item-tag");
            tagElement.textContent = tag;
            tagsContainer.appendChild(tagElement);
        }

        item.appendChild(icon);
        item.appendChild(details);
        item.appendChild(tagsContainer);

        item.addEventListener("click", () =>
        {
            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_EXISTING_INFORMATION_SOURCE_SELECTED,
            {
                detail: { informationSource },
                bubbles: true
            }));
        });

        return item;
    }
}

customElements.define("information-source-existing-selector", InformationSourceExistingSelector);
export default InformationSourceExistingSelector;