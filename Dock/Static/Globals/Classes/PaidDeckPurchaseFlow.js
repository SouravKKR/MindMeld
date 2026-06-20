import DialogBox from "../../CommonComponents/DialogBox.js";
import ProgressDialog from "../../CommonComponents/ProgressDialog.js";
import PaidDeckPasswordPrompt from "./PaidDeckPasswordPrompt.js";
import PaidDeckLicenseSyncer from "./Syncing/PaidDeckLicenseSyncer.js";
import ZohoPaymentsCheckout from "./Payments/ZohoPaymentsCheckout.js";
import { paymentProviders } from "../Enumerations/PaymentProviders.js";

/**
 * PaidDeckPurchaseFlow
 *
 * Shared buyer-side purchase flow extracted from PaidDeckLibraryPage
 * so both the library card and the details page can initiate a
 * purchase with identical Zoho Payments checkout handling. Returns true
 * when the deck is successfully acquired (paid or zero-cost grant),
 * false on cancellation or failure.
 */
class PaidDeckPurchaseFlow
{
    static async run(deck, region)
    {
        if (!deck)
        {
            return false;
        }

        let initiateResponse;
        try
        {
            // For a free / fully-discounted deck the server seeds the buyer's
            // encrypted copy inside this request, which can take a while for a
            // large deck — show a progress bar over it.
            initiateResponse = await PaidDeckPurchaseFlow.#runWithProgress
            (
                "Preparing your library",
                "Setting things up…",
                () => fetch("/PaidDecks/Purchase/Initiate",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        deckIds: [deck.id],
                        region: region,
                        paymentProvider: paymentProviders.ZOHO
                    })
                })
            );
        }
        catch (initiateError)
        {
            await DialogBox.alert("Error", `Network error: ${initiateError.message}`);
            return false;
        }

        if (!initiateResponse.ok)
        {
            const responseJson = await initiateResponse.json().catch(() => ({}));
            await DialogBox.alert("Purchase failed", responseJson.error || `HTTP ${initiateResponse.status}`);
            return false;
        }

        const responseJson = await initiateResponse.json();

        if (responseJson.requiresPayment === false)
        {
            if (responseJson.requiresPasswordSetup)
            {
                await PaidDeckPurchaseFlow.#promptPasswordSetup();
            }
            await PaidDeckPurchaseFlow.#refreshLibraryAfterPurchase();
            await DialogBox.alert("Acquired", "This deck has been added to your library. You'll find it on your home page.");
            return true;
        }

        return await PaidDeckPurchaseFlow.#openPaymentCheckout(deck, responseJson, region);
    }

    static async #openPaymentCheckout(deck, initiateResponse, region)
    {
        const order = initiateResponse.order;
        const checkoutContext = order.checkoutContext;

        let checkoutResult;
        try
        {
            checkoutResult = await ZohoPaymentsCheckout.open(checkoutContext, { description: deck.title });
        }
        catch (checkoutError)
        {
            await DialogBox.alert("Checkout error", checkoutError.message || String(checkoutError));
            return false;
        }

        // Buyer dismissed the widget without paying.
        if (!checkoutResult)
        {
            return false;
        }

        // The server seeds the buyer's encrypted copy inside Verify — show a
        // progress bar over that "move to your library".
        const verifyResponse = await PaidDeckPurchaseFlow.#runWithProgress
        (
            "Adding to your library",
            "Finalising your copy…",
            () => fetch("/PaidDecks/Purchase/Verify",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    providerOrderId: checkoutResult.providerOrderId,
                    providerPaymentId: checkoutResult.providerPaymentId,
                    signature: checkoutResult.signature,
                    paymentProvider: initiateResponse.provider,
                    deckIds: [deck.id],
                    region: region,
                    amountMinor: order.amountMinor,
                    currency: order.currency
                })
            })
        );

        if (verifyResponse.ok)
        {
            const verifyResultJson = await verifyResponse.json().catch(() => ({}));
            if (verifyResultJson?.requiresPasswordSetup)
            {
                await PaidDeckPurchaseFlow.#promptPasswordSetup();
            }
            await PaidDeckPurchaseFlow.#refreshLibraryAfterPurchase();
            await DialogBox.alert("Purchase complete", "Your deck has been added to your library. You'll find it on your home page.");
            return true;
        }

        const verifyJson = await verifyResponse.json().catch(() => ({}));
        await DialogBox.alert("Verification failed", verifyJson.error || `HTTP ${verifyResponse.status}`);
        return false;
    }

    /**
     * Runs an async step (the seeding round-trip) behind a progress bar. There
     * is no server-side streaming, so the bar eases smoothly toward 90% while
     * the request is in flight and snaps to 100% when it resolves — enough to
     * show the user the deck is being copied into their account, not frozen.
     */
    static async #runWithProgress(title, statusText, performRequest)
    {
        const progressDialog = ProgressDialog.show(title);
        let progressFraction = 0.06;
        progressDialog.setProgress(progressFraction, statusText);

        const intervalId = setInterval(() =>
        {
            progressFraction = progressFraction + (0.9 - progressFraction) * 0.1;
            progressDialog.setProgress(Math.min(progressFraction, 0.9), statusText);
        }, 350);

        try
        {
            return await performRequest();
        }
        finally
        {
            clearInterval(intervalId);
            try
            {
                progressDialog.setProgress(1, "Done");
            }
            catch (ignoredError)
            {
                // Dialog already gone — nothing to update.
            }
            progressDialog.close();
        }
    }

    /**
     * After a successful acquisition, pull the freshly-issued license so the
     * registry + crypto keys update and PaidDeckLibraryPresenter materialises
     * the home-page tile — making the deck appear without waiting for the next
     * background sync or a reload.
     */
    static async #refreshLibraryAfterPurchase()
    {
        try
        {
            await PaidDeckLicenseSyncer.pullLicenses();
        }
        catch (refreshError)
        {
            console.warn("[PaidDeckPurchaseFlow] Post-purchase library refresh failed:", refreshError);
        }
    }

    /**
     * Walks the buyer through a one-time paid-deck password setup
     * after their first purchase. The password derives the KEK that
     * wraps every owned deck's content key — without it the server
     * refuses to deliver content. Skipping for now is allowed (the
     * buyer can come back later) but they won't be able to study
     * until they set one.
     */
    static async #promptPasswordSetup()
    {
        const setupResult = await PaidDeckPasswordPrompt.showSetupPrompt();
        if (!setupResult.confirmed)
        {
            return;
        }

        try
        {
            const setupResponse = await fetch("/PaidDecks/SetPassword",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: setupResult.password })
            });

            if (!setupResponse.ok)
            {
                const errorJson = await setupResponse.json().catch(() => ({}));
                await DialogBox.alert("Password setup failed", errorJson.error || `HTTP ${setupResponse.status}`);
            }
        }
        catch (setupError)
        {
            await DialogBox.alert("Password setup failed", setupError.message);
        }
    }
}

export default PaidDeckPurchaseFlow;
