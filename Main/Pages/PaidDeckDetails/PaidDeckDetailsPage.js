import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import PaidDeckPurchaseFlow from "../../Globals/Classes/PaidDeckPurchaseFlow.js";
import PaidDeckRegistry from "../../Globals/Classes/PaidDeckRegistry.js";
import PaidDeckBadgeChip from "./Components/PaidDeckBadgeChip.js";
import PaidDeckTreePreview from "./Components/PaidDeckTreePreview.js";

/**
 * PaidDeckDetailsPage
 *
 * Buyer-facing deep dive for a single paid deck. Renders everything
 * the storefront knows about a deck without ever needing to decrypt
 * its content blob — counts, tree preview, feature badges, extra
 * tags, and the institute block all live on the paidDecks document.
 *
 * The CTA in the header is context-aware:
 *   - Owned + same version           → "Already owned" (disabled)
 *   - Owned + newer version on server → "Update available"
 *   - Not owned                       → Buy (delegates to
 *                                       PaidDeckPurchaseFlow)
 */
class PaidDeckDetailsPage extends HTMLElement
{
    #deck = null;
    #region = "IN";

    initialize(deck, region)
    {
        this.#deck = deck;
        if (typeof region === "string" && region.length > 0)
        {
            this.#region = region;
        }
    }

