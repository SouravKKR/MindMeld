import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import PaidDeckPurchaseFlow from "../../Globals/Classes/PaidDeckPurchaseFlow.js";
import PaidDeckRegistry from "../../Globals/Classes/PaidDeckRegistry.js";
import PaidDeckBadgeChip from "./Components/PaidDeckBadgeChip.js";
import PaidDeckTreePreview from "./Components/PaidDeckTreePreview.js";
import PaidDeckThumbnails from "../../Globals/Classes/PaidDeckThumbnails.js";
import ManagePaidDeckCopiesDialog from "../Home/Components/ManagePaidDeckCopiesDialog.js";
import LicenseConstants from "../../Globals/Constants/LicenseConstants.js";

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

        const thumbnailUrl = PaidDeckThumbnails.resolveDeckThumbnail(deck);
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

        // Quick-facts shown right by the price: date modified + institute.
        // updatedAt is the canonical "modified" stamp; older decks predate it,
        // so fall back to the key-rotation / publish timestamps.
        const lastUpdatedText = PaidDeckDetailsPage.#formatDate(deck.updatedAt || deck.lastKeyRotationAt || deck.publishedAt);

        const metaItems = [];
        if (lastUpdatedText)
        {
            metaItems.push(`
                <div class="paid-deck-details-meta-item">
                    <span class="paid-deck-details-meta-label">Last updated</span>
                    <span class="paid-deck-details-meta-value">${escape(lastUpdatedText)}</span>
                </div>
            `);
        }
        if (institute && typeof institute.name === "string" && institute.name.length > 0)
        {
            const instituteText = institute.location
                ? `${institute.name} · ${institute.location}`
                : institute.name;
            metaItems.push(`
                <div class="paid-deck-details-meta-item">
                    <span class="paid-deck-details-meta-label">Institute</span>
                    <span class="paid-deck-details-meta-value">${escape(instituteText)}</span>
                </div>
            `);
        }
        const metaBlock = metaItems.length > 0
            ? `<div class="paid-deck-details-meta">${metaItems.join("")}</div>`
            : "";

        const heroBadges = badgeChips
            ? `<div class="paid-deck-details-hero-badges">${badgeChips}</div>`
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
                        ${metaBlock}
                        <div class="paid-deck-details-price">
                            ${showStrike ? `<span class="paid-deck-details-price-strike">${currency} ${(baseMinor / 100).toFixed(2)}</span>` : ""}
                            <span class="paid-deck-details-price-final">${currency} ${(finalMinor / 100).toFixed(2)}</span>
                        </div>
                        ${callToActionState.expiryText ? `<div class="paid-deck-details-ownership-expiry">${escape(callToActionState.expiryText)}</div>` : ""}
                        <div class="paid-deck-details-cta-row">
                            <button
                                class="paid-deck-details-cta paid-deck-details-cta-${callToActionState.variant}"
                                data-role="cta"
                                ${callToActionState.disabled ? "disabled" : ""}>
                                ${callToActionState.label}
                            </button>
                            ${callToActionState.showExtend ? `
                                <button class="paid-deck-details-cta paid-deck-details-cta-extend" data-role="extend">
                                    Extend
                                </button>
                            ` : ""}
                            ${callToActionState.showOpenButton ? `
                                <button class="paid-deck-details-cta paid-deck-details-cta-open" data-role="open-deck">
                                    Open deck
                                </button>
                            ` : ""}
                            ${callToActionState.showAddCopy ? `
                                <button class="paid-deck-details-cta paid-deck-details-cta-add-copy" data-role="add-copy" ${callToActionState.addCopyDisabled ? "disabled" : ""}>
                                    ${callToActionState.addCopyDisabled ? `Max ${callToActionState.maxCopies} copies` : "Add another copy"}
                                </button>
                            ` : ""}
                        </div>
                        ${(callToActionState.variant === "buy" || callToActionState.showExtend || callToActionState.showAddCopy) ? `
                            <div class="paid-deck-details-refund-note">All purchases are final and non-refundable.</div>
                        ` : ""}
                        ${heroBadges}
                    </div>
                </section>

                ${deck.description ? `
                    <section class="paid-deck-details-section">
                        <h3 class="paid-deck-details-section-heading">About this deck</h3>
                        <div class="paid-deck-details-description">${escape(deck.description)}</div>
                    </section>
                ` : ""}

                ${(extraTagPills || tagPills) ? `
                    <section class="paid-deck-details-section">
                        <h3 class="paid-deck-details-section-heading">Tags</h3>
                        <div class="paid-deck-details-tags">${extraTagPills}${tagPills}</div>
                    </section>
                ` : ""}

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

        // Extend re-runs the purchase flow, which re-grants the license with a
        // fresh access period (the server applies the deck's grant terms).
        const extendButton = this.querySelector('[data-role="extend"]');
        if (extendButton)
        {
            extendButton.addEventListener("click", async () =>
            {
                extendButton.disabled = true;
                extendButton.textContent = "Working…";
                const extended = await PaidDeckPurchaseFlow.run(this.#deck, this.#region);
                if (extended)
                {
                    this.connectedCallback();
                }
                else
                {
                    extendButton.disabled = false;
                    extendButton.textContent = "Extend";
                }
            });
        }

        // Add another independent copy of an owned deck (up to the cap). The new
        // copy's content arrives via the next sync; ManagePaidDeckCopiesDialog
        // handles the request + sync, then we refresh the CTA (the copy count
        // changed, so "Add" may now read "Max N copies").
        const addCopyButton = this.querySelector('[data-role="add-copy"]');
        if (addCopyButton && !addCopyButton.disabled)
        {
            addCopyButton.addEventListener("click", async () =>
            {
                addCopyButton.disabled = true;
                addCopyButton.textContent = "Adding…";
                const added = await ManagePaidDeckCopiesDialog.addCopy(this.#deck.id);
                if (added)
                {
                    await DialogBox.alert("Copy added", "Another copy of this deck has been added to your library. You'll find it on your home page.");
                }
                this.connectedCallback();
            });
        }

        const ctaButton = this.querySelector('[data-role="cta"]');
        if (!ctaButton || ctaButton.disabled) return;

        ctaButton.addEventListener("click", async () =>
        {
            const state = this.#computeCallToActionState();

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
            const ownership = PaidDeckDetailsPage.#getOwnershipExpiry(license);

            // Time-limited (subscription) access shows an Extend action; a
            // lifetime license just reads "Already purchased". Content updates
            // arrive automatically through the normal sync pipeline, so there is
            // no separate "update available" / redownload action. An owned deck
            // also offers adding another independent copy, up to the cap.
            const copyCount = PaidDeckRegistry.getInstanceCount(deck.id);
            const maxCopies = LicenseConstants.MAX_PAID_DECK_COPIES_PER_USER;
            return { variant: "owned", label: "Already purchased", disabled: true, showOpenButton: true, showExtend: ownership.hasExpiry, expiryText: ownership.expiryText, showAddCopy: true, addCopyDisabled: copyCount >= maxCopies, maxCopies: maxCopies };
        }

        const finalMinor = deck.computedPrice?.finalPriceMinor ?? deck.basePriceMinor ?? 0;
        const currency = deck.computedPrice?.currency || deck.currency || "INR";
        return { variant: "buy", label: `Buy for ${currency} ${(finalMinor / 100).toFixed(2)}`, disabled: false, showOpenButton: false, showExtend: false, expiryText: "", showAddCopy: false, addCopyDisabled: false, maxCopies: 0 };
    }

    /**
     * Reads the buyer's license expiry. The grant model uses an epoch-zero
     * (1970) sentinel for "forever / lifetime"; a real future date means
     * time-limited access that can be extended.
     */
    static #getOwnershipExpiry(license)
    {
        if (!license || !license.expiresAt)
        {
            return { hasExpiry: false, expiryText: "" };
        }
        const expiryDate = new Date(license.expiresAt);
        if (isNaN(expiryDate.getTime()))
        {
            return { hasExpiry: false, expiryText: "" };
        }
        const expiryYear = expiryDate.getFullYear();
        // < 2001 = epoch sentinel (lifetime); > 9000 = far-future sentinel.
        if (expiryYear < 2001 || expiryYear > 9000)
        {
            return { hasExpiry: false, expiryText: "" };
        }
        return { hasExpiry: true, expiryText: `Access until ${PaidDeckDetailsPage.#formatDate(expiryDate)}` };
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

    static #formatDate(rawValue)
    {
        if (!rawValue) return "";
        const date = new Date(rawValue);
        if (isNaN(date.getTime())) return "";
        return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
}

customElements.define("paid-deck-details-page", PaidDeckDetailsPage);
export default PaidDeckDetailsPage;
