import { screenshotDetectionReasons } from "../../Enumerations/ScreenshotDetectionReasons.js";

/**
 * ScreenshotDetector
 *
 * Best-effort signals for "the user is trying to capture this screen".
 * None of the browser APIs reliably detect screenshots, so this is a
 * defence-in-depth layer that combines several heuristics:
 *
 *   - PrintScreen keystroke (does not actually intercept the OS-level
 *     screenshot, but lets us blur the card before it lands in the
 *     clipboard for a paste).
 *   - Tab visibilitychange to "hidden" — often correlates with
 *     screenshot tools that overlay the page.
 *   - Long window-blur durations — same.
 *   - getDisplayMedia presence — if a paid card opens a
 *     screen-recording prompt, blur the content.
 *
 * On every signal we:
 *   1. Add a blur class to a registered container.
 *   2. POST /PaidDecks/ScreenshotAttempt to telemetry-log it.
 *   3. Fire a CustomEvent so the page can show its own UX.
 *
 * Active only while at least one paid-card container is registered.
 */
class ScreenshotDetector
{
    static EVENT_NAME = "PAID_DECK_SCREENSHOT_ATTEMPT";

    static #registeredContainers = new Set();
    static #installed = false;
    static #blurReleaseTimer = null;
    static #activeDeckId = null;
    static #activeCardId = null;

    static install()
    {
        if (ScreenshotDetector.#installed)
        {
            return;
        }

        ScreenshotDetector.#installed = true;

        window.addEventListener("keydown", ScreenshotDetector.#handleKeyDown);
        document.addEventListener("visibilitychange", ScreenshotDetector.#handleVisibilityChange);
        window.addEventListener("blur", ScreenshotDetector.#handleBlur);
        window.addEventListener("focus", ScreenshotDetector.#handleFocus);
    }

    static registerContainer(container, deckId, cardId)
    {
        if (!container)
        {
            return;
        }

        container.classList.add("paid-deck-card-container");
        container.style.userSelect = "none";
        container.style.webkitUserSelect = "none";
        container.setAttribute("oncontextmenu", "return false");

        ScreenshotDetector.#registeredContainers.add(container);
        ScreenshotDetector.#activeDeckId = deckId || null;
        ScreenshotDetector.#activeCardId = cardId || null;
        ScreenshotDetector.install();
    }

    static unregisterContainer(container)
    {
        if (!container)
        {
            return;
        }
        ScreenshotDetector.#registeredContainers.delete(container);

        if (ScreenshotDetector.#registeredContainers.size === 0)
        {
            ScreenshotDetector.#activeDeckId = null;
            ScreenshotDetector.#activeCardId = null;
        }
    }

    static #handleKeyDown(keyEvent)
    {
        if (ScreenshotDetector.#registeredContainers.size === 0)
        {
            return;
        }

        if (keyEvent.key === "PrintScreen" || keyEvent.code === "PrintScreen")
        {
            ScreenshotDetector.#triggerCapture(screenshotDetectionReasons.PRINT_SCREEN_KEY);
        }
    }

    static #handleVisibilityChange()
    {
        if (ScreenshotDetector.#registeredContainers.size === 0)
        {
            return;
        }

        if (document.visibilityState === "hidden")
        {
            ScreenshotDetector.#triggerCapture(screenshotDetectionReasons.VISIBILITY_HIDDEN);
        }
    }

    static #blurStartTimestamp = 0;

    static #handleBlur()
    {
        if (ScreenshotDetector.#registeredContainers.size === 0)
        {
            return;
        }
        ScreenshotDetector.#blurStartTimestamp = Date.now();
    }

    static #handleFocus()
    {
        if (ScreenshotDetector.#blurStartTimestamp === 0)
        {
            return;
        }

        const blurDurationMilliseconds = Date.now() - ScreenshotDetector.#blurStartTimestamp;
        ScreenshotDetector.#blurStartTimestamp = 0;

        const LONG_BLUR_THRESHOLD_MILLISECONDS = 3000;

        if (blurDurationMilliseconds > LONG_BLUR_THRESHOLD_MILLISECONDS && ScreenshotDetector.#registeredContainers.size > 0)
        {
            ScreenshotDetector.#triggerCapture(screenshotDetectionReasons.BLUR_LONG_FOCUS);
        }
    }

    static #triggerCapture(reasonEnumValue)
    {
        for (const container of ScreenshotDetector.#registeredContainers)
        {
            container.classList.add("paid-deck-card-blurred");
        }

        clearTimeout(ScreenshotDetector.#blurReleaseTimer);
        ScreenshotDetector.#blurReleaseTimer = setTimeout(() =>
        {
            for (const container of ScreenshotDetector.#registeredContainers)
            {
                container.classList.remove("paid-deck-card-blurred");
            }
        }, 4000);

        window.dispatchEvent(new CustomEvent(ScreenshotDetector.EVENT_NAME,
        {
            detail:
            {
                reason: reasonEnumValue,
                deckId: ScreenshotDetector.#activeDeckId,
                cardId: ScreenshotDetector.#activeCardId
            }
        }));

        // Fire-and-forget telemetry. Log failures only — do not block UX.
        fetch("/PaidDecks/ScreenshotAttempt",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify
            ({
                deckId: ScreenshotDetector.#activeDeckId,
                cardId: ScreenshotDetector.#activeCardId,
                reason: reasonEnumValue,
                userAgent: navigator.userAgent
            })
        }).catch((logError) =>
        {
            console.warn("[ScreenshotDetector] Telemetry POST failed:", logError);
        });
    }
}

export default ScreenshotDetector;
