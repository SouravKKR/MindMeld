import DialogBox from "../../../CommonComponents/DialogBox.js";
import SourceLicenceDeclarationForm from "../../../CommonComponents/SourceLicenceDeclarationForm.js";
import { sourceUsageModes } from "../../../Globals/Enumerations/SourceUsageModes.js";

/**
 * PaidDeckVerificationSourcesDialog
 *
 * Manages the documents and pages a paid deck's generated content is checked
 * against — or written from — and shows the permanent record of every licence
 * declared for them.
 *
 * WHAT A SOURCE IS USED FOR IS PER SOURCE, and the dialog shows it on every
 * card because the three mean very different things:
 *
 *   Checking only — the default. The document is read by the verification pass,
 *       which runs after content already exists and can only raise flags for a
 *       person to review. Nothing in the deck was written from it.
 *   Writing content, and checking — the deck's content may also be written from
 *       this document, and the result is then checked back against it. Offered
 *       only under a licence that records a right to create new material from
 *       it, and refused by the server otherwise.
 *   Writing content only — written from, and deliberately kept out of the
 *       checks. Held to the same licence rule as the mode above; what differs is
 *       that the document is not a fair yardstick for the whole deck. A chapter
 *       covering part of the syllabus, or a past question paper, writes its part
 *       well and would report everything outside its scope as a gap.
 *
 * They rest on different bases — independent creation for the first, the
 * declared licence for the other two — and the audit report keeps them apart,
 * per topic. An administrator who could not see which a source was would not be
 * able to tell which claim their deck actually supports. The badge is three
 * states for that reason: the distinction that matters most on this card is
 * between the two writing modes, which is exactly the one a content/not-content
 * badge would hide.
 *
 * The ordinary generation source list is unaffected: it still accepts a
 * curriculum or syllabus and nothing else. A licensed document reaches
 * generation through this dialog, where its licence is declared and the file is
 * retained as proof, or not at all.
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
    static #UPDATE_ENDPOINT = "/Admin/PaidDecks/VerificationSources/Update";
    static #DETACH_ENDPOINT = "/Admin/PaidDecks/VerificationSources/Detach";
    static #DOWNLOAD_ENDPOINT = "/Admin/PaidDecks/VerificationSource";
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

        this.#wireEditButtons(bodyElement);
        this.#wireDownloadButtons(bodyElement);
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
                    <span class="verification-source-label">Used for</span>
                    <span class="verification-source-usage ${PaidDeckVerificationSourcesDialog.#buildUsageClassName(source.usageMode)}">
                        ${SourceLicenceDeclarationForm.describeUsage(source.usageMode)}
                    </span>
                </div>
                ${source.sourceNote ? `
                    <div class="verification-source-row">
                        <span class="verification-source-label">Note</span>
                        <span class="verification-source-value-wrap">${PaidDeckVerificationSourcesDialog.#escape(source.sourceNote)}</span>
                    </div>` : ""}
                <div class="verification-source-row">
                    <span class="verification-source-label">Attached</span>
                    <span>${source.attachedAt ? PaidDeckVerificationSourcesDialog.#escape(new Date(source.attachedAt).toLocaleString()) : ""}</span>
                </div>
                <div class="verification-source-card-actions">
                    <button type="button" class="verification-source-edit" data-source-id="${PaidDeckVerificationSourcesDialog.#escape(source.id)}">Edit note / usage</button>
                    ${source.contentHash ? `
                        <button type="button" class="verification-source-download" data-source-id="${PaidDeckVerificationSourcesDialog.#escape(source.id)}">Download source</button>` : ""}
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

    /**
     * "Edit note / usage" — the two fields on an attached source that may
     * legitimately be revised after the fact.
     *
     * Everything else about a source is fixed at attach time: its document, its
     * hash, its licence, who declared it and when. Changing one of those is a
     * different source, and should be a detach and a re-attach that both appear
     * in the history rather than an edit that quietly rewrites it.
     *
     * The edit itself appends to the declaration log — the server writes the
     * event before touching the row — so the previous note and the previous
     * usage stay visible in the Declarations tab.
     */
    #wireEditButtons(bodyElement)
    {
        for (const editButton of bodyElement.querySelectorAll(".verification-source-edit"))
        {
            editButton.addEventListener("click", async () =>
            {
                const source = this.#sources.find(candidate => candidate.id === editButton.dataset.sourceId);

                if (!source)
                {
                    return;
                }

                const revision = await PaidDeckVerificationSourcesDialog.#promptSourceRevision(source);

                if (revision === null)
                {
                    return;
                }

                editButton.disabled = true;
                this.#showError(null);

                try
                {
                    await PaidDeckVerificationSourcesDialog.#post(
                        PaidDeckVerificationSourcesDialog.#UPDATE_ENDPOINT,
                        {
                            verificationSourceId: source.id,
                            usageMode: revision.usageMode,
                            sourceNote: revision.sourceNote,
                        });

                    await this.#refresh();
                }
                catch (updateError)
                {
                    editButton.disabled = false;
                    this.#showError(updateError.message);
                }
            });
        }
    }

    /**
     * "Download source" — retrieves the declared document itself.
     *
     * Navigated to rather than fetched, so the browser's own download handling
     * takes it: the response is a file with a Content-Disposition, and reading
     * it into memory here to re-offer it would gain nothing and would break for
     * a large textbook. Shown only for a source that has stored bytes; a
     * URL-only source has none of ours to serve.
     */
    #wireDownloadButtons(bodyElement)
    {
        for (const downloadButton of bodyElement.querySelectorAll(".verification-source-download"))
        {
            downloadButton.addEventListener("click", () =>
            {
                const downloadUrl = `${PaidDeckVerificationSourcesDialog.#DOWNLOAD_ENDPOINT}`
                    + `?verificationSourceId=${encodeURIComponent(downloadButton.dataset.sourceId)}`;

                window.open(downloadUrl, "_blank");
            });
        }
    }

    /**
     * Asks for the revised usage and note, seeded with what is stored now.
     *
     * Reuses SourceLicenceDeclarationForm's rule about which licences permit
     * content usage rather than restating it, so the disabled option and the
     * reason behind it stay in one place. The licence itself is shown but not
     * editable here — it is what the rule is applied TO.
     */
    static #promptSourceRevision(source)
    {
        // Through the shared normaliser, never a ternary over the modes this
        // file happens to name. A ternary silently rewrites anything it does not
        // recognise, so opening this dialog on a source would have offered a
        // downgrade as its default and saved one on OK.
        const storedUsageMode = SourceLicenceDeclarationForm.normaliseUsageMode(source.usageMode);

        const bPermitsContent = SourceLicenceDeclarationForm.permitsContentUsage(source.licenceType);

        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <div class="source-licence-dialog">
                    <div class="title-section">Edit this source</div>
                    <div class="message-section">
                        Declared licence:
                        ${PaidDeckVerificationSourcesDialog.#escape(
                            SourceLicenceDeclarationForm.describeLicence(source.licenceType, source.licenceNote))}.
                        The licence itself cannot be changed here — detach the source and re-attach it if it was
                        declared wrongly, so both acts appear in the history.
                        This deck's content has already been written, so changing the usage now affects only
                        future checks: setting a source to write content only removes it from them, and nothing
                        already generated changes either way.
                    </div>
                    <div class="source-licence-fields">
                        <label class="source-licence-field">
                            <span>How this source is used</span>
                            <select data-role="source-usage-mode">
                                ${SourceLicenceDeclarationForm.buildUsageModeOptionsMarkup(
                                    storedUsageMode, bPermitsContent)}
                            </select>
                        </label>
                        <label class="source-licence-field">
                            <span>Note (anything worth recording about this source — kept in the audit report)</span>
                            <textarea data-role="source-note" maxlength="2048" rows="3"></textarea>
                        </label>
                        <div class="source-licence-error" data-role="licence-error" hidden></div>
                    </div>
                    <div class="button-section">
                        <button type="button" class="cancel-button">Cancel</button>
                        <button type="button" class="ok-button">Save</button>
                    </div>
                </div>
            `);

            // The usage select is not assigned here: the markup carries the
            // selection, and it declines to pre-select an option it had to
            // disable. Assigning the stored value afterwards would put the
            // select back onto a disabled option, which submits.
            dialog.querySelector('[data-role="source-note"]').value = source.sourceNote || "";

            let bResolved = false;
            const finalize = (value) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve(value);
            };

            dialog.querySelector(".ok-button").addEventListener("click", () =>
            {
                const usageMode = Number(dialog.querySelector('[data-role="source-usage-mode"]').value);
                const sourceNote = dialog.querySelector('[data-role="source-note"]').value.trim();

                if (SourceLicenceDeclarationForm.isContentUsage(usageMode) && !bPermitsContent)
                {
                    const errorElement = dialog.querySelector('[data-role="licence-error"]');
                    errorElement.textContent = "This licence does not record a right to create new material from the source.";
                    errorElement.hidden = false;
                    return;
                }

                finalize({ usageMode: usageMode, sourceNote: sourceNote });
            });

            dialog.querySelector(".cancel-button").addEventListener("click", () => finalize(null));

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(null));
            }
        });
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
            message: "This document will be used against content that is sold — to check it, and, if you say so "
                + "below, to write it. Declare the basis on which it may be used: you are stating this, and the "
                + "document is retained alongside your declaration so it can be produced later.",
            bShowUrlField: true,
            bShowUsageFields: true,
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
                usageMode: declaration.usageMode,
                sourceNote: declaration.sourceNote,
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
            message: "This page will be consulted against content that is sold. Give its address and declare the "
                + "basis on which it may be used.",
            bShowUrlField: true,
            bShowUsageFields: true,
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
                usageMode: declaration.usageMode,
                sourceNote: declaration.sourceNote,
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

    /**
     * The badge's modifier class for one stored usage mode.
     *
     * Three states rather than two, and named after the mode rather than after
     * "is it content", because the difference the reviewer is looking for on
     * this card is precisely between the two content modes: one of them was
     * checked back against the document and one was deliberately not.
     */
    static #buildUsageClassName(usageMode)
    {
        switch (SourceLicenceDeclarationForm.normaliseUsageMode(usageMode))
        {
            case sourceUsageModes.CONTENT_AND_VERIFICATION:
                return "verification-source-usage-content";

            case sourceUsageModes.CONTENT_ONLY:
                return "verification-source-usage-content-only";

            default:
                return "verification-source-usage-verification";
        }
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
