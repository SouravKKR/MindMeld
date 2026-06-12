import TermsAndConditionsConstants from "../Constants/TermsAndConditionsConstants.js";
import UserIdentityManager from "./UserIdentityManager.js";
import LegalDocumentPdfRenderer from "./LegalDocumentPdfRenderer.js";

/**
 * TermsAndConditionsManager
 *
 * Owns the post-login legal-agreement flow for every legal document the
 * server exposes (today: Terms of Service + Privacy Policy).
 * `LoginPopupSequence` invokes `runForLogin(user)` as step 1 of its
 * serial welcome-popup chain — this class is no longer subscribed to
 * ON_USER_LOGGED_IN directly so it never races the other welcome popups.
 *
 *   1. Fetch `/LegalDocuments` (server-seeded array of { key, title,
 *      version, contentHtml }).
 *   2. For each document, look up the user's stored `agreed<Key>Version`
 *      in `additionalData`. Skip the document if the stored version is
 *      already at or above the server's.
 *   3. Otherwise, show a non-dismissable modal — title comes from the
 *      server, body is the server's contentHtml. Documents are shown
 *      sequentially in server order so the user never juggles two
 *      stacked modals.
 *   4. On Agree → POST `/Legal/Accept` with the document key + version. The
 *      server validates the version against the live document, records the
 *      consent (server version + timestamp) and returns the updated
 *      additionalData, which is mirrored onto the in-memory User so
 *      subsequent sessions don't re-prompt. `/Legal/Accept` is the only
 *      writer of consent state; the server's global legal-acceptance gate
 *      blocks all other endpoints until this completes.
 *   5. On Decline → call /Logout and reload.
 *
 * Version-key naming convention: `agreedTermsOfServiceVersion`,
 * `agreedPrivacyPolicyVersion`, etc. The key is derived from the
 * document's `key` by lower-camel-casing the snake-case identifier
 * (TERMS_OF_SERVICE → "TermsOfService"; PRIVACY_POLICY → "PrivacyPolicy").
 */
class TermsAndConditionsManager
{
    static #LEGAL_DOCUMENTS_ENDPOINT = "/LegalDocuments";
    static #ACCEPT_ENDPOINT          = "/Legal/Accept";
    static #LOGOUT_ENDPOINT          = "/Logout";

    static #AGREED_VERSION_KEY_PREFIX = "agreed";
    static #AGREED_VERSION_KEY_SUFFIX = "Version";
    static #AGREED_AT_KEY_SUFFIX      = "At";

    /**
     * Public entry point invoked by LoginPopupSequence. Resolves only
     * after every required legal modal has been agreed to (or the
     * decline path's logout-and-reload has been kicked off). Returns
     * immediately for anonymous identities — they have no per-account
     * additionalData to write the agreement into.
     */
    static async runForLogin(user)
    {
        await TermsAndConditionsManager.#handleUserLoggedIn(user);
    }

    static async #handleUserLoggedIn(user)
    {
        if (!user)
        {
            return;
        }

        // Legal flow is logged-in-only. If the identity is still
        // anonymous when this listener fires (race during boot), skip —
        // there's no server-backed additionalData to write to.
        if (UserIdentityManager.isAnonymous())
        {
            return;
        }

        let legalDocuments;
        try
        {
            legalDocuments = await TermsAndConditionsManager.#fetchLegalDocuments();
        }
        catch (fetchError)
        {
            console.error("[TermsAndConditionsManager] Failed to fetch /LegalDocuments:", fetchError);
            return;
        }

        if (!Array.isArray(legalDocuments) || legalDocuments.length === 0)
        {
            return;
        }

        const additionalData = user.getAdditionalData() || {};

        // Chain documents one after the other so two modals never stack.
        // Each iteration awaits the modal's resolution (or skip) before
        // showing the next.
        for (const legalDocument of legalDocuments)
        {
            const agreedVersionKey = TermsAndConditionsManager.#buildAgreedVersionKey(legalDocument.key);
            const storedVersion = Number(additionalData[agreedVersionKey] || 0);

            if (storedVersion >= Number(legalDocument.version))
            {
                continue;
            }

            // Show + await user response. If the user declines, the
            // logout/reload path takes over and the loop is moot.
            // eslint-disable-next-line no-await-in-loop
            await TermsAndConditionsManager.#showDocument(user, legalDocument);

            // After Agree, mirror the persisted change back onto the
            // local snapshot so the next iteration's check sees it.
            const refreshedAdditionalData = user.getAdditionalData() || {};
            additionalData[agreedVersionKey] = refreshedAdditionalData[agreedVersionKey];
        }
    }

