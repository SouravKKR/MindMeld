import DialogBox from "../../../CommonComponents/DialogBox.js";
import SearchableDropdown from "../../../CommonComponents/SearchableDropdown.js";
import Deck from "../../../Globals/Model/Deck.js";
import { deckPurchaseGranularity } from "../../../Globals/Enumerations/DeckPurchaseGranularity.js";
import PaidDeckBadgeRegistry from "../../../Globals/Classes/PaidDeckBadgeRegistry.js";
import PaidDeckUploadDialog from "./PaidDeckUploadDialog.js";
import PaidDeckThumbnailPicker from "./PaidDeckThumbnailPicker.js";
import PaidDeckAiFieldGenerator from "./PaidDeckAiFieldGenerator.js";
import RegionMetadata from "../../../Globals/Classes/RegionMetadata.js";

/**
 * PaidDeckEditDialog
 *
 * Edit form for a single existing PaidDeck. Pre-populates the same
 * fields PaidDeckUploadDialog collects; only sends fields the server's
 * /Admin/PaidDecks/Update accepts. Also surfaces the read-only
 * contentSummary + a "Replace Deck Content" button that re-POSTs to
 * /Admin/PaidDecks/Upload with the same deckId so new buyers receive
 * the freshly-encrypted payload while existing buyers keep their
 * version until they explicitly redownload.
 */
class PaidDeckEditDialog
{
    static #UPDATE_ENDPOINT = "/Admin/PaidDecks/Update";
    static #UPLOAD_ENDPOINT = "/Admin/PaidDecks/Upload";

