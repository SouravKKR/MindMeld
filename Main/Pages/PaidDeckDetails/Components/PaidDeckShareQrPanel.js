import QrCodeRenderer from "../../../Globals/Classes/QrCodeRenderer.js";
import PaidDeckShareConstants from "../../../Globals/Constants/PaidDeckShareConstants.js";
import { copyTextToClipboard } from "../../../Globals/UtilityFunctions/CopyTextToClipboard.js";
import { download } from "../../../Globals/UtilityFunctions/Download.js";

/**
 * PaidDeckShareQrPanel
 *
 * The "Share this deck" block: a scannable QR code for a paid deck's store
 * page, the link it encodes in a readable field, and Download QR / Copy link
 * actions. Used both on the buyer-facing details page and from the admin
 * panel's deck list.
 *
 * The link points at the deep-link route, which is a door onto the SPA shell
 * rather than a page of its own — PaidDeckDeepLinkBootstrap reads the deck ID
 * off it once the app boots and navigates to the store page internally.
 *
 * The origin comes from window.location.origin, never a hardcoded domain, so
 * the same code produces a working link on localhost, on the development and
 * testing environments, and in production.
 */
class PaidDeckShareQrPanel extends HTMLElement
{
    static #COPIED_FEEDBACK_MILLISECONDS = 2000;
    static #DOWNLOAD_FILE_NAME_PREFIX = "CogniumLearn-QR-";
    static #UNSAFE_FILE_NAME_CHARACTERS = /[^a-zA-Z0-9._-]+/g;
    static #COPY_LINK_LABEL = "Copy link";
    static #COPIED_LABEL = "Copied";
    static #DOWNLOAD_LABEL = "Download QR";

    #deckId = "";
    #deckTitle = "";
    #bIsPublished = true;
    #copiedFeedbackTimeoutId = null;

    initialize(deckId, deckTitle, bIsPublished)
    {
        this.#deckId = typeof deckId === "string" ? deckId : "";
        this.#deckTitle = typeof deckTitle === "string" ? deckTitle : "";
        this.#bIsPublished = bIsPublished !== false;
    }

