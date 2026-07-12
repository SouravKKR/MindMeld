import DialogBox from "../../../CommonComponents/DialogBox.js";
import ProgressDialog from "../../../CommonComponents/ProgressDialog.js";
import Deck from "../../../Globals/Model/Deck.js";
import { deckPurchaseGranularity } from "../../../Globals/Enumerations/DeckPurchaseGranularity.js";
import PaidDeckBadgeRegistry from "../../../Globals/Classes/PaidDeckBadgeRegistry.js";
import RegionMetadata from "../../../Globals/Classes/RegionMetadata.js";
import PaidDeckUploadActivitySource from "../../Activity/Sources/PaidDeckUploadActivitySource.js";
import PaidDeckThumbnailPicker from "./PaidDeckThumbnailPicker.js";
import PaidDeckAiFieldGenerator from "./PaidDeckAiFieldGenerator.js";

/**
 * PaidDeckUploadDialog
 *
 * Full-featured admin upload form. Every PaidDeck metadata field is
 * settable here; the encrypted deck payload itself is pasted as JSON
 * (or, in a future pass, picked from a file). The dialog resolves to
 * `true` on a successful upload so the caller can refresh its list.
 *
 * When the admin pastes a deck payload, fields the admin hasn't yet
 * touched (title / description / tags) are auto-populated from the
 * deck's own metadata as a convenience — the admin can still override
 * any of them before submitting.
 */
class PaidDeckUploadDialog
{
    static #UPLOAD_ENDPOINT = "/Admin/PaidDecks/Upload";

