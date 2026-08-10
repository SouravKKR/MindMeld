// Imported for its side effect: DialogBox is what registers the <dialog-box>
// custom element this class builds by hand. Without it the element would be
// created but never upgraded, and the dialog would render as an inert div.
import "../../../CommonComponents/DialogBox.js";
import AuthenticationEvents from "../../../Globals/Events/AuthenticationEvents.js";
import { creditPricingStates } from "../../../Globals/Enumerations/CreditPricingStates.js";
import { generationEstimateOutcomes } from "../../../Globals/Enumerations/GenerationEstimateOutcomes.js";
import { formatCredits } from "../../../Globals/UtilityFunctions/FormatCredits.js";

/**
 * GenerationEstimateDialog
 *
 * The mandatory pre-flight step of "Start Generation". Pressing Start no longer
 * submits anything: it prices the run first, shows what it will cost, and only
 * submits once the user confirms inside this dialog.
 *
 * Why it exists as its own class: the page used to carry an optional "Compute
 * Cost" button that almost nobody pressed, so a user holding one credit could
 * launch a whole-textbook run, watch it die partway, and be disappointed. Making
 * the estimate unavoidable is the fix, and the estimate's fetching, caching,
 * markup, shortfall arithmetic and three-way outcome are a cohesive
 * responsibility that does not belong on the form controller.
 *
 * The shortfall is deliberately a WARNING, not a block. A user who has read
 * "you have 1 credit, this needs about 46, it will stop partway and you can
 * resume after topping up" and still chooses to start is making an informed
 * decision — the disappointment this feature removes is the surprise, not the
 * choice. Nothing here is a security boundary; the server remains authoritative
 * for affordability through CreditPreflight and the Agent's per-task charging.
 */
class GenerationEstimateDialog
{
    static ESTIMATE_ENDPOINT = "/Generate/EstimateCost";

    // An estimate only changes when the form changes, so an unchanged form
    // re-uses the last answer instead of spending a request. This matters
    // because estimating is now on the critical path: start → cancel → tweak →
    // start must not run into the endpoint's per-user rate limit.
    static ESTIMATE_CACHE_LIFETIME_MILLISECONDS = 5 * 60 * 1000;

    static #cachedSettingsFingerprint = null;
    static #cachedEstimate = null;
    static #cachedEstimateAtMilliseconds = 0;

    /**
     * Prices the run, presents it, and reports what the user chose.
     *
     * @param {object} generationSettingsMap the same body /Generate receives
     * @param {string} exportWarningHtml already-escaped markup for the one-way
     *        "this deck will no longer be exportable" consequence, or "" when
     *        the run does not carry it
     * @returns {Promise<number>} a generationEstimateOutcomes value
     */
    static async present(generationSettingsMap, exportWarningHtml)
    {
        const estimateResult = await GenerationEstimateDialog.#fetchEstimate(generationSettingsMap);

        if (!estimateResult.bAvailable)
        {
            // No estimate and no cached one to fall back on. Say why rather than
            // silently starting an unpriced run behind the user's back.
            await GenerationEstimateDialog.#showBlockingMessage("Couldn't estimate", estimateResult.messageHtml);
            return generationEstimateOutcomes.CANCEL;
        }

        const balanceCredits = await GenerationEstimateDialog.#readFreshBalance();
        const requiredCredits = GenerationEstimateDialog.#resolveRequiredCredits(estimateResult.estimate);
        const bShortfall = requiredCredits !== null && balanceCredits !== null && balanceCredits < requiredCredits;

        const messageHtml = GenerationEstimateDialog.#buildMessageHtml(
            estimateResult.estimate,
            balanceCredits,
            requiredCredits,
            exportWarningHtml,
            estimateResult.bFromCache
        );