    connectedCallback()
    {
        if (this.#deckId.length === 0)
        {
            this.innerHTML = `<div class="paid-deck-share-qr-unavailable">This deck has no shareable link yet.</div>`;
            return;
        }

        const shareUrl = this.#buildShareUrl();

        this.innerHTML = `
            <div class="paid-deck-share-qr-layout">
                <div class="paid-deck-share-qr-surface" data-role="qr-surface">
                    <div class="paid-deck-share-qr-placeholder">Preparing QR code…</div>
                </div>
                <div class="paid-deck-share-qr-details">
                    <div class="paid-deck-share-qr-hint">Scan this code, or share the link, to open this deck's store page.</div>
                    <input
                        class="paid-deck-share-qr-link-field"
                        data-role="share-link"
                        type="text"
                        readonly
                        value="${PaidDeckShareQrPanel.#escape(shareUrl)}">
                    <div class="paid-deck-share-qr-actions">
                        <button type="button" class="paid-deck-share-qr-button" data-role="download-qr">
                            ${PaidDeckShareQrPanel.#DOWNLOAD_LABEL}
                        </button>
                        <button type="button" class="paid-deck-share-qr-button" data-role="copy-link">
                            ${PaidDeckShareQrPanel.#COPY_LINK_LABEL}
                        </button>
                    </div>
                    ${this.#bIsPublished ? "" : `
                        <div class="paid-deck-share-qr-unpublished-notice">
                            This deck is not published yet — the link will not open until it is.
                        </div>
                    `}
                </div>
            </div>
        `;

        this.#wireActions();
        this.#renderQrCode(shareUrl);
    }

    disconnectedCallback()
    {
        if (this.#copiedFeedbackTimeoutId !== null)
        {
            clearTimeout(this.#copiedFeedbackTimeoutId);
            this.#copiedFeedbackTimeoutId = null;
        }
    }

    #buildShareUrl()
    {
        const queryParameterName = PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER;
        return `${window.location.origin}${PaidDeckShareConstants.DEEP_LINK_ROUTE_PATH}?${queryParameterName}=${encodeURIComponent(this.#deckId)}`;
    }

    async #renderQrCode(shareUrl)
    {
        const svgMarkup = await QrCodeRenderer.renderSvgMarkup(shareUrl);

        // The details page rebuilds itself wholesale after a purchase / extend /
        // add-copy, which throws this element away while the encoder may still
        // be loading. Without this guard a resolved render would write into a
        // detached node — invisible, but a leak of work and a confusing DOM.
        if (!this.isConnected)
        {
            return;
        }

        const qrSurfaceElement = this.querySelector('[data-role="qr-surface"]');
        if (!qrSurfaceElement)
        {
            return;
        }

        if (svgMarkup.length === 0)
        {
            qrSurfaceElement.innerHTML = `<div class="paid-deck-share-qr-placeholder">QR code unavailable — the link above still works.</div>`;
            return;
        }

        qrSurfaceElement.innerHTML = svgMarkup;
    }

    #wireActions()
    {
        const downloadButton = this.querySelector('[data-role="download-qr"]');
        if (downloadButton)
        {
            downloadButton.addEventListener("click", () => this.#handleDownloadQrCode(downloadButton));
        }

        const copyLinkButton = this.querySelector('[data-role="copy-link"]');
        if (copyLinkButton)
        {
            copyLinkButton.addEventListener("click", () => this.#handleCopyLink(copyLinkButton));
        }

        // Selecting the whole link on focus makes a manual copy one keystroke
        // away wherever the Clipboard API is unavailable.
        const shareLinkField = this.querySelector('[data-role="share-link"]');
        if (shareLinkField)
        {
            shareLinkField.addEventListener("focus", () => shareLinkField.select());
        }
    }

    async #handleDownloadQrCode(downloadButton)
    {
        downloadButton.disabled = true;
        downloadButton.textContent = "Preparing…";

        try
        {
            const pngBytes = await QrCodeRenderer.renderPngBytes(this.#buildShareUrl(), PaidDeckShareConstants.QR_MODULE_TARGET_PIXEL_SIZE);

            if (pngBytes)
            {
                download(pngBytes, PaidDeckShareQrPanel.#buildFileName(this.#deckTitle, this.#deckId), "image/png");
            }
            else
            {
                console.warn("[PaidDeckShareQrPanel] QR code could not be rasterised — nothing to download.");
            }
        }
        finally
        {
            if (this.isConnected)
            {
                downloadButton.disabled = false;
                downloadButton.textContent = PaidDeckShareQrPanel.#DOWNLOAD_LABEL;
            }
        }
    }

    async #handleCopyLink(copyLinkButton)
    {
        const bCopied = await copyTextToClipboard(this.#buildShareUrl());
        if (!bCopied || !this.isConnected)
        {
            return;
        }

        // Inline label feedback rather than a dialog: confirming a copy with a
        // modal is heavier than the action it is confirming.
        copyLinkButton.textContent = PaidDeckShareQrPanel.#COPIED_LABEL;

        if (this.#copiedFeedbackTimeoutId !== null)
        {
            clearTimeout(this.#copiedFeedbackTimeoutId);
        }

        this.#copiedFeedbackTimeoutId = setTimeout(() =>
        {
            this.#copiedFeedbackTimeoutId = null;
            if (this.isConnected)
            {
                copyLinkButton.textContent = PaidDeckShareQrPanel.#COPY_LINK_LABEL;
            }
        }, PaidDeckShareQrPanel.#COPIED_FEEDBACK_MILLISECONDS);
    }

    static #buildFileName(deckTitle, deckId)
    {
        const rawName = deckTitle.length > 0 ? deckTitle : deckId;
        const safeName = rawName.replace(PaidDeckShareQrPanel.#UNSAFE_FILE_NAME_CHARACTERS, "_");
        return `${PaidDeckShareQrPanel.#DOWNLOAD_FILE_NAME_PREFIX}${safeName}.png`;
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

customElements.define("paid-deck-share-qr-panel", PaidDeckShareQrPanel);
export default PaidDeckShareQrPanel;
