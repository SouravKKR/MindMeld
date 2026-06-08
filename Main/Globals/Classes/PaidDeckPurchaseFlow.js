import DialogBox from "../../CommonComponents/DialogBox.js";
import PaidDeckPasswordPrompt from "./PaidDeckPasswordPrompt.js";
import { paymentProviders } from "../Enumerations/PaymentProviders.js";

/**
 * PaidDeckPurchaseFlow
 *
 * Shared buyer-side purchase flow extracted from PaidDeckLibraryPage
 * so both the library card and the details page can initiate a
 * purchase with identical Razorpay checkout handling. Returns true
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
            initiateResponse = await fetch("/PaidDecks/Purchase/Initiate",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    deckIds: [deck.id],
                    region: region,
                    paymentProvider: paymentProviders.RAZORPAY
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
            const responseJson = await initiateResponse.json().catch(() => ({}));
            await DialogBox.alert("Purchase failed", responseJson.error || `HTTP ${initiateResponse.status}`);
            return false;
        }

        const responseJson = await initiateResponse.json();

        if (responseJson.requiresPayment === false)
        {
            await DialogBox.alert("Acquired", "This deck has been added to your library.");
            return true;
        }

        return await PaidDeckPurchaseFlow.#openPaymentCheckout(deck, responseJson, region);
    }

    static async #openPaymentCheckout(deck, initiateResponse, region)
    {
        const order = initiateResponse.order;
        const checkoutContext = order.checkoutContext;

        if (!window.Razorpay)
        {
            await DialogBox.alert
            (
                "Razorpay SDK missing",
                "The Razorpay checkout script is not loaded. Include https://checkout.razorpay.com/v1/checkout.js in your HTML."
            );
            return false;
        }

        return await new Promise((resolve) =>
        {
            const options =
            {
                key: checkoutContext.keyId,
                amount: checkoutContext.amount,
                currency: checkoutContext.currency,
                order_id: checkoutContext.orderId,
                name: "MindMeld",
                description: deck.title,
                handler: async (razorpayResponse) =>
                {
                    const verifyResponse = await fetch("/PaidDecks/Purchase/Verify",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify
                        ({
                            providerOrderId: razorpayResponse.razorpay_order_id,
                            providerPaymentId: razorpayResponse.razorpay_payment_id,
                            signature: razorpayResponse.razorpay_signature,
                            paymentProvider: initiateResponse.provider,
                            deckIds: [deck.id],
                            region: region,
                            amountMinor: order.amountMinor,
                            currency: order.currency
                        })
                    });

                    if (verifyResponse.ok)
                    {
                        const verifyResultJson = await verifyResponse.json().catch(() => ({}));
                        if (verifyResultJson?.requiresPasswordSetup)
                        {
                            await PaidDeckPurchaseFlow.#promptPasswordSetup();
                        }
                        await DialogBox.alert("Purchase complete", "Your deck has been added to your library.");
                        resolve(true);
                    }
                    else
                    {
                        const verifyJson = await verifyResponse.json().catch(() => ({}));
                        await DialogBox.alert("Verification failed", verifyJson.error || `HTTP ${verifyResponse.status}`);
                        resolve(false);
                    }
                },
                modal:
                {
                    ondismiss: () => resolve(false)
                }
            };

            const razorpayInstance = new window.Razorpay(options);
            razorpayInstance.open();
        });
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
