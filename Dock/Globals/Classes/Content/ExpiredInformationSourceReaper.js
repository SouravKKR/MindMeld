const InformationSourceQueryEngine = require("../Database/InformationSourceQueryEngine");
const ReferencedProofSourceHashes = require("./ReferencedProofSourceHashes");
const DerivedContentQueryEngine = require("../Database/DerivedContentQueryEngine");
const DerivedContentPurger = require("./DerivedContentPurger");
const InformationSourcePurger = require("./InformationSourcePurger");
const SourceRetentionPolicy = require("./SourceRetentionPolicy");
const EphemeralUploadRegistry = require("./EphemeralUploadRegistry");

/**
 * ExpiredInformationSourceReaper — enforces the document retention promise.
 *
 * SourceRetentionPolicy decides WHAT is due; this class is the thing that
 * actually runs, and that separation is the point. A retention rule that exists
 * only as a field is not retention: this codebase previously carried a TEMPORARY
 * mode for a long time with nothing consuming it, so a source marked temporary
 * was kept forever AND billed as free. The rule and the job that applies it have
 * to ship together.
 *
 * Why a reaper and not a Mongo TTL index. A TTL index would drop the
 * information-source ROW and nothing else, leaving the object-storage blob and
 * the derived byproducts (embedding chunks, cached figures) behind forever — the
 * row is the only thing recording where the blob lives, so once it is gone the
 * content is both unreachable and unremovable. Deletion has to run the full
 * cascade in InformationSourcePurger.
 *
 * Sweeps are bounded per tick and idempotent: the purger deletes the row first,
 * so a crash mid-cascade cannot reap the same row twice, and the orphan pass
 * below reclaims anything the interrupted cascade left. A policy lookup that
 * throws skips that user rather than defaulting to deletion — the failure mode
 * of a retention job must be "keep", never "delete". Mirrors the
 * LogArchivalScheduler interval-loop / single-runner pattern.
 */
class ExpiredInformationSourceReaper
{
    static #TICK_INTERVAL_MILLISECONDS = 60 * 60 * 1000;
    static #INITIAL_DELAY_MILLISECONDS = 90 * 1000;
    static #USER_BATCH_SIZE = 200;
    static #ORPHAN_INSPECTION_LIMIT = 500;
    static #EPHEMERAL_SWEEP_LIMIT = 500;
    static #FIGURE_OBJECT_INSPECTION_LIMIT = 2000;

    static #intervalHandle = null;
    static #bRunning = false;

    // Where the last figure-object sweep stopped. Held in memory only: the sweep
    // is idempotent, so a restart costs one re-scan of the head of the prefix
    // rather than correctness, and that is not worth a collection.
    static #figureSweepStartAfterPath = null;