    /**
     * Fetches a single legal document by key and triggers a browser
     * download as plain text. Used by the sign-in Terms of Service /
     * Privacy Policy hyperlinks for logged-out users so they can read
     * the documents offline before deciding to sign in.
     *
     * @param {string} documentKey - The server's document key (e.g. "TERMS_OF_SERVICE").
     */
    static async downloadDocument(documentKey)
    {
        let legalDocuments;
        try
        {
            legalDocuments = await TermsAndConditionsManager.#fetchLegalDocuments();
        }
        catch (fetchError)
        {
            console.error("[TermsAndConditionsManager] download fetch failed:", fetchError);
            return;
        }

        const document_ = Array.isArray(legalDocuments)
            ? legalDocuments.find(entry => entry.key === documentKey)
            : null;

        if (!document_)
        {
            return;
        }

        TermsAndConditionsManager.#triggerDownload(document_);
    }

    static async #fetchLegalDocuments()
    {
        const response = await fetch(TermsAndConditionsManager.#LEGAL_DOCUMENTS_ENDPOINT);

        if (!response.ok)
        {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();
    }

    /**
     * Shows a single legal-document modal and resolves once the user has
     * Agreed (and the agreement has been persisted) or the logout path
     * has been triggered. Idempotent across overlapping calls — one
     * dialog at a time.
     */
    static #showDocument(user, legalDocument)
    {
        return new Promise((resolve) =>
        {
            const dialog = document.createElement("dialog-box");
            dialog.classList.add("terms-conditions-dialog");
            document.body.appendChild(dialog);

            const escapedTitle = TermsAndConditionsManager.#escapeHtml(legalDocument.title);
            const safeContent = TermsAndConditionsManager.#sanitizeContentHtml(legalDocument.contentHtml);

            dialog.innerHTML =
            `
                <button class="close-button" title="Close (decline and log out)">
                    <img src="./Globals/Assets/Images/Icons/CloseIcon.svg" alt="Close">
                </button>
                <div class="title-section">${escapedTitle}</div>
                <div class="message-section terms-conditions-content">
                    ${safeContent}
                </div>
                <div class="terms-conditions-error" hidden></div>
                <div class="button-section terms-conditions-buttons">
                    <button class="download-button">${TermsAndConditionsConstants.DOWNLOAD_BUTTON_LABEL}</button>
                    <button class="decline-button cancel-button">${TermsAndConditionsConstants.DECLINE_BUTTON_LABEL}</button>
                    <button class="agree-button ok-button">${TermsAndConditionsConstants.AGREE_BUTTON_LABEL}</button>
                </div>
            `;

            const closeButton    = dialog.querySelector(".close-button");
            const downloadButton = dialog.querySelector(".download-button");
            const declineButton  = dialog.querySelector(".decline-button");
            const agreeButton    = dialog.querySelector(".agree-button");
            const errorElement   = dialog.querySelector(".terms-conditions-error");

            // Closing the dialog (X / Escape) routes to decline so terms
            // must be either accepted or refused, never silently bypassed.
            const triggerDecline = async () =>
            {
                if (agreeButton.disabled)
                {
                    return;
                }
                agreeButton.disabled   = true;
                declineButton.disabled = true;
                closeButton.disabled   = true;
                await TermsAndConditionsManager.#logoutAndReload();
            };

            closeButton.addEventListener("click", triggerDecline);

            const escapeKeyHandler = (keyDownEvent) =>
            {
                if (keyDownEvent.key === "Escape")
                {
                    keyDownEvent.preventDefault();
                    triggerDecline();
                }
            };
            window.addEventListener("keydown", escapeKeyHandler);

            const cleanupObserver = new MutationObserver(() =>
            {
                if (!document.body.contains(dialog))
                {
                    window.removeEventListener("keydown", escapeKeyHandler);
                    cleanupObserver.disconnect();
                }
            });
            cleanupObserver.observe(document.body, { childList: true });

            downloadButton.addEventListener("click", () =>
            {
                TermsAndConditionsManager.#triggerDownload(legalDocument);
            });

            declineButton.addEventListener("click", triggerDecline);

            agreeButton.addEventListener("click", async () =>
            {
                agreeButton.disabled   = true;
                declineButton.disabled = true;
                const originalAgreeLabel = agreeButton.textContent;
                agreeButton.textContent  = "Saving…";
                errorElement.hidden      = true;
                errorElement.textContent = "";

                const persisted = await TermsAndConditionsManager.#persistAgreement(user, legalDocument);

                if (!persisted)
                {
                    agreeButton.disabled   = false;
                    declineButton.disabled = false;
                    agreeButton.textContent = originalAgreeLabel;
                    errorElement.textContent = "Couldn't save your agreement. Check your connection and try again. If this keeps happening, restart the app.";
                    errorElement.hidden = false;
                    return;
                }

                dialog.remove();
                resolve();
            });
        });
    }

    static #triggerDownload(legalDocument)
    {
        let blob;
        try
        {
            blob = LegalDocumentPdfRenderer.renderToBlob(legalDocument);
        }
        catch (renderError)
        {
            // Fall back to plain text only if the PDF pipeline outright fails
            // (e.g. jsPDF script missing in some embedded surface) so users
            // can still leave with a readable copy of the document.
            console.error("[TermsAndConditionsManager] PDF render failed, falling back to plain text:", renderError);
            const plainText = TermsAndConditionsManager.#stripHtmlToPlainText(legalDocument.contentHtml);
            blob = new Blob([plainText], { type: "text/plain;charset=utf-8" });
        }

        const downloadUrl = URL.createObjectURL(blob);

        const safeBaseName = (legalDocument.title || "Legal-Document").replace(/\s+/g, "-");
        const fileExtension = (blob.type === "application/pdf") ? "pdf" : "txt";
        const fileName = TermsAndConditionsConstants.DOWNLOAD_FILE_NAME_TEMPLATE
            .replace("{title}", safeBaseName)
            .replace("{ext}", fileExtension);

        const anchorElement = document.createElement("a");
        anchorElement.href     = downloadUrl;
        anchorElement.download = fileName;
        document.body.appendChild(anchorElement);
        anchorElement.click();
        anchorElement.remove();

        URL.revokeObjectURL(downloadUrl);
    }

    static async #persistAgreement(user, legalDocument)
    {
        try
        {
            const response = await fetch(TermsAndConditionsManager.#ACCEPT_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(
                {
                    documentKey: legalDocument.key,
                    version:     Number(legalDocument.version)
                })
            });

            if (!response.ok)
            {
                console.error(`[TermsAndConditionsManager] persist failed: status ${response.status}`);
                return false;
            }

            const responseJson = await response.json();
            const serverAdditionalData = responseJson?.additionalData;

            if (serverAdditionalData)
            {
                user.setAdditionalData(serverAdditionalData);
            }
            else
            {
                // Fallback mirror only if the server omitted the echo — the
                // server is still the authority on the recorded version.
                const agreedVersionKey = TermsAndConditionsManager.#buildAgreedVersionKey(legalDocument.key);
                const agreedAtKey      = TermsAndConditionsManager.#buildAgreedAtKey(legalDocument.key);
                const merged = { ...(user.getAdditionalData() || {}),
                    [agreedVersionKey]: Number(legalDocument.version),
                    [agreedAtKey]:      new Date().toISOString() };
                user.setAdditionalData(merged);
            }

            return true;
        }
        catch (error)
        {
            console.error("[TermsAndConditionsManager] persist failed:", error);
            return false;
        }
    }

