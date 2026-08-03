import DialogBox from "../../../CommonComponents/DialogBox.js";
import DeckEvents from "../../../Globals/Events/DeckEvents.js";

/**
 * DeckMergeFlow
 *
 * Orchestrates the user-facing dialog sequence required to merge one deck
 * into another. The mechanical move (cards, sub-decks, materials, mock
 * tests, tags, additionalData) lives on `Deck.mergeFrom`. This class only
 * handles the conflict-resolution conversation: confirm intent, prompt
 * the user to pick a name / shortName when those differ, walk the union
 * of additionalData keys and prompt on differing values, then delegate
 * to `targetDeck.mergeFrom(...)` and surface the home-page UI updates.
 *
 * Cancellation at any modal aborts the entire flow without touching
 * either deck.
 */
class DeckMergeFlow
{
    static async runMergeFlow(sourceDeck, targetDeck)
    {
        if (!sourceDeck || !targetDeck || sourceDeck === targetDeck)
        {
            return;
        }

        // ── Reject anything that would move paid content out of its own
        //    subtree. mergeFrom relocates every card, material, mock test and
        //    sub-deck from the source into the target and then deletes the
        //    source, so merging a paid deck into a normal one would carry
        //    seller-owned content into a deck that is freely exportable. The
        //    reverse direction is refused too: absorbing a normal deck into a
        //    paid one would leave the learner's own content stranded inside a
        //    subtree they can never export.
        if (sourceDeck.isPaidLicensedSubtree() || targetDeck.isPaidLicensedSubtree())
        {
            await DialogBox.alert(
                "Cannot merge",
                "Purchased decks can't be merged. Their content belongs to the seller and has to stay in its own deck."
            );
            return;
        }

        // ── Reject cycles up front so the user gets a clear explanation
        //    instead of a thrown error mid-flow.
        if (targetDeck.isDescendantOf(sourceDeck))
        {
            await DialogBox.alert(
                "Cannot merge",
                `"${DeckMergeFlow.#escapeHtml(targetDeck.getName())}" is inside "${DeckMergeFlow.#escapeHtml(sourceDeck.getName())}". Merging an ancestor into one of its descendants would create a loop in the deck tree.`
            );
            return;
        }

        // Capture the source's parent BEFORE `mergeFrom` deletes the
        // source — Deck.delete() detaches the source from its parent, so
        // by the time we want to dispatch DeckEvents.DELETE the parent
        // reference would already be null.
        const sourceParentBeforeMerge = sourceDeck.getParent();

        // ── Step 1: confirm intent ──────────────────────────────────────
        const userAcceptedIntent = await DeckMergeFlow.#confirmMergeIntent(sourceDeck, targetDeck);
        if (!userAcceptedIntent)
        {
            return;
        }

        const resolutions = {};

        // ── Step 2: name conflict ───────────────────────────────────────
        if (sourceDeck.getName() !== targetDeck.getName())
        {
            const resolvedName = await DeckMergeFlow.#resolveNameConflict(sourceDeck.getName(), targetDeck.getName());
            if (resolvedName === null)
            {
                return;
            }
            resolutions.name = resolvedName;
        }

        // ── Step 3: shortName conflict ──────────────────────────────────
        if (sourceDeck.getShortName() !== targetDeck.getShortName())
        {
            const resolvedShortName = await DeckMergeFlow.#resolveShortNameConflict(sourceDeck.getShortName(), targetDeck.getShortName());
            if (resolvedShortName === null)
            {
                return;
            }
            resolutions.shortName = resolvedShortName;
        }

        // ── Step 4: additionalData conflicts ────────────────────────────
        const sourceAdditionalData = sourceDeck.getAdditionalData() || {};
        const targetAdditionalData = targetDeck.getAdditionalData() || {};
        const resolvedAdditionalData = await DeckMergeFlow.#resolveAdditionalDataConflicts(sourceAdditionalData, targetAdditionalData);
        if (resolvedAdditionalData === null)
        {
            return;
        }
        if (Object.keys(resolvedAdditionalData).length > 0)
        {
            resolutions.additionalData = resolvedAdditionalData;
        }

        // ── Step 5: perform the merge ───────────────────────────────────
        try
        {
            await targetDeck.mergeFrom(sourceDeck, resolutions);
        }
        catch (mergeError)
        {
            console.error("[DeckMergeFlow] mergeFrom failed:", mergeError);
            await DialogBox.alert("Merge failed", `The merge could not be completed:\n${mergeError?.message || mergeError}`);
            return;
        }

        // ── Step 6: surface UI updates ─────────────────────────────────
        // Deck.delete() inside mergeFrom only fires SyncEvents.ENTITY_DELETED,
        // not DeckEvents.DELETE — HomePage listens for the latter to refresh
        // the grid, so dispatch it here with the captured parent.
        window.dispatchEvent(new CustomEvent(DeckEvents.DELETE,
        {
            detail: { parent: sourceParentBeforeMerge }
        }));

        window.dispatchEvent(new CustomEvent(DeckEvents.UPDATE,
        {
            detail: { deck: targetDeck }
        }));
    }

