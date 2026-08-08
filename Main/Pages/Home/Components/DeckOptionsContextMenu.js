import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import DeckEvents from "../../../Globals/Events/DeckEvents.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import { entityTypes } from "../../../Globals/Enumerations/EntityTypes.js";
import HomePageContextMenu from "./HomePageContextMenu.js";
import AiFeatureGate from "../../../Globals/Classes/AiFeatureGate.js";
import LicenseConstants from "../../../Globals/Constants/LicenseConstants.js";
import PaidDeckLicenseSyncer from "../../../Globals/Classes/Syncing/PaidDeckLicenseSyncer.js";
import ManagePaidDeckCopiesDialog from "./ManagePaidDeckCopiesDialog.js";
import PaidDeckRegistry from "../../../Globals/Classes/PaidDeckRegistry.js";
import ProgressDialog from "../../../CommonComponents/ProgressDialog.js";
import IntellectualPropertyNotice from "../../../CommonComponents/IntellectualPropertyNotice.js";
import SyncManager from "../../../Globals/Classes/SyncManager.js";
import AiGeneratedExportReporter from "../../../Globals/Classes/Security/AiGeneratedExportReporter.js";
import { aiGeneratedExportBlockReasons } from "../../../Globals/Enumerations/AiGeneratedExportBlockReasons.js";


class DeckOptionsContextMenu extends ContextMenu
{
    #deck = null;

    static tagName = "deck-options-context-menu";

    initialize(position = { x: 0, y: 0 }, deck)
    {
        super.initialize(position);
        this.#deck = deck;
    }

    /**
     * @param {string} title
     * @param {object[]} options - each { label, entityClassName, handler }.
     *        `entityClassName` gives every choice its own stable hook (e.g.
     *        `entity-picker-card-button`) so a tutorial can spotlight exactly
     *        one of them; `.entity-picker-button` alone matches all three.
     */
    #openEntityPicker(title, options)
    {
        const buttons = options.map(option =>
            `<button class="entity-picker-button ${option.entityClassName}">${option.label}</button>`
        ).join("");

        const dialog = DialogBox.modal(
            `<div class="entity-picker">
                <h2 style="margin: 0 0 16px 0; font-size: 1.1em;">${title}</h2>
                ${buttons}
            </div>`
        );

        dialog.querySelectorAll(".entity-picker-button").forEach((btn, i) =>
        {
            btn.addEventListener("click", () =>
            {
                dialog.close();
                options[i].handler();
            });
        });
    }