    static show(deck)
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(PaidDeckEditDialog.#getFormMarkup(deck));

            const formElement = dialog.querySelector(".paid-deck-edit-form");
            const cancelButton = dialog.querySelector(".paid-deck-edit-cancel");
            const submitButton = dialog.querySelector(".paid-deck-edit-submit");
            const errorElement = dialog.querySelector(".paid-deck-edit-error");

            PaidDeckEditDialog.#wireBadgePicker(dialog, deck);
            PaidDeckEditDialog.#populateInstituteDatalist(dialog);
            PaidDeckEditDialog.#wireReplaceContentButton(dialog, deck, resolve);
            PaidDeckEditDialog.#wireAiGenerateButtons(dialog, formElement, deck);

            const existingThumbnailImage = (deck.additionalData && typeof deck.additionalData === "object")
                ? deck.additionalData.thumbnailImage
                : "";
            PaidDeckThumbnailPicker.wireField
            (
                dialog.querySelector('[data-role="edit-thumbnail-field"]'),
                { thumbnailUrl: deck.thumbnailUrl || "", thumbnailImage: existingThumbnailImage || "" }
            );

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

                const updates = PaidDeckEditDialog.#collectFormUpdates(formElement, dialog, deck);

                submitButton.disabled = true;
                submitButton.textContent = "Saving…";

                try
                {
                    const response = await fetch(PaidDeckEditDialog.#UPDATE_ENDPOINT,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: deck.id, updates: updates })
                    });

                    if (response.ok)
                    {
                        finalize(true);
                        return;
                    }

                    const errorJson = await response.json().catch(() => ({}));
                    errorElement.textContent = errorJson.error || `Save failed (HTTP ${response.status}).`;
                    errorElement.hidden = false;
                }
                catch (saveError)
                {
                    errorElement.textContent = saveError.message;
                    errorElement.hidden = false;
                }
                finally
                {
                    submitButton.disabled = false;
                    submitButton.textContent = "Save";
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

    /**
     * Reads the four AI-generatable metadata fields from the form so the
     * generator can stay consistent with what the admin has already typed.
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
     * Description / Tags. The edit dialog only holds the stored PaidDeck
     * record, not a live deck tree, so context comes from the original
     * source deck when it is still in the admin's local library
     * (Deck.getById) and otherwise from the metadata already on the
     * record. Buttons stay enabled since that metadata is always present.
     */
    static #wireAiGenerateButtons(dialog, formElement, deck)
    {
        const aiButtons = dialog.querySelectorAll('[data-role="ai-generate"]');
        if (aiButtons.length === 0)
        {
            return;
        }

        const gatherContext = () =>
        {
            const sourceDeck = (typeof Deck.getById === "function") ? Deck.getById(deck.id) : null;
            return {
                studyMaterialTitles: PaidDeckAiFieldGenerator.collectStudyMaterialTitles(sourceDeck),
                deckChain: PaidDeckAiFieldGenerator.collectDeckChain(sourceDeck),
                existingMetadata: PaidDeckEditDialog.#readMetadataFromForm(formElement)
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
            aiButton.title = "Generate this field with AI";
            PaidDeckAiFieldGenerator.wireField(aiButton, targetInput, field, gatherContext);
        }
    }

    /**
     * <option> list of supported currencies with `currentCurrency` selected.
     * If the deck's existing currency isn't in the supported set (e.g. legacy
     * data), it's kept as an option so editing other fields never silently
     * rewrites the currency.
     */
    static #renderCurrencyOptions(currentCurrency)
    {
        const current = (currentCurrency || "INR").toUpperCase();
        const supported = RegionMetadata.getSupportedCurrencies();
        const codes = supported.includes(current) ? supported : [current, ...supported];
        return codes
            .map((code) => `<option value="${code}"${code === current ? " selected" : ""}>${PaidDeckEditDialog.#escape(code)}</option>`)
            .join("");
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
                .map((instituteName) => `<option value="${PaidDeckEditDialog.#escape(instituteName)}"></option>`)
                .join("");
        }
        catch (fetchError)
        {
            // Datalist stays empty — admin can still type a new value.
        }
    }

    static #listSourceDeckCandidates()
    {
        return Deck.getAll((deck) =>
        {
            if (deck.getId() === "0") return false;
            const parent = typeof deck.getParent === "function" ? deck.getParent() : null;
            return parent !== null && parent !== undefined && parent.getId() === "0";
        });
    }

    static #formatDeckSublabel(deckInstance)
    {
        const cardCount = PaidDeckEditDialog.#safeCount(deckInstance, "getCards");
        const studyMaterialCount = PaidDeckEditDialog.#safeCount(deckInstance, "getStudyMaterials");
        const mockTestCount = PaidDeckEditDialog.#safeCount(deckInstance, "getMockTests");
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

    static #renderBadgePicker(selectedBadgeValues)
    {
        const selectedSet = new Set((selectedBadgeValues || []).map((value) => Number(value)));
        const chips = PaidDeckBadgeRegistry.getAll().map((entry) =>
        {
            const isSelected = selectedSet.has(entry.value);
            return `
                <button type="button" class="paid-deck-badge-chip ${isSelected ? "paid-deck-badge-chip-selected" : ""}" data-badge-value="${entry.value}" title="${PaidDeckEditDialog.#escape(entry.description)}">
                    <img class="paid-deck-badge-chip-icon" src="${entry.iconPath}" alt="">
                    <span class="paid-deck-badge-chip-label">${PaidDeckEditDialog.#escape(entry.label)}</span>
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

    static #wireReplaceContentButton(dialog, deck, resolveOuter)
    {
        const replaceButton = dialog.querySelector(".paid-deck-edit-replace-content");
        if (!replaceButton) return;

        replaceButton.addEventListener("click", () =>
        {
            const subDialog = DialogBox.modal(`
                <form class="paid-deck-replace-form" onsubmit="return false;">
                    <h2 class="paid-deck-edit-title">Replace deck content</h2>
                    <p class="paid-deck-upload-subtitle">
                        Pick the new source deck from your local library. The content is
                        re-encrypted and stored alongside the old asset — existing buyers
                        keep their copy until they choose to redownload, and new buyers
                        receive this version.
                    </p>
                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>New source deck *</span>
                        <div class="paid-deck-source-deck-row">
                            <button type="button" class="paid-deck-source-deck-button" data-role="pick-replace-source-deck">
                                Choose a deck from your library...
                            </button>
                            <div class="paid-deck-source-deck-summary" data-role="replace-source-deck-summary" hidden></div>
                        </div>
                    </label>
                    <div class="paid-deck-upload-error" data-role="replace-error" hidden></div>
                    <div class="paid-deck-upload-actions">
                        <button type="button" class="paid-deck-replace-cancel">Cancel</button>
                        <button type="button" class="paid-deck-replace-submit">Replace</button>
                    </div>
                </form>
            `);

            const errorElement = subDialog.querySelector('[data-role="replace-error"]');
            const cancelButton = subDialog.querySelector(".paid-deck-replace-cancel");
            const submitButton = subDialog.querySelector(".paid-deck-replace-submit");
            const pickerButton = subDialog.querySelector('[data-role="pick-replace-source-deck"]');
            const summaryElement = subDialog.querySelector('[data-role="replace-source-deck-summary"]');

            const sourceDeckState = { selectedDeck: null };

            pickerButton.addEventListener("click", async () =>
            {
                const candidateDecks = PaidDeckEditDialog.#listSourceDeckCandidates();
                const pickedDeckId = await SearchableDropdown.show
                ({
                    title: "Choose new source deck",
                    searchPlaceholder: "Search your decks...",
                    items: candidateDecks.map((candidateDeck) =>
                    ({
                        key: candidateDeck.getId(),
                        label: candidateDeck.getName(),
                        sublabel: PaidDeckEditDialog.#formatDeckSublabel(candidateDeck)
                    }))
                });

                if (!pickedDeckId) return;

                const pickedDeck = Deck.getById(pickedDeckId);
                if (!pickedDeck) return;

                sourceDeckState.selectedDeck = pickedDeck;
                pickerButton.textContent = `Replace pick (currently: ${pickedDeck.getName()})`;
                summaryElement.innerHTML = `
                    <strong>Selected:</strong> ${PaidDeckEditDialog.#escape(pickedDeck.getName())}
                    — ${PaidDeckEditDialog.#formatDeckSublabel(pickedDeck)}
                `;
                summaryElement.hidden = false;
            });

            cancelButton.addEventListener("click", () => subDialog.close());

            submitButton.addEventListener("click", async () =>
            {
                errorElement.hidden = true;
                errorElement.textContent = "";

                if (!sourceDeckState.selectedDeck)
                {
                    errorElement.textContent = "Pick a source deck before replacing.";
                    errorElement.hidden = false;
                    return;
                }

                const parsedPayload = PaidDeckUploadDialog.serialiseDeckForUpload(sourceDeckState.selectedDeck);
                if (!parsedPayload)
                {
                    errorElement.textContent = "Could not serialise the picked deck.";
                    errorElement.hidden = false;
                    return;
                }

                submitButton.disabled = true;
                submitButton.textContent = "Replacing…";

                try
                {
                    const response = await fetch(PaidDeckEditDialog.#UPLOAD_ENDPOINT,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify
                        ({
                            metadata:
                            {
                                id: deck.id,
                                title: deck.title,
                                description: deck.description,
                                sellerId: deck.sellerId,
                                thumbnailUrl: deck.thumbnailUrl,
                                category: deck.category,
                                tags: deck.tags || [],
                                basePriceMinor: deck.basePriceMinor || 0,
                                currency: deck.currency || "INR",
                                // Content is being replaced, so the link follows
                                // the newly picked deck rather than whatever the
                                // listing was originally published from.
                                sourceDeckId: sourceDeckState.selectedDeck.getId(),
                                provenanceDeckId: sourceDeckState.selectedDeck.getId(),
                                // Licence duration must be re-sent, not omitted.
                                // PaidDeckPublishService resolves absent fields
                                // to 0 / false, which LicenseExpiryResolver reads
                                // as UNSPECIFIED — "caller must refuse to grant".
                                // Leaving them out silently made a live deck
                                // unpurchasable every time its content was
                                // refreshed.
                                durationDays: deck.durationDays || 0,
                                isPerpetual: deck.isPerpetual === true,
                                granularity: deck.granularity || 0,
                                bundleChildIds: deck.bundleChildIds || [],
                                parentBundleIds: deck.parentBundleIds || [],
                                isPublished: deck.isPublished || false,
                                additionalData: deck.additionalData || {},
                                featureBadges: deck.featureBadges || [],
                                extraTags: deck.extraTags || []
                            },
                            deckPayload: parsedPayload
                        })
                    });

                    if (response.ok)
                    {
                        subDialog.close();
                        dialog.close();
                        resolveOuter(true);
                        return;
                    }

                    const errorJson = await response.json().catch(() => ({}));
                    errorElement.textContent = errorJson.error || `Replace failed (HTTP ${response.status}).`;
                    errorElement.hidden = false;
                }
                catch (replaceError)
                {
                    errorElement.textContent = replaceError.message;
                    errorElement.hidden = false;
                }
                finally
                {
                    submitButton.disabled = false;
                    submitButton.textContent = "Replace";
                }
            });
        });
    }

    static #getFormMarkup(deck)
    {
        const tagsJoined = Array.isArray(deck.tags) ? deck.tags.join(", ") : "";
        const extraTagsJoined = Array.isArray(deck.extraTags) ? deck.extraTags.join(", ") : "";
        const bundleChildIdsJoined = Array.isArray(deck.bundleChildIds) ? deck.bundleChildIds.join(", ") : "";
        const parentBundleIdsJoined = Array.isArray(deck.parentBundleIds) ? deck.parentBundleIds.join(", ") : "";

        const existingInstitute = (deck.additionalData && typeof deck.additionalData === "object" && deck.additionalData.institute)
            ? deck.additionalData.institute
            : {};
        const instituteNameValue = typeof existingInstitute.name === "string" ? existingInstitute.name : "";
        const instituteLocationValue = typeof existingInstitute.location === "string" ? existingInstitute.location : "";
        const instituteAlternateNamesValue = Array.isArray(existingInstitute.alternateNames) ? existingInstitute.alternateNames.join(", ") : "";

        const contentSummary = (deck.contentSummary && typeof deck.contentSummary === "object") ? deck.contentSummary : {};
        const totalCards = Number(contentSummary.totalCards) || 0;
        const totalStudyMaterials = Number(contentSummary.totalStudyMaterials) || 0;
        const totalMockTests = Number(contentSummary.totalMockTests) || 0;
        const contentVersion = Number(contentSummary.contentVersion) || 0;

        return `
            <form class="paid-deck-edit-form" onsubmit="return false;">
                <h2 class="paid-deck-edit-title">Edit ${PaidDeckEditDialog.#escape(deck.title)}</h2>

                <div class="paid-deck-upload-grid">
                    <label class="paid-deck-upload-field">
                        <div class="paid-deck-field-label-row">
                            <span>Title</span>
                            <button type="button" class="paid-deck-ai-generate" data-role="ai-generate" data-field="title">✨ AI generate</button>
                        </div>
                        <input type="text" name="title" maxlength="256" value="${PaidDeckEditDialog.#escape(deck.title)}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <div class="paid-deck-field-label-row">
                            <span>Category</span>
                            <button type="button" class="paid-deck-ai-generate" data-role="ai-generate" data-field="category">✨ AI generate</button>
                        </div>
                        <input type="text" name="category" maxlength="128" value="${PaidDeckEditDialog.#escape(deck.category)}">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <div class="paid-deck-field-label-row">
                            <span>Description</span>
                            <button type="button" class="paid-deck-ai-generate" data-role="ai-generate" data-field="description">✨ AI generate</button>
                        </div>
                        <textarea name="description" rows="3" maxlength="4096">${PaidDeckEditDialog.#escape(deck.description)}</textarea>
                    </label>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Thumbnail</span>
                        ${PaidDeckThumbnailPicker.renderField("edit-thumbnail-field")}
                    </div>

                    <label class="paid-deck-upload-field">
                        <span>Base price (minor units — e.g. 100 = 1.00)</span>
                        <input type="number" name="basePriceMinor" min="0" value="${Number(deck.basePriceMinor) || 0}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Currency</span>
                        <select name="currency">
                            ${PaidDeckEditDialog.#renderCurrencyOptions(deck.currency || "INR")}
                        </select>
                    </label>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>License duration</span>
                        <label class="paid-deck-upload-field paid-deck-upload-field-checkbox">
                            <input type="checkbox" name="isPerpetual" ${deck.isPerpetual === true ? "checked" : ""}>
                            <span>Perpetual — lifetime access, never expires</span>
                        </label>
                        <input type="number" name="durationDays" min="1" value="${Number(deck.durationDays) > 0 ? Number(deck.durationDays) : ""}" placeholder="Or a rental length in days (e.g. 365)">
                        <small>Tick Perpetual for lifetime access, or enter a positive number of days for a time-limited license. A deck with neither set cannot be purchased.</small>
                    </div>

                    <label class="paid-deck-upload-field">
                        <span>Granularity</span>
                        <select name="granularity">
                            <option value="${deckPurchaseGranularity.INDIVIDUAL}" ${deck.granularity === deckPurchaseGranularity.INDIVIDUAL ? "selected" : ""}>Individually buyable</option>
                            <option value="${deckPurchaseGranularity.BUNDLE_ONLY}" ${deck.granularity === deckPurchaseGranularity.BUNDLE_ONLY ? "selected" : ""}>Bundle only</option>
                        </select>
                    </label>

                    <label class="paid-deck-upload-field">
                        <div class="paid-deck-field-label-row">
                            <span>Tags (comma-separated)</span>
                            <button type="button" class="paid-deck-ai-generate" data-role="ai-generate" data-field="tags">✨ AI generate</button>
                        </div>
                        <input type="text" name="tags" value="${PaidDeckEditDialog.#escape(tagsJoined)}">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Extra tags shown on the purchase page (comma-separated)</span>
                        <input type="text" name="extraTags" value="${PaidDeckEditDialog.#escape(extraTagsJoined)}" placeholder="Boards 2026, Crash Course, ...">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Bundle child IDs (comma-separated)</span>
                        <input type="text" name="bundleChildIds" value="${PaidDeckEditDialog.#escape(bundleChildIdsJoined)}">
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Parent bundle IDs (comma-separated)</span>
                        <input type="text" name="parentBundleIds" value="${PaidDeckEditDialog.#escape(parentBundleIdsJoined)}">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-checkbox">
                        <input type="checkbox" name="isPublished" ${deck.isPublished ? "checked" : ""}>
                        <span>Published</span>
                    </label>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full paid-deck-upload-section-divider">
                        <span class="paid-deck-upload-section-heading">Feature badges (shown as icon chips on the purchase page)</span>
                    </div>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full">
                        ${PaidDeckEditDialog.#renderBadgePicker(deck.featureBadges)}
                    </div>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full paid-deck-upload-section-divider">
                        <span class="paid-deck-upload-section-heading">Institute (optional)</span>
                    </div>

                    <label class="paid-deck-upload-field">
                        <span>Institute name</span>
                        <input type="text" name="instituteName" list="paid-deck-institute-options" maxlength="256" value="${PaidDeckEditDialog.#escape(instituteNameValue)}" placeholder="Enter institute name">
                        <datalist id="paid-deck-institute-options"></datalist>
                    </label>

                    <label class="paid-deck-upload-field">
                        <span>Institute location</span>
                        <input type="text" name="instituteLocation" maxlength="256" value="${PaidDeckEditDialog.#escape(instituteLocationValue)}" placeholder="Enter location">
                    </label>

                    <label class="paid-deck-upload-field paid-deck-upload-field-full">
                        <span>Institute alternate names (comma-separated)</span>
                        <input type="text" name="instituteAlternateNames" value="${PaidDeckEditDialog.#escape(instituteAlternateNamesValue)}" placeholder="Enter alternate names">
                    </label>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full paid-deck-upload-section-divider">
                        <span class="paid-deck-upload-section-heading">Content summary (auto-computed at upload)</span>
                    </div>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full paid-deck-content-summary-row">
                        <div class="paid-deck-content-summary-cell"><strong>${totalCards}</strong> flashcards</div>
                        <div class="paid-deck-content-summary-cell"><strong>${totalStudyMaterials}</strong> study materials</div>
                        <div class="paid-deck-content-summary-cell"><strong>${totalMockTests}</strong> mock tests</div>
                        <div class="paid-deck-content-summary-cell">Content version <strong>v${contentVersion}</strong></div>
                    </div>

                    <div class="paid-deck-upload-field paid-deck-upload-field-full">
                        <button type="button" class="paid-deck-edit-replace-content">Replace Deck Content...</button>
                    </div>
                </div>

                <div class="paid-deck-edit-error" hidden></div>
                <div class="paid-deck-upload-actions">
                    <button type="button" class="paid-deck-edit-cancel">Cancel</button>
                    <button type="button" class="paid-deck-edit-submit">Save</button>
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

    static #collectFormUpdates(formElement, dialog, deck)
    {
        const getValue = (name) => formElement.elements[name]?.value ?? "";
        const getChecked = (name) => Boolean(formElement.elements[name]?.checked);

        // Start from the deck's existing additionalData so other keys the
        // admin set out-of-band (sourceFile, internalNotes, etc.) survive
        // an institute edit instead of being silently wiped.
        const mergedAdditionalData = (deck && deck.additionalData && typeof deck.additionalData === "object")
            ? { ...deck.additionalData }
            : {};

        const instituteName = getValue("instituteName").trim();
        if (instituteName.length > 0)
        {
            mergedAdditionalData.institute =
            {
                name: instituteName,
                location: getValue("instituteLocation").trim(),
                alternateNames: PaidDeckEditDialog.#parseCsvList(getValue("instituteAlternateNames"))
            };
        }
        else
        {
            // Clearing the name field intentionally removes the institute
            // entirely — admins shouldn't have to manually scrub it from the
            // additionalData JSON when they want to make a deck universal.
            delete mergedAdditionalData.institute;
        }

        // Thumbnail: a built-in URL goes on thumbnailUrl; an uploaded image
        // rides in additionalData.thumbnailImage (resolved ahead of the URL).
        // Clear the stale image when the admin switches back to a URL/default.
        const thumbnailSelection = PaidDeckThumbnailPicker.readSelection(dialog.querySelector('[data-role="edit-thumbnail-field"]'));
        if (thumbnailSelection.thumbnailImage)
        {
            mergedAdditionalData.thumbnailImage = thumbnailSelection.thumbnailImage;
        }
        else
        {
            delete mergedAdditionalData.thumbnailImage;
        }

        return {
            title: getValue("title").trim(),
            category: getValue("category").trim(),
            description: getValue("description").trim(),
            thumbnailUrl: thumbnailSelection.thumbnailUrl,
            basePriceMinor: Number(getValue("basePriceMinor") || 0),
            currency: getValue("currency").trim().toUpperCase() || "INR",
            // A ticked "Perpetual" box always wins; otherwise a positive day
            // count sells a finite rental. Both blank leaves the deck ungrantable
            // until the admin picks one (enforced server-side).
            durationDays: getChecked("isPerpetual") ? 0 : (Number(getValue("durationDays") || 0) > 0 ? Math.floor(Number(getValue("durationDays"))) : 0),
            isPerpetual: getChecked("isPerpetual"),
            granularity: Number(getValue("granularity") || 0),
            tags: PaidDeckEditDialog.#parseCsvList(getValue("tags")),
            extraTags: PaidDeckEditDialog.#parseCsvList(getValue("extraTags")),
            bundleChildIds: PaidDeckEditDialog.#parseCsvList(getValue("bundleChildIds")),
            parentBundleIds: PaidDeckEditDialog.#parseCsvList(getValue("parentBundleIds")),
            isPublished: getChecked("isPublished"),
            featureBadges: PaidDeckEditDialog.#collectSelectedBadgeValues(dialog),
            additionalData: mergedAdditionalData
        };
    }
}

export default PaidDeckEditDialog;
