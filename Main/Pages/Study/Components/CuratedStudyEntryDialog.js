import CuratedStudyArchiveDialog from "./CuratedStudyArchiveDialog.js";
import CuratedStudyContentTypeFilterDialog from "./CuratedStudyContentTypeFilterDialog.js";
import CuratedStudyController from "../../../Globals/Classes/CuratedStudy/CuratedStudyController.js";
import CuratedStudyProgressOverlay from "./CuratedStudyProgressOverlay.js";
import CuratedStudySession from "../Classes/CuratedStudySession.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import AutoAnalysisDeckFields from "../../../Globals/Classes/Analysis/AutoAnalysisDeckFields.js";
import PaidDeckStudyGate from "../../../Globals/Classes/PaidDeckStudyGate.js";


/**
 * CuratedStudyEntryDialog
 *
 * Entry point users see when they click "Curated Study" on the deck's
 * study-mode picker. Offers three actions:
 *
 *   - **Latest**     — open the current LIVE batch in CuratedStudySession.
 *                      Disabled when no LIVE batch exists.
 *   - **Archive**    — open the read-only archive view, scoped by a
 *                      Materials/Flashcards/Both content-type filter.
 *                      Disabled when no archived batches exist.
 *   - **Regenerate** — confirm + force a fresh batch via the agent
 *                      (re-analyse + regenerate). Shows the progress
 *                      overlay; on completion re-opens this dialog.
 *
 * If the agent skipped its most recent auto-analysis because the user
 * had an active batch in progress, a warning banner explains why and
 * offers Regenerate as the workaround.
 */
class CuratedStudyEntryDialog
{
    static async show(deck)
    {
        if (!deck)
        {
            return;
        }

        // Belt-and-braces unlock: the study-mode chooser already gates a paid
        // deck before reaching here, but this is a public entry point — ensure
        // the deck is unlocked + decrypted so curated materials never render as
        // locked placeholders. No-op for a normal or already-unlocked deck.
        const bReady = await PaidDeckStudyGate.ensureReadyForStudy(deck);
        if (!bReady)
        {
            return;
        }

        // Defence in depth — clean up orphaned LIVE materials from
        // prior data corruption before computing LIVE-batch state.
        // Idempotent and fast when there's nothing to fix.
        await CuratedStudyController.repairOrphanedLiveBatches(deck);

        const liveBatchInfo = CuratedStudyController.getLiveBatchInfo(deck);
        const archivedBatches = CuratedStudyController.getArchivedBatches(deck);
        const additionalData = deck.getAdditionalData() || {};
        const lastSkippedAt = additionalData[AutoAnalysisDeckFields.LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT] || null;

        const bHasLiveBatch = liveBatchInfo !== null;
        const bHasArchive   = archivedBatches.length > 0;
        // Manual Regenerate without any new card grades since the last
        // analysis is wasteful — the agent would re-score the same
        // cards and (very likely) emit the same topic list. Gate the
        // button on actual progress and surface the reason in its
        // description so the user understands what to do.
        const bHasNewProgress = CuratedStudyController.hasStudiedSinceLastAnalysis(deck);

        const skippedBannerHtml = lastSkippedAt
            ? `
                <div class="curated-entry-skipped-banner">
                    <strong>Auto-analysis was skipped.</strong>
                    <span>We left your current curated batch alone because you have not yet finished it. Click <em>Regenerate</em> to force a fresh batch — your in-progress materials will be archived.</span>
                </div>
            `
            : "";

        const dialog = DialogBox.modal(`
            <h2 align="center">Curated Study</h2>
            <p align="center" class="curated-entry-deck-name">${CuratedStudyEntryDialog.#escapeHtml(deck.getName?.() || "")}</p>
            ${skippedBannerHtml}
            <div class="curated-entry-actions">
                <button class="curated-entry-latest-button" ${bHasLiveBatch ? "" : "disabled"}>
                    <span class="curated-entry-action-label">Latest curated study</span>
                    <span class="curated-entry-action-description">${bHasLiveBatch ? `${liveBatchInfo.topicGroups.length} topic(s) ready` : "No active batch — try Regenerate"}</span>
                </button>
                <button class="curated-entry-archive-button" ${bHasArchive ? "" : "disabled"}>
                    <span class="curated-entry-action-label">View archive</span>
                    <span class="curated-entry-action-description">${bHasArchive ? `${archivedBatches.length} past batch(es)` : "No archived batches yet"}</span>
                </button>
                <button class="curated-entry-regenerate-button" ${bHasNewProgress ? "" : "disabled"}>
                    <span class="curated-entry-action-label">Regenerate</span>
                    <span class="curated-entry-action-description">${bHasNewProgress ? "Re-analyse the deck and replace the current batch" : "Study a few cards before regenerating — there's no new evidence since the last analysis."}</span>
                </button>
            </div>
            <div class="curated-entry-cancel-row">
                <button class="curated-entry-cancel">Cancel</button>
            </div>
        `);

        const latestButton     = dialog.querySelector(".curated-entry-latest-button");
        const archiveButton    = dialog.querySelector(".curated-entry-archive-button");
        const regenerateButton = dialog.querySelector(".curated-entry-regenerate-button");
        const cancelButton     = dialog.querySelector(".curated-entry-cancel");

        if (bHasLiveBatch)
        {
            latestButton.addEventListener("click", () =>
            {
                dialog.close();
                PageNavigator.open("study-page", CuratedStudySession, deck, { batchTag: liveBatchInfo.tag });
            });
        }

        if (bHasArchive)
        {
            archiveButton.addEventListener("click", async () =>
            {
                dialog.close();
                const contentFilter = await CuratedStudyContentTypeFilterDialog.show();
                if (contentFilter === null)
                {
                    // User cancelled the filter — return them to the entry
                    // dialog so they aren't stranded.
                    CuratedStudyEntryDialog.show(deck);
                    return;
                }
                await CuratedStudyArchiveDialog.show(deck, contentFilter);
            });
        }

        regenerateButton.addEventListener("click", async () =>
        {
            // Close the entry dialog BEFORE any DialogBox.confirm/alert
            // calls. DialogBox uses a singleton-queue model — only one
            // dialog is mounted at a time, and subsequent ones are
            // parked in the queue until the active one closes. If we
            // call confirm() while the entry dialog is still up, the
            // confirm sits invisible behind it and the await never
            // resolves. On cancel we reopen the entry dialog so the
            // user isn't dumped back to the deck without warning.
            dialog.close();

            // Note: no enable-flags prompt here. The agent treats
            // `force=true` as an explicit user-initiated override of
            // both autoPerformanceAnalysisEnabled and
            // autoGenerateCuratedStudyEnabled (those toggles exist
            // solely to govern unattended weekly behaviour). Manual
            // Regenerate respects the user's preference to keep
            // auto-runs off while still letting them generate
            // curated content on demand.
            const confirmed = await DialogBox.confirm(
                "Regenerate curated study?",
                "This will re-analyse the deck and replace the current curated batch. Any materials and flashcards in the current batch will move to your archive. Continue?"
            );
            if (!confirmed)
            {
                CuratedStudyEntryDialog.show(deck);
                return;
            }
            await CuratedStudyEntryDialog.#runForceRegen(deck);
        });

        cancelButton.addEventListener("click", () => dialog.close());

        const closeButton = dialog.querySelector(".close-button");
        if (closeButton)
        {
            closeButton.addEventListener("click", () => dialog.close());
        }
    }

