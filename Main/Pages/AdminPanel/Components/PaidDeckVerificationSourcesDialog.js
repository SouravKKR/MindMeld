import DialogBox from "../../../CommonComponents/DialogBox.js";
import SourceLicenceDeclarationForm from "../../../CommonComponents/SourceLicenceDeclarationForm.js";

/**
 * PaidDeckVerificationSourcesDialog
 *
 * Manages the documents and pages a paid deck's generated content is checked
 * AGAINST, and shows the permanent record of every licence declared for them.
 *
 * WHAT THESE SOURCES ARE. Paid-deck generation accepts a curriculum or syllabus
 * and writes content from model knowledge — it never reads a third-party
 * document, and the audit trail says so. A source attached here is read only by
 * the verification pass, which runs afterwards over content that already exists
 * and can only raise flags for a person to review. The dialog says this in as
 * many words, because an administrator who believed these were generation
 * inputs would attach the wrong things for the wrong reasons.
 *
 * TWO VIEWS, NOT ONE LIST. "Attached" is the working set a check would use right
 * now; "Declarations" is every attachment and removal ever recorded, including
 * for sources no longer attached. They are separated because only the second is
 * evidence: a source detached last month is still what a past check was carried
 * out against, and a list that quietly dropped it would leave a verification
 * nobody can trace back to the document that justified it.
 *
 * The licence declaration is mandatory and is checked BY THE SERVER as well as
 * here. This form is a courtesy that explains the rule before the request; the
 * gate is what enforces it.
 */
class PaidDeckVerificationSourcesDialog
{
    static #LIST_ENDPOINT = "/Admin/PaidDecks/VerificationSources/List";
    static #ATTACH_ENDPOINT = "/Admin/PaidDecks/VerificationSources/Attach";
    static #DETACH_ENDPOINT = "/Admin/PaidDecks/VerificationSources/Detach";
    static #RUN_ENDPOINT = "/Admin/PaidDecks/VerificationSources/Run";
    static #STATUS_ENDPOINT = "/Admin/PaidDecks/VerificationSources/Status";
    static #UPLOAD_ENDPOINT = "/InformationSource/Upload";

    /**
     * How often the run status is re-read while a check is in flight.
     *
     * The pass takes minutes, so this is slow on purpose: a one-second poll
     * would issue hundreds of requests to watch a progress line that changes
     * three times.
     */
    static #STATUS_POLL_INTERVAL_MILLISECONDS = 5000;

    static #VIEW_ATTACHED = "ATTACHED";
    static #VIEW_DECLARATIONS = "DECLARATIONS";

