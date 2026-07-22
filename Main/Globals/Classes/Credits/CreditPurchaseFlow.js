import DialogBox from "../../../CommonComponents/DialogBox.js";
import ProgressDialog from "../../../CommonComponents/ProgressDialog.js";
import CreditPurchaseDialog from "./CreditPurchaseDialog.js";
import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import RegionMetadata from "../RegionMetadata.js";
import SoundEffects from "../SoundEffects.js";
import PaymentCheckout from "../Payments/PaymentCheckout.js";

/**
 * CreditPurchaseFlow
 *
 * Buyer-side flow for purchasing credits, mirroring PaidDeckPurchaseFlow's
 * checkout handling: quote (Options) → pick quantity (CreditPurchaseDialog)
 * → Initiate (server-priced order) → provider checkout → Verify → refresh the
 * cached user so the new balance shows everywhere immediately. The server
 * selects the payment provider and returns its enum in the initiate response;
 * PaymentCheckout opens the matching widget (Razorpay today).
 *
 * Returns true when credits were granted, false on cancellation or failure.
 * A payment captured without a successful Verify (closed tab, network drop)
 * is still completed server-side by the provider webhook — the balance then
 * appears on the next Settings refresh.
 */
class CreditPurchaseFlow
{
    static async run()
    {
        const localeRegionHint = RegionMetadata.guessRegionFromLocale() || "";

        let optionsResponse;
        try
        {
            optionsResponse = await fetch(`/Credits/Purchase/Options?localeRegionHint=${encodeURIComponent(localeRegionHint)}`);
        }
        catch (optionsError)
        {
            await DialogBox.alert("Error", `Network error: ${optionsError.message}`);
            return false;
        }

        if (!optionsResponse.ok)
        {
            const errorJson = await optionsResponse.json().catch(() => ({}));
            await DialogBox.alert("Buy Credits", errorJson.error || `HTTP ${optionsResponse.status}`);
            return false;
        }

        const options = await optionsResponse.json();
        const selection = await CreditPurchaseDialog.show(options);

        if (!selection)
        {
            return false;
        }

        let initiateResponse;
        try
        {
            initiateResponse = await fetch("/Credits/Purchase/Initiate",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    credits: selection.credits,
                    localeRegionHint: localeRegionHint
                })
            });
        }
        catch (initiateError)
        {
            await DialogBox.alert("Error", `Network error: ${initiateError.message}`);
            return false;
        }

        if (!initiateResponse.ok)
        {
            const errorJson = await initiateResponse.json().catch(() => ({}));
            await DialogBox.alert("Purchase failed", CreditPurchaseFlow.#describeInitiateError(errorJson, initiateResponse.status));
            return false;
        }

        const initiateJson = await initiateResponse.json();
        return await CreditPurchaseFlow.#openPaymentCheckout(initiateJson);
    }

    static #describeInitiateError(errorJson, httpStatus)
    {
        const errorCode = errorJson?.error || "";

        if (errorCode === "CREDIT_PRICING_NOT_CONFIGURED")
        {
            return "Credit purchases aren't available yet. Please check back later.";
        }
        if (errorCode === "BELOW_MINIMUM_PURCHASE")
        {
            return `The minimum purchase is ${errorJson.minimumPurchaseCredits} credits.`;
        }
        if (errorCode === "AMOUNT_BELOW_PROVIDER_MINIMUM")
        {
            return `That amount is too small to charge. Please buy at least ${errorJson.minimumCreditsForCharge} credits.`;
        }
        if (errorCode === "PAYMENT_PROVIDER_NOT_CONFIGURED")
        {
            return "Payments are unavailable right now. Please try again later.";
        }
        return errorCode || `HTTP ${httpStatus}`;
    }

    static async #openPaymentCheckout(initiateResponse)
    {
        const order = initiateResponse.order;
        const checkoutContext = order.checkoutContext;
        const quotedCredits = initiateResponse.quote?.credits ?? 0;

        let checkoutResult;
        try
        {
            checkoutResult = await PaymentCheckout.open(initiateResponse.provider, checkoutContext, { description: `${quotedCredits} CogniumLearn credits` });
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

        const verifyResponse = await CreditPurchaseFlow.#runWithProgress
        (
            "Adding your credits",
            "Confirming your payment…",
            () => fetch("/Credits/Purchase/Verify",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    providerOrderId: checkoutResult.providerOrderId,
                    providerPaymentId: checkoutResult.providerPaymentId,
                    signature: checkoutResult.signature,
                    paymentProvider: initiateResponse.provider
                })
            })
        );

        if (verifyResponse.ok)
        {
            const verifyJson = await verifyResponse.json().catch(() => ({}));

            SoundEffects.playPurchaseSuccess();

            // Pull the fresh user so the new balance shows in Settings, the
            // profile component and every other consumer of window["user"]
            // immediately.
            await AuthenticationEvents.refreshUserFromServer();

            const balanceSuffix = typeof verifyJson.balance === "number"
                ? ` New balance: ${Math.round(verifyJson.balance * 100) / 100} credits.`
                : "";
            await DialogBox.alert("Purchase complete", `${verifyJson.creditsGranted ?? quotedCredits} credits added.${balanceSuffix}`);
            return true;
        }

        const verifyJson = await verifyResponse.json().catch(() => ({}));
        await DialogBox.alert
        (
            "Verification failed",
            `${verifyJson.error || `HTTP ${verifyResponse.status}`} — if you were charged, your credits will still arrive automatically within a few minutes.`
        );
        return false;
    }

    /**
     * Runs an async step behind a progress bar. There is no server-side
     * streaming, so the bar eases smoothly toward 90% while the request is in
     * flight and snaps to 100% when it resolves.
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
}

export default CreditPurchaseFlow;