        return await GenerationEstimateDialog.#showChoiceDialog("Before we start", messageHtml, bShortfall);
    }

    // ─────────────────────────────────────────────
    //  Estimating
    // ─────────────────────────────────────────────

    /**
     * Fetches the estimate, serving an unexpired cached one for an unchanged
     * form. A rate-limited response falls back to the cache when there is one,
     * because being told "wait 30 seconds" is a dead end when estimating is the
     * only route to starting a generation.
     *
     * @returns {Promise<{bAvailable: boolean, estimate: (object|null), bFromCache: boolean, messageHtml: string}>}
     */
    static async #fetchEstimate(generationSettingsMap)
    {
        const settingsFingerprint = GenerationEstimateDialog.#describeSettingsFingerprint(generationSettingsMap);

        const cachedEstimate = GenerationEstimateDialog.#readCachedEstimate(settingsFingerprint);
        if (cachedEstimate !== null)
        {
            return { bAvailable: true, estimate: cachedEstimate, bFromCache: true, messageHtml: "" };
        }

        try
        {
            const estimateResponse = await fetch(GenerationEstimateDialog.ESTIMATE_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(generationSettingsMap)
            });

            if (estimateResponse.status === 429)
            {
                // The form changed, so the cached estimate is for different
                // settings — but a slightly stale number the user can see beats
                // refusing to let them start at all. Say it is a moment old.
                const staleEstimate = GenerationEstimateDialog.#readAnyCachedEstimate();
                if (staleEstimate !== null)
                {
                    return { bAvailable: true, estimate: staleEstimate, bFromCache: true, messageHtml: "" };
                }

                const throttleDetail = await estimateResponse.json().catch(() => ({}));
                const retryAfterSeconds = Number(throttleDetail?.retryAfterSeconds);
                return {
                    bAvailable: false,
                    estimate: null,
                    bFromCache: false,
                    messageHtml: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                        ? `You can start another generation in ${retryAfterSeconds}s.`
                        : "You're starting generations too quickly. Please wait a moment and try again."
                };
            }

            if (!estimateResponse.ok)
            {
                return {
                    bAvailable: false,
                    estimate: null,
                    bFromCache: false,
                    messageHtml: "We couldn't work out what this run will cost right now. Please try again."
                };
            }

            const estimate = await estimateResponse.json();
            GenerationEstimateDialog.#writeCachedEstimate(settingsFingerprint, estimate);
            return { bAvailable: true, estimate: estimate, bFromCache: false, messageHtml: "" };
        }
        catch (estimateError)
        {
            console.error("[GenerationEstimateDialog] Cost estimate failed:", estimateError);
            return {
                bAvailable: false,
                estimate: null,
                bFromCache: false,
                messageHtml: "We couldn't reach the server. Please check your connection and try again."
            };
        }
    }

    /**
     * Fields that change where a run's output is stored but not what it costs.
     * Excluded from the cache key so switching between them does not discard a
     * still-valid estimate and spend another rate-limited /Generate/EstimateCost
     * call to be told the same number.
     *
     * Credits are always the individual's, including for a run generated for an
     * organization — organization pools fund members by topping up their
     * personal balances — so the target library genuinely has no bearing on the
     * price. Should that ever stop being true, this list is what has to shrink.
     */
    static COST_NEUTRAL_SETTINGS_KEYS = ["organizationId"];

    static #describeSettingsFingerprint(generationSettingsMap)
    {
        try
        {
            const costRelevantSettings = { ...generationSettingsMap };

            for (const costNeutralKey of GenerationEstimateDialog.COST_NEUTRAL_SETTINGS_KEYS)
            {
                delete costRelevantSettings[costNeutralKey];
            }

            return JSON.stringify(costRelevantSettings);
        }
        catch (serialisationError)
        {
            // An unserialisable body can never match a fingerprint, which just
            // means every attempt re-fetches — correct, only slower.
            return null;
        }
    }

    static #readCachedEstimate(settingsFingerprint)
    {
        if (settingsFingerprint === null || settingsFingerprint !== GenerationEstimateDialog.#cachedSettingsFingerprint)
        {
            return null;
        }
        return GenerationEstimateDialog.#readAnyCachedEstimate();
    }

    static #readAnyCachedEstimate()
    {
        if (GenerationEstimateDialog.#cachedEstimate === null)
        {
            return null;
        }

        const ageMilliseconds = new Date().getTime() - GenerationEstimateDialog.#cachedEstimateAtMilliseconds;
        if (ageMilliseconds > GenerationEstimateDialog.ESTIMATE_CACHE_LIFETIME_MILLISECONDS)
        {
            return null;
        }

        return GenerationEstimateDialog.#cachedEstimate;
    }

    static #writeCachedEstimate(settingsFingerprint, estimate)
    {
        GenerationEstimateDialog.#cachedSettingsFingerprint = settingsFingerprint;
        GenerationEstimateDialog.#cachedEstimate = estimate;
        GenerationEstimateDialog.#cachedEstimateAtMilliseconds = new Date().getTime();
    }

    /**
     * The balance the run should be judged against: the estimate plus its own
     * uncertainty band. CreditEstimator already publishes that as `high`
     * (estimate + 10%, widening to + 25% when image enhancement is priced), so
     * this reads it rather than hardcoding a multiplier that would drift away
     * from the band the same response is displaying.
     *
     * @returns {number|null} null when nothing is priced, so no threshold exists
     */
    static #resolveRequiredCredits(estimate)
    {
        if (!estimate || typeof estimate.estimatedCredits !== "number")
        {
            return null;
        }

        const highEstimate = Number(estimate.high);
        if (Number.isFinite(highEstimate) && highEstimate > 0)
        {
            return highEstimate;
        }

        return estimate.estimatedCredits;
    }

    /**
     * Re-reads the signed-in user so the warning is judged against the balance
     * the server holds now, not the one cached when the app booted — earlier
     * generations in the same session will have spent credits since.
     *
     * @returns {Promise<number|null>} null when no balance is known at all
     */
    static async #readFreshBalance()
    {
        try
        {
            await AuthenticationEvents.refreshUserFromServer();
        }
        catch (refreshError)
        {
            // Offline or a transient failure — the cached user is still the best
            // number available, and a slightly stale warning beats none.
            console.warn("[GenerationEstimateDialog] Could not refresh the balance:", refreshError);
        }

        const balanceValue = window["user"]?.getAdditionalData()?.credits;
        return typeof balanceValue === "number" ? balanceValue : null;
    }

    // ─────────────────────────────────────────────
    //  Markup
    // ─────────────────────────────────────────────

    static #buildMessageHtml(estimate, balanceCredits, requiredCredits, exportWarningHtml, bFromCache)
    {
        // The one-way consequence goes ABOVE the numbers. It is irreversible and
        // reaches cards the user wrote by hand, so it must not end up read as a
        // footnote under a cost breakdown.
        const exportHtml = (typeof exportWarningHtml === "string" && exportWarningHtml.length > 0)
            ? `<div class="generation-estimate-export-warning">${exportWarningHtml}</div>`
            : "";

        if (!estimate || estimate.estimatedCredits === null || estimate.estimatedCredits === undefined)
        {
            return exportHtml
                + `<div class="generation-estimate-note">Credit pricing isn't configured yet, so we can't estimate what this run will cost.</div>`;
        }

        const credits = estimate.estimatedCredits;
        const moneySuffix = (typeof estimate.pricePerCredit === "number" && estimate.currency)
            ? ` (≈ ${estimate.currency} ${(credits * estimate.pricePerCredit).toFixed(2)})`
            : "";

        // A line reading "0 cr" says nothing about WHY. Label the three reasons a
        // line can be zero so an unpriced task is never mistaken for a free one.
        const stateLabelByValue =
        {
            [creditPricingStates.UNPRICED]: "not priced",
            [creditPricingStates.DENIED]: "unavailable",
            [creditPricingStates.FREE]: "free",
        };

        const breakdownHtml = (Array.isArray(estimate.breakdown) ? estimate.breakdown : [])
            .map(item =>
            {
                const stateLabel = stateLabelByValue[item.state];
                const amountLabel = stateLabel ? stateLabel : `${item.credits} cr`;
                return `<div class="generation-estimate-breakdown-row"><span>${item.label}</span><span>${amountLabel}</span></div>`;
            })
            .join("");

        const unpricedLabels = Array.isArray(estimate.unpricedLabels) ? estimate.unpricedLabels : [];
        const deniedLabels = Array.isArray(estimate.deniedLabels) ? estimate.deniedLabels : [];

        const noticeHtml = [
            deniedLabels.length > 0
                ? `<div class="generation-estimate-note">Currently unavailable: ${deniedLabels.join(", ")}. This generation can't run until that changes.</div>`
                : "",
            unpricedLabels.length > 0
                ? `<div class="generation-estimate-note">No credit pricing is configured for: ${unpricedLabels.join(", ")}. Those parts won't be charged, so the total above is lower than the real cost of the run.</div>`
                : "",
            bFromCache
                ? `<div class="generation-estimate-note">This estimate was worked out a moment ago.</div>`
                : "",
        ].join("");

        return `
            ${exportHtml}
            <div class="generation-estimate-headline">≈ ${credits} credits${moneySuffix}</div>
            <div class="generation-estimate-range">Estimated range: ${estimate.low}–${estimate.high} credits</div>
            ${breakdownHtml ? `<div class="generation-estimate-breakdown">${breakdownHtml}</div>` : ""}
            ${GenerationEstimateDialog.#buildBalanceHtml(balanceCredits, requiredCredits)}
            ${noticeHtml}
            ${GenerationEstimateDialog.#buildDisclaimerHtml(estimate)}
        `;
    }

    /**
     * The balance line, and — when it falls short of the estimate plus its band
     * — the warning that says exactly what will happen. Naming the shortfall in
     * credits is the whole point: "you don't have enough" without a number is
     * what left users guessing.
     */
    static #buildBalanceHtml(balanceCredits, requiredCredits)
    {
        if (balanceCredits === null)
        {
            return "";
        }

        const balanceLabel = formatCredits(balanceCredits);

        if (requiredCredits === null || balanceCredits >= requiredCredits)
        {
            return `<div class="generation-estimate-balance">Your balance: ${balanceLabel} credits</div>`;
        }

        return `
            <div class="generation-estimate-balance">Your balance: ${balanceLabel} credits</div>
            <div class="generation-estimate-shortfall">
                This run needs about ${formatCredits(requiredCredits)} credits, so it will stop partway once your
                credits run out. You can top up and resume it from the Home page — nothing already generated is lost.
            </div>
        `;
    }

    /**
     * The disclaimer, worded from the band the server actually returned rather
     * than a hardcoded 10% — the band widens to 25% when image enhancement is
     * priced, and a disclaimer that under-states its own uncertainty is worse
     * than none.
     */
    static #buildDisclaimerHtml(estimate)
    {
        const credits = Number(estimate?.estimatedCredits);
        const highEstimate = Number(estimate?.high);

        let bandPercentage = 10;
        if (Number.isFinite(credits) && credits > 0 && Number.isFinite(highEstimate) && highEstimate > credits)
        {
            bandPercentage = Math.round(((highEstimate - credits) / credits) * 100);
        }

        return `
            <div class="generation-estimate-disclaimer">
                These are estimates and can be around ${bandPercentage}% higher or lower. You're charged from the
                real usage during the run, not from this figure.
            </div>
        `;
    }

    // ─────────────────────────────────────────────
    //  Dialogs
    // ─────────────────────────────────────────────

    /**
     * The three-way confirm. Built directly on the dialog-box element rather
     * than through DialogBox.confirm, which only offers Ok/Cancel — the same
     * approach CreditNotice takes for its custom labels.
     *
     * The primary action keeps the .ok-button class so the delegated sound cue
     * and the dialog's own keyboard handling continue to treat it as the
     * confirming action.
     *
     * @returns {Promise<number>} a generationEstimateOutcomes value
     */
    static #showChoiceDialog(titleText, messageHtml, bShortfall)
    {
        const dialog = document.createElement("dialog-box");
        dialog.innerHTML =
        `
            <div class="title-section">${titleText}</div>
            <div class="message-section">${messageHtml}</div>
            <div class="button-section">
                <button class="ok-button generation-estimate-start-button">${bShortfall ? "Start anyway" : "Start Generation"}</button>
                <button class="generation-estimate-buy-button">Buy Credits</button>
                <button class="cancel-button">Cancel</button>
            </div>
        `;

        return new Promise((resolve) =>
        {
            const startButton = dialog.querySelector(".generation-estimate-start-button");
            const buyButton = dialog.querySelector(".generation-estimate-buy-button");
            const cancelButton = dialog.querySelector(".cancel-button");

            startButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve(generationEstimateOutcomes.START);
            });

            buyButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve(generationEstimateOutcomes.BUY_CREDITS);
            });

            cancelButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve(generationEstimateOutcomes.CANCEL);
            });

            document.body.appendChild(dialog);
        });
    }

    /**
     * A one-button dialog for the case where no estimate could be produced at
     * all. Deliberately not DialogBox.alert: the message is markup built here.
     */
    static #showBlockingMessage(titleText, messageHtml)
    {
        const dialog = document.createElement("dialog-box");
        dialog.innerHTML =
        `
            <div class="title-section">${titleText}</div>
            <div class="message-section">${messageHtml}</div>
            <div class="button-section">
                <button class="ok-button">OK</button>
            </div>
        `;

        return new Promise((resolve) =>
        {
            dialog.querySelector(".ok-button").addEventListener("click", () =>
            {
                dialog.close();
                resolve();
            });

            document.body.appendChild(dialog);
        });
    }
}

export default GenerationEstimateDialog;