    static async show(deck)
    {
        if (!deck || typeof deck.id !== "string" || deck.id.length === 0)
        {
            await DialogBox.alert("No deck selected", "This row has no deck ID to attach verification sources to.");
            return;
        }

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <div class="paid-deck-verification-sources-dialog">
                    <div class="title-section">Verification sources — ${PaidDeckVerificationSourcesDialog.#escape(deck.title || deck.id)}</div>
                    <div class="verification-sources-explainer">
                        Documents and pages this deck's <strong>already-generated</strong> content is checked against.
                        They are never used to write the deck — generation reads only the syllabus — and a check can
                        only raise flags for you to review. Attaching one records a permanent declaration of the basis
                        on which it may be used.
                    </div>
                    <div class="verification-sources-tabs" role="tablist">
                        <button type="button" class="verification-sources-tab" data-view="${PaidDeckVerificationSourcesDialog.#VIEW_ATTACHED}">Attached</button>
                        <button type="button" class="verification-sources-tab" data-view="${PaidDeckVerificationSourcesDialog.#VIEW_DECLARATIONS}">Declaration history</button>
                    </div>
                    <div class="verification-sources-status" data-role="run-status" hidden></div>
                    <div class="verification-sources-error" data-role="error" hidden></div>
                    <div data-role="sources-body"></div>
                    <div class="verification-sources-actions">
                        <button type="button" class="verification-sources-secondary" data-role="attach-document">Attach a document</button>
                        <button type="button" class="verification-sources-secondary" data-role="attach-url">Attach a URL</button>
                        <button type="button" class="verification-sources-run" data-role="run-check">Run verification against sources</button>
                    </div>
                </div>
            `);

            const controller = new PaidDeckVerificationSourcesDialog(dialog, deck);
            controller.start();

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () =>
                {
                    controller.stop();
                    resolve();
                });
            }
        });
    }

    #dialog = null;
    #deck = null;
    #view = PaidDeckVerificationSourcesDialog.#VIEW_ATTACHED;
    #sources = [];
    #declarations = [];
    #runStatus = null;
    #maximumSources = 0;
    #pollTimerId = null;

    constructor(dialog, deck)
    {
        this.#dialog = dialog;
        this.#deck = deck;
    }

    start()
    {
        this.#dialog.querySelector('[data-role="attach-document"]')
            .addEventListener("click", () => this.#attachDocument());

        this.#dialog.querySelector('[data-role="attach-url"]')
            .addEventListener("click", () => this.#attachUrl());

        this.#dialog.querySelector('[data-role="run-check"]')
            .addEventListener("click", () => this.#runCheck());

        for (const tabButton of this.#dialog.querySelectorAll(".verification-sources-tab"))
        {
            tabButton.addEventListener("click", () =>
            {
                this.#view = tabButton.dataset.view;
                this.#render();
            });
        }

        this.#refresh();
    }

    stop()
    {
        // The dialog is gone; a poll that keeps firing would hold a reference to
        // detached DOM and keep issuing requests nobody is watching.
        if (this.#pollTimerId !== null)
        {
            clearTimeout(this.#pollTimerId);
            this.#pollTimerId = null;
        }
    }

    async #refresh()
    {
        try
        {
            const responseJson = await PaidDeckVerificationSourcesDialog.#post(
                PaidDeckVerificationSourcesDialog.#LIST_ENDPOINT, { deckId: this.#deck.id });

            this.#sources = Array.isArray(responseJson.sources) ? responseJson.sources : [];
            this.#declarations = Array.isArray(responseJson.declarations) ? responseJson.declarations : [];
            this.#maximumSources = Number(responseJson.maximumSources) || 0;
            this.#runStatus = responseJson.runStatus || null;

            this.#showError(null);
            this.#render();
            this.#schedulePollIfRunning();
        }
        catch (loadError)
        {
            this.#showError(loadError.message);
        }
    }

    #schedulePollIfRunning()
    {
        this.stop();

        if (!this.#runStatus || this.#runStatus.state !== "RUNNING")
        {
            return;
        }

        this.#pollTimerId = setTimeout(() => this.#pollStatus(), PaidDeckVerificationSourcesDialog.#STATUS_POLL_INTERVAL_MILLISECONDS);
    }

    async #pollStatus()
    {
        this.#pollTimerId = null;

        try
        {
            const responseJson = await PaidDeckVerificationSourcesDialog.#post(
                PaidDeckVerificationSourcesDialog.#STATUS_ENDPOINT, { deckId: this.#deck.id });

            this.#runStatus = responseJson.runStatus || null;
        }
        catch (statusError)
        {
            // A failed poll is not a failed run. Reporting it as one would tell
            // the reviewer their check died when it is still going; the next
            // poll usually succeeds.
            console.warn(`[PaidDeckVerificationSourcesDialog] Status poll failed: ${statusError.message}`);
        }

        this.#render();
        this.#schedulePollIfRunning();
    }

    #render()
    {
        const bodyElement = this.#dialog.querySelector('[data-role="sources-body"]');

        for (const tabButton of this.#dialog.querySelectorAll(".verification-sources-tab"))
        {
            tabButton.classList.toggle("verification-sources-tab-active", tabButton.dataset.view === this.#view);
        }

        bodyElement.innerHTML = this.#view === PaidDeckVerificationSourcesDialog.#VIEW_DECLARATIONS
            ? this.#buildDeclarationsMarkup()
            : this.#buildAttachedMarkup();

        this.#wireDetachButtons(bodyElement);
        this.#renderRunStatus();
        this.#renderActionAvailability();
    }

    #buildAttachedMarkup()
    {
        if (this.#sources.length === 0)
        {
            return `
                <div class="verification-sources-empty">
                    No verification sources are attached. This deck's content has been checked by the standard
                    verification only, and against no external document.
                </div>
            `;
        }

        const cards = this.#sources.map(source => `
            <div class="verification-source-card">
                <div class="verification-source-name">${PaidDeckVerificationSourcesDialog.#escape(source.name || "(unnamed)")}</div>
                <div class="verification-source-row">
                    <span class="verification-source-label">Declared licence</span>
                    <span>${PaidDeckVerificationSourcesDialog.#escape(SourceLicenceDeclarationForm.describeLicence(source.licenceType, source.licenceNote))}</span>
                </div>
                ${source.sourceUrl ? `
                    <div class="verification-source-row">
                        <span class="verification-source-label">URL</span>
                        <span class="verification-source-value-wrap">${PaidDeckVerificationSourcesDialog.#escape(source.sourceUrl)}</span>
                    </div>` : ""}
                ${source.contentHash ? `
                    <div class="verification-source-row">
                        <span class="verification-source-label">Content hash</span>
                        <span class="verification-source-value-wrap">${PaidDeckVerificationSourcesDialog.#escape(source.contentHash.slice(0, 32))}…</span>
                    </div>` : ""}
                <div class="verification-source-row">
                    <span class="verification-source-label">Declared by</span>
                    <span>${PaidDeckVerificationSourcesDialog.#escape(source.declaredByUserId || "")}</span>
                </div>
                <div class="verification-source-row">
                    <span class="verification-source-label">Attached</span>
                    <span>${source.attachedAt ? PaidDeckVerificationSourcesDialog.#escape(new Date(source.attachedAt).toLocaleString()) : ""}</span>
                </div>
                <div class="verification-source-card-actions">
                    <button type="button" class="verification-source-detach" data-source-id="${PaidDeckVerificationSourcesDialog.#escape(source.id)}">Detach</button>
                </div>
            </div>
        `).join("");

        return `<div class="verification-source-list">${cards}</div>`;
    }

    #buildDeclarationsMarkup()
    {
        if (this.#declarations.length === 0)
        {
            return `<div class="verification-sources-empty">No licence declarations have been recorded for this deck.</div>`;
        }

        // Newest first: the history is read to answer "what happened most
        // recently", and an auditor working backwards from a question about the
        // current state should not have to scroll to reach it.
        const rows = [...this.#declarations].reverse().map(declaration => `
            <tr>
                <td>${PaidDeckVerificationSourcesDialog.#escape(declaration.createdAt ? new Date(declaration.createdAt).toLocaleString() : "")}</td>
                <td><span class="verification-declaration-event verification-declaration-event-${PaidDeckVerificationSourcesDialog.#escape((declaration.event || "ATTACHED").toLowerCase())}">${PaidDeckVerificationSourcesDialog.#escape(declaration.event || "ATTACHED")}</span></td>
                <td class="verification-source-value-wrap">${PaidDeckVerificationSourcesDialog.#escape(declaration.sourceName || "")}</td>
                <td class="verification-source-value-wrap">${PaidDeckVerificationSourcesDialog.#escape(SourceLicenceDeclarationForm.describeLicence(declaration.licenceType, declaration.licenceNote))}</td>
                <td class="verification-source-value-wrap">${PaidDeckVerificationSourcesDialog.#escape(declaration.declaredByEmail || declaration.declaredByUserId || "")}</td>
            </tr>
        `).join("");

        // The table is wrapped in its own horizontal scroller. A long URL or a
        // 128-character hash must not be able to widen the dialog past the
        // viewport, which on a phone would put the close button off screen.
        return `
            <div class="verification-declaration-scroller">
                <table class="verification-declaration-table">
                    <thead>
                        <tr><th>When</th><th>Event</th><th>Source</th><th>Declared licence</th><th>Declared by</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }

    #renderRunStatus()
    {
        const statusElement = this.#dialog.querySelector('[data-role="run-status"]');

        if (!this.#runStatus)
        {
            statusElement.hidden = true;
            return;
        }

        const describeState =
        {
            RUNNING: "Checking this deck against the attached sources… this takes a few minutes.",
            FINISHED: `Check finished. ${this.#runStatus.flagsRaised || 0} flag(s) raised — open Verification to review them.`,
            FAILED: this.#runStatus.detail || "The check could not be completed.",
        };

        statusElement.textContent = describeState[this.#runStatus.state] || "";
        statusElement.hidden = statusElement.textContent.length === 0;
        statusElement.classList.toggle("verification-sources-status-failed", this.#runStatus.state === "FAILED");
    }

    #renderActionAvailability()
    {
        const bRunning = this.#runStatus !== null && this.#runStatus.state === "RUNNING";
        const bAtCapacity = this.#maximumSources > 0 && this.#sources.length >= this.#maximumSources;

        const runButton = this.#dialog.querySelector('[data-role="run-check"]');
        runButton.disabled = bRunning || this.#sources.length === 0;

        for (const role of ["attach-document", "attach-url"])
        {
            this.#dialog.querySelector(`[data-role="${role}"]`).disabled = bAtCapacity;
        }
    }

    #wireDetachButtons(bodyElement)
    {
        for (const detachButton of bodyElement.querySelectorAll(".verification-source-detach"))
        {
            detachButton.addEventListener("click", async () =>
            {
                const bConfirmed = await DialogBox.confirm(
                    "Detach this source?",
                    "The deck will no longer be checked against it. The declaration already recorded for it is "
                    + "permanent and stays in the history, and the document itself is kept as proof of that "
                    + "declaration.",
                );

                if (!bConfirmed)
                {
                    return;
                }

                detachButton.disabled = true;

                try
                {
                    await PaidDeckVerificationSourcesDialog.#post(
                        PaidDeckVerificationSourcesDialog.#DETACH_ENDPOINT,
                        { verificationSourceId: detachButton.dataset.sourceId });

                    await this.#refresh();
                }
                catch (detachError)
                {
                    detachButton.disabled = false;
                    this.#showError(detachError.message);
                }
            });
        }
    }

    async #attachDocument()
    {
        // Licence first, file second — the same order the refinement attachment
        // uses. Asking after the upload would mean a document is already stored
        // before anyone has said whether it may be.
        const declaration = await SourceLicenceDeclarationForm.prompt({
            title: "On what basis may this source be used?",
            message: "This document will be used to check content that is sold. Declare the basis on which it may be "
                + "used — you are stating this, and the document is retained alongside your declaration so it can "
                + "be produced later.",
            bShowUrlField: true,
            urlLabel: "Source URL (where this document came from)",
        });

        if (declaration === null)
        {
            return;
        }

        const selectedFile = await PaidDeckVerificationSourcesDialog.#pickFile();

        if (selectedFile === null)
        {
            return;
        }

        this.#showError(null);

        try
        {
            const informationSourceId = await PaidDeckVerificationSourcesDialog.#uploadDocument(selectedFile, declaration);

            await PaidDeckVerificationSourcesDialog.#post(PaidDeckVerificationSourcesDialog.#ATTACH_ENDPOINT, {
                deckId: this.#deck.id,
                informationSourceId: informationSourceId,
                name: selectedFile.name,
                sourceUrl: declaration.sourceUrl,
                licenceType: declaration.licenceType,
                licenceNote: declaration.licenceNote,
            });

            await this.#refresh();
        }
        catch (attachError)
        {
            this.#showError(attachError.message);
        }
    }

    async #attachUrl()
    {
        const declaration = await SourceLicenceDeclarationForm.prompt({
            title: "On what basis may this page be used?",
            message: "This page will be consulted to check content that is sold. Give its address and declare the "
                + "basis on which it may be used.",
            bShowUrlField: true,
            urlLabel: "Page URL",
        });

        if (declaration === null)
        {
            return;
        }

        if (declaration.sourceUrl.length === 0)
        {
            this.#showError("Give the address of the page to check against.");
            return;
        }

        this.#showError(null);

        try
        {
            await PaidDeckVerificationSourcesDialog.#post(PaidDeckVerificationSourcesDialog.#ATTACH_ENDPOINT, {
                deckId: this.#deck.id,
                sourceUrl: declaration.sourceUrl,
                name: declaration.sourceUrl,
                licenceType: declaration.licenceType,
                licenceNote: declaration.licenceNote,
            });

            await this.#refresh();
        }
        catch (attachError)
        {
            this.#showError(attachError.message);
        }
    }

    async #runCheck()
    {
        this.#showError(null);

        try
        {
            const responseJson = await PaidDeckVerificationSourcesDialog.#post(
                PaidDeckVerificationSourcesDialog.#RUN_ENDPOINT, { deckId: this.#deck.id });

            this.#runStatus = responseJson.runStatus || { state: "RUNNING", flagsRaised: 0 };
            this.#render();
            this.#schedulePollIfRunning();
        }
        catch (runError)
        {
            this.#showError(runError.message);
        }
    }

    #showError(message)
    {
        const errorElement = this.#dialog.querySelector('[data-role="error"]');
        errorElement.textContent = message || "";
        errorElement.hidden = !message;
    }

    static #pickFile()
    {
        return new Promise((resolve) =>
        {
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = ".pdf,.txt,.md,application/pdf,text/plain";

            fileInput.addEventListener("change", () =>
                resolve(fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null));

            // A cancelled picker fires no change event in most browsers, so the
            // promise would hang. 'cancel' is not universally supported either,
            // which is why both are wired rather than either alone.
            fileInput.addEventListener("cancel", () => resolve(null));

            fileInput.click();
        });
    }

    /**
     * Uploads through the ordinary information-source path, carrying the licence
     * declaration so it lands on the stored row.
     *
     * PERMANENT retention is requested because a source that expires in seven
     * days is not proof of anything. The retention HOLD is what actually
     * protects it once a declaration cites it; this only avoids stamping a
     * seven-day expiry in the window before that.
     */
    static async #uploadDocument(selectedFile, declaration)
    {
        const metadata =
        {
            name: selectedFile.name,
            mimeType: selectedFile.type || "application/octet-stream",
            sourceType: 0,
            retentionMode: 1,
            ocrMode: 0,
            licenceType: declaration.licenceType,
            licenceNote: declaration.licenceNote,
            sourceUrl: declaration.sourceUrl,
        };

        const formData = new FormData();
        formData.append("file", selectedFile);

        const response = await fetch(
            `${PaidDeckVerificationSourcesDialog.#UPLOAD_ENDPOINT}?metadata=${encodeURIComponent(JSON.stringify(metadata))}`,
            { method: "POST", body: formData },
        );

        if (!response.ok)
        {
            const errorJson = await response.json().catch(() => ({}));
            throw new Error(errorJson.detail || errorJson.error || `Upload failed (HTTP ${response.status}).`);
        }

        const responseJson = await response.json();

        if (!responseJson.informationSource || !responseJson.informationSource.id)
        {
            throw new Error("The upload succeeded but returned no source id.");
        }

        return responseJson.informationSource.id;
    }

    static async #post(endpoint, body)
    {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        const responseJson = await response.json().catch(() => ({}));

        if (!response.ok)
        {
            // The server's detail is preferred over its error code: the codes
            // name a rule, the details explain what is missing, and this dialog
            // is where an administrator finds out which field to fix.
            throw new Error(responseJson.detail || responseJson.error || `Request failed (HTTP ${response.status}).`);
        }

        return responseJson;
    }

    static #escape(value)
    {
        return String(value === null || value === undefined ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default PaidDeckVerificationSourcesDialog;
