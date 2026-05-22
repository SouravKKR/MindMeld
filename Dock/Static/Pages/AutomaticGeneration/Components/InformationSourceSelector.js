import { informationSourceTypes } from "../../../Globals/Enumerations/InformationSourceTypes.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";
import InformationSource from "../../../Globals/Model/InformationSource.js";
import ExtractableInformationSource from "../../../Globals/Classes/Decorators/ExtractableInformationSource.js";
import PageRange from "../../../Globals/Classes/Decorators/PageRange.js";
import InformationSourceUploader from "./InformationSourceUploader.js";
import InformationSourceCard from "./InformationSourceCard.js";
import PageRangeListEditor from "./PageRangeListEditor.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";


class InformationSourceSelector extends HTMLElement
{
    static tagName = "information-source-selector";

    #addSelect = null;
    #informationSourcesList = null;

    connectedCallback()
    {
        this.innerHTML =
        `
            <div class="information-sources-content">
                <div class="information-sources-list"></div>
                <select class="information-source-add-select">
                    <option value="" disabled selected>Add Source...</option>
                </select>
            </div>
        `;

        this.#addSelect = this.querySelector(".information-source-add-select");
        this.#informationSourcesList = this.querySelector(".information-sources-list");

        // Opt-in filter: callers that don't want every source type
        // exposed (e.g. the Study-page ask-AI menu has no use for the
        // Curriculum/Syllabus type) pass `exclude-types="KEY1,KEY2"`
        // as a comma-separated attribute. Backwards-compatible —
        // omit the attribute and every key is offered as before.
        const excludeTypesAttribute = this.getAttribute("exclude-types") || "";
        const excludedTypeKeySet = new Set(
            excludeTypesAttribute
                .split(",")
                .map((rawKey) => rawKey.trim())
                .filter((trimmedKey) => trimmedKey.length > 0)
        );

        for (const key of Object.keys(informationSourceTypes))
        {
            if (excludedTypeKeySet.has(key))
            {
                continue;
            }
            const option = document.createElement("option");
            option.value = key;
            option.textContent = enumerationToTitleCase(key);
            this.#addSelect.appendChild(option);
        }

        this.#addSelect.addEventListener("change", () => this.#handleAddSource());
    }

    getSources()
    {
        const informationSourceItems = this.#informationSourcesList.querySelectorAll(".information-source-item");
        const sources = [];

        for (const informationSourceItem of informationSourceItems)
        {
            const extractable = this.#resolveExtractableInformationSource(informationSourceItem);

            if (extractable !== null)
            {
                sources.push(extractable);
            }
        }

        return sources;
    }

    /**
     * Replaces the current source list with the given ExtractableInformationSource[]
     * Used by the "Inherit Syllabus Sources From Information Sources" mirroring logic.
     */
    setSources(extractableSources)
    {
        this.#informationSourcesList.innerHTML = "";

        // Re-enable any singleton options that were previously consumed
        const singletonKeys = ["ANYWHERE_ON_THE_INTERNET", "AI_GENERATED", "REPUTED_EXTERNAL_SOURCES"];
        for (const key of singletonKeys)
        {
            const option = this.#addSelect.querySelector(`option[value="${key}"]`);
            if (option)
            {
                option.disabled = false;
            }
        }

        if (!Array.isArray(extractableSources))
        {
            return;
        }

        for (const extractable of extractableSources)
        {
            this.#appendExistingSource(extractable);
        }
    }