    static show()
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(PaidDeckUploadDialog.#getFormMarkup());

            const formElement = dialog.querySelector(".paid-deck-upload-form");
            const cancelButton = dialog.querySelector(".paid-deck-upload-cancel");
            const submitButton = dialog.querySelector(".paid-deck-upload-submit");
            const errorElement = dialog.querySelector(".paid-deck-upload-error");

            PaidDeckUploadDialog.#wireBadgePicker(dialog);
            PaidDeckUploadDialog.#populateInstituteDatalist(dialog);
            PaidDeckThumbnailPicker.wireField(dialog.querySelector('[data-role="bundle-thumbnail-field"]'));
            const bundleRegionalBlock = dialog.querySelector('[data-role="regional-prices-block"]');
            PaidDeckUploadDialog.#wireRegionalPriceEditor
            (
                bundleRegionalBlock?.querySelector('[data-role="regional-add"]'),
                bundleRegionalBlock?.querySelector('[data-role="regional-prices-rows"]')
            );
            const sourceDeckState = PaidDeckUploadDialog.#wireSourceDeckPicker(dialog, formElement);
            PaidDeckUploadDialog.#wireAiGenerateButtons(dialog, formElement, sourceDeckState);

            let bResolved = false;

            const finalize = (result) =>
            {
                if (bResolved) return;
                bResolved = true;
                dialog.close();
                resolve(result);
            };

            cancelButton.addEventListener("click", () => finalize(false));

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(false));
            }

            submitButton.addEventListener("click", async () =>
            {
                errorElement.textContent = "";
                errorElement.hidden = true;

                if (!sourceDeckState.selectedDeck)
                {
                    errorElement.textContent = "Pick a source deck before uploading.";
                    errorElement.hidden = false;
                    return;
                }

                const bundleId = PaidDeckUploadDialog.#generateUuid();

                // Sub-decks are only sold separately under INDIVIDUAL
                // granularity. Under BUNDLE_ONLY the tree is hidden and any
                // boxes ticked beforehand are ignored — the deck ships as one
                // bundle, no per-sub-deck PaidDecks are created.
                const bSellIndividually = Number(formElement.elements["granularity"]?.value) === deckPurchaseGranularity.INDIVIDUAL;
                const checkedChildRows = bSellIndividually
                    ? PaidDeckUploadDialog.#collectCheckedChildRows(sourceDeckState)
                    : [];

                // Validate every checked child row before any network
                // call so we either upload the full set or none of it.
                for (const childRow of checkedChildRows)
                {
                    const trimmedTitle = childRow.titleInput.value.trim();
                    if (trimmedTitle.length === 0)
                    {
                        errorElement.textContent = `Set a title for the checked sub-deck "${childRow.subDeck.getName()}".`;
                        errorElement.hidden = false;
                        return;
                    }
                    const numericPrice = Number(childRow.priceInput.value);
                    if (!Number.isFinite(numericPrice) || numericPrice < 0)
                    {
                        errorElement.textContent = `Set a non-negative price for the checked sub-deck "${childRow.subDeck.getName()}".`;
                        errorElement.hidden = false;
                        return;
                    }
                }

                const childPayloads = PaidDeckUploadDialog.#collectChildPayloads(formElement, dialog, checkedChildRows, bundleId);
                const childIds = childPayloads.map((childPayload) => childPayload.metadata.id);

                const bundlePayload = PaidDeckUploadDialog.#collectBundlePayload
                (
                    formElement,
                    dialog,
                    sourceDeckState.selectedDeck,
                    bundleId,
                    childIds
                );

                if (!bundlePayload.metadata.title)
                {
                    errorElement.textContent = "Title is required.";
                    errorElement.hidden = false;
                    return;
                }

                if (!bundlePayload.deckPayload)
                {
                    errorElement.textContent = "Could not serialise the picked deck.";
                    errorElement.hidden = false;
                    return;
                }

                for (const childPayload of childPayloads)
                {
                    if (!childPayload.deckPayload)
                    {
                        errorElement.textContent = `Could not serialise sub-deck "${childPayload.metadata.title}".`;
                        errorElement.hidden = false;
                        return;
                    }
                }

                submitButton.disabled = true;
                submitButton.textContent = "Uploading…";

                const totalUploadCount = childPayloads.length + 1;
                let uploadedCount = 0;

                // Determinate progress modal (on top of this form) + a live
                // entry in "View Activity" via the client-side upload source.
                const progressDialog = ProgressDialog.show("Uploading paid deck");
                PaidDeckUploadActivitySource.begin(bundlePayload.metadata.title || "Paid deck", totalUploadCount);

                const reportProgress = () =>
                {
                    progressDialog.setProgress(uploadedCount / totalUploadCount, `Uploaded ${uploadedCount}/${totalUploadCount}…`);
                    PaidDeckUploadActivitySource.update(uploadedCount);
                };
                reportProgress();

                try
                {
                    // Children first so the bundle's bundleChildIds
                    // references rows already present in `paidDecks`.
                    // Server doesn't enforce FK constraints today, but
                    // the order keeps the storefront consistent even
                    // when the bundle is fetched immediately.
                    for (const childPayload of childPayloads)
                    {
                        const childResponse = await fetch(PaidDeckUploadDialog.#UPLOAD_ENDPOINT,
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(childPayload)
                        });
                        if (!childResponse.ok)
                        {
                            const childErrorJson = await childResponse.json().catch(() => ({}));
                            throw new Error(childErrorJson.error || `Sub-deck "${childPayload.metadata.title}" upload failed (HTTP ${childResponse.status}).`);
                        }
                        uploadedCount++;
                        reportProgress();
                    }

                    const bundleResponse = await fetch(PaidDeckUploadDialog.#UPLOAD_ENDPOINT,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(bundlePayload)
                    });

                    if (!bundleResponse.ok)
                    {
                        const bundleErrorJson = await bundleResponse.json().catch(() => ({}));
                        throw new Error(bundleErrorJson.error || `Bundle upload failed (HTTP ${bundleResponse.status}).`);
                    }
                    uploadedCount++;
                    reportProgress();

                    PaidDeckUploadActivitySource.finish(true);
                    finalize(true);
                }
                catch (uploadError)
                {
                    PaidDeckUploadActivitySource.finish(false);
                    errorElement.textContent = uploadError.message;
                    errorElement.hidden = false;
                }
                finally
                {
                    progressDialog.close();
                    submitButton.disabled = false;
                    submitButton.textContent = "Upload";
                }
            });
        });
    }

    static #escape(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    static #renderBadgePicker()
    {
        const chips = PaidDeckBadgeRegistry.getAll().map((entry) =>
        {
            return `
                <button type="button" class="paid-deck-badge-chip" data-badge-value="${entry.value}" title="${PaidDeckUploadDialog.#escape(entry.description)}">
                    <img class="paid-deck-badge-chip-icon" src="${entry.iconPath}" alt="">
                    <span class="paid-deck-badge-chip-label">${PaidDeckUploadDialog.#escape(entry.label)}</span>
                </button>
            `;
        }).join("");

        return `<div class="paid-deck-badge-picker" data-role="badge-picker">${chips}</div>`;
    }

    static #wireBadgePicker(dialog)
    {
        const picker = dialog.querySelector('[data-role="badge-picker"]');
        if (!picker) return;

        picker.addEventListener("click", (clickEvent) =>
        {
            const chip = clickEvent.target.closest(".paid-deck-badge-chip");
            if (!chip) return;
            chip.classList.toggle("paid-deck-badge-chip-selected");
        });
    }

    static #collectSelectedBadgeValues(dialog)
    {
        const selectedChips = dialog.querySelectorAll(".paid-deck-badge-chip.paid-deck-badge-chip-selected");
        const values = [];
        for (const chip of selectedChips)
        {
            const numericValue = Number(chip.dataset.badgeValue);
            if (Number.isFinite(numericValue))
            {
                values.push(numericValue);
            }
        }
        return values;
    }

    static async #populateInstituteDatalist(dialog)
    {
        const datalistElement = dialog.querySelector("#paid-deck-institute-options");
        if (!datalistElement) return;

        try
        {
            const response = await fetch("/Admin/PaidDecks/List?includeUnpublished=true");
            if (!response.ok) return;
            const responseJson = await response.json();
            const decksList = Array.isArray(responseJson.decks) ? responseJson.decks : [];

            const uniqueInstituteNames = new Set();
            for (const paidDeck of decksList)
            {
                const instituteName = paidDeck?.additionalData?.institute?.name;
                if (typeof instituteName === "string" && instituteName.trim().length > 0)
                {
                    uniqueInstituteNames.add(instituteName.trim());
                }
            }

            const sortedInstituteNames = Array.from(uniqueInstituteNames).sort((firstName, secondName) =>
            {
                return firstName.localeCompare(secondName, undefined, { sensitivity: "base" });
            });

            datalistElement.innerHTML = sortedInstituteNames
                .map((instituteName) => `<option value="${PaidDeckUploadDialog.#escape(instituteName)}"></option>`)
                .join("");
        }
        catch (fetchError)
        {
            // Datalist stays empty — admin can still type a new
            // institute by hand, which is the whole point of <datalist>.
        }
    }

    /**
     * Backs the picker button with Deck.configureSearchableSelector — the
     * shared searchable deck selector — so the admin can pick any deck in
     * the tree at any depth (every deck except the root). The picked Deck
     * instance plus the per-sub-deck row state for the individual-pricing
     * tree live on the returned state object so #collectBundlePayload /
     * #collectChildPayloads can read them on submit.
     */
    static #wireSourceDeckPicker(dialog, formElement)
    {
        const pickerButton = dialog.querySelector('[data-role="pick-source-deck"]');
        const summaryElement = dialog.querySelector('[data-role="source-deck-summary"]');

        const titleInput = formElement.elements["title"];
        const descriptionInput = formElement.elements["description"];
        const tagsInput = formElement.elements["tags"];
        const granularitySelect = formElement.elements["granularity"];

        const dirtyFields = new Set();
        for (const formField of [titleInput, descriptionInput, tagsInput])
        {
            if (!formField) continue;
            formField.addEventListener("input", () => dirtyFields.add(formField.name));
        }

        const state =
        {
            selectedDeck: null,
            // Map<subDeckId, { subDeck, checkbox, titleInput, descriptionInput, thumbnailField, priceInput, regionalRowsContainer }>
            childRowsBySubDeckId: new Map()
        };

        const applyAutoFillFromDeck = (deckInstance) =>
        {
            if (titleInput && !dirtyFields.has("title") && titleInput.value.trim().length === 0)
            {
                const deckName = typeof deckInstance.getName === "function" ? deckInstance.getName() : "";
                if (deckName) titleInput.value = deckName;
            }
            if (descriptionInput && !dirtyFields.has("description") && descriptionInput.value.trim().length === 0
                && typeof deckInstance.getDescription === "function")
            {
                const deckDescription = deckInstance.getDescription();
                if (typeof deckDescription === "string" && deckDescription.length > 0)
                {
                    descriptionInput.value = deckDescription;
                }
            }
            if (tagsInput && !dirtyFields.has("tags") && tagsInput.value.trim().length === 0
                && typeof deckInstance.getTags === "function")
            {
                const deckTags = deckInstance.getTags();
                if (Array.isArray(deckTags) && deckTags.length > 0)
                {
                    tagsInput.value = deckTags.join(", ");
                }
            }
        };

        const renderSummary = (deckInstance) =>
        {
            const cardCount = PaidDeckUploadDialog.#safeCount(deckInstance, "getCards");
            const studyMaterialCount = PaidDeckUploadDialog.#safeCount(deckInstance, "getStudyMaterials");
            const mockTestCount = PaidDeckUploadDialog.#safeCount(deckInstance, "getMockTests");
            summaryElement.innerHTML = `
                <strong>Selected:</strong> ${PaidDeckUploadDialog.#escape(deckInstance.getName())}
                — ${cardCount} cards · ${studyMaterialCount} materials · ${mockTestCount} mock tests
            `;
            summaryElement.hidden = false;
        };

        // Back the picker button with the shared searchable deck selector
        // from the Deck model so the admin can choose ANY deck in the tree,
        // at any depth — not just top-level ones. The root deck (id "0") is
        // the only exclusion since it isn't itself a sellable deck. Labels
        // carry the full ancestor path so nested picks stay unambiguous.
        Deck.configureSearchableSelector
        (
            pickerButton,
            (deckInstance) => deckInstance.getId() !== "0",
            undefined,
            null,
            "Choose a deck from your library..."
        );

        pickerButton.addEventListener("change", () =>
        {
            const pickedDeck = Deck.getById(pickerButton.value);
            if (!pickedDeck) return;

            state.selectedDeck = pickedDeck;
            renderSummary(pickedDeck);
            applyAutoFillFromDeck(pickedDeck);
            PaidDeckUploadDialog.#renderIndividualPricingTree(dialog, pickedDeck, state);
            PaidDeckUploadDialog.#applyGranularityVisibility(dialog, granularitySelect, pickedDeck);
        });

        if (granularitySelect)
        {
            granularitySelect.addEventListener("change", () =>
            {
                PaidDeckUploadDialog.#applyGranularityVisibility(dialog, granularitySelect, state.selectedDeck);
            });
        }

        return state;
    }

    /**
     * Reads the four AI-generatable metadata fields from the form so the
     * generator can stay consistent with whatever the admin has already
     * typed (and so generating one field is informed by the others).
     */
    static #readMetadataFromForm(formElement)
    {
        const getValue = (name) => (formElement.elements[name]?.value ?? "").trim();
        return {
            title: getValue("title"),
            category: getValue("category"),
            tags: getValue("tags"),
            description: getValue("description")
        };
    }

    /**
     * Wires the "✨ AI generate" buttons next to Title / Category /
     * Description / Tags. Generation context (study-material titles,
     * deck hierarchy) comes from the picked source deck, so the buttons
     * stay disabled until a deck is selected.
     */
    static #wireAiGenerateButtons(dialog, formElement, sourceDeckState)
    {
        const aiButtons = dialog.querySelectorAll('[data-role="ai-generate"]');
        if (aiButtons.length === 0)
        {
            return;
        }

        const gatherContext = () =>
        {
            const selectedDeck = sourceDeckState.selectedDeck;
            return {
                studyMaterialTitles: PaidDeckAiFieldGenerator.collectStudyMaterialTitles(selectedDeck),
                deckChain: PaidDeckAiFieldGenerator.collectDeckChain(selectedDeck),
                existingMetadata: PaidDeckUploadDialog.#readMetadataFromForm(formElement)
            };
        };

        for (const aiButton of aiButtons)
        {
            const field = aiButton.dataset.field;
            const targetInput = formElement.elements[field];
            if (!targetInput)
            {
                continue;
            }

            aiButton.disabled = true;
            aiButton.title = "Pick a source deck first";
            PaidDeckAiFieldGenerator.wireField(aiButton, targetInput, field, gatherContext);
        }

        const pickerButton = dialog.querySelector('[data-role="pick-source-deck"]');
        if (pickerButton)
        {
            pickerButton.addEventListener("change", () =>
            {
                if (!sourceDeckState.selectedDeck)
                {
                    return;
                }
                for (const aiButton of aiButtons)
                {
                    aiButton.disabled = false;
                    aiButton.title = "Generate this field with AI";
                }
            });
        }
    }

    /**
     * Shows / hides the individual-pricing tree container based on the
     * granularity choice. The tree only makes sense when the admin is
     * marking content as "individually buyable sub-decks" AND the
     * picked source deck actually has direct sub-decks; otherwise the
     * bundle price is the only knob.
     */
    static #applyGranularityVisibility(dialog, granularitySelect, sourceDeck)
    {
        const treeContainer = dialog.querySelector('[data-role="individual-tree-container"]');
        if (!treeContainer) return;

        const isIndividual = Number(granularitySelect?.value) === deckPurchaseGranularity.INDIVIDUAL;
        const hasSubDecks = sourceDeck && typeof sourceDeck.getSubDecks === "function" && sourceDeck.getSubDecks().length > 0;
        treeContainer.hidden = !(isIndividual && hasSubDecks);
    }

    /**
     * Returns the markup for an optional "Regional prices" editor — a heading,
     * an (initially empty) rows container, and an "Add region" button. The
     * SAME block backs both the bundle (in #getFormMarkup) and every sub-deck
     * node (in #buildIndividualTreeNode), so the main deck and its sub-decks
     * are priced identically. The data-role attributes repeat per editor; each
     * editor is wired and read against its OWN container element so they never
     * cross-contaminate.
     */
    /**
     * <option> list of the supported currencies (region display currencies),
     * with `selectedCurrency` pre-selected. Backs every currency dropdown so
     * an admin can only pick a currency the system can actually convert.
     */
    static #renderCurrencyOptions(selectedCurrency)
    {
        const selected = (selectedCurrency || "").toUpperCase();
        return RegionMetadata.getSupportedCurrencies()
            .map((code) => `<option value="${code}"${code === selected ? " selected" : ""}>${code}</option>`)
            .join("");
    }

    static #renderRegionalPriceEditor(hintText)
    {
        return `
            <div class="paid-deck-upload-tree-heading">
                <span>Regional prices (optional)</span>
                <small>${PaidDeckUploadDialog.#escape(hintText)}</small>
            </div>
            <div data-role="regional-prices-rows" class="paid-deck-regional-prices-rows"></div>
            <button type="button" class="paid-deck-regional-add" data-role="regional-add">+ Add region</button>
        `;
    }

    /**
     * Wires one regional-price editor given its "Add region" button and rows
     * container. The button appends a row (region picker + price + currency +
     * remove); picking a region pre-fills the currency with that region's
     * display currency. Rows are read on submit by
     * #collectRegionalPricesFromContainer and persisted as per-region
     * overrides; the deck's base price remains the default.
     */
    static #wireRegionalPriceEditor(addButton, rowsContainer)
    {
        if (!addButton || !rowsContainer) return;

        const regionOptionsHtml = RegionMetadata.getAllRegions()
            .map((region) => `<option value="${region.code}">${PaidDeckUploadDialog.#escape(region.label)} (${PaidDeckUploadDialog.#escape(region.currency)})</option>`)
            .join("");
        const currencyOptionsHtml = PaidDeckUploadDialog.#renderCurrencyOptions("");

        addButton.addEventListener("click", () =>
        {
            const rowElement = document.createElement("div");
            rowElement.className = "paid-deck-regional-price-row";
            rowElement.innerHTML = `
                <select data-role="regional-region" class="paid-deck-regional-region">${regionOptionsHtml}</select>
                <input type="number" data-role="regional-price" class="paid-deck-regional-price" min="0" value="0" placeholder="Price (minor units, e.g. 100 = 1.00)">
                <select data-role="regional-currency" class="paid-deck-regional-currency">${currencyOptionsHtml}</select>
                <button type="button" data-role="regional-remove" class="paid-deck-regional-remove" aria-label="Remove region">×</button>
            `;
            rowsContainer.appendChild(rowElement);

            const regionSelect = rowElement.querySelector('[data-role="regional-region"]');
            const currencyInput = rowElement.querySelector('[data-role="regional-currency"]');
            const removeButton = rowElement.querySelector('[data-role="regional-remove"]');

            const syncCurrency = () =>
            {
                currencyInput.value = RegionMetadata.getDisplayCurrency(regionSelect.value);
            };
            syncCurrency();
            regionSelect.addEventListener("change", syncCurrency);
            removeButton.addEventListener("click", () => rowElement.remove());
        });
    }

    /**
     * Reads one editor's regional-price rows into a deduped array of
     * { region, priceMinor, currency }. The last row wins when the same
     * region is listed twice; rows with a non-finite/negative price are
     * dropped. Scoped to the passed container so a node's rows never pick up
     * a descendant node's rows.
     */
    static #collectRegionalPricesFromContainer(rowsContainer)
    {
        if (!rowsContainer) return [];

        const byRegion = new Map();
        for (const rowElement of rowsContainer.querySelectorAll(".paid-deck-regional-price-row"))
        {
            const region = rowElement.querySelector('[data-role="regional-region"]')?.value || "";
            if (!RegionMetadata.isValidRegion(region)) continue;

            const priceMinor = Number(rowElement.querySelector('[data-role="regional-price"]')?.value);
            if (!Number.isFinite(priceMinor) || priceMinor < 0) continue;

            const currencyRaw = rowElement.querySelector('[data-role="regional-currency"]')?.value || "";
            const currency = (currencyRaw.trim() || RegionMetadata.getDisplayCurrency(region)).toUpperCase();

            byRegion.set(region, { region, priceMinor: Math.round(priceMinor), currency });
        }
        return Array.from(byRegion.values());
    }

    /** Bundle-level regional prices — scoped to the bundle's own editor block. */
    static #collectRegionalPrices(dialog)
    {
        return PaidDeckUploadDialog.#collectRegionalPricesFromContainer
        (
            dialog.querySelector('[data-role="regional-prices-block"] [data-role="regional-prices-rows"]')
        );
    }

    /**
     * Renders the picked source deck's sub-decks as a RECURSIVE tree: every
     * deck at any depth gets its own checkbox + inline mini-form (title /
     * price / description / thumbnail), and any node with its own sub-decks
     * is expandable. This lets the admin sell at any granularity — e.g.
     * "KCET", "KCET > Chemistry", and "KCET > Chemistry > Electrochemistry"
     * all as separately-buyable decks.
     *
     * `state.childRowsBySubDeckId` stays a FLAT Map keyed by deckId across
     * every depth, so the existing collect / validate / serialize paths
     * (which iterate Map.values()) keep working unchanged. Each checked deck
     * becomes its own PaidDeck child whose content is its own subtree. The
     * Map is rebuilt from scratch on every source-deck change so a previous
     * pick's selections don't bleed into a new one.
     */
    static #renderIndividualPricingTree(dialog, sourceDeck, state)
    {
        const treeElement = dialog.querySelector('[data-role="individual-tree"]');
        if (!treeElement) return;

        state.childRowsBySubDeckId = new Map();
        treeElement.innerHTML = "";

        if (!sourceDeck || typeof sourceDeck.getSubDecks !== "function") return;

        const subDecks = sourceDeck.getSubDecks();
        if (subDecks.length === 0)
        {
            treeElement.innerHTML = `<div class="paid-deck-individual-tree-empty">This deck has no sub-decks — only the bundle price applies.</div>`;
            return;
        }

        for (const subDeck of subDecks)
        {
            treeElement.appendChild(PaidDeckUploadDialog.#buildIndividualTreeNode(subDeck, state, 0));
        }
    }

    /**
     * Builds one tree node (row + mini-form + children container) for
     * `subDeck` at the given depth and registers its row state. Children are
     * NOT built up front — they are built lazily, exactly one level at a
     * time, the first time this node is expanded. A node expands when its
     * checkbox is ticked (so checking a deck reveals the sub-decks directly
     * beneath it) or via its caret (to drill in without selling the parent).
     * Picking the source deck therefore shows only the first level; deeper
     * levels appear on demand as the admin checks/expands into a branch.
     */
    static #buildIndividualTreeNode(subDeck, state, depth)
    {
        const subDeckId = subDeck.getId();
        const childDecks = typeof subDeck.getSubDecks === "function" ? subDeck.getSubDecks() : [];
        const hasChildren = childDecks.length > 0;
        const indentPixels = depth * 18;

        const nodeElement = document.createElement("div");
        nodeElement.className = "paid-deck-individual-tree-node";
        nodeElement.dataset.subDeckId = subDeckId;
        nodeElement.innerHTML = `
            <div class="paid-deck-individual-tree-row" style="padding-left: ${indentPixels}px;">
                <button type="button" class="paid-deck-individual-tree-caret${hasChildren ? "" : " paid-deck-individual-tree-caret-hidden"}" data-role="row-caret" aria-label="Expand sub-decks">▸</button>
                <label class="paid-deck-individual-tree-toggle">
                    <input type="checkbox" data-role="row-checkbox">
                    <span class="paid-deck-individual-tree-name">${PaidDeckUploadDialog.#escape(subDeck.getName())}</span>
                    <span class="paid-deck-individual-tree-counts">${PaidDeckUploadDialog.#formatDeckSublabel(subDeck)}</span>
                </label>
            </div>
            <div class="paid-deck-individual-tree-mini-form paid-deck-upload-grid" data-role="row-mini-form" style="margin-left: ${indentPixels}px;" hidden>
                <label class="paid-deck-upload-field">
                    <span>Title *</span>
                    <input type="text" data-role="row-title" maxlength="256">
                </label>
                <label class="paid-deck-upload-field">
                    <span>Price * (minor units — e.g. 100 = 1.00)</span>
                    <input type="number" data-role="row-price" min="0" value="0">
                </label>
                <label class="paid-deck-upload-field paid-deck-upload-field-full">
                    <span>Description</span>
                    <textarea data-role="row-description" rows="2" maxlength="4096"></textarea>
                </label>
                <div class="paid-deck-upload-field paid-deck-upload-field-full">
                    <span>Thumbnail</span>
                    ${PaidDeckThumbnailPicker.renderField("row-thumbnail-field")}
                </div>
                <div class="paid-deck-upload-field paid-deck-upload-field-full">
                    ${PaidDeckUploadDialog.#renderRegionalPriceEditor("Add a region to set this sub-deck's price there; regions you don't list use this sub-deck's price auto-converted.")}
                </div>
            </div>
            <div class="paid-deck-individual-tree-children" data-role="row-children" hidden></div>
        `;

        // Grab references now, while the children container is still empty,
        // so these queries can't accidentally match a descendant node's
        // inputs (descendants are appended below, after the mini-form).
        const checkboxInput = nodeElement.querySelector('[data-role="row-checkbox"]');
        const miniFormElement = nodeElement.querySelector('[data-role="row-mini-form"]');
        const titleInputElement = nodeElement.querySelector('[data-role="row-title"]');
        const descriptionInputElement = nodeElement.querySelector('[data-role="row-description"]');
        const thumbnailFieldElement = nodeElement.querySelector('[data-role="row-thumbnail-field"]');
        const priceInputElement = nodeElement.querySelector('[data-role="row-price"]');
        const caretButton = nodeElement.querySelector('[data-role="row-caret"]');
        const childrenContainer = nodeElement.querySelector('[data-role="row-children"]');

        // Per-sub-deck regional-price editor (scoped to this node's mini-form,
        // which never contains a descendant node's editor).
        const regionalRowsContainer = miniFormElement.querySelector('[data-role="regional-prices-rows"]');
        PaidDeckUploadDialog.#wireRegionalPriceEditor
        (
            miniFormElement.querySelector('[data-role="regional-add"]'),
            regionalRowsContainer
        );

        // Per-sub-deck thumbnail picker (scoped to this node's mini-form).
        PaidDeckThumbnailPicker.wireField(thumbnailFieldElement);

        titleInputElement.value = subDeck.getName();
        const subDeckDescription = typeof subDeck.getDescription === "function" ? subDeck.getDescription() : "";
        if (typeof subDeckDescription === "string") descriptionInputElement.value = subDeckDescription;

        state.childRowsBySubDeckId.set(subDeckId,
        {
            subDeck: subDeck,
            checkbox: checkboxInput,
            titleInput: titleInputElement,
            descriptionInput: descriptionInputElement,
            thumbnailField: thumbnailFieldElement,
            priceInput: priceInputElement,
            regionalRowsContainer: regionalRowsContainer
        });

        // Build the DIRECT children (one level only) the first time this node
        // is expanded. Each child is itself lazy, so deeper levels keep
        // building on demand rather than all at once.
        let bChildrenBuilt = false;
        const buildChildrenIfNeeded = () =>
        {
            if (bChildrenBuilt || !hasChildren) return;
            for (const childDeck of childDecks)
            {
                childrenContainer.appendChild(PaidDeckUploadDialog.#buildIndividualTreeNode(childDeck, state, depth + 1));
            }
            bChildrenBuilt = true;
        };

        const setExpanded = (bExpanded) =>
        {
            if (!hasChildren) return;
            if (bExpanded) buildChildrenIfNeeded();
            childrenContainer.hidden = !bExpanded;
            caretButton.classList.toggle("paid-deck-individual-tree-caret-expanded", bExpanded);
        };

        checkboxInput.addEventListener("change", () =>
        {
            miniFormElement.hidden = !checkboxInput.checked;
            // Ticking a deck reveals one level of its sub-decks so the admin
            // can drill into exactly the branch they want to sell; unticking
            // collapses them again. (The caret can still toggle visibility
            // independently of the checkbox.)
            setExpanded(checkboxInput.checked);
        });

        if (hasChildren)
        {
            caretButton.addEventListener("click", () =>
            {
                setExpanded(childrenContainer.hidden);
            });
        }

        return nodeElement;
    }

    static #formatDeckSublabel(deckInstance)
    {
        const cardCount = PaidDeckUploadDialog.#safeCount(deckInstance, "getCards");
        const studyMaterialCount = PaidDeckUploadDialog.#safeCount(deckInstance, "getStudyMaterials");
        const mockTestCount = PaidDeckUploadDialog.#safeCount(deckInstance, "getMockTests");
        return `${cardCount} cards · ${studyMaterialCount} materials · ${mockTestCount} mock tests`;
    }

    static #safeCount(deckInstance, methodName)
    {
        try
        {
            const value = deckInstance[methodName](true);
            return Array.isArray(value) ? value.length : 0;
        }
        catch (countError)
        {
            return 0;
        }
    }

    static #getFormMarkup()
    {
        return `
            <form class="paid-deck-upload-form" onsubmit="return false;">
                <h2 class="paid-deck-upload-title">Upload a paid deck</h2>
                <p class="paid-deck-upload-subtitle">Pick a source deck from your library, fill in the storefront details, and set pricing — the server encrypts a copy on upload.</p>

                <section class="paid-deck-upload-section">
                    <h3 class="paid-deck-upload-section-title">Source deck</h3>
                    <div class="paid-deck-upload-section-body">
                        <div class="paid-deck-source-deck-row">
                            <button type="button" class="paid-deck-source-deck-button" data-role="pick-source-deck">
                                Choose a deck from your library...
                            </button>
                            <div class="paid-deck-source-deck-summary" data-role="source-deck-summary" hidden></div>
                        </div>
                    </div>
                </section>

                <section class="paid-deck-upload-section">
                    <h3 class="paid-deck-upload-section-title">Bundle listing</h3>
                    <div class="paid-deck-upload-section-body paid-deck-upload-grid">
                        <label class="paid-deck-upload-field">
                            <div class="paid-deck-field-label-row">
                                <span>Title *</span>
                                <button type="button" class="paid-deck-ai-generate" data-role="ai-generate" data-field="title">✨ AI generate</button>
                            </div>
                            <input type="text" name="title" required maxlength="256">
                        </label>

                        <label class="paid-deck-upload-field">
                            <div class="paid-deck-field-label-row">
                                <span>Category</span>
                                <button type="button" class="paid-deck-ai-generate" data-role="ai-generate" data-field="category">✨ AI generate</button>
                            </div>
                            <input type="text" name="category" maxlength="128">
                        </label>

                        <label class="paid-deck-upload-field paid-deck-upload-field-full">
                            <div class="paid-deck-field-label-row">
                                <span>Description</span>
                                <button type="button" class="paid-deck-ai-generate" data-role="ai-generate" data-field="description">✨ AI generate</button>
                            </div>
                            <textarea name="description" rows="3" maxlength="4096"></textarea>
                        </label>

                        <div class="paid-deck-upload-field paid-deck-upload-field-full">
                            <span>Thumbnail</span>
                            ${PaidDeckThumbnailPicker.renderField("bundle-thumbnail-field")}
                        </div>

                        <label class="paid-deck-upload-field paid-deck-upload-field-full">
                            <div class="paid-deck-field-label-row">
                                <span>Tags (comma-separated)</span>
                                <button type="button" class="paid-deck-ai-generate" data-role="ai-generate" data-field="tags">✨ AI generate</button>
                            </div>
                            <input type="text" name="tags" placeholder="Enter tags">
                        </label>

                        <label class="paid-deck-upload-field paid-deck-upload-field-full">
                            <span>Extra tags shown on the purchase page (comma-separated)</span>
                            <input type="text" name="extraTags" placeholder="Enter extra tags">
                        </label>
                    </div>
                </section>

                <section class="paid-deck-upload-section">
                    <h3 class="paid-deck-upload-section-title">Pricing</h3>
                    <div class="paid-deck-upload-section-body paid-deck-upload-grid">
                        <label class="paid-deck-upload-field">
                            <span>Currency</span>
                            <select name="currency">${PaidDeckUploadDialog.#renderCurrencyOptions("INR")}</select>
                        </label>

                        <label class="paid-deck-upload-field">
                            <span>Granularity</span>
                            <select name="granularity">
                                <option value="${deckPurchaseGranularity.INDIVIDUAL}">Individually buyable sub-decks</option>
                                <option value="${deckPurchaseGranularity.BUNDLE_ONLY}">Bundle only</option>
                            </select>
                        </label>

                        <label class="paid-deck-upload-field paid-deck-upload-field-full">
                            <span>Bundle price * (minor units — e.g. 100 = 1.00)</span>
                            <input type="number" name="basePriceMinor" min="0" value="0">
                        </label>

                        <div class="paid-deck-upload-field paid-deck-upload-field-full">
                            <span>License duration *</span>
                            <label class="paid-deck-upload-field paid-deck-upload-field-checkbox">
                                <input type="checkbox" name="isPerpetual" data-role="license-perpetual">
                                <span>Perpetual — lifetime access, never expires</span>
                            </label>
                            <input type="number" name="durationDays" data-role="license-duration-days" min="1" placeholder="Or a rental length in days (e.g. 365)">
                            <small>Access must be sold explicitly: tick Perpetual for lifetime access, or enter a positive number of days for a time-limited license. A deck with neither set cannot be purchased.</small>
                        </div>

                        <div class="paid-deck-upload-field paid-deck-upload-field-full" data-role="regional-prices-block">
                            ${PaidDeckUploadDialog.#renderRegionalPriceEditor("The bundle price above is the default. Add a region only to set a specific price there — buyers in regions you don't list see the default auto-converted into their local currency.")}
                        </div>

                        <div class="paid-deck-upload-field paid-deck-upload-field-full" data-role="individual-tree-container" hidden>
                            <div class="paid-deck-upload-tree-heading">
                                <span>Individually purchasable sub-decks</span>
                                <small>Check the sub-decks you want to list separately. Unchecked sub-decks still ship as content inside the bundle — they just aren't sold on their own.</small>
                            </div>
                            <div data-role="individual-tree" class="paid-deck-individual-tree"></div>
                        </div>
                    </div>
                </section>

                <section class="paid-deck-upload-section">
                    <h3 class="paid-deck-upload-section-title">Feature badges</h3>
                    <div class="paid-deck-upload-section-body">
                        <p class="paid-deck-upload-section-hint">Shown as icon chips on the purchase page.</p>
                        ${PaidDeckUploadDialog.#renderBadgePicker()}
                    </div>
                </section>

                <section class="paid-deck-upload-section">
                    <h3 class="paid-deck-upload-section-title">Institute <span class="paid-deck-upload-section-suffix">(optional)</span></h3>
                    <div class="paid-deck-upload-section-body paid-deck-upload-grid">
                        <label class="paid-deck-upload-field">
                            <span>Institute name</span>
                            <input type="text" name="instituteName" list="paid-deck-institute-options" maxlength="256" placeholder="Enter institute name">
                            <datalist id="paid-deck-institute-options"></datalist>
                        </label>

                        <label class="paid-deck-upload-field">
                            <span>Institute location</span>
                            <input type="text" name="instituteLocation" maxlength="256" placeholder="Enter location">
                        </label>

                        <label class="paid-deck-upload-field paid-deck-upload-field-full">
                            <span>Institute alternate names (comma-separated)</span>
                            <input type="text" name="instituteAlternateNames" placeholder="Enter alternate names">
                        </label>
                    </div>
                </section>

                <section class="paid-deck-upload-section">
                    <h3 class="paid-deck-upload-section-title">Publish</h3>
                    <div class="paid-deck-upload-section-body">
                        <label class="paid-deck-upload-field paid-deck-upload-field-checkbox">
                            <input type="checkbox" name="isPublished" checked>
                            <span>Publish immediately (otherwise the deck is uploaded as a draft and stays hidden from the storefront).</span>
                        </label>
                    </div>
                </section>

                <details class="paid-deck-upload-section paid-deck-upload-advanced">
                    <summary class="paid-deck-upload-section-title">Advanced</summary>
                    <div class="paid-deck-upload-section-body paid-deck-upload-grid">
                        <label class="paid-deck-upload-field">
                            <span>Seller ID</span>
                            <input type="text" name="sellerId">
                        </label>

                        <label class="paid-deck-upload-field">
                            <span>Parent bundle IDs (comma-separated)</span>
                            <input type="text" name="parentBundleIds" placeholder="Existing parent-bundle UUIDs">
                        </label>

                        <label class="paid-deck-upload-field paid-deck-upload-field-full">
                            <span>Additional data (JSON object, optional)</span>
                            <textarea name="additionalData" rows="3" placeholder='Enter raw JSON, e.g. {"sourceFile":"..."}'></textarea>
                        </label>
                    </div>
                </details>

                <div class="paid-deck-upload-error" hidden></div>
                <div class="paid-deck-upload-actions">
                    <button type="button" class="paid-deck-upload-cancel">Cancel</button>
                    <button type="button" class="paid-deck-upload-submit">Upload</button>
                </div>
            </form>
        `;
    }

    static #parseCsvList(rawValue)
    {
        if (typeof rawValue !== "string" || rawValue.trim().length === 0) return [];
        return rawValue
            .split(",")
            .map(part => part.trim())
            .filter(part => part.length > 0);
    }

    static #parseJsonOrNull(rawValue)
    {
        if (typeof rawValue !== "string" || rawValue.trim().length === 0) return null;
        try
        {
            return JSON.parse(rawValue);
        }
        catch (parseError)
        {
            return null;
        }
    }

    /**
     * Reads the explicit license-duration control into { durationDays,
     * isPerpetual }. A ticked "Perpetual" box always wins (durationDays 0); a
     * positive day count otherwise selects a finite rental. Leaving both blank
     * yields { durationDays: 0, isPerpetual: false } — which the server refuses
     * to grant, so the admin is nudged to choose one.
     */
    static #collectLicenseDuration(formElement)
    {
        const isPerpetual = Boolean(formElement.elements["isPerpetual"]?.checked);
        if (isPerpetual)
        {
            return { durationDays: 0, isPerpetual: true };
        }
        const durationDaysRaw = Number(formElement.elements["durationDays"]?.value || 0);
        const durationDays = Number.isFinite(durationDaysRaw) && durationDaysRaw > 0 ? Math.floor(durationDaysRaw) : 0;
        return { durationDays: durationDays, isPerpetual: false };
    }

    static #collectBundlePayload(formElement, dialog, selectedSourceDeck, bundleId, childIds)
    {
        const getValue = (name) => formElement.elements[name]?.value ?? "";
        const getChecked = (name) => Boolean(formElement.elements[name]?.checked);
        const licenseDuration = PaidDeckUploadDialog.#collectLicenseDuration(formElement);

        const additionalDataRaw = getValue("additionalData");
        const additionalData = additionalDataRaw.trim().length > 0
            ? (PaidDeckUploadDialog.#parseJsonOrNull(additionalDataRaw) || {})
            : {};

        // Merge institute fields into additionalData without clobbering
        // anything the admin hand-pasted into the JSON textarea. The whole
        // institute block is omitted when no name was provided so universal
        // (institute-less) decks stay genuinely universal.
        const instituteName = getValue("instituteName").trim();
        if (instituteName.length > 0)
        {
            additionalData.institute =
            {
                name: instituteName,
                location: getValue("instituteLocation").trim(),
                alternateNames: PaidDeckUploadDialog.#parseCsvList(getValue("instituteAlternateNames"))
            };
        }

        const deckPayload = PaidDeckUploadDialog.serialiseDeckForUpload(selectedSourceDeck);

        // Thumbnail: a built-in URL goes on thumbnailUrl; an uploaded image
        // (a self-contained data URL) rides in additionalData.thumbnailImage,
        // which the storefront resolves ahead of thumbnailUrl.
        const bundleThumbnail = PaidDeckThumbnailPicker.readSelection(dialog.querySelector('[data-role="bundle-thumbnail-field"]'));
        if (bundleThumbnail.thumbnailImage)
        {
            additionalData.thumbnailImage = bundleThumbnail.thumbnailImage;
        }

        const metadata =
        {
            id: bundleId,
            title: getValue("title").trim(),
            category: getValue("category").trim(),
            description: getValue("description").trim(),
            sellerId: getValue("sellerId").trim(),
            thumbnailUrl: bundleThumbnail.thumbnailUrl,
            basePriceMinor: Number(getValue("basePriceMinor") || 0),
            currency: getValue("currency").trim().toUpperCase() || "INR",
            durationDays: licenseDuration.durationDays,
            isPerpetual: licenseDuration.isPerpetual,
            granularity: Number(getValue("granularity") || 0),
            tags: PaidDeckUploadDialog.#parseCsvList(getValue("tags")),
            extraTags: PaidDeckUploadDialog.#parseCsvList(getValue("extraTags")),
            bundleChildIds: Array.isArray(childIds) ? childIds : [],
            parentBundleIds: PaidDeckUploadDialog.#parseCsvList(getValue("parentBundleIds")),
            isPublished: getChecked("isPublished"),
            featureBadges: PaidDeckUploadDialog.#collectSelectedBadgeValues(dialog),
            regionalPrices: PaidDeckUploadDialog.#collectRegionalPrices(dialog),
            additionalData: additionalData
        };

        return { metadata, deckPayload };
    }

    /**
     * Builds one upload payload per checked sub-deck row. Each child
     * inherits the bundle's currency, tags, badges, institute, and
     * isPublished — anything more granular would balloon the per-row
     * mini-form. Admin can override per-child later via Edit dialog.
     */
    static #collectChildPayloads(formElement, dialog, checkedChildRows, bundleId)
    {
        if (!Array.isArray(checkedChildRows) || checkedChildRows.length === 0) return [];

        const getValue = (name) => formElement.elements[name]?.value ?? "";
        const getChecked = (name) => Boolean(formElement.elements[name]?.checked);

        const sharedCurrency = getValue("currency").trim().toUpperCase() || "INR";
        const sharedTags = PaidDeckUploadDialog.#parseCsvList(getValue("tags"));
        const sharedExtraTags = PaidDeckUploadDialog.#parseCsvList(getValue("extraTags"));
        const sharedFeatureBadges = PaidDeckUploadDialog.#collectSelectedBadgeValues(dialog);
        const sharedSellerId = getValue("sellerId").trim();
        const sharedIsPublished = getChecked("isPublished");
        // Individually-sold sub-decks inherit the bundle's license duration; the
        // admin can override any child later via the Edit dialog.
        const sharedLicenseDuration = PaidDeckUploadDialog.#collectLicenseDuration(formElement);

        const instituteName = getValue("instituteName").trim();
        const sharedInstitute = instituteName.length > 0
            ? {
                name: instituteName,
                location: getValue("instituteLocation").trim(),
                alternateNames: PaidDeckUploadDialog.#parseCsvList(getValue("instituteAlternateNames"))
            }
            : null;

        const childPayloads = [];
        for (const childRow of checkedChildRows)
        {
            const childId = PaidDeckUploadDialog.#generateUuid();
            const childAdditionalData = {};
            if (sharedInstitute) childAdditionalData.institute = sharedInstitute;

            const childThumbnail = PaidDeckThumbnailPicker.readSelection(childRow.thumbnailField);
            if (childThumbnail.thumbnailImage)
            {
                childAdditionalData.thumbnailImage = childThumbnail.thumbnailImage;
            }

            const childMetadata =
            {
                id: childId,
                title: childRow.titleInput.value.trim(),
                category: "",
                description: childRow.descriptionInput.value.trim(),
                sellerId: sharedSellerId,
                thumbnailUrl: childThumbnail.thumbnailUrl,
                basePriceMinor: Number(childRow.priceInput.value || 0),
                currency: sharedCurrency,
                durationDays: sharedLicenseDuration.durationDays,
                isPerpetual: sharedLicenseDuration.isPerpetual,
                granularity: deckPurchaseGranularity.INDIVIDUAL,
                tags: sharedTags,
                extraTags: sharedExtraTags,
                bundleChildIds: [],
                parentBundleIds: [bundleId],
                isPublished: sharedIsPublished,
                featureBadges: sharedFeatureBadges,
                regionalPrices: PaidDeckUploadDialog.#collectRegionalPricesFromContainer(childRow.regionalRowsContainer),
                additionalData: childAdditionalData
            };

            childPayloads.push
            ({
                metadata: childMetadata,
                deckPayload: PaidDeckUploadDialog.serialiseDeckForUpload(childRow.subDeck)
            });
        }
        return childPayloads;
    }

    static #collectCheckedChildRows(sourceDeckState)
    {
        const checkedRows = [];
        if (!sourceDeckState || !sourceDeckState.childRowsBySubDeckId) return checkedRows;
        for (const childRow of sourceDeckState.childRowsBySubDeckId.values())
        {
            if (childRow.checkbox && childRow.checkbox.checked)
            {
                checkedRows.push(childRow);
            }
        }
        return checkedRows;
    }

    static #generateUuid()
    {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        {
            return crypto.randomUUID();
        }
        // Fallback for environments without crypto.randomUUID — RFC4122-shaped UUIDv4 only.
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (placeholderChar) =>
        {
            const randomNibble = Math.random() * 16 | 0;
            const finalNibble = placeholderChar === "x" ? randomNibble : (randomNibble & 0x3 | 0x8);
            return finalNibble.toString(16);
        });
    }

    /**
     * Builds the same export-bundle JSON shape that Deck.export() emits
     * before BSON/gzip — a `{ metadata, data: [...] }` with each deck
     * in a flat list and parent references resolved. Reused here (and
     * by PaidDeckEditDialog's replace-content sub-dialog) so server-
     * side PaidDeckUserContentCloner's flat-list branch can ingest it
     * unchanged.
     *
     * Per the protected-study spec, we strip buyer-meaningless state:
     * - bRetainProgress: false        — the admin's FSRS / attempts are not the buyer's
     * - bRetainAutoAnalysisSettings: false  — those are per-user preferences
     */
    static serialiseDeckForUpload(deckInstance)
    {
        if (!deckInstance || typeof deckInstance.getExportData !== "function")
        {
            return null;
        }
        const exportData = deckInstance.getExportData
        (
            { bRecursive: true, bRetainProgress: false, bRetainAutoAnalysisSettings: false, bAllowPaidContent: true },
            []
        );
        if (!Array.isArray(exportData) || exportData.length === 0)
        {
            return null;
        }
        exportData[0].parent = null;
        return {
            metadata: deckInstance.getExportMetadata(),
            data: exportData
        };
    }
}

export default PaidDeckUploadDialog;