    #handleEvents()
    {
        const insightsButton       = this.querySelector(".insights-button");
        const addButton            = this.querySelector(".add-button");
        const expandButton         = this.querySelector(".expand-button");
        const editButton           = this.querySelector(".edit-button");
        const browseButton         = this.querySelector(".browse-button");
        const exportButton         = this.querySelector(".export-button");
        const generateWithAIButton = this.querySelector(".generate-with-ai-button");

        this.addEventListener("click", (event) => { event.stopPropagation(); });

        if (insightsButton)
        {
            insightsButton.addEventListener("click", () =>
            {
                PageNavigator.open("deck-insights-page", this.#deck);
                DeckOptionsContextMenu.removeAll();
                HomePageContextMenu.removeAll();
            });
        }

        if (expandButton)
        {
            expandButton.addEventListener("click", () =>
            {
                window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: this.#deck } }));
            });
        }

        const hideFromHomeButton = this.querySelector(".hide-from-home-button");
        if (hideFromHomeButton)
        {
            hideFromHomeButton.addEventListener("click", async () =>
            {
                DeckOptionsContextMenu.removeAll();
                HomePageContextMenu.removeAll();
                await this.#setCopyHidden(this.#deck.getAdditionalData?.()?.hidden !== true);
            });
        }

        const deleteCopyButton = this.querySelector(".delete-copy-button");
        if (deleteCopyButton)
        {
            deleteCopyButton.addEventListener("click", async () =>
            {
                DeckOptionsContextMenu.removeAll();
                HomePageContextMenu.removeAll();
                await this.#deleteThisCopy();
            });
        }

        // Bound before the `if (!addButton) return` guard below, because a paid
        // deck's menu has no Add button and would never reach anything wired
        // after it.
        if (browseButton)
        {
            browseButton.addEventListener("click", () => { this.#openBrowsePicker(); });
        }

        const updateContentButton = this.querySelector(".update-content-button");
        if (updateContentButton)
        {
            updateContentButton.addEventListener("click", async () =>
            {
                DeckOptionsContextMenu.removeAll();
                HomePageContextMenu.removeAll();
                await this.#updateThisCopyContent();
            });
        }

        const manageCopiesButton = this.querySelector(".manage-copies-button");
        if (manageCopiesButton)
        {
            manageCopiesButton.addEventListener("click", () =>
            {
                DeckOptionsContextMenu.removeAll();
                HomePageContextMenu.removeAll();
                const paidDeckId = this.#deck?.getAdditionalData?.()?.paidDeckId;
                if (paidDeckId)
                {
                    ManagePaidDeckCopiesDialog.show(paidDeckId);
                }
            });
        }

        if (!addButton)
        {
            return;
        }

        addButton.addEventListener("click", () =>
        {
            DeckOptionsContextMenu.removeAll();
            HomePageContextMenu.removeAll();

            this.#openEntityPicker("Add to deck", [
                {
                    label:           "Card",
                    entityClassName: "entity-picker-card-button",
                    handler:         () => PageNavigator.open("card-editor-page", null, this.#deck)
                },
                {
                    label:           "Study Material",
                    entityClassName: "entity-picker-study-material-button",
                    handler:         () => PageNavigator.open("study-material-editor-page", null, this.#deck)
                },
                {
                    label:           "Mock Test",
                    entityClassName: "entity-picker-mock-test-button",
                    handler:         () => PageNavigator.open("mock-test-editor-page", null, this.#deck)
                },
            ]);
        });

        if (generateWithAIButton)
        {
            generateWithAIButton.addEventListener("click", async () =>
            {
                if(!window["user"])
                {
                    await DialogBox.alert("Error", "You must be logged in to use this feature.");
                    return;
                }

                if (!await AiFeatureGate.ensureAllowedOrShowAlert())
                {
                    return;
                }

                PageNavigator.open("automatic-generation-page", this.#deck);
                DeckOptionsContextMenu.removeAll();
                HomePageContextMenu.removeAll();
            });
        }

        // Correcting generated content before it is published. Rendered on every
        // non-paid deck and gated on CLICK rather than hidden by entitlement —
        // matching Generate With AI above, so a user on a lower tier gets an
        // upgrade prompt naming the feature instead of a button that silently
        // is not there.
        const refineWithAiButton = this.querySelector(".refine-with-ai-button");

        if (refineWithAiButton)
        {
            refineWithAiButton.addEventListener("click", async () =>
            {
                if (!window["user"])
                {
                    await DialogBox.alert("Error", "You must be logged in to use this feature.");
                    return;
                }

                if (!await AiFeatureGate.ensureAllowedOrShowAlert())
                {
                    return;
                }

                PageNavigator.open("content-refinement-page", this.#deck);
                DeckOptionsContextMenu.removeAll();
                HomePageContextMenu.removeAll();
            });
        }

        if (editButton)
        {
            editButton.addEventListener("click", () =>
            {
                PageNavigator.open("deck-editor-page", this.#deck, this.#deck.getParent());
                DeckOptionsContextMenu.removeAll();
            });
        }

        // Null-guarded like every other optional button above. The Export button
        // is absent on an AI-generated deck, and the `if (!addButton) return`
        // guard does NOT cover that case — a generated deck is not a paid deck,
        // so it still renders Add. Without this guard opening the options menu
        // on any generated deck threw a TypeError.
        if (!exportButton)
        {
            return;
        }

        exportButton.addEventListener("click", () =>
        {
            const dialog = DialogBox.modal(
                `
                    <style>
                        .export-options-body
                        {
                            display: flex;
                            flex-direction: column;
                            gap: 6px;
                            padding: 4px 14px 14px 14px;
                            min-width: min(360px, 88vw);
                        }
                        .export-options-body .export-options-title
                        {
                            margin: 6px 0 4px 0;
                            font-size: 1.15rem;
                            font-weight: 700;
                            text-align: center;
                        }
                        .export-options-body .export-field-container
                        {
                            padding: 6px 4px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                            font-size: 14px;
                        }
                        .export-options-body .export-field-container label
                        {
                            flex: 1;
                            cursor: pointer;
                        }
                        .export-options-body .export-field-container input[type="checkbox"]
                        {
                            width: 18px;
                            height: 18px;
                            flex-shrink: 0;
                            cursor: pointer;
                        }
                        .export-options-body .export-button-container
                        {
                            margin-top: 8px;
                        }
                        .export-options-body .export-button
                        {
                            background-color: var(--accent-color, #1a73e8);
                            color: #fff;
                            font-weight: 600;
                            padding: 10px;
                            border-radius: 6px;
                            width: 100%;
                            border: none;
                            cursor: pointer;
                            font-size: 14px;
                        }
                        @media (orientation: portrait), (max-width: 600px)
                        {
                            .export-options-body
                            {
                                padding: 2px 10px 10px 10px;
                                gap: 4px;
                                min-width: 0;
                            }
                            .export-options-body .export-options-title
                            {
                                font-size: 1.05rem;
                                margin: 4px 0 2px 0;
                            }
                            .export-options-body .export-field-container
                            {
                                padding: 5px 2px;
                                font-size: 13.5px;
                                gap: 8px;
                            }
                        }
                    </style>
                    <div class="export-options-body">
                        <div class="export-options-title">Export Options</div>
                        <intellectual-property-notice context="export"></intellectual-property-notice>
                        <div class="export-field-container">
                            <label for="retain-progress-checkbox">Retain Progress</label>
                            <input id="retain-progress-checkbox" type="checkbox" class="retain-progress-checkbox" checked>
                        </div>
                        <div class="export-field-container">
                            <label for="recursive-checkbox">Recursive</label>
                            <input id="recursive-checkbox" type="checkbox" class="recursive-checkbox" checked>
                        </div>
                        <div class="export-field-container">
                            <label for="retain-auto-analysis-settings-checkbox">Retain Auto-Analysis Settings</label>
                            <input id="retain-auto-analysis-settings-checkbox" type="checkbox" class="retain-auto-analysis-settings-checkbox">
                        </div>
                        <div class="export-button-container">
                            <button class="export-button">Export</button>
                        </div>
                    </div>
                `
            );

            dialog.querySelector(".export-button").addEventListener("click", async () =>
            {
                const retainProgress = dialog.querySelector(".retain-progress-checkbox").checked;
                const recursive      = dialog.querySelector(".recursive-checkbox").checked;
                const retainAutoAnalysisSettings = dialog.querySelector(".retain-auto-analysis-settings-checkbox").checked;

                // Subtree gate. A recursive export pulls in every descendant, so
                // a deck that is itself clean still cannot be exported when
                // anything beneath it was AI-generated — otherwise a parent, or
                // ultimately the root deck, becomes the way that content leaves
                // the app. Non-recursive exports of a clean deck stay allowed;
                // the node-level check that gates the menu button covers those.
                if (recursive && this.#deck?.containsAiGeneratedContent?.() === true)
                {
                    AiGeneratedExportReporter.report(
                    {
                        deckId: this.#deck?.getId?.() ?? null,
                        bRecursiveRequested: true,
                        bBlocked: true,
                        reason: aiGeneratedExportBlockReasons.SUBTREE_AI_GENERATED,
                    });

                    await DialogBox.alert(
                        "Can't export this deck",
                        "This deck contains AI-generated study material, which can't be exported. "
                        + "Turn off Recursive to export only this deck's own content.",
                    );
                    return;
                }

                // The node-level gate hides the Export button entirely, so on an
                // unmodified client this branch is unreachable. Reaching it means
                // the button was re-enabled — exactly the bypass the telemetry
                // exists to surface — so record it (bBlocked false: the export
                // below is about to run) rather than silently allowing it.
                if (this.#deck?.isAiGenerated?.() === true)
                {
                    AiGeneratedExportReporter.report(
                    {
                        deckId: this.#deck?.getId?.() ?? null,
                        bRecursiveRequested: recursive,
                        bBlocked: false,
                        reason: aiGeneratedExportBlockReasons.NODE_AI_GENERATED,
                    });
                }

                await this.#deck.export({
                    bRecursive: recursive,
                    bRetainProgress: retainProgress,
                    bRetainAutoAnalysisSettings: retainAutoAnalysisSettings,
                });

                dialog.close();
            });

            DeckOptionsContextMenu.removeAll();
        });
    }

    /**
     * Toggles the synced "hidden" flag on this paid-deck copy's root and forces
     * a full home-grid rebuild so the tile appears/disappears immediately.
     * Hiding keeps the copy fully intact (content + progress) for re-showing.
     */
    async #setCopyHidden(bHidden)
    {
        const parentDeck = this.#deck.getParent();
        this.#deck.setAdditionalDataField("hidden", bHidden === true);
        await this.#deck.save();
        window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: parentDeck } }));
    }

    /**
     * Permanently deletes this copy: asks the server to drop it from the
     * license registry + tombstone its rows, then tears it down locally. The
     * purchase/license is kept so the buyer can add a fresh copy later.
     */
    async #deleteThisCopy()
    {
        const additionalData = this.#deck?.getAdditionalData?.() || {};
        const paidDeckId = additionalData.paidDeckId;
        const instanceId = additionalData.paidDeckInstanceId || LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID;

        if (!paidDeckId)
        {
            return;
        }

        const confirmed = await DialogBox.confirm
        (
            "Delete this copy?",
            "This permanently removes this copy and its study progress from all your devices. Your purchase is kept — you can add a fresh copy any time while your access is valid."
        );
        if (!confirmed)
        {
            return;
        }

        const parentDeck = this.#deck.getParent();

        let response;
        try
        {
            response = await fetch("/PaidDecks/Copies/Delete",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: paidDeckId, instanceId: instanceId })
            });
        }
        catch (networkError)
        {
            await DialogBox.alert("Couldn't delete copy", `Network error: ${networkError.message}`);
            return;
        }

        if (!response.ok)
        {
            const errorJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Couldn't delete copy", errorJson.error || `HTTP ${response.status}`);
            return;
        }

        // Local teardown (cascades + emits tombstones via normal sync), then
        // refresh the synced copy registry so the manage dialog / store reflect
        // the removal.
        await this.#deck.delete();
        await PaidDeckLicenseSyncer.pullLicenses();

        window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: parentDeck } }));
    }

    #openBrowsePicker()
    {
        DeckOptionsContextMenu.removeAll();
        HomePageContextMenu.removeAll();

        this.#openEntityPicker("Browse", [
            {
                label:           "Cards",
                entityClassName: "entity-picker-card-button",
                handler:         () => PageNavigator.open("browser-page", this.#deck, entityTypes.CARD)
            },
            {
                label:           "Study Materials",
                entityClassName: "entity-picker-study-material-button",
                handler:         () => PageNavigator.open("browser-page", this.#deck, entityTypes.STUDY_MATERIAL)
            },
            {
                label:           "Mock Tests",
                entityClassName: "entity-picker-mock-test-button",
                handler:         () => PageNavigator.open("browser-page", this.#deck, entityTypes.MOCK_TEST)
            },
        ]);
    }

    /**
     * Walks the buyer through updating this copy to the publisher's current
     * content.
     *
     * The dry run comes first so the confirmation can state real numbers rather
     * than a vague warning: which cards keep their progress, which reset, and
     * what the publisher removed. An update is never applied silently, and
     * declining leaves the copy on its current version indefinitely.
     */
    async #updateThisCopyContent()
    {
        const additionalData = this.#deck?.getAdditionalData?.() || {};
        const paidDeckId = additionalData.paidDeckId;
        const instanceId = additionalData.paidDeckInstanceId || LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID;

        if (!paidDeckId)
        {
            return;
        }

        let plannedCounts = null;
        try
        {
            const dryRunResponse = await fetch("/PaidDecks/Copies/UpdateContent",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: paidDeckId, instanceId: instanceId, dryRun: true })
            });

            if (!dryRunResponse.ok)
            {
                const errorJson = await dryRunResponse.json().catch(() => ({}));
                await DialogBox.alert("Couldn't check for an update", errorJson.error || `HTTP ${dryRunResponse.status}`);
                return;
            }

            plannedCounts = (await dryRunResponse.json()).counts;
        }
        catch (dryRunError)
        {
            await DialogBox.alert("Couldn't check for an update", dryRunError.message);
            return;
        }

        const confirmationLines = [];
        if (plannedCounts.reset > 0)
        {
            confirmationLines.push(`${plannedCounts.reset} item(s) changed — your progress on those resets, and any edits you made to them are replaced by the new version.`);
        }
        if (plannedCounts.carried > 0)
        {
            confirmationLines.push(`${plannedCounts.carried} item(s) are unchanged — your progress and your edits on those are kept.`);
        }
        if (plannedCounts.added > 0)
        {
            confirmationLines.push(`${plannedCounts.added} new item(s) will be added.`);
        }
        if (plannedCounts.removed > 0)
        {
            confirmationLines.push(`${plannedCounts.removed} item(s) were removed by the publisher and will disappear.`);
        }
        confirmationLines.push("This can't be undone. Your other copies of this deck aren't affected.");

        const bConfirmed = await DialogBox.confirm("Update this copy?", confirmationLines.join("<br><br>"));
        if (!bConfirmed)
        {
            return;
        }

        const progressDialog = ProgressDialog.show("Updating your copy");
        progressDialog.setProgress(0.3, "Applying the new content\u2026");

        try
        {
            const updateResponse = await fetch("/PaidDecks/Copies/UpdateContent",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: paidDeckId, instanceId: instanceId })
            });

            if (!updateResponse.ok)
            {
                const errorJson = await updateResponse.json().catch(() => ({}));
                progressDialog.close();
                await DialogBox.alert("Update failed", errorJson.error || `HTTP ${updateResponse.status}`);
                return;
            }

            progressDialog.setProgress(0.7, "Syncing\u2026");
            await PaidDeckLicenseSyncer.pullLicenses();
            await SyncManager.sync();
            progressDialog.setProgress(1, "Done");
        }
        catch (updateError)
        {
            progressDialog.close();
            await DialogBox.alert("Update failed", updateError.message);
            return;
        }
        finally
        {
            progressDialog.close();
        }

        await DialogBox.alert("Updated", "This copy is now on the publisher's latest version.");
    }

    connectedCallback()
    {
        // A paid deck is any node carrying the paidDeckId tag (stamped on the
        // bundle root AND every sub-deck at provisioning). The seller's content
        // is still immutable — a learner's edits are stored as separate
        // encrypted overlays and never overwrite it — so the options that would
        // ADD or GENERATE new content into someone else's deck stay hidden.
        // Browse is offered because that is how the learner reaches the card
        // and study-material editors outside a study session.
        // Export stays hidden: it is the primary enforcement that paid content
        // can't be extracted to a shareable file.
        const additionalData = this.#deck?.getAdditionalData?.() || {};
        const isPaidDeck = typeof additionalData.paidDeckId === "string" && additionalData.paidDeckId.length > 0;

        // Export is withheld from AI-generated content: it was synthesised from
        // uploaded source material and must not leave the app as a shareable file.
        //
        // Gated at the NODE here, and again on the subtree at export time. Hiding
        // the button whenever any descendant is generated would be simpler but
        // wrong — it would block a clean parent from a non-recursive export that
        // never touches the generated children. The recursive case is caught in
        // the export handler, where the recursion flag is actually known.
        const bExportAllowed = this.#deck?.isAiGenerated?.() !== true;

        // Per-copy controls only make sense on the ROOT of a paid copy (a
        // top-level tile), not on its sub-decks — those still show just
        // Insights + Expand like before.
        const parentDeck = this.#deck?.getParent?.();
        const isPaidCopyRoot = isPaidDeck && parentDeck && typeof parentDeck.isRoot === "function" && parentDeck.isRoot();
        const isHiddenCopy = additionalData.hidden === true;
        // Offered only when the publisher has actually released newer content
        // than this copy holds. A copy whose seeded version is unknown (every
        // licence issued before content versioning) counts as current, so no
        // existing buyer is nagged to reset their progress for nothing.
        const bUpdateAvailable = isPaidCopyRoot
            && PaidDeckRegistry.isContentUpdateAvailable(additionalData.paidDeckId, additionalData.paidDeckInstanceId || LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID);
        const updateContentControl = bUpdateAvailable
            ? `<button class="update-content-button">Update content…</button>`
            : "";
        const paidCopyControls = isPaidCopyRoot
            ? `
                ${updateContentControl}
                <button class="hide-from-home-button">${isHiddenCopy ? "Show on home" : "Hide from home"}</button>
                <button class="delete-copy-button">Delete copy</button>
                <button class="manage-copies-button">Manage copies…</button>
            `
            : "";

        this.innerHTML = isPaidDeck
            ? `
                <button class="insights-button">Insights</button>
                <button class="expand-button">Expand</button>
                <button class="browse-button">Browse</button>
                ${paidCopyControls}
            `
            : `
                <button class="insights-button">Insights</button>
                <button class="add-button">Add</button>
                <button class="generate-with-ai-button">Generate With AI</button>
                <button class="refine-with-ai-button">Refine With AI</button>
                <button class="expand-button">Expand</button>
                <button class="edit-button">Edit</button>
                <button class="browse-button">Browse</button>
                ${bExportAllowed ? `<button class="export-button">Export</button>` : ""}
            `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define("deck-options-context-menu", DeckOptionsContextMenu);
export default DeckOptionsContextMenu;