    #resolveExtractableInformationSource(informationSourceItem)
    {
        const selectedKey = informationSourceItem.dataset.sourceType;

        if (selectedKey === "PROVIDED_DOCUMENTS" || selectedKey === "CURRICULUM_OR_SYLLABUS")
        {
            if (!(informationSourceItem._serverInformationSource instanceof InformationSource))
            {
                return null;
            }

            const pageRangeEditor = informationSourceItem.querySelector("page-range-list-editor");
            const pageRanges = pageRangeEditor ? pageRangeEditor.getPageRanges() : [];

            informationSourceItem._serverInformationSource.setSourceType(informationSourceTypes[selectedKey]);

            return new ExtractableInformationSource({
                informationSource: informationSourceItem._serverInformationSource,
                pageRanges
            });
        }

        if (selectedKey === "SPECIFIC_URL_ON_THE_INTERNET")
        {
            const urlInput = informationSourceItem.querySelector(".information-source-url-input");
            const url = urlInput ? urlInput.value.trim() : "";

            if (url.length === 0)
            {
                return null;
            }

            return new ExtractableInformationSource({
                informationSource: new InformationSource({
                    sourceType: informationSourceTypes[selectedKey],
                    name: url
                }),
                pageRanges: []
            });
        }

        if (this.#isSingleton(selectedKey))
        {
            return new ExtractableInformationSource({
                informationSource: new InformationSource({
                    sourceType: informationSourceTypes[selectedKey]
                }),
                pageRanges: []
            });
        }

        return null;
    }

    #appendExistingSource(extractable)
    {
        const informationSource = extractable.getInformationSource();
        const sourceTypeValue = informationSource.getSourceType();

        let selectedKey = null;
        for (const key of Object.keys(informationSourceTypes))
        {
            if (informationSourceTypes[key] === sourceTypeValue)
            {
                selectedKey = key;
                break;
            }
        }

        if (selectedKey === null)
        {
            return;
        }

        const informationSourceItem = this.#buildSourceItemSkeleton(selectedKey);

        if (selectedKey === "PROVIDED_DOCUMENTS" || selectedKey === "CURRICULUM_OR_SYLLABUS")
        {
            informationSourceItem._serverInformationSource = informationSource;

            const staticCard = InformationSourceCard.create(informationSource, null);
            informationSourceItem.appendChild(staticCard);

            const pageRangeEditor = document.createElement("page-range-list-editor");
            pageRangeEditor.classList.add("information-source-page-range-editor");
            informationSourceItem.appendChild(pageRangeEditor);

            pageRangeEditor.addEventListener(AutomaticGenerationEvents.ON_SOURCES_CHANGED, () => this.#dispatchSourcesChanged());

            requestAnimationFrame(() =>
            {
                pageRangeEditor.setPageRanges(extractable.getPageRanges() || []);
            });
        }
        else if (selectedKey === "SPECIFIC_URL_ON_THE_INTERNET")
        {
            const urlInput = document.createElement("input");
            urlInput.type = "url";
            urlInput.value = informationSource.getName() || "";
            urlInput.classList.add("information-source-url-input");
            urlInput.addEventListener("input", () => this.#dispatchSourcesChanged());
            informationSourceItem.appendChild(urlInput);
        }

        if (this.#isSingleton(selectedKey))
        {
            const singletonOption = this.#addSelect.querySelector(`option[value="${selectedKey}"]`);
            if (singletonOption)
            {
                singletonOption.disabled = true;
            }
        }

        this.#informationSourcesList.appendChild(informationSourceItem);
    }

    #buildSourceItemSkeleton(selectedKey)
    {
        const informationSourceItem = document.createElement("div");
        informationSourceItem.classList.add("information-source-item");
        informationSourceItem.dataset.sourceType = selectedKey;

        const informationSourceItemHeader = document.createElement("div");
        informationSourceItemHeader.classList.add("information-source-item-header");

        const informationSourceItemLabel = document.createElement("label");
        informationSourceItemLabel.textContent = enumerationToTitleCase(selectedKey);

        const informationSourceDeleteButton = document.createElement("button");
        informationSourceDeleteButton.type = "button";
        informationSourceDeleteButton.textContent = "✕";
        informationSourceDeleteButton.classList.add("information-source-delete-button");
        informationSourceDeleteButton.addEventListener("click", () =>
        {
            informationSourceItem.remove();

            if (this.#isSingleton(selectedKey))
            {
                const singletonOption = this.#addSelect.querySelector(`option[value="${selectedKey}"]`);
                if (singletonOption)
                {
                    singletonOption.disabled = false;
                }
            }

            this.#dispatchSourcesChanged();
        });

        informationSourceItemHeader.appendChild(informationSourceItemLabel);
        informationSourceItemHeader.appendChild(informationSourceDeleteButton);
        informationSourceItem.appendChild(informationSourceItemHeader);

        return informationSourceItem;
    }

    #dispatchSourcesChanged()
    {
        this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_SOURCES_CHANGED, {bubbles: true}));
    }

    #handleAddSource()
    {
        const selectedKey = this.#addSelect.value;
        if (!selectedKey) return;

        const informationSourceItem = this.#buildSourceItemSkeleton(selectedKey);

        if (selectedKey === "PROVIDED_DOCUMENTS" || selectedKey === "CURRICULUM_OR_SYLLABUS")
        {
            const informationSourceUploader = document.createElement("information-source-uploader");
            informationSourceUploader.setAttribute("source-type-key", selectedKey);

            informationSourceUploader.addEventListener(AutomaticGenerationEvents.ON_INFORMATION_SOURCE_UPLOADED, (event) =>
            {
                const { informationSource, xhr } = event.detail;
                informationSourceUploader.replaceWith(InformationSourceCard.create(informationSource, xhr));

                const attachPageRangeEditor = (resolvedSource) =>
                {
                    informationSourceItem._serverInformationSource = resolvedSource;

                    const pageRangeEditor = document.createElement("page-range-list-editor");
                    pageRangeEditor.classList.add("information-source-page-range-editor");
                    informationSourceItem.appendChild(pageRangeEditor);

                    pageRangeEditor.addEventListener(AutomaticGenerationEvents.ON_SOURCES_CHANGED, () => this.#dispatchSourcesChanged());

                    this.#dispatchSourcesChanged();
                };

                if (xhr === null)
                {
                    attachPageRangeEditor(informationSource);
                }
                else
                {
                    xhr.addEventListener("load", () =>
                    {
                        const serverInformationSource = InformationSource.fromJson(JSON.parse(xhr.responseText));
                        attachPageRangeEditor(serverInformationSource);
                    });
                }
            });

            informationSourceItem.appendChild(informationSourceUploader);
        }
        else if (selectedKey === "SPECIFIC_URL_ON_THE_INTERNET")
        {
            const informationSourceUrlInput = document.createElement("input");
            informationSourceUrlInput.type = "url";
            informationSourceUrlInput.placeholder = "Enter URL...";
            informationSourceUrlInput.classList.add("information-source-url-input");
            informationSourceUrlInput.addEventListener("input", () => this.#dispatchSourcesChanged());
            informationSourceItem.appendChild(informationSourceUrlInput);
        }

        if (this.#isSingleton(selectedKey))
        {
            const singletonOption = this.#addSelect.querySelector(`option[value="${selectedKey}"]`);
            if (singletonOption)
            {
                singletonOption.disabled = true;
            }
        }

        this.#informationSourcesList.appendChild(informationSourceItem);
        this.#addSelect.value = "";

        this.#dispatchSourcesChanged();
    }

    #isSingleton(key)
    {
        return key === "ANYWHERE_ON_THE_INTERNET"
            || key === "AI_GENERATED"
            || key === "REPUTED_EXTERNAL_SOURCES";
    }
}


customElements.define("information-source-selector", InformationSourceSelector);
export default InformationSourceSelector;
