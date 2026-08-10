import DialogBox from "../../CommonComponents/DialogBox.js";
import ProgressDialog from "../../CommonComponents/ProgressDialog.js";
import PaidDeckPasswordSetup from "./PaidDeckPasswordSetup.js";
import PaidDeckLicenseSyncer from "./Syncing/PaidDeckLicenseSyncer.js";
import PaidDeckSession from "./Crypto/PaidDeckSession.js";
import SyncManager from "./SyncManager.js";
import PaymentCheckout from "./Payments/PaymentCheckout.js";
import TutorialEngine from "./TutorialEngine.js";
import TutorialSampleDeckBuilder from "./Tutorials/TutorialSampleDeckBuilder.js";
import UserIdentityManager from "./UserIdentityManager.js";
import ErrorCodes from "../Constants/ErrorCodes.js";

/**
 * PaidDeckPurchaseFlow
 *
 * Shared buyer-side purchase flow extracted from PaidDeckLibraryPage
 * so both the library card and the details page can initiate a
 * purchase with identical checkout handling. The server selects the payment
 * provider and returns its enum in the initiate response; PaymentCheckout
 * opens the matching widget (Razorpay today). Returns true when the deck is
 * successfully acquired (paid or zero-cost grant), false on cancellation or
 * failure.
 */
class PaidDeckPurchaseFlow
{
    // Declared before the map below, which reads it: static fields initialise in
    // declaration order, so the other way round would put `undefined` in the map.
    static SIMULATED_VIEW_MESSAGE =
        "You're viewing the app as a different plan. Purchases are real money and a real licence, "
        + "so they can't be made from a simulated view — switch back to viewing as yourself first.";

    // Server error codes that deserve a sentence a buyer can act on instead of
    // the raw token. Anything not listed still falls back to the code itself,
    // which is what support needs for the rarer failures.
    static BUYER_FACING_ERROR_MESSAGES =
    {
        [ErrorCodes.PRICING_DURATION_NOT_CONFIGURED]: "This deck isn't available to acquire just yet — its access terms haven't been published. Please try again later.",
        [ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED]: "Payments are temporarily unavailable. Please try again later.",
        [ErrorCodes.ALREADY_OWNED]: "You already own this deck — it's on your home page.",
        [ErrorCodes.SIMULATED_VIEW_NOT_PURCHASABLE]: PaidDeckPurchaseFlow.SIMULATED_VIEW_MESSAGE
    };

    static async run(deck, region)
    {
        if (!deck)
        {
            return false;
        }

        // Refused here as well as on the server, because a buyer who clicks Buy
        // and gets a payment sheet before being told no has already been asked
        // for money that could not have been taken. The server refusal is the
        // control; this is the courtesy.
        if (UserIdentityManager.isPlanViewContext())
        {
            await DialogBox.alert("Not available in this view", PaidDeckPurchaseFlow.SIMULATED_VIEW_MESSAGE);
            return false;
        }

        // Tutorial demo: never initiate a real order, open provider checkout, or
        // call the server. Silently drop a flagged local sample copy onto the
        // home page and report success — no alert (it would sit buried behind
        // the tutorial overlay); the tutorial's own copy explains what happened.
        if (TutorialEngine.isRunning())
        {
            await TutorialSampleDeckBuilder.createPurchasedSampleForUser(deck.title);
            return true;
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
                        region: region
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
            await DialogBox.alert("Purchase failed", PaidDeckPurchaseFlow.#describeError(responseJson.error, initiateResponse.status));
            return false;
        }

        const responseJson = await initiateResponse.json();

        if (responseJson.requiresPayment === false)
        {
            if (responseJson.requiresPasswordSetup)
            {
                const setupOutcome = await PaidDeckPurchaseFlow.#promptPasswordSetup();
                if (setupOutcome.setupSucceeded)
                {
                    await PaidDeckSession.unlock(deck.id, setupOutcome.password).catch(() => {});
                }
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
            checkoutResult = await PaymentCheckout.open(initiateResponse.provider, checkoutContext, { description: deck.title });
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
                const setupOutcome = await PaidDeckPurchaseFlow.#promptPasswordSetup();
                if (setupOutcome.setupSucceeded)
                {
                    await PaidDeckSession.unlock(deck.id, setupOutcome.password).catch(() => {});
                }
            }
            await PaidDeckPurchaseFlow.#refreshLibraryAfterPurchase();
            await DialogBox.alert("Purchase complete", "Your deck has been added to your library. You'll find it on your home page.");
            return true;
        }

        const verifyJson = await verifyResponse.json().catch(() => ({}));
        await DialogBox.alert("Verification failed", PaidDeckPurchaseFlow.#describeError(verifyJson.error, verifyResponse.status));
        return false;
    }

    /**
     * Turns a server error code into the sentence shown in the failure dialog.
     * Known codes get buyer-facing copy; anything else keeps the raw code (or the
     * HTTP status when the body carried none) so support can still identify it.
     */
    static #describeError(errorCode, statusCode)
    {
        if (typeof errorCode === "string" && PaidDeckPurchaseFlow.BUYER_FACING_ERROR_MESSAGES[errorCode])
        {
            return PaidDeckPurchaseFlow.BUYER_FACING_ERROR_MESSAGES[errorCode];
        }

        return errorCode || `HTTP ${statusCode}`;
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
     * the home-page tile — then immediately kick off a content sync so the
     * purchased deck's cards appear without waiting for the next background
     * sync cycle.
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

        SyncManager.sync().catch((syncError) =>
        {
            console.warn("[PaidDeckPurchaseFlow] Post-purchase content sync failed:", syncError);
        });
    }

    /**
     * Walks the buyer through the one-time paid-deck password setup after their
     * first purchase. The password derives the KEK that wraps every owned
     * deck's content key — without it the server refuses to deliver content, so
     * the prompt cannot be dismissed and this returns only once a password has
     * been chosen.
     *
     * Returns { setupSucceeded, password } so the caller can pre-unlock the
     * PaidDeckSession immediately — eliminating the second password prompt when
     * the user first opens the deck.
     */
    static async #promptPasswordSetup()
    {
        const setupResult = await PaidDeckPasswordSetup.run();
        return { setupSucceeded: setupResult.succeeded, password: setupResult.password };
    }
}

export default PaidDeckPurchaseFlow;