    static start()
    {
        if (ExpiredInformationSourceReaper.#intervalHandle !== null)
        {
            return;
        }

        ExpiredInformationSourceReaper.#intervalHandle = setInterval(
            () => { ExpiredInformationSourceReaper.#tick(); },
            ExpiredInformationSourceReaper.#TICK_INTERVAL_MILLISECONDS,
        );
        if (typeof ExpiredInformationSourceReaper.#intervalHandle.unref === "function")
        {
            ExpiredInformationSourceReaper.#intervalHandle.unref();
        }

        // One deferred sweep shortly after boot, once the database has settled.
        const initialTimer = setTimeout(
            () => { ExpiredInformationSourceReaper.#tick(); },
            ExpiredInformationSourceReaper.#INITIAL_DELAY_MILLISECONDS,
        );
        if (typeof initialTimer.unref === "function")
        {
            initialTimer.unref();
        }
    }

    static async #tick()
    {
        if (ExpiredInformationSourceReaper.#bRunning)
        {
            return;
        }
        ExpiredInformationSourceReaper.#bRunning = true;

        try
        {
            // Sweep per user, because the retention rule is a property of the
            // account rather than of the row: a subscriber keeps everything, a
            // lapsed account loses everything once its grace elapses, and a
            // free account ages each upload out individually. Resolving the
            // policy once per user also keeps the subscription lookups bounded
            // by user count rather than by source count.
            const candidateUserIds = await InformationSourceQueryEngine.getUserIdsWithSources(
                ExpiredInformationSourceReaper.#USER_BATCH_SIZE,
            );

            const nowMilliseconds = Date.now();
            let reapedCount = 0;
            let embeddingChunksRemoved = 0;
            let figuresRemoved = 0;
            let retainedUserCount = 0;

            for (const candidateUserId of candidateUserIds)
            {
                let policy;
                try
                {
                    policy = await SourceRetentionPolicy.resolveForUser(candidateUserId, nowMilliseconds);
                }
                catch (policyError)
                {
                    // Failing to resolve a policy must never be read as "delete".
                    // Skip the user and retry next tick.
                    console.warn(`[ExpiredInformationSourceReaper] Could not resolve retention for ${candidateUserId} (skipping): ${policyError?.message || policyError}`);
                    continue;
                }

                // Sources this user has cited as a licensing basis — either as
                // the reference a content refinement was made from, or as a
                // declared verification source for a paid deck. They outlive the
                // retention rules because the declaration that accompanied them
                // is only worth something while the document can still be
                // produced — and the rules above would otherwise delete them
                // exactly when a lapsed subscription makes the question most
                // likely to be asked. Resolved per user, in step with the
                // policy, so the lookup stays bounded the same way the
                // subscription lookups are.
                let referencedProofHashes;
                try
                {
                    referencedProofHashes = await ReferencedProofSourceHashes.findForUser(candidateUserId);
                }
                catch (holdLookupError)
                {
                    // Failing to load the holds must never be read as "no holds
                    // apply" — that would delete the proof this sweep is
                    // specifically not allowed to delete. Skip the user and
                    // retry next tick, exactly as a policy failure does.
                    console.warn(`[ExpiredInformationSourceReaper] Could not resolve licensing holds for ${candidateUserId} (skipping): ${holdLookupError?.message || holdLookupError}`);
                    continue;
                }

                const userSources = await InformationSourceQueryEngine.getInformationSourcesByUserId(candidateUserId);
                const dueSources = userSources.filter(userSource => SourceRetentionPolicy.isSourceDue(userSource, policy, nowMilliseconds, referencedProofHashes));

                if (dueSources.length === 0)
                {
                    retainedUserCount++;
                    continue;
                }

                for (const dueSource of dueSources)
                {
                    try
                    {
                        const purgeResult = await InformationSourcePurger.purgeSingleSource(dueSource);
                        reapedCount++;
                        embeddingChunksRemoved += purgeResult.embeddingChunksRemoved;
                        figuresRemoved += purgeResult.figuresRemoved;
                    }
                    catch (purgeError)
                    {
                        // One bad row must not stall the sweep — the next tick retries it.
                        console.warn(`[ExpiredInformationSourceReaper] Failed to reap ${dueSource.getId()}: ${purgeError?.message || purgeError}`);
                    }
                }
            }

            if (reapedCount > 0)
            {
                console.log(
                    `[ExpiredInformationSourceReaper] Reaped ${reapedCount} source(s) across ` +
                    `${candidateUserIds.length - retainedUserCount} account(s) — ` +
                    `${embeddingChunksRemoved} embedding chunk(s), ${figuresRemoved} figure(s) removed.`,
                );
            }
        }
        catch (sweepError)
        {
            console.error(`[ExpiredInformationSourceReaper] Sweep failed: ${sweepError?.message || sweepError}`);
        }

        try
        {
            await ExpiredInformationSourceReaper.#reconcileOrphanedDerivedContent();
        }
        catch (reconciliationError)
        {
            console.error(`[ExpiredInformationSourceReaper] Orphan reconciliation failed: ${reconciliationError?.message || reconciliationError}`);
        }

        try
        {
            await ExpiredInformationSourceReaper.#sweepExpiredEphemeralUploads();
        }
        catch (ephemeralSweepError)
        {
            console.error(`[ExpiredInformationSourceReaper] Ephemeral upload sweep failed: ${ephemeralSweepError?.message || ephemeralSweepError}`);
        }

        try
        {
            await ExpiredInformationSourceReaper.#sweepOrphanedFigureObjects();
        }
        catch (figureSweepError)
        {
            console.error(`[ExpiredInformationSourceReaper] Figure object sweep failed: ${figureSweepError?.message || figureSweepError}`);
        }
        finally
        {
            ExpiredInformationSourceReaper.#bRunning = false;
        }
    }

    /**
     * Deletes uploaded files that are not information sources once their
     * retention window has elapsed — scanned answer sheets and support-ticket
     * attachments.
     *
     * These ride this reaper rather than getting a scheduler each because the
     * job is identical in shape (bounded periodic sweep, single runner, failure
     * means retry-next-tick) and because a second interval loop over the same
     * database is cost with no benefit. What differs is only the source of
     * truth for "what is due", which EphemeralUploadRegistry owns.
     *
     * Each prefix is independent: one that fails to delete keeps its record and
     * is retried next tick, rather than stalling the ones behind it.
     */
    static async #sweepExpiredEphemeralUploads()
    {
        const dueRecords = await EphemeralUploadRegistry.findDue(
            Date.now(),
            ExpiredInformationSourceReaper.#EPHEMERAL_SWEEP_LIMIT,
        );

        if (dueRecords.length === 0)
        {
            return;
        }

        let purgedPrefixCount = 0;
        let removedObjectCount = 0;

        for (const dueRecord of dueRecords)
        {
            try
            {
                removedObjectCount += await EphemeralUploadRegistry.purgePrefix(dueRecord.storagePrefix);
                purgedPrefixCount++;
            }
            catch (purgeError)
            {
                console.warn(
                    `[ExpiredInformationSourceReaper] Failed to purge ephemeral upload ${dueRecord.storagePrefix}: ` +
                    `${purgeError?.message || purgeError}`,
                );
            }
        }

        console.log(
            `[ExpiredInformationSourceReaper] Purged ${purgedPrefixCount} expired ephemeral upload prefix(es) ` +
            `(${removedObjectCount} object(s) removed).`,
        );
    }

    /**
     * Removes page text and cached figures whose information-source row no
     * longer exists.
     *
     * These are the residue of removals that predate the delete cascade, or of
     * a cascade interrupted between the row delete and the purge. Without this
     * the extracted verbatim text of a deleted document persists indefinitely,
     * which would undercut both the TEMPORARY retention promise and any
     * erasure commitment.
     *
     * A hash is only a candidate when NO information-source row references it,
     * so live grounding data is never touched — an in-use source always has a
     * row. That is what makes this safe to run unattended.
     */
    static async #reconcileOrphanedDerivedContent()
    {
        const orphanedPairs = await DerivedContentQueryEngine.findOrphanedDerivedContent(
            ExpiredInformationSourceReaper.#ORPHAN_INSPECTION_LIMIT,
        );

        if (orphanedPairs.length === 0)
        {
            return;
        }

        let embeddingChunksRemoved = 0;
        let figuresRemoved = 0;
        let figureObjectsRemoved = 0;

        for (const orphanedPair of orphanedPairs)
        {
            const purgeCounts = await DerivedContentPurger.purgeForUserAndContentHash(orphanedPair.userId, orphanedPair.contentHash);
            embeddingChunksRemoved += purgeCounts.embeddingChunksRemoved;
            figuresRemoved += purgeCounts.figuresRemoved;
            figureObjectsRemoved += purgeCounts.figureObjectsRemoved;
        }

        console.log(
            `[ExpiredInformationSourceReaper] Reconciled ${orphanedPairs.length} orphaned (user, document) pair(s) — ` +
            `${embeddingChunksRemoved} embedding chunk(s), ${figuresRemoved} figure(s), ` +
            `${figureObjectsRemoved} figure object(s) removed.`,
        );
    }

    /**
     * Reclaims figure PNGs in object storage that no figure row points at.
     *
     * The pass above works from the rows outwards, so it can only reach objects
     * whose row survived long enough to name them. Everything written before the
     * cascade covered objects at all — and anything left by a cascade that died
     * between the row delete and the object delete — is invisible to it and
     * reachable only by listing the bucket. Without this sweep those crops of
     * uploaded textbooks stay indefinitely, which is the exact retention gap the
     * cascade was extended to close.
     *
     * DerivedContentPurger owns the safety rules (minimum object age, and a
     * last-reference check against the figure rows); this method owns only when
     * the sweep runs, how much it is allowed to look at, and where it resumes.
     *
     * The cursor is what makes a bounded sweep eventually exhaustive: each tick
     * continues after the previous tick's last key and wraps to the beginning
     * once the prefix runs out, so every object is reached rather than only the
     * first page of them.
     */
    static async #sweepOrphanedFigureObjects()
    {
        const sweepResult = await DerivedContentPurger.sweepOrphanedFigureObjects(
            ExpiredInformationSourceReaper.#FIGURE_OBJECT_INSPECTION_LIMIT,
            Date.now(),
            ExpiredInformationSourceReaper.#figureSweepStartAfterPath,
        );

        ExpiredInformationSourceReaper.#figureSweepStartAfterPath = sweepResult.nextStartAfterPath;

        if (sweepResult.figureObjectsRemoved === 0 && sweepResult.figureObjectsFailed === 0)
        {
            return;
        }

        console.log(
            `[ExpiredInformationSourceReaper] Swept ${sweepResult.inspectedCount} figure object(s) — ` +
            `${sweepResult.figureObjectsRemoved} orphan(s) removed, ${sweepResult.figureObjectsFailed} failed.`,
        );
    }
}

module.exports = ExpiredInformationSourceReaper;