    /**
     * Drives the force-regen task end-to-end:
     *   1. Mount a blocking progress overlay with a "cancel and go
     *      back" escape — the cancel detaches the overlay but lets the
     *      underlying task continue running silently in the background.
     *   2. Queue the force-regen via CuratedStudyController, streaming
     *      progress events into the overlay.
     *   3. On COMPLETED, dismiss the overlay and re-open this entry
     *      dialog so the user immediately sees the fresh Latest button.
     *   4. On FAILED / timeout / network error, surface the error in
     *      the overlay with a Close button.
     */
    static async #runForceRegen(deck)
    {
        const progressOverlay = CuratedStudyProgressOverlay.show({
            title: "Regenerating curated study…",
            statusText: "Re-analysing your deck",
            onCancel: () =>
            {
                // Cancel returns the user to the previous page; the
                // underlying task keeps running and will sync in later.
                // No need to re-show the entry dialog — the user
                // explicitly bailed.
            },
        });

        try
        {
            const result = await CuratedStudyController.queueForceRegen(deck, {
                onStatusChange: (statusEvent) =>
                {
                    progressOverlay.updateStatus(statusEvent);
                },
            });

            progressOverlay.close();

            // If the server rejected the force-regen because another
            // analysis was already in flight (returned 409), joining
            // that unrelated task doesn't produce the new batch the
            // user asked for. Tell them so they don't silently believe
            // the regen succeeded — they can re-open Curated Study in
            // a moment to retry.
            if (result?.reason === "force_blocked_by_active_task")
            {
                await DialogBox.alert(
                    "Regeneration delayed",
                    "Another analysis was already running for this deck, so a fresh batch could not be generated right now. Open Curated Study again in a minute or two and try Regenerate."
                );
                return;
            }

            // Re-open the entry dialog so the user lands on the new LIVE
            // batch without an extra click. queueForceRegen's bTriggerSync
            // option already pulled the new materials in, so getLiveBatchInfo
            // sees the fresh batch.
            if (result?.status !== undefined)
            {
                // Paid decks aren't delivered by sync — the new batch was
                // written into the buyer's encrypted per-user store, so
                // re-hydrate the deck (no password re-prompt this session) to
                // pull the fresh manifest + curated entities before re-opening.
                const refreshedDeck = await CuratedStudyEntryDialog.#rehydratePaidDeckIfNeeded(deck);
                CuratedStudyEntryDialog.show(refreshedDeck || deck);
            }
        }
        catch (regenerationError)
        {
            progressOverlay.showError("Regeneration failed", regenerationError?.message || String(regenerationError));
        }
    }

    /**
     * In the unified model a paid deck is a normal synced deck, so a regen's
     * fresh curated batch arrives through the regular sync pipeline that
     * queueForceRegen already triggers (bTriggerSync). There is no separate
     * per-user store to re-hydrate from, so this is a no-op kept only so the
     * call site stays uniform — the existing in-tree deck instance is reused.
     */
    static async #rehydratePaidDeckIfNeeded(deck)
    {
        return null;
    }

    static #escapeHtml(value)
    {
        if (typeof value !== "string")
        {
            return "";
        }
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default CuratedStudyEntryDialog;