    // ── Modal helpers ───────────────────────────────────────────────────

    static #confirmMergeIntent(sourceDeck, targetDeck)
    {
        return new Promise((resolve) =>
        {
            const sourceName = DeckMergeFlow.#escapeHtml(sourceDeck.getName());
            const targetName = DeckMergeFlow.#escapeHtml(targetDeck.getName());

            const dialog = DialogBox.modal(`
                <h2 class="deck-merge-flow-title">Merge deck?</h2>
                <p class="deck-merge-flow-body">
                    This will move all of <strong>${sourceName}</strong>'s cards,
                    sub-decks, study materials, and mock tests into
                    <strong>${targetName}</strong>, then delete the source deck.
                </p>
                <p class="deck-merge-flow-body deck-merge-flow-body-warning">
                    This cannot be undone.
                </p>
                <div class="deck-merge-flow-buttons">
                    <button type="button" class="deck-merge-flow-cancel-button">Cancel</button>
                    <button type="button" class="deck-merge-flow-confirm-button">Merge</button>
                </div>
            `);

            let hasResolved = false;
            const finishWith = (result) =>
            {
                if (hasResolved)
                {
                    return;
                }
                hasResolved = true;
                dialog.close();
                resolve(result);
            };

            dialog.querySelector(".deck-merge-flow-cancel-button").addEventListener("click", () => finishWith(false));
            dialog.querySelector(".deck-merge-flow-confirm-button").addEventListener("click", () => finishWith(true));
        });
    }

