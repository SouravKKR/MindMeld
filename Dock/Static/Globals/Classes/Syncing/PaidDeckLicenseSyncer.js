import PaidDeckRegistry from "../PaidDeckRegistry.js";
import PaidDeckCryptoManager from "../Crypto/PaidDeckCryptoManager.js";
import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import SyncEvents from "../../Events/SyncEvents.js";

/**
 * PaidDeckLicenseSyncer
 *
 * Pulls deck-license updates from /Sync/Licenses on every successful
 * regular sync, updates the in-memory PaidDeckRegistry, and feeds each
 * fresh wrappedKeyBlob into PaidDeckCryptoManager so the keys on this
 * device stay in lockstep with the latest server rotation.
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
            PaidDeckRegistry.initialize();
        });

        window.addEventListener(SyncEvents.COMPLETED, () =>
        {
            PaidDeckLicenseSyncer.pullLicenses().catch((pullError) =>
            {
                console.warn("[PaidDeckLicenseSyncer] License pull failed:", pullError);
            });
        });
    }

    static async pullLicenses()
    {
        await PaidDeckRegistry.initialize();
        const sinceTimestamp = PaidDeckRegistry.getLastSyncTimestamp();

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

        for (const license of licenses)
        {
            await PaidDeckCryptoManager.applyLicenseUpdate(license);
        }
    }
}

export default PaidDeckLicenseSyncer;
