import CuratedStudyMaterialFields from "./CuratedStudyMaterialFields.js";
import Deck from "../../Model/Deck.js";


/**
 * CuratedStudyMaterialMigration
 *
 * One-shot client-side migration that converts legacy curated study
 * materials carrying the deprecated `batchReviewState = "PENDING_REVIEW"`
 * value into the new `"ARCHIVED" + sessionOutcome = "AUTO_REPLACED"`
 * shape. PENDING_REVIEW was used by the old batch-review modal flow,
 * which has been deleted — any material still carrying it would never
 * be surfaced to the user.
 *
 * Why client-side: the curated state lives on per-material
 * `additionalData` and rides the standard sync push. Doing the rewrite
 * here means the sync layer naturally uploads the corrected state on
 * the next push — no server-side migration job needed, no Mongo
 * downtime, no parallel codepath in Dock.
 *
 * Idempotent + gated by a localStorage flag. Even when re-runs would
 * be no-ops (every material is already migrated), skipping the walk
 * keeps boot-time DOM-blocking work to a minimum on later sessions.
 */
class CuratedStudyMaterialMigration
{
    static #STORAGE_FLAG_KEY = "cogniumlearn-curated-pending-review-migrated-v2";
    static #LEGACY_PENDING_REVIEW_NAME = "PENDING_REVIEW";
    static #ARCHIVED_NAME              = "ARCHIVED";
    static #AUTO_REPLACED_OUTCOME_NAME = "AUTO_REPLACED";

    static async runIfNeeded()
    {
        if (CuratedStudyMaterialMigration.#hasRun())
        {
            return;
        }

        const rootDeck = Deck.getRoot();
        if (!rootDeck)
        {
            return;
        }

        // Must pass bIncludeCurated=true — Deck.getStudyMaterials
        // excludes curated materials by default, but the legacy
        // PENDING_REVIEW state we are migrating lives exclusively on
        // curated materials.
        const allMaterials = rootDeck.getStudyMaterials(true, true);
        const decksTouched = new Set();
        let rewriteCount = 0;

        for (const material of allMaterials)
        {
            const additionalData = material.getAdditionalData?.() || {};
            const currentReviewState = additionalData[CuratedStudyMaterialFields.BATCH_REVIEW_STATE];
            if (currentReviewState !== CuratedStudyMaterialMigration.#LEGACY_PENDING_REVIEW_NAME)
            {
                continue;
            }

            material.setAdditionalDataField(CuratedStudyMaterialFields.BATCH_REVIEW_STATE, CuratedStudyMaterialMigration.#ARCHIVED_NAME);
            material.setAdditionalDataField(CuratedStudyMaterialFields.SESSION_OUTCOME, CuratedStudyMaterialMigration.#AUTO_REPLACED_OUTCOME_NAME);
            rewriteCount += 1;

            const owningDeck = material.getDeck?.();
            if (owningDeck)
            {
                decksTouched.add(owningDeck);
            }
        }

        // Save each touched deck exactly once instead of once per
        // material — Deck.save() persists every entity hanging off the
        // deck, so per-material saves would N-square the work.
        let bAllSavesSucceeded = true;
        for (const touchedDeck of decksTouched)
        {
            try
            {
                await touchedDeck.save(false);
            }
            catch (saveError)
            {
                bAllSavesSucceeded = false;
                console.warn(`[CuratedStudyMaterialMigration] Failed to save deck ${touchedDeck.getId?.() || "(unknown)"} after migration:`, saveError);
            }
        }

        // Only mark the migration as done when every save succeeded.
        // If a save failed, the in-memory rewrite landed but the disk
        // copy still carries PENDING_REVIEW; we want the next boot to
        // retry instead of silently skipping the leftover materials.
        if (bAllSavesSucceeded)
        {
            CuratedStudyMaterialMigration.#markRun();
        }

        if (rewriteCount > 0)
        {
            console.info(`[CuratedStudyMaterialMigration] Rewrote ${rewriteCount} PENDING_REVIEW material(s) to ARCHIVED + AUTO_REPLACED${bAllSavesSucceeded ? "" : " (some saves failed — migration will retry on next boot)"}.`);
        }
    }

    static #hasRun()
    {
        try
        {
            return window.localStorage.getItem(CuratedStudyMaterialMigration.#STORAGE_FLAG_KEY) === "1";
        }
        catch (storageError)
        {
            return false;
        }
    }

    static #markRun()
    {
        try
        {
            window.localStorage.setItem(CuratedStudyMaterialMigration.#STORAGE_FLAG_KEY, "1");
        }
        catch (storageError)
        {
            // localStorage unavailable — migration will harmlessly try
            // again on the next session, finding no PENDING_REVIEW
            // materials left.
        }
    }
}

export default CuratedStudyMaterialMigration;