    static #resolveNameConflict(sourceName, targetName)
    {
        return DeckMergeFlow.#resolveScalarConflict(
            "Choose a name",
            "The two decks have different names. Pick which one to keep, or type a new one.",
            sourceName,
            targetName
        );
    }

    static #resolveShortNameConflict(sourceShortName, targetShortName)
    {
        return DeckMergeFlow.#resolveScalarConflict(
            "Choose a short name",
            "The two decks have different short names. Pick which one to keep, or type a new one.",
            sourceShortName,
            targetShortName
        );
    }

    static #resolveScalarConflict(title, body, sourceValue, targetValue)
    {
        return new Promise((resolve) =>
        {
            const sourceDisplay = DeckMergeFlow.#escapeHtml(sourceValue ?? "");
            const targetDisplay = DeckMergeFlow.#escapeHtml(targetValue ?? "");

            const dialog = DialogBox.modal(`
                <h2 class="deck-merge-flow-title">${DeckMergeFlow.#escapeHtml(title)}</h2>
                <p class="deck-merge-flow-body">${DeckMergeFlow.#escapeHtml(body)}</p>
                <div class="deck-merge-flow-choice-list">
                    <button type="button" class="deck-merge-flow-choice-button" data-choice="target">
                        <span class="deck-merge-flow-choice-tag">Keep</span>
                        <span class="deck-merge-flow-choice-value">${targetDisplay}</span>
                    </button>
                    <button type="button" class="deck-merge-flow-choice-button" data-choice="source">
                        <span class="deck-merge-flow-choice-tag">Use</span>
                        <span class="deck-merge-flow-choice-value">${sourceDisplay}</span>
                    </button>
                </div>
                <div class="deck-merge-flow-custom-row">
                    <input type="text" class="deck-merge-flow-custom-input" placeholder="Or type a new name..." />
                    <button type="button" class="deck-merge-flow-custom-button">Use this</button>
                </div>
                <div class="deck-merge-flow-buttons">
                    <button type="button" class="deck-merge-flow-cancel-button">Cancel</button>
                </div>
            `);

            let hasResolved = false;
            const finishWith = (result) =>
            {
                if (hasResolved)
                {
                    return;
                }
                hasResolved = true;
                dialog.close();
                resolve(result);
            };

            for (const choiceButton of dialog.querySelectorAll(".deck-merge-flow-choice-button"))
            {
                choiceButton.addEventListener("click", () =>
                {
                    const choice = choiceButton.getAttribute("data-choice");
                    finishWith(choice === "source" ? sourceValue : targetValue);
                });
            }

            const customInput = dialog.querySelector(".deck-merge-flow-custom-input");
            const customButton = dialog.querySelector(".deck-merge-flow-custom-button");
            customButton.addEventListener("click", () =>
            {
                const customValue = customInput.value.trim();
                if (customValue.length > 0)
                {
                    finishWith(customValue);
                }
            });
            customInput.addEventListener("keydown", (keyEvent) =>
            {
                if (keyEvent.key === "Enter")
                {
                    keyEvent.preventDefault();
                    customButton.click();
                }
            });

            dialog.querySelector(".deck-merge-flow-cancel-button").addEventListener("click", () => finishWith(null));
        });
    }

    static async #resolveAdditionalDataConflicts(sourceData, targetData)
    {
        const resolutions = {};
        const allKeys = new Set([...Object.keys(sourceData), ...Object.keys(targetData)]);

        for (const fieldKey of allKeys)
        {
            // Entity-channel slots (popup notes, content overlays) are maps of
            // independent records, merged per record by Deck.#mergeAdditionalData.
            // Prompting about them would show the learner a wall of raw JSON and
            // make them choose one side's whole map over the other's.
            if (DeckMergeFlow.#ENTITY_CHANNEL_ADDITIONAL_DATA_KEYS.includes(fieldKey))
            {
                continue;
            }

            const hasSource = Object.prototype.hasOwnProperty.call(sourceData, fieldKey);
            const hasTarget = Object.prototype.hasOwnProperty.call(targetData, fieldKey);

            // Only prompt when both decks carry differing values for the
            // same key. Keys present in only one side are auto-merged by
            // Deck.#mergeAdditionalData without user input.
            if (!hasSource || !hasTarget)
            {
                continue;
            }

            if (DeckMergeFlow.#valuesEqual(sourceData[fieldKey], targetData[fieldKey]))
            {
                continue;
            }

            const resolvedValue = await DeckMergeFlow.#resolveAdditionalDataKeyConflict(
                fieldKey,
                sourceData[fieldKey],
                targetData[fieldKey]
            );

            if (resolvedValue === DeckMergeFlow.#CANCEL_SENTINEL)
            {
                return null;
            }
            resolutions[fieldKey] = resolvedValue;
        }

        return resolutions;
    }

    static #CANCEL_SENTINEL = Symbol("DeckMergeFlow.cancel");

    // Kept in step with Deck's own list of additionalData slots that hold
    // records syncing as their own entity type.
    static #ENTITY_CHANNEL_ADDITIONAL_DATA_KEYS = ["askAiPopupLinks", "contentOverlays"];

    static #resolveAdditionalDataKeyConflict(fieldKey, sourceValue, targetValue)
    {
        return new Promise((resolve) =>
        {
            const sourceDisplay = DeckMergeFlow.#escapeHtml(DeckMergeFlow.#stringifyForDisplay(sourceValue));
            const targetDisplay = DeckMergeFlow.#escapeHtml(DeckMergeFlow.#stringifyForDisplay(targetValue));
            const keyDisplay = DeckMergeFlow.#escapeHtml(fieldKey);

            const dialog = DialogBox.modal(`
                <h2 class="deck-merge-flow-title">Resolve "${keyDisplay}"</h2>
                <p class="deck-merge-flow-body">
                    Both decks store a different value for <strong>${keyDisplay}</strong>.
                    Pick which one to keep on the merged deck.
                </p>
                <div class="deck-merge-flow-choice-list">
                    <button type="button" class="deck-merge-flow-choice-button" data-choice="target">
                        <span class="deck-merge-flow-choice-tag">Keep</span>
                        <span class="deck-merge-flow-choice-value">${targetDisplay}</span>
                    </button>
                    <button type="button" class="deck-merge-flow-choice-button" data-choice="source">
                        <span class="deck-merge-flow-choice-tag">Use</span>
                        <span class="deck-merge-flow-choice-value">${sourceDisplay}</span>
                    </button>
                </div>
                <div class="deck-merge-flow-buttons">
                    <button type="button" class="deck-merge-flow-cancel-button">Cancel merge</button>
                </div>
            `);

            let hasResolved = false;
            const finishWith = (result) =>
            {
                if (hasResolved)
                {
                    return;
                }
                hasResolved = true;
                dialog.close();
                resolve(result);
            };

            for (const choiceButton of dialog.querySelectorAll(".deck-merge-flow-choice-button"))
            {
                choiceButton.addEventListener("click", () =>
                {
                    const choice = choiceButton.getAttribute("data-choice");
                    finishWith(choice === "source" ? sourceValue : targetValue);
                });
            }

            dialog.querySelector(".deck-merge-flow-cancel-button").addEventListener("click", () => finishWith(DeckMergeFlow.#CANCEL_SENTINEL));
        });
    }

    // ── Pure helpers ────────────────────────────────────────────────────

    static #valuesEqual(firstValue, secondValue)
    {
        if (firstValue === secondValue)
        {
            return true;
        }
        try
        {
            return JSON.stringify(firstValue) === JSON.stringify(secondValue);
        }
        catch (error)
        {
            return false;
        }
    }

    static #stringifyForDisplay(value)
    {
        if (value === null || value === undefined)
        {
            return "(empty)";
        }
        if (typeof value === "string")
        {
            return value;
        }
        try
        {
            return JSON.stringify(value);
        }
        catch (error)
        {
            return String(value);
        }
    }

    static #escapeHtml(unsafeString)
    {
        if (unsafeString === null || unsafeString === undefined)
        {
            return "";
        }
        return String(unsafeString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

export default DeckMergeFlow;