    connectedCallback()
    {
        this.setAttribute("page", "");

        if (!this.#deck)
        {
            this.innerHTML = `
                <header-component title="Paid Deck"></header-component>
                <div class="paid-deck-details-empty">No deck selected.</div>
            `;
            return;
        }

        this.innerHTML = this.#renderPageMarkup();

        this.#mountTreePreview();
        this.#wireCallToActionButton();
    }

    #renderPageMarkup()
    {
        const deck = this.#deck;
        const escape = PaidDeckDetailsPage.#escape;

        const thumbnailUrl = deck.thumbnailUrl || "./Globals/Assets/Images/Icons/DeckIcon.svg";
        const finalMinor = deck.computedPrice?.finalPriceMinor ?? deck.basePriceMinor ?? 0;
        const baseMinor = deck.computedPrice?.basePriceMinor ?? deck.basePriceMinor ?? 0;
        const showStrike = baseMinor > 0 && finalMinor < baseMinor;
        const currency = deck.computedPrice?.currency || deck.currency || "INR";

        const contentSummary = (deck.contentSummary && typeof deck.contentSummary === "object") ? deck.contentSummary : {};
        const totalCards = Number(contentSummary.totalCards) || 0;
        const totalStudyMaterials = Number(contentSummary.totalStudyMaterials) || 0;
        const totalMockTests = Number(contentSummary.totalMockTests) || 0;

        const featureBadges = Array.isArray(deck.featureBadges) ? deck.featureBadges : [];
        const extraTags = Array.isArray(deck.extraTags) ? deck.extraTags : [];
        const tags = Array.isArray(deck.tags) ? deck.tags : [];

        const institute = (deck.additionalData && typeof deck.additionalData === "object" && deck.additionalData.institute)
            ? deck.additionalData.institute
            : null;

        const callToActionState = this.#computeCallToActionState();

        const summaryPieces = [];
        if (totalCards > 0)
        {
            summaryPieces.push(`<strong>${totalCards}</strong> Flashcard${totalCards === 1 ? "" : "s"}`);
        }
        if (totalStudyMaterials > 0)
        {
            summaryPieces.push(`<strong>${totalStudyMaterials}</strong> Study Material${totalStudyMaterials === 1 ? "" : "s"}`);
        }
        if (totalMockTests > 0)
        {
            summaryPieces.push(`<strong>${totalMockTests}</strong> Mock Test${totalMockTests === 1 ? "" : "s"}`);
        }
        const summaryLine = summaryPieces.length > 0 ? `Includes ${summaryPieces.join(" · ")}` : "";

        const badgeChips = featureBadges
            .map((badgeValue) => `<paid-deck-badge-chip data-badge-value="${Number(badgeValue)}"></paid-deck-badge-chip>`)
            .join("");

        const extraTagPills = extraTags
            .map((tag) => `<span class="paid-deck-details-extra-tag">${escape(tag)}</span>`)
            .join("");

        const tagPills = tags
            .map((tag) => `<span class="paid-deck-details-tag">#${escape(tag)}</span>`)
            .join("");

        const instituteBlock = institute && typeof institute.name === "string" && institute.name.length > 0
            ? `
                <section class="paid-deck-details-section">
                    <h3 class="paid-deck-details-section-heading">Institute</h3>
                    <div class="paid-deck-details-institute">
                        <div class="paid-deck-details-institute-name">${escape(institute.name)}</div>
                        ${institute.location ? `<div class="paid-deck-details-institute-location">${escape(institute.location)}</div>` : ""}
                    </div>
                </section>
            `
            : "";

        return `
            <header-component title="Paid Deck"></header-component>
            <div class="paid-deck-details-body">
                <section class="paid-deck-details-hero">
                    <img class="paid-deck-details-thumb" src="${escape(thumbnailUrl)}" alt="">
                    <div class="paid-deck-details-hero-text">
                        <h1 class="paid-deck-details-title">${escape(deck.title || "Untitled")}</h1>
                        ${deck.category ? `<div class="paid-deck-details-category">${escape(deck.category)}</div>` : ""}
                        ${summaryLine ? `<div class="paid-deck-details-summary">${summaryLine}</div>` : ""}
                        <div class="paid-deck-details-price">
                            ${showStrike ? `<span class="paid-deck-details-price-strike">${currency} ${(baseMinor / 100).toFixed(2)}</span>` : ""}
                            <span class="paid-deck-details-price-final">${currency} ${(finalMinor / 100).toFixed(2)}</span>
                        </div>
                        <div class="paid-deck-details-cta-row">
                            <button
                                class="paid-deck-details-cta paid-deck-details-cta-${callToActionState.variant}"
                                data-role="cta"
                                ${callToActionState.disabled ? "disabled" : ""}>
                                ${callToActionState.label}
                            </button>
                            ${callToActionState.showOpenButton ? `
                                <button class="paid-deck-details-cta paid-deck-details-cta-open" data-role="open-deck">
                                    Open deck
                                </button>
                            ` : ""}
                        </div>
                    </div>
                </section>

                ${deck.description ? `
                    <section class="paid-deck-details-section">
                        <h3 class="paid-deck-details-section-heading">About this deck</h3>
                        <div class="paid-deck-details-description">${escape(deck.description)}</div>
                    </section>
                ` : ""}

                ${badgeChips ? `
                    <section class="paid-deck-details-section">
                        <h3 class="paid-deck-details-section-heading">Features</h3>
                        <div class="paid-deck-details-badges">${badgeChips}</div>
                    </section>
                ` : ""}

                ${(extraTagPills || tagPills) ? `
                    <section class="paid-deck-details-section">
                        <h3 class="paid-deck-details-section-heading">Tags</h3>
                        <div class="paid-deck-details-tags">${extraTagPills}${tagPills}</div>
                    </section>
                ` : ""}

                ${instituteBlock}

                <section class="paid-deck-details-section">
                    <h3 class="paid-deck-details-section-heading">What's inside</h3>
                    <paid-deck-tree-preview data-role="tree-preview"></paid-deck-tree-preview>
                </section>
            </div>
        `;
    }

    #mountTreePreview()
    {
        const treePreviewElement = this.querySelector('[data-role="tree-preview"]');
        if (!treePreviewElement) return;
        const treeSnapshot = (this.#deck.contentSummary && Array.isArray(this.#deck.contentSummary.treeSnapshot))
            ? this.#deck.contentSummary.treeSnapshot
            : [];
        treePreviewElement.initialize(treeSnapshot);
        if (treePreviewElement.isConnected)
        {
            // initialize() ran after connectedCallback already fired —
            // re-trigger its render. New elements don't hit this path.
            treePreviewElement.connectedCallback();
        }
    }

    #wireCallToActionButton()
    {
        const openDeckButton = this.querySelector('[data-role="open-deck"]');
        if (openDeckButton)
        {
            openDeckButton.addEventListener("click", () =>
            {
                PageNavigator.open("paid-deck-browse-page", this.#deck);
            });
        }

        const ctaButton = this.querySelector('[data-role="cta"]');
        if (!ctaButton || ctaButton.disabled) return;

        ctaButton.addEventListener("click", async () =>
        {
            const state = this.#computeCallToActionState();

            if (state.variant === "update")
            {
                await this.#handleUpdateAvailable();
                return;
            }

            if (state.variant === "buy")
            {
                ctaButton.disabled = true;
                ctaButton.textContent = "Working…";
                const acquired = await PaidDeckPurchaseFlow.run(this.#deck, this.#region);
                if (acquired)
                {
                    // Refresh the CTA — the deck is now owned, so the
                    // button should flip to "Already owned".
                    this.connectedCallback();
                }
                else
                {
                    ctaButton.disabled = false;
                    ctaButton.textContent = state.label;
                }
            }
        });
    }

    #computeCallToActionState()
    {
        const deck = this.#deck;

        if (deck.computedPrice?.reason === "ALREADY_OWNED" || PaidDeckRegistry.isLicensed(deck.id))
        {
            const license = PaidDeckRegistry.getLicense(deck.id);
            const downloadedVersion = (license && Number(license.downloadedContentVersion)) || 0;
            const currentVersion = Number(deck.contentSummary?.contentVersion) || 0;

            if (currentVersion > downloadedVersion && downloadedVersion > 0)
            {
                return { variant: "update", label: "Update available", disabled: false, showOpenButton: true };
            }

            return { variant: "owned", label: "Already owned", disabled: true, showOpenButton: true };
        }

        const finalMinor = deck.computedPrice?.finalPriceMinor ?? deck.basePriceMinor ?? 0;
        const currency = deck.computedPrice?.currency || deck.currency || "INR";
        return { variant: "buy", label: `Buy for ${currency} ${(finalMinor / 100).toFixed(2)}`, disabled: false, showOpenButton: false };
    }

    async #handleUpdateAvailable()
    {
        const choiceDialog = DialogBox.modal(`
            <div class="paid-deck-update-choice">
                <h2 class="paid-deck-update-choice-title">A newer version of this deck is available</h2>
                <p class="paid-deck-update-choice-message">
                    Choose how you'd like to receive the update. Your current copy stays on this device either way.
                </p>
                <div class="paid-deck-update-choice-buttons">
                    <button type="button" class="paid-deck-update-choice-replace">Replace existing copy</button>
                    <button type="button" class="paid-deck-update-choice-duplicate">Download as separate deck</button>
                    <button type="button" class="paid-deck-update-choice-cancel">Cancel</button>
                </div>
            </div>
        `);

        const choicePromise = new Promise((resolve) =>
        {
            choiceDialog.querySelector(".paid-deck-update-choice-replace").addEventListener("click", () =>
            {
                choiceDialog.close();
                resolve("REPLACE");
            });
            choiceDialog.querySelector(".paid-deck-update-choice-duplicate").addEventListener("click", () =>
            {
                choiceDialog.close();
                resolve("DUPLICATE");
            });
            choiceDialog.querySelector(".paid-deck-update-choice-cancel").addEventListener("click", () =>
            {
                choiceDialog.close();
                resolve(null);
            });
        });

        const choice = await choicePromise;
        if (!choice) return;

        try
        {
            const redownloadResponse = await fetch("/PaidDecks/Redownload",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: this.#deck.id })
            });

            if (!redownloadResponse.ok)
            {
                const errorJson = await redownloadResponse.json().catch(() => ({}));
                await DialogBox.alert("Update failed", errorJson.error || `HTTP ${redownloadResponse.status}`);
                return;
            }

            const redownloadJson = await redownloadResponse.json();
            const newContentVersion = Number(redownloadJson.contentVersion) || 0;

            await fetch("/PaidDecks/MarkVersionDownloaded",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: this.#deck.id, contentVersion: newContentVersion })
            });

            // Reflect the new version in the local registry immediately
            // so this page (and any other surface) shows "Already owned"
            // before the next license sync round-trip.
            await PaidDeckRegistry.markDownloadedVersion(this.#deck.id, newContentVersion);

            const modeLabel = choice === "REPLACE" ? "replace your existing copy" : "download as a separate deck";
            await DialogBox.alert
            (
                "Update queued",
                `A new license at version ${newContentVersion} has been issued. The next sync will ${modeLabel} on this device.`
            );

            // Refresh the CTA so it flips back to "Already owned".
            this.connectedCallback();
        }
        catch (updateError)
        {
            await DialogBox.alert("Update failed", updateError.message);
        }
    }

    static #escape(rawValue)
    {
        if (rawValue === null || rawValue === undefined) return "";
        return String(rawValue)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define("paid-deck-details-page", PaidDeckDetailsPage);
export default PaidDeckDetailsPage;
