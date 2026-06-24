import PaidDeckRegistry from "../PaidDeckRegistry.js";
import PaidDeckStudyGate from "../PaidDeckStudyGate.js";
import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import SyncEvents from "../../Events/SyncEvents.js";

/**
 * PaidDeckLicenseSyncer
 *
 * Pulls deck-license updates from /Sync/Licenses on every successful
 * regular sync and updates the in-memory PaidDeckRegistry (which powers the
 * owner watermark + ownership checks). It does NOT touch content keys: in the
 * unified model the per-deck content key is unlocked once per session from the
 * paid-deck password via PaidDeckSession (in-memory only), and paid content
 * itself is delivered + encrypted through the regular /Sync pipeline.
 *
 * Independent of the main SyncOrchestrator state machine — runs as an
 * after-effect of SyncEvents.COMPLETED rather than threading through
 * the chunked push/pull protocol. Keeps the orchestrator unaware of
 * paid-deck specifics.
 */
class PaidDeckLicenseSyncer
{
    static #LICENSES_ENDPOINT = "/Sync/Licenses";
    static #installed = false;

    static install()
    {
        if (PaidDeckLicenseSyncer.#installed)
        {
            return;
        }
        PaidDeckLicenseSyncer.#installed = true;

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () =>
        {
            // Reconcile against the server's FULL license set on login (since=0),
            // not just the incremental delta. The incremental pull keys off
            // rotatedAt > lastSyncTimestamp, so a license that never re-rotated
            // after the client's timestamp advanced would never refresh — leaving
            // the registry stale (an owned deck wrongly showing "Buy"). A full
            // pull also delivers REVOKED/expired statuses so ownership flips off
            // when access lapses.
            PaidDeckRegistry.initialize().then(() =>
            {
                PaidDeckLicenseSyncer.pullLicenses(true).catch((pullError) =>
                {
                    console.warn("[PaidDeckLicenseSyncer] Login license reconciliation failed:", pullError);
                });
            });
        });

        window.addEventListener(SyncEvents.COMPLETED, () =>
        {
            PaidDeckLicenseSyncer.pullLicenses().catch((pullError) =>
            {
                console.warn("[PaidDeckLicenseSyncer] License pull failed:", pullError);
            });

            // Re-decrypt any paid deck cards that arrived encrypted from this
            // sync cycle while the session was already unlocked — prevents the
            // locked placeholder from appearing after a background sync replaces
            // Card objects mid-session.
            PaidDeckStudyGate.redecryptUnlockedDecks().catch((redecryptError) =>
            {
                console.warn("[PaidDeckLicenseSyncer] Background re-decrypt failed:", redecryptError);
            });
        });
    }

    /**
     * Pulls deck-license updates into PaidDeckRegistry. By default this is
     * incremental (rotatedAt > the registry's lastSyncTimestamp); pass
     * bForceFullReconcile = true to pull the entire license set (since=0),
     * used on login so a stale-but-unchanged license can never strand an
     * owned deck on the Buy screen.
     */
    static async pullLicenses(bForceFullReconcile = false)
    {
        await PaidDeckRegistry.initialize();
        const sinceTimestamp = bForceFullReconcile ? 0 : PaidDeckRegistry.getLastSyncTimestamp();

        let response = null;

        try
        {
            response = await fetch(PaidDeckLicenseSyncer.#LICENSES_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sinceTimestamp })
            });
        }
        catch (fetchError)
        {
            return;
        }

        if (!response.ok)
        {
            return;
        }

        const responseJson = await response.json();
        const licenses = Array.isArray(responseJson.licenses) ? responseJson.licenses : [];

        await PaidDeckRegistry.applyLicenseUpdates(licenses, responseJson.serverTimestamp);

        // No content-key handling here — the owned deck (and any license-driven
        // change) arrives through the regular /Sync pipeline as a normal deck.
    }
}

export default PaidDeckLicenseSyncer;
