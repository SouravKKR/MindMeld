const { notificationTypes } = require("../../Enumerations/NotificationTypes");

/**
 * Central catalogue of notification message content. Every wired trigger builds
 * its {type, title, body, data} here rather than inlining copy at the call
 * site, so wording stays consistent and editable in one place. The caller still
 * chooses the delivery channels (the bitwise NotificationChannels flags) at the
 * call site — this class only owns the content + type.
 *
 * `data` is a string map echoed to the client and into the FCM payload for
 * deep-linking (values are coerced to strings by FirebaseMessagingClient).
 */
class NotificationContent
{
    // ── Generation ───────────────────────────────────────────────────────────
    static generationComplete(deckId)
    {
        return {
            type: notificationTypes.GENERATION_COMPLETE,
            title: "Your study set is ready",
            body: "Your generated flashcards and study materials are ready to review.",
            data: { deckId: deckId ?? "", target: "deck" }
        };
    }

    static deckAnalysisComplete(deckId)
    {
        return {
            type: notificationTypes.GENERATION_COMPLETE,
            title: "New study material is ready",
            body: "Your deck analysis finished and fresh curated study material is waiting for you.",
            data: { deckId: deckId ?? "", target: "deck" }
        };
    }

    // ── Purchases ────────────────────────────────────────────────────────────
    static deckPurchaseComplete(deckCount)
    {
        const count = Number.isInteger(deckCount) && deckCount > 0 ? deckCount : 1;
        const noun = count === 1 ? "deck is" : "decks are";
        return {
            type: notificationTypes.PURCHASE,
            title: "Purchase complete",
            body: `Your ${count === 1 ? "" : count + " "}${noun} unlocked and ready to study.`,
            data: { target: "library", deckCount: count }
        };
    }

    // ── Credits ──────────────────────────────────────────────────────────────
    static creditTopUpComplete(creditsGranted, balanceAfter)
    {
        return {
            type: notificationTypes.CREDITS,
            title: "Credits added",
            body: `${creditsGranted} credits were added to your account.`,
            data: { target: "credits", creditsGranted: creditsGranted ?? 0, balanceAfter: balanceAfter ?? 0 }
        };
    }

    static creditsGrantedByAdmin(creditsGranted)
    {
        return {
            type: notificationTypes.CREDITS,
            title: "Credits added",
            body: `You received ${creditsGranted} credits.`,
            data: { target: "credits", creditsGranted: creditsGranted ?? 0 }
        };
    }

    static recurringCreditsGranted(creditsGranted)
    {
        return {
            type: notificationTypes.CREDITS,
            title: "Your recurring credits arrived",
            body: `${creditsGranted} credits were added as part of your ongoing allowance.`,
            data: { target: "credits", creditsGranted: creditsGranted ?? 0 }
        };
    }

    static signupCreditsGranted(creditsGranted)
    {
        return {
            type: notificationTypes.CREDITS,
            title: "Welcome to CogniumLearn",
            body: `We've added ${creditsGranted} credits to get you started. Happy studying!`,
            data: { target: "credits", creditsGranted: creditsGranted ?? 0 }
        };
    }

    static outOfCredits(context)
    {
        return {
            type: notificationTypes.CREDITS,
            title: "You're out of credits",
            body: "You ran out of credits before this could finish. Top up to resume where you left off.",
            data: { target: "credits", context: context ?? "" }
        };
    }

    // ── Security ─────────────────────────────────────────────────────────────
    static newDeviceSignIn(deviceName)
    {
        const label = (typeof deviceName === "string" && deviceName.trim().length > 0) ? deviceName.trim() : "a new device";
        return {
            type: notificationTypes.SECURITY,
            title: "New sign-in",
            body: `Your account was just signed in on ${label}. If this wasn't you, review your devices.`,
            data: { target: "devices", deviceName: label }
        };
    }

    // ── Subscription ─────────────────────────────────────────────────────────
    static subscriptionActivated()
    {
        return {
            type: notificationTypes.SUBSCRIPTION,
            title: "Subscription active",
            body: "Your subscription is active — enjoy your plan benefits.",
            data: { target: "subscription" }
        };
    }

    static subscriptionRenewed()
    {
        return {
            type: notificationTypes.SUBSCRIPTION,
            title: "Subscription renewed",
            body: "Your subscription renewed and this cycle's credits have been added.",
            data: { target: "subscription" }
        };
    }

    static subscriptionPaymentPending()
    {
        return {
            type: notificationTypes.SUBSCRIPTION,
            title: "Payment issue",
            body: "We couldn't process your subscription payment. We'll retry — please check your payment method to avoid losing access.",
            data: { target: "subscription" }
        };
    }

    static subscriptionHalted()
    {
        return {
            type: notificationTypes.SUBSCRIPTION,
            title: "Subscription payment failed",
            body: "Your subscription payment failed after several retries. Update your payment method to keep your plan.",
            data: { target: "subscription" }
        };
    }

    static subscriptionCancelled()
    {
        return {
            type: notificationTypes.SUBSCRIPTION,
            title: "Subscription cancelled",
            body: "Your subscription has been cancelled. You'll keep access until the end of the current period.",
            data: { target: "subscription" }
        };
    }

    static subscriptionCompleted()
    {
        return {
            type: notificationTypes.SUBSCRIPTION,
            title: "Subscription ended",
            body: "Your subscription has reached its final cycle and is now complete.",
            data: { target: "subscription" }
        };
    }

    // ── Organization ─────────────────────────────────────────────────────────
    static addedToOrganization(organizationName)
    {
        const label = (typeof organizationName === "string" && organizationName.trim().length > 0) ? organizationName.trim() : "an organization";
        return {
            type: notificationTypes.ORGANIZATION,
            title: "You've joined an organization",
            body: `You were added to ${label} on CogniumLearn.`,
            data: { target: "organization", organizationName: label }
        };
    }
}

module.exports = NotificationContent;
