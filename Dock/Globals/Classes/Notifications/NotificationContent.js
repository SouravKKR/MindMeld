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
    static DEFAULT_EMAIL_CALL_TO_ACTION_LABEL = "Open CogniumLearn";
    static DEFAULT_EMAIL_FOOTER_TEXT = "You're receiving this because you have a CogniumLearn account.";

    /**
     * Resolves the email payload for any notification.
     *
     * An entry that carries no `email` block still produces a sensible, fully
     * branded message built from its in-app title and body — requesting the
     * EMAIL channel must never silently send nothing, and the alternative
     * (every builder having to spell out an email block) would guarantee that
     * some future one forgets.
     *
     * @param {{title?: string, body?: string, email?: object}} notification
     * @returns {{subject: string, headingText: string, introText: string, highlightText: string, callToActionLabel: string, footerText: string}}
     */
    static toEmailContent(notification)
    {
        const emailBlock = (notification?.email !== null && typeof notification?.email === "object") ? notification.email : {};
        const title = String(notification?.title ?? "");
        const body = String(notification?.body ?? "");

        return {
            subject: emailBlock.subject || title || "A notification from CogniumLearn",
            headingText: emailBlock.headingText || title,
            introText: emailBlock.introText || body,
            highlightText: emailBlock.highlightText || "",
            callToActionLabel: emailBlock.callToActionLabel || NotificationContent.DEFAULT_EMAIL_CALL_TO_ACTION_LABEL,
            footerText: emailBlock.footerText || NotificationContent.DEFAULT_EMAIL_FOOTER_TEXT
        };
    }

    // ── Generation ───────────────────────────────────────────────────────────
    static generationComplete(deckId)
    {
        return {
            type: notificationTypes.GENERATION_COMPLETE,
            title: "Your study set is ready",
            body: "Your generated flashcards and study materials are ready to review.",
            data: { deckId: deckId ?? "", target: "deck" },
            email:
            {
                subject: "Your CogniumLearn study set is ready",
                headingText: "Your study set is ready",
                introText: "The generation you started has finished. Your new flashcards, study materials and mock tests are waiting for you in CogniumLearn.",
                highlightText: "",
                callToActionLabel: NotificationContent.DEFAULT_EMAIL_CALL_TO_ACTION_LABEL,
                footerText: "You're receiving this because you started an AI generation on CogniumLearn."
            }
        };
    }

    static deckAnalysisComplete(deckId)
    {
        return {
            type: notificationTypes.GENERATION_COMPLETE,
            title: "New study material is ready",
            body: "Your deck analysis finished and fresh curated study material is waiting for you.",
            data: { deckId: deckId ?? "", target: "deck" },
            email:
            {
                subject: "New curated study material is ready on CogniumLearn",
                headingText: "New study material is ready",
                introText: "We looked at how your studying is going and put together fresh curated material for the topics you're finding hardest.",
                highlightText: "",
                callToActionLabel: NotificationContent.DEFAULT_EMAIL_CALL_TO_ACTION_LABEL,
                footerText: "You're receiving this because automatic deck analysis is switched on for one of your decks."
            }
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
            // The disclosure lives in the notification itself rather than only
            // in a policy page, because this is the moment a member's spending
            // becomes visible to someone else. They are told once, plainly, at
            // the point it starts being true.
            body: `You were added to ${label} on CogniumLearn. They can give you credits, set which AI features you get inside their view, and see how many credits you spend and on what.`,
            data: { target: "organization", organizationName: label }
        };
    }

    /**
     * Sent to the owner when credits they paid for land in the pool.
     */
    static organizationCreditsPurchased(organizationName, creditsAdded)
    {
        const label = (typeof organizationName === "string" && organizationName.trim().length > 0) ? organizationName.trim() : "your organization";
        const credits = Number(creditsAdded) || 0;
        return {
            type: notificationTypes.ORGANIZATION,
            title: "Credits added",
            body: `${credits} credits are now in ${label}'s pool, ready to distribute.`,
            data: { target: "organization", organizationName: label, creditsAdded: credits }
        };
    }

    /**
     * Sent to the owner and delegates as the contract term runs out. The pool is
     * not lost at the end of a term — it freezes — so the message says what
     * actually stops rather than implying the credits disappear.
     */
    static organizationTermEnding(organizationName, daysRemaining)
    {
        const label = (typeof organizationName === "string" && organizationName.trim().length > 0) ? organizationName.trim() : "your organization";
        const days = Number(daysRemaining) || 0;
        return {
            type: notificationTypes.ORGANIZATION,
            title: days <= 1 ? "Credit term ends tomorrow" : `Credit term ends in ${days} days`,
            body: `${label}'s credit term ends soon. Unused credits are kept and become available again when it is renewed, but distributions pause until then.`,
            data: { target: "organization", organizationName: label, daysRemaining: days }
        };
    }

    /**
     * Sent once when the term has lapsed and the pool has been frozen.
     */
    static organizationTermExpired(organizationName)
    {
        const label = (typeof organizationName === "string" && organizationName.trim().length > 0) ? organizationName.trim() : "your organization";
        return {
            type: notificationTypes.ORGANIZATION,
            title: "Credit term ended",
            body: `${label}'s credit term has ended, so distributions are paused. Any unused credits are kept and become available again on renewal. Members keep everything already given to them.`,
            data: { target: "organization", organizationName: label }
        };
    }

    /**
     * Sent when a recurring distribution could not run because the pool could
     * not cover it. Names the shortfall so the top-up can be the right size.
     */
    static organizationPoolEmpty(organizationName, requiredCredits, availableCredits)
    {
        const label = (typeof organizationName === "string" && organizationName.trim().length > 0) ? organizationName.trim() : "your organization";
        const required = Number(requiredCredits) || 0;
        const available = Number(availableCredits) || 0;
        return {
            type: notificationTypes.ORGANIZATION,
            title: "Recurring credits were skipped",
            body: `${label}'s pool holds ${available} credits but this cycle needed ${required}, so nothing was given out. Top up and the next cycle runs normally — this one is not back-paid.`,
            data: { target: "organization", organizationName: label, requiredCredits: required, availableCredits: available }
        };
    }

    // ── Support ──────────────────────────────────────────────────────────────
    // Delivered only to reporters who ticked "notify me when this is resolved".
    // Everyone else still finds the outcome in the Report Issue dialog's "Your
    // reports" tab, which reads the same ticket status without needing a push.
    static supportTicketResolved(ticketId, creditsGranted)
    {
        const credits = Number(creditsGranted) || 0;
        const rewardSentence = credits > 0 ? ` We've added ${credits} credits to your account as a thank you.` : "";
        return {
            type: notificationTypes.SUPPORT,
            title: "The issue you reported is fixed",
            body: `Thanks for the report — it's been resolved.${rewardSentence}`,
            data: { target: "support", ticketId: ticketId ?? "" }
        };
    }

    static supportTicketDeclined(ticketId)
    {
        return {
            type: notificationTypes.SUPPORT,
            title: "Update on the issue you reported",
            body: "We've finished reviewing your report. Open your reports to see what we found.",
            data: { target: "support", ticketId: ticketId ?? "" }
        };
    }
}

module.exports = NotificationContent;
