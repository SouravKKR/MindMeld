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

    /**
     * Narrows the "Add Source..." dropdown to a specific set of source types, or
     * restores the full list when passed null.
     *
     * Used by paid-deck mode, which accepts CURRICULUM_OR_SYLLABUS and nothing
     * else. This is a convenience so the user is shown what the mode allows
     * while they are choosing — the restriction is enforced server-side in
     * PaidDeckGenerationGate, and removing an option from a dropdown constrains
     * nothing on its own.
     *
     * @param {number[]|null} allowedSourceTypeValues informationSourceTypes values, or null for no restriction.
     */
    setAllowedSourceTypes(allowedSourceTypeValues)
    {
        if (!this.#addSelect)
        {
            return;
        }

        const allowedValueSet = Array.isArray(allowedSourceTypeValues) ? new Set(allowedSourceTypeValues) : null;

        for (const option of Array.from(this.#addSelect.options))
        {
            if (option.value === "")
            {
                continue;
            }

            const sourceTypeValue = informationSourceTypes[option.value];
            option.hidden = allowedValueSet !== null && !allowedValueSet.has(sourceTypeValue);
            option.disabled = option.hidden;
        }
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
     * Returns true while any uploaded document is still uploading or being
     * OCR'd — its card is in the "uploading" state and has no resolved
     * _serverInformationSource yet, so getSources() silently omits it. The
     * AutomaticGenerationPage checks this before starting so an in-flight upload
     * is never quietly dropped from the run (the "only 4 of my 5 sources" bug).
     * Errored cards (state-error, e.g. a duplicate) are NOT pending — they were
     * genuinely not added and must not block forever.
     * @returns {boolean}
     */
    hasPendingUploads()
    {
        return this.#informationSourcesList.querySelector("information-source-card.state-uploading") !== null;
    }

    /**
     * Replaces the current source list with the given ExtractableInformationSource[]
     * Used by the "Inherit Syllabus Sources From Information Sources" mirroring logic.
     *
     * In-progress uploads (PROVIDED_DOCUMENTS / CURRICULUM_OR_SYLLABUS items
     * whose XHR has not yet returned, identified by _serverInformationSource
     * being unset) are preserved across the rebuild. Settings only learns
     * about an upload after xhr.load fires `attachPageRangeEditor` — so
     * during OCR the upload is in DOM only, and a naive innerHTML wipe
     * would silently destroy the card while the request keeps running
     * server-side. The TEMPLATE→ADVANCED downgrade path is the canonical
     * caller that triggered this; the fix here is trigger-agnostic.
     */
    setSources(extractableSources)
    {
        const PRESERVABLE_SOURCE_TYPES = new Set(["PROVIDED_DOCUMENTS", "CURRICULUM_OR_SYLLABUS", "QUESTION_PAPER"]);
        const pendingUploadItems = Array.from(this.#informationSourcesList.children).filter(item =>
        {
            return (item._serverInformationSource == null)
                && PRESERVABLE_SOURCE_TYPES.has(item.dataset.sourceType);
        });

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

        if (Array.isArray(extractableSources))
        {
            for (const extractable of extractableSources)
            {
                this.#appendExistingSource(extractable);
            }
        }

        for (const pendingItem of pendingUploadItems)
        {
            this.#informationSourcesList.appendChild(pendingItem);
        }
    }

    #resolveExtractableInformationSource(informationSourceItem)
    {
        const selectedKey = informationSourceItem.dataset.sourceType;

        if (selectedKey === "PROVIDED_DOCUMENTS" || selectedKey === "CURRICULUM_OR_SYLLABUS" || selectedKey === "QUESTION_PAPER")
        {
            if (!(informationSourceItem._serverInformationSource instanceof InformationSource))
            {
                return null;
            }

            const pageRangeEditor = informationSourceItem.querySelector("page-range-list-editor");
            const pageRanges = pageRangeEditor ? pageRangeEditor.getPageRanges() : [];

            // The ROW's dropdown decides what this source is for THIS run.
            //
            // What a file was uploaded as says nothing useful: everything lands
            // in storage as a provided document, and the same PDF is legitimately
            // a curriculum in one run and reference material in the next. The
            // stored type is a record of which slot happened to be open at upload
            // time, not a property of the bytes — so treating it as authoritative
            // meant a row the user had explicitly set to "Curriculum Or Syllabus"
            // still submitted as PROVIDED_DOCUMENTS and was refused outright by
            // PaidDeckGenerationGate, with nothing on screen explaining why.
            //
            // This only sets the type on the copy this page holds; the stored row
            // in Mongo is untouched, so the choice stays scoped to this run.
            //
            // Declaring a role is not the same as proving one. The curriculum
            // claim is verified independently, against the document's own
            // structure, by the plausibility verdict OcrPdf records at upload and
            // PaidDeckGenerationGate re-reads here.
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

        let pendingPageRangeEditor = null;
        let pendingPageRangesToApply = null;

        if (selectedKey === "PROVIDED_DOCUMENTS" || selectedKey === "CURRICULUM_OR_SYLLABUS" || selectedKey === "QUESTION_PAPER")
        {
            informationSourceItem._serverInformationSource = informationSource;

            const staticCard = InformationSourceCard.create(informationSource, null);
            informationSourceItem.appendChild(staticCard);

            const pageRangeEditor = document.createElement("page-range-list-editor");
            pageRangeEditor.classList.add("information-source-page-range-editor");
            informationSourceItem.appendChild(pageRangeEditor);

            pageRangeEditor.addEventListener(AutomaticGenerationEvents.ON_SOURCES_CHANGED, () => this.#dispatchSourcesChanged());

            // setPageRanges has to wait until the editor is actually
            // attached to the document — until then its connectedCallback
            // hasn't fired and #rangesContainer is still null. The
            // informationSourceItem is still detached at this point, so
            // we stash the editor + page-range payload and apply them
            // below right after the item is appended to the live list.
            pendingPageRangeEditor   = pageRangeEditor;
            pendingPageRangesToApply = extractable.getPageRanges() || [];
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

        // Editor is now in the document tree -- connectedCallback has
        // fired, #modeSelect and #rangesContainer exist. Safe to apply
        // the captured page ranges synchronously so the subsequent
        // .getSources() call inside the mirror logic reads the correct
        // ranges instead of the editor's default FULL_BOOK state.
        if (pendingPageRangeEditor !== null)
        {
            pendingPageRangeEditor.setPageRanges(pendingPageRangesToApply);
        }
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

        if (selectedKey === "PROVIDED_DOCUMENTS" || selectedKey === "CURRICULUM_OR_SYLLABUS" || selectedKey === "QUESTION_PAPER")
        {
            const informationSourceUploader = document.createElement("information-source-uploader");
            informationSourceUploader.setAttribute("source-type-key", selectedKey);

            informationSourceUploader.addEventListener(AutomaticGenerationEvents.ON_INFORMATION_SOURCE_UPLOADED, (event) =>
            {
                const { informationSource, xhr } = event.detail;
                const informationSourceCard = InformationSourceCard.create(informationSource, xhr);
                informationSourceUploader.replaceWith(informationSourceCard);

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
                    // The card drives the upload AND the background-OCR poll, then
                    // emits READY with the server-resolved source once OCR is
                    // COMPLETED. Gate the page-range editor (and therefore
                    // getSources()) on that — NOT the raw xhr "load", which now
                    // returns before OCR finishes — so a source whose OCR is still
                    // running can never be fed into a generation.
                    informationSourceCard.addEventListener(AutomaticGenerationEvents.ON_INFORMATION_SOURCE_READY, (readyEvent) =>
                    {
                        attachPageRangeEditor(readyEvent.detail.informationSource);
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