    static async #logoutAndReload()
    {
        try
        {
            // /Logout is registered without an explicit method on the
            // server, so it only matches GET (the framework default).
            // Sending POST silently fails to delete the session and the
            // page reloads with the user still authenticated — which
            // makes this same dialog re-appear in an endless loop.
            await fetch(TermsAndConditionsManager.#LOGOUT_ENDPOINT);
        }
        catch (error)
        {
            console.error("[TermsAndConditionsManager] logout failed:", error);
        }
        window.location.reload();
    }

    // ── Key derivation ──────────────────────────────────────────────────

    /**
     * Translates a snake-cased document key (e.g. "PRIVACY_POLICY") into
     * its camel-cased agreed-version field name on additionalData
     * (e.g. "agreedPrivacyPolicyVersion"; "TERMS_OF_SERVICE" →
     * "agreedTermsOfServiceVersion").
     */
    static #buildAgreedVersionKey(documentKey)
    {
        return TermsAndConditionsManager.#AGREED_VERSION_KEY_PREFIX
            + TermsAndConditionsManager.#toCamel(documentKey)
            + TermsAndConditionsManager.#AGREED_VERSION_KEY_SUFFIX;
    }

    static #buildAgreedAtKey(documentKey)
    {
        return TermsAndConditionsManager.#AGREED_VERSION_KEY_PREFIX
            + TermsAndConditionsManager.#toCamel(documentKey)
            + TermsAndConditionsManager.#AGREED_AT_KEY_SUFFIX;
    }

    static #toCamel(snakeCaseString)
    {
        const lowered = String(snakeCaseString || "").toLowerCase();
        return lowered
            .split("_")
            .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
            .join("");
    }

    // ── HTML hygiene ────────────────────────────────────────────────────

    /**
     * Strips any <script> / <style> blocks and inline event handler
     * attributes (`on*`) from the server-supplied HTML before insertion.
     * The seed JSON is operator-controlled and trusted, but this is a
     * cheap defence-in-depth against accidental copy-paste of user-
     * generated content into the seed file later.
     */
    static #sanitizeContentHtml(rawHtml)
    {
        if (typeof rawHtml !== "string")
        {
            return "";
        }
        return rawHtml
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
            .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
    }

    static #stripHtmlToPlainText(rawHtml)
    {
        if (typeof rawHtml !== "string")
        {
            return "";
        }
        const parser = new DOMParser();
        const parsed = parser.parseFromString(rawHtml, "text/html");
        return parsed.body.innerText.trim();
    }

    static #escapeHtml(rawString)
    {
        if (rawString === null || rawString === undefined)
        {
            return "";
        }
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

export default TermsAndConditionsManager;
