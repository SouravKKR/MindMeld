import DialogBox from "./DialogBox.js";
import { supportTicketTypes } from "../Globals/Enumerations/SupportTicketTypes.js";
import { supportTicketStatus } from "../Globals/Enumerations/SupportTicketStatus.js";
import { supportTicketReportStatus } from "../Globals/Enumerations/SupportTicketReportStatus.js";
import { enumerationToTitleCase } from "../Globals/UtilityFunctions/EnumerationToTitleCase.js";

/**
 * ReportIssueDialog
 *
 * The in-app replacement for the old support mailto: link, in two modes behind
 * one component.
 *
 *   AUTHENTICATED (show)      — every issue type, plus "Your reports".
 *   PUBLIC        (showPublic) — the types that do not need an account: a
 *                                copyright / IP complaint, and "I can't sign
 *                                in". Reachable from the sign-in screen and
 *                                from /copyright.
 *
 * ── Why ONE component rather than two ──────────────────────────────────────
 *
 * The two doors have to collect the same things and say the same things, and
 * the reliable way to guarantee that is for there to be one implementation of
 * each field, each limit and each error message. Two dialogs would drift, and
 * the one that drifted would be the unauthenticated one — the door used by
 * people who are not our users and cannot tell us it is broken. What differs
 * between the modes is only which issue types are offered and whether a contact
 * address is asked for; both of those are one branch each.
 *
 * ── The three flows inside it ──────────────────────────────────────────────
 *
 * A SUPPORT REPORT posts once and is done.
 *
 * A COPYRIGHT COMPLAINT posts, then asks for a code sent to the address given,
 * then offers to attach evidence. The complaint is already recorded before the
 * code is entered — the confirmation decides whether it becomes actionable, not
 * whether it was received, and the dialog says so in as many words so nobody
 * abandons the form believing nothing happened.
 *
 * "Your reports" is not a nicety. Someone who leaves the notify box unchecked
 * has declined an email, not declined the right to know whether their problem
 * was fixed — so the status is always available there regardless of that choice.
 */
class ReportIssueDialog
{
    // Mirrors Dock/Globals/Classes/Support/SupportTicketLimits.js and
    // SupportAttachmentPolicy.js. Enforced here only to give immediate feedback —
    // the server re-checks every one of these against the bytes that arrive, so a
    // bypassed client-side guard changes nothing.
    static MINIMUM_DESCRIPTION_LENGTH = 20;
    static MAXIMUM_DESCRIPTION_LENGTH = 4000;
    static MAXIMUM_ATTACHMENT_COUNT = 5;
    static MAXIMUM_FILE_BYTES = 10 * 1024 * 1024;
    static ACCEPTED_MIME_TYPES = "image/png,image/jpeg,image/webp,image/gif,application/pdf";

    // Mirrors Common/Constants/IntellectualPropertyComplaintConstants.json.
    static MINIMUM_WORK_DESCRIPTION_LENGTH = 20;
    static MINIMUM_LOCATION_DESCRIPTION_LENGTH = 20;

    static ALLOWED_MIME_TYPE_SET = new Set
    ([
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "image/gif",
        "application/pdf"
    ]);

    /**
     * Labels that must NOT be derived from the enum name.
     *
     * Every other type is title-cased straight from its member name, which keeps
     * the client and the admin list on one vocabulary with no label map to
     * drift. These two are the exceptions, and both for the same reason: the
     * enum names are written for storage and the labels have to be findable by
     * someone searching the page for a word they already have in mind.
     * "Intellectual Property" is invisible to a person looking for "copyright",
     * and "Account Access" is invisible to one looking for "can't sign in".
     */
    static ISSUE_TYPE_LABELS =
    {
        INTELLECTUAL_PROPERTY: "Copyright / IP infringement",
        ACCOUNT_ACCESS: "Can't sign in / account access"
    };

    /**
     * The types the public form offers. Mirrors
     * Dock/Globals/Classes/Support/PublicReportPolicy.js — the server is the
     * authority and refuses anything else, so this list only decides what is
     * shown.
     */
    static PUBLIC_ISSUE_TYPE_NAMES = ["INTELLECTUAL_PROPERTY", "ACCOUNT_ACCESS"];

    /**
     * Which fields this dialog shows, for one issue type in one mode.
     *
     * A pure function rather than logic inlined in the open handler, because
     * the rules are the feature: the form has to ask for exactly what it needs
     * and nothing else, and the three modes are easy to get subtly wrong when
     * the decision is spread across a handful of `hidden` assignments.
     *
     * ── The rules, and why each is what it is ─────────────────────────────
     *
     * CONTACT ADDRESS is asked for only when we do not already have one. For a
     * signed-in bug report we do — asking again is a field to fill for no
     * reason, and a second address to reconcile if the two differ. It IS asked
     * for on every complaint, signed in or not, because the complainant may be
     * writing for a rights owner who is not the account holder and the reply
     * has to reach the correspondent; it is prefilled from the session when
     * there is one, so the common case is still a glance rather than typing.
     * And it is asked for on every public report, because there is no session
     * to take it from.
     *
     * THE COMPLAINT PARTICULARS — name, capacity, the work, where it appears,
     * the two statements — belong to a copyright complaint alone. They exist to
     * satisfy Clause 19.4 of the Terms, and putting them in front of somebody
     * reporting that a button does not work is noise that makes the real form
     * look like a legal instrument.
     *
     * THE NOTIFY CHOICE is a choice only an account holder has. A public
     * reporter has no in-app "Your reports" view to fall back on, so the email
     * is their only channel and it is always sent — offering a checkbox that
     * cannot meaningfully be unticked would be a lie. A complaint is answered by
     * the Grievance Officer under a published deadline, which is not something
     * anyone opts out of either.
     *
     * @param {string} issueTypeName
     * @param {boolean} bPublicMode
     * @returns {{bComplaintFields: boolean, bReportFields: boolean, bContactField: boolean, bNotifyChoice: boolean}}
     */
    static resolveFieldVisibility(issueTypeName, bPublicMode)
    {
        const bComplaint = issueTypeName === "INTELLECTUAL_PROPERTY";

        return {
            bComplaintFields: bComplaint,
            bReportFields: !bComplaint,
            bContactField: bComplaint || bPublicMode === true,
            bNotifyChoice: !bComplaint && bPublicMode !== true
        };
    }

    /**
     * Opens the dialog for a signed-in user.
     *
     * @returns {Promise<boolean>} True when something was successfully submitted.
     */
    static async show()
    {
        const currentUser = window["user"];

        if (!currentUser || typeof currentUser.getId !== "function" || !currentUser.getId())
        {
            // Not a dead end any more. Someone with no account may still have a
            // copyright complaint or an account they cannot get into, and both of
            // those are exactly the cases the public form exists for.
            return await ReportIssueDialog.showPublic();
        }

        return await ReportIssueDialog.#open({ bPublicMode: false, initialIssueTypeName: "BUG" });
    }

    /**
     * Opens the dialog with no session — the sign-in screen and /copyright.
     *
     * @param {string} initialIssueTypeName which type to preselect
     * @returns {Promise<boolean>}
     */
    static async showPublic(initialIssueTypeName = "INTELLECTUAL_PROPERTY")
    {
        return await ReportIssueDialog.#open({ bPublicMode: true, initialIssueTypeName: initialIssueTypeName });
    }

    /**
     * @param {{bPublicMode: boolean, initialIssueTypeName: string}} options
     * @returns {Promise<boolean>}
     */
    static async #open(options)
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(ReportIssueDialog.#buildMarkup(options));

            const selectedFiles = [];
            let bSubmitted = false;

            // Held across the complaint's three steps. The token is the only
            // thing that lets the evidence step write, and it exists solely in
            // this closure — never in storage, never in the URL.
            const complaintState = { complaintId: "", reference: "", evidenceUploadToken: "" };

            const errorElement = dialog.querySelector('[data-role="error"]');
            const descriptionInput = dialog.querySelector('[data-role="description"]');
            const counterElement = dialog.querySelector('[data-role="description-counter"]');
            const fileInput = dialog.querySelector('[data-role="file-input"]');
            const dropZone = dialog.querySelector('[data-role="drop-zone"]');
            const attachmentListElement = dialog.querySelector('[data-role="attachment-list"]');
            const submitButton = dialog.querySelector('[data-role="submit"]');
            const progressElement = dialog.querySelector('[data-role="progress"]');
            const issueTypeSelect = dialog.querySelector('[data-role="issue-type"]');

            function showError(message)
            {
                errorElement.textContent = message;
                errorElement.hidden = String(message ?? "").length === 0;
            }

            ReportIssueDialog.#populateIssueTypes(issueTypeSelect, options);
            ReportIssueDialog.#bindTabs(dialog);

            function applyIssueTypeMode()
            {
                const visibility = ReportIssueDialog.resolveFieldVisibility(issueTypeSelect.value, options.bPublicMode);

                for (const complaintField of dialog.querySelectorAll('[data-mode="complaint"]'))
                {
                    complaintField.hidden = !visibility.bComplaintFields;
                }

                for (const reportField of dialog.querySelectorAll('[data-mode="report"]'))
                {
                    reportField.hidden = !visibility.bReportFields;
                }

                dialog.querySelector('[data-role="contact-field"]').hidden = !visibility.bContactField;
                dialog.querySelector('[data-role="notify-field"]').hidden = !visibility.bNotifyChoice;

                if (visibility.bContactField)
                {
                    ReportIssueDialog.#prefillContactEmail(dialog);
                }

                descriptionInput.placeholder = ReportIssueDialog.#describePlaceholder(issueTypeSelect.value);
                submitButton.textContent = visibility.bComplaintFields ? "Submit complaint" : "Send report";
                showError("");
            }

            issueTypeSelect.addEventListener("change", applyIssueTypeMode);
            applyIssueTypeMode();

            descriptionInput.addEventListener("input", () =>
            {
                counterElement.textContent = `${descriptionInput.value.length} / ${ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH}`;
                showError("");
            });

            function renderAttachments()
            {
                attachmentListElement.innerHTML = selectedFiles
                    .map((file, fileIndex) =>
                        `<li class="report-issue-attachment">
                            <span class="report-issue-attachment-name">${ReportIssueDialog.#escapeHtml(file.name)}</span>
                            <span class="report-issue-attachment-size">${ReportIssueDialog.#formatBytes(file.size)}</span>
                            <button type="button" class="report-issue-attachment-remove" data-index="${fileIndex}" aria-label="Remove attachment">×</button>
                        </li>`)
                    .join("");

                dropZone.classList.toggle("report-issue-drop-zone-full", selectedFiles.length >= ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT);
            }

            function addFiles(fileList)
            {
                for (const file of Array.from(fileList || []))
                {
                    if (selectedFiles.length >= ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT)
                    {
                        showError(`You can attach up to ${ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT} files.`);
                        break;
                    }

                    if (!ReportIssueDialog.ALLOWED_MIME_TYPE_SET.has(String(file.type || "").toLowerCase()))
                    {
                        showError(`"${file.name}" isn't a supported file type. Attach images or PDFs.`);
                        continue;
                    }

                    if (file.size > ReportIssueDialog.MAXIMUM_FILE_BYTES)
                    {
                        showError(`"${file.name}" is larger than ${ReportIssueDialog.#formatBytes(ReportIssueDialog.MAXIMUM_FILE_BYTES)}.`);
                        continue;
                    }

                    selectedFiles.push(file);
                }

                renderAttachments();
            }

            dropZone.addEventListener("click", () => fileInput.click());
            fileInput.addEventListener("change", () =>
            {
                addFiles(fileInput.files);
                // Cleared so re-picking the same file still fires a change event.
                fileInput.value = "";
            });

            dropZone.addEventListener("dragover", (dragEvent) =>
            {
                dragEvent.preventDefault();
                dropZone.classList.add("report-issue-drop-zone-active");
            });
            dropZone.addEventListener("dragleave", () => dropZone.classList.remove("report-issue-drop-zone-active"));
            dropZone.addEventListener("drop", (dropEvent) =>
            {
                dropEvent.preventDefault();
                dropZone.classList.remove("report-issue-drop-zone-active");
                addFiles(dropEvent.dataTransfer?.files);
            });

            attachmentListElement.addEventListener("click", (clickEvent) =>
            {
                const removeButton = clickEvent.target.closest(".report-issue-attachment-remove");

                if (!removeButton)
                {
                    return;
                }

                selectedFiles.splice(Number(removeButton.dataset.index), 1);
                renderAttachments();
                showError("");
            });

            dialog.querySelector('[data-role="cancel"]').addEventListener("click", () => dialog.close());

            submitButton.addEventListener("click", async () =>
            {
                showError("");

                if (issueTypeSelect.value === "INTELLECTUAL_PROPERTY")
                {
                    await submitComplaint();
                    return;
                }

                submitReport();
            });

            /**
             * The copyright / IP path. JSON, no files — evidence is offered only
             * after the address has been confirmed.
             */
            async function submitComplaint()
            {
                const complaintPayload = ReportIssueDialog.#readComplaintFields(dialog);
                const validationMessage = ReportIssueDialog.#validateComplaint(complaintPayload);

                if (validationMessage.length > 0)
                {
                    showError(validationMessage);
                    return;
                }

                submitButton.disabled = true;

                let responseJson = {};
                let statusCode = 0;

                try
                {
                    const response = await fetch("/Legal/IntellectualPropertyComplaint",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(complaintPayload)
                    });

                    statusCode = response.status;
                    responseJson = await response.json();
                }
                catch (submitError)
                {
                    submitButton.disabled = false;
                    showError("Couldn't reach the server. Check your connection and try again.");
                    return;
                }

                if (statusCode < 200 || statusCode >= 300 || responseJson.success !== true)
                {
                    submitButton.disabled = false;
                    showError(ReportIssueDialog.#describeError(responseJson, statusCode));
                    return;
                }

                bSubmitted = true;
                complaintState.reference = String(responseJson.reference ?? "");
                ReportIssueDialog.#showComplaintConfirmationStep(dialog, complaintState, responseJson, complaintPayload.contactEmail, selectedFiles);
            }

            /**
             * The ordinary support-report path, unchanged apart from the contact
             * address the public mode adds and the endpoint it posts to.
             */
            function submitReport()
            {
                const description = descriptionInput.value.trim();

                if (description.length < ReportIssueDialog.MINIMUM_DESCRIPTION_LENGTH)
                {
                    showError(`Please describe the issue in at least ${ReportIssueDialog.MINIMUM_DESCRIPTION_LENGTH} characters so we can act on it.`);
                    return;
                }

                if (description.length > ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH)
                {
                    showError(`Please shorten the description to ${ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH} characters or fewer.`);
                    return;
                }

                const contactEmail = String(dialog.querySelector('[data-role="contact-email"]').value ?? "").trim();

                if (options.bPublicMode && !ReportIssueDialog.#isPlausibleEmail(contactEmail))
                {
                    showError("Please give us an email address we can reply to — it's the only way we can reach you about this.");
                    return;
                }

                submitButton.disabled = true;

                const formData = new FormData();
                formData.append("issueType", String(supportTicketTypes[issueTypeSelect.value] ?? supportTicketTypes.OTHER));
                formData.append("description", description);
                formData.append("bNotifyOnResolution", dialog.querySelector('[data-role="notify"]').checked ? "true" : "false");

                if (contactEmail.length > 0)
                {
                    formData.append("contactEmail", contactEmail);
                }

                // One repeated field name; the server reads each file's name and
                // type from its own multipart part headers and re-validates both.
                for (const file of selectedFiles)
                {
                    formData.append("attachments", file);
                }

                // XMLHttpRequest rather than fetch specifically for upload
                // progress — a 10 MB screenshot on a slow connection otherwise
                // looks like a frozen dialog.
                const request = new XMLHttpRequest();
                request.open("POST", options.bPublicMode ? "/Support/Report/SubmitPublic" : "/Support/Report/Submit");

                request.upload.onprogress = (progressEvent) =>
                {
                    if (!progressEvent.lengthComputable || selectedFiles.length === 0)
                    {
                        return;
                    }

                    progressElement.hidden = false;
                    progressElement.textContent = `Uploading… ${Math.round((progressEvent.loaded / progressEvent.total) * 100)}%`;
                };

                request.onload = () =>
                {
                    progressElement.hidden = true;

                    let responseJson = {};
                    try
                    {
                        responseJson = JSON.parse(request.responseText || "{}");
                    }
                    catch (parseError)
                    {
                        responseJson = {};
                    }

                    if (request.status >= 200 && request.status < 300 && responseJson.success !== false)
                    {
                        bSubmitted = true;
                        ReportIssueDialog.#showSubmittedState(dialog, responseJson, options);
                        return;
                    }

                    submitButton.disabled = false;
                    showError(ReportIssueDialog.#describeError(responseJson, request.status));
                };

                request.onerror = () =>
                {
                    progressElement.hidden = true;
                    submitButton.disabled = false;
                    showError("Couldn't reach the server. Check your connection and try again.");
                };

                request.send(formData);
            }

            dialog.setDismissHandler(() => dialog.close());

            // DialogBox emits no close event, so resolution is tied to removal from
            // the DOM instead — which covers the close button, Escape, and the
            // programmatic close above uniformly.
            const removalObserver = new MutationObserver(() =>
            {
                if (!document.body.contains(dialog))
                {
                    removalObserver.disconnect();
                    resolve(bSubmitted);
                }
            });
            removalObserver.observe(document.body, { childList: true });

            if (!options.bPublicMode)
            {
                ReportIssueDialog.#loadMyReports(dialog);
            }
        });
    }

    /**
     * @param {{bPublicMode: boolean}} options
     * @returns {string}
     */
    static #buildMarkup(options)
    {
        const tabsHtml = options.bPublicMode
            ? ""
            : `<div class="report-issue-tabs">
                   <button type="button" class="report-issue-tab report-issue-tab-active" data-tab="report">Report an issue</button>
                   <button type="button" class="report-issue-tab" data-tab="mine">Your reports</button>
               </div>`;

        const myReportsPanelHtml = options.bPublicMode
            ? ""
            : `<div class="report-issue-panel" data-panel="mine" hidden>
                   <div class="report-issue-my-reports" data-role="my-reports">Loading your reports…</div>
               </div>`;

        const subtitle = options.bPublicMode
            ? "You don't need an account. Tell us what's wrong and we'll reply to the address you give us."
            : "Tell us what went wrong and we'll look into it. You can check back here for the outcome.";

        return `
            <div class="report-issue-dialog">
                <h2 class="report-issue-title">Report an issue</h2>
                <p class="report-issue-subtitle">${ReportIssueDialog.#escapeHtml(subtitle)}</p>

                ${tabsHtml}

                <div class="report-issue-panel" data-panel="report">
                    <label class="report-issue-field">
                        <span>What kind of issue is it?</span>
                        <select data-role="issue-type"></select>
                    </label>

                    <!-- The password warning leads the placeholder rather than
                         trailing it. A single-line input truncates its
                         placeholder on a narrow screen, and "Where we should
                         reply. Never enter your pas…" cuts off the only half
                         that matters. The label carries the reply hint instead,
                         where it always fits. -->
                    <label class="report-issue-field" data-role="contact-field" hidden>
                        <span>Your email address <em>(where we'll reply)</em></span>
                        <input type="email" data-role="contact-email" autocomplete="email"
                            placeholder="Never enter your password anywhere in this form.">
                    </label>

                    <!-- ── Copyright / IP complaint fields ───────────────────
                         Hidden until that type is chosen. The wording of each
                         one tracks Clause 19.4 of the Terms of Service, which
                         is what a complaint has to contain to be actionable. -->
                    <label class="report-issue-field" data-mode="complaint" hidden>
                        <span>Your full name</span>
                        <input type="text" data-role="complainant-name" autocomplete="name" placeholder="The name of the rights owner, or your own if you act for them.">
                    </label>

                    <label class="report-issue-field" data-mode="complaint" hidden>
                        <span>In what capacity are you writing?</span>
                        <input type="text" data-role="capacity-statement"
                            placeholder="e.g. I am the author, or I am authorised to act for the publisher.">
                    </label>

                    <label class="report-issue-field" data-mode="complaint" hidden>
                        <span>What work is being infringed?</span>
                        <textarea data-role="work-description" rows="4"
                            placeholder="Name and describe the work — the title, edition, ISBN or URL if you have it — clearly enough for us to identify it."></textarea>
                    </label>

                    <label class="report-issue-field" data-mode="complaint" hidden>
                        <span>Where does it appear on CogniumLearn?</span>
                        <textarea data-role="location-description" rows="4"
                            placeholder="Describe where you saw it — the deck or listing name, the page, what the material looks like — in enough detail for us to find it."></textarea>
                    </label>

                    <label class="report-issue-field" data-mode="complaint" hidden>
                        <span>Deck, listing or study-material ID <em>(optional, if you have one)</em></span>
                        <input type="text" data-role="entity-reference" placeholder="Paste an ID if you have one. Leave blank if not — we'll search from your description.">
                    </label>

                    <label class="report-issue-checkbox" data-mode="complaint" hidden>
                        <input type="checkbox" data-role="good-faith">
                        <span>I believe in good faith that this use is not authorised by the rights owner, its agent or the law.</span>
                    </label>

                    <label class="report-issue-checkbox" data-mode="complaint" hidden>
                        <input type="checkbox" data-role="accuracy">
                        <span>The information in this complaint is accurate.</span>
                    </label>

                    <!-- ── Support-report fields ─────────────────────────── -->
                    <label class="report-issue-field" data-mode="report">
                        <span>What happened?</span>
                        <textarea data-role="description" rows="6" maxlength="${ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH}"
                            placeholder="Describe what you were doing, what you expected, and what happened instead."></textarea>
                        <span class="report-issue-counter" data-role="description-counter">0 / ${ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH}</span>
                    </label>

                    <div class="report-issue-field" data-mode="report">
                        <span>Attachments <em>(optional — up to ${ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT} images or PDFs, ${ReportIssueDialog.#formatBytes(ReportIssueDialog.MAXIMUM_FILE_BYTES)} each)</em></span>
                        <div class="report-issue-drop-zone" data-role="drop-zone">
                            <span>Drop screenshots here, or click to choose</span>
                        </div>
                        <input type="file" multiple accept="${ReportIssueDialog.ACCEPTED_MIME_TYPES}" data-role="file-input" hidden>
                        <ul class="report-issue-attachments" data-role="attachment-list"></ul>
                    </div>

                    <label class="report-issue-checkbox" data-role="notify-field">
                        <input type="checkbox" data-role="notify" checked>
                        <span>Email me when this is resolved</span>
                    </label>

                    <p class="report-issue-subtitle" data-mode="complaint" hidden>
                        We'll record your complaint straight away and email you a code to confirm this address.
                        Our Grievance Officer replies within 15 days. You can attach evidence once the address is confirmed.
                    </p>

                    <div class="report-issue-error" data-role="error" hidden></div>
                    <div class="report-issue-progress" data-role="progress" hidden></div>

                    <div class="report-issue-actions">
                        <button type="button" class="cancel-button report-issue-cancel" data-role="cancel">Cancel</button>
                        <button type="button" class="ok-button report-issue-submit" data-role="submit">Send report</button>
                    </div>
                </div>

                ${myReportsPanelHtml}
            </div>
        `;
    }

    /**
     * Reads the complaint fields into the exact body the endpoint expects.
     *
     * The single "entity reference" input is sent as all three id fields. The
     * complainant cannot be expected to know whether the string they copied is a
     * deck id, a listing id or a study-material id — and the resolver treats each
     * as a lead rather than a lookup key, so an id offered against the wrong slot
     * simply finds nothing there.
     *
     * @param {HTMLElement} dialog
     * @returns {object}
     */
    static #readComplaintFields(dialog)
    {
        const readValue = (roleName) => String(dialog.querySelector(`[data-role="${roleName}"]`)?.value ?? "").trim();
        const entityReference = readValue("entity-reference");

        return {
            complainantName: readValue("complainant-name"),
            contactEmail: readValue("contact-email"),
            capacityStatement: readValue("capacity-statement"),
            workDescription: readValue("work-description"),
            locationDescription: readValue("location-description"),
            deckId: entityReference,
            paidDeckId: entityReference,
            studyMaterialId: entityReference,
            bGoodFaithStatement: dialog.querySelector('[data-role="good-faith"]').checked,
            bAccuracyStatement: dialog.querySelector('[data-role="accuracy"]').checked
        };
    }

    /**
     * Mirrors the server's checks so a complainant is told what is missing
     * before a round trip, not after.
     *
     * @param {object} complaintPayload
     * @returns {string} An empty string when everything is present.
     */
    static #validateComplaint(complaintPayload)
    {
        if (complaintPayload.complainantName.length === 0)
        {
            return "Please tell us your name — a complaint has to be attributable to someone.";
        }

        if (!ReportIssueDialog.#isPlausibleEmail(complaintPayload.contactEmail))
        {
            return "Please give us an email address we can reply to and send your confirmation code to.";
        }

        if (complaintPayload.capacityStatement.length === 0)
        {
            return "Please tell us whether you own the right or are acting for the owner.";
        }

        if (complaintPayload.workDescription.length < ReportIssueDialog.MINIMUM_WORK_DESCRIPTION_LENGTH)
        {
            return `Please describe the work in at least ${ReportIssueDialog.MINIMUM_WORK_DESCRIPTION_LENGTH} characters so we can identify it.`;
        }

        if (complaintPayload.locationDescription.length < ReportIssueDialog.MINIMUM_LOCATION_DESCRIPTION_LENGTH)
        {
            return `Please describe where it appears in at least ${ReportIssueDialog.MINIMUM_LOCATION_DESCRIPTION_LENGTH} characters so we can find it.`;
        }

        if (!complaintPayload.bGoodFaithStatement || !complaintPayload.bAccuracyStatement)
        {
            return "Please confirm both statements — we can only act on a complaint that carries them.";
        }

        return "";
    }

    /**
     * Step two of a complaint: the code that confirms the address.
     *
     * The copy leads with "we've recorded it" deliberately. Someone who cannot
     * find the email, or who gives up here, has still filed a complaint and the
     * deadlines are already running — telling them otherwise would be false, and
     * would make people re-submit the same notice repeatedly.
     *
     * @param {HTMLElement} dialog
     * @param {object} complaintState
     * @param {object} responseJson
     * @param {string} contactEmail
     * @param {File[]} selectedFiles
     * @returns {void}
     */
    static #showComplaintConfirmationStep(dialog, complaintState, responseJson, contactEmail, selectedFiles)
    {
        const reference = String(responseJson?.reference ?? "");
        const bCodeSent = responseJson?.bVerificationCodeSent === true;

        const codeNoticeHtml = bCodeSent
            ? `<p>We've emailed a 6-digit code to <strong>${ReportIssueDialog.#escapeHtml(contactEmail)}</strong>. Enter it below to confirm this address.</p>`
            : `<p>We couldn't send a confirmation code to <strong>${ReportIssueDialog.#escapeHtml(contactEmail)}</strong> just now. Your complaint is still recorded, and our Grievance Officer will contact you at that address.</p>`;

        dialog.querySelector('[data-panel="report"]').innerHTML = `
            <div class="report-issue-submitted">
                <h3>Your complaint is recorded.</h3>
                <p>Your reference is <strong>${ReportIssueDialog.#escapeHtml(reference)}</strong>. Please quote it in any reply.
                   We'll respond within 15 days, counted from now — not from when you confirm below.</p>
                ${codeNoticeHtml}

                ${bCodeSent ? `
                <label class="report-issue-field">
                    <span>Confirmation code</span>
                    <input type="text" data-role="confirmation-code" inputmode="numeric" maxlength="6" placeholder="6-digit code">
                </label>

                <div class="report-issue-error" data-role="confirm-error" hidden></div>

                <div class="report-issue-actions">
                    <button type="button" class="cancel-button" data-role="skip-confirm">I'll confirm later</button>
                    <button type="button" class="ok-button" data-role="confirm">Confirm my address</button>
                </div>` : `
                <div class="report-issue-actions">
                    <button type="button" class="ok-button" data-role="done">Done</button>
                </div>`}
            </div>
        `;

        const doneButton = dialog.querySelector('[data-role="done"]');
        if (doneButton)
        {
            doneButton.addEventListener("click", () => dialog.close());
            return;
        }

        dialog.querySelector('[data-role="skip-confirm"]').addEventListener("click", () => dialog.close());

        const confirmButton = dialog.querySelector('[data-role="confirm"]');
        const confirmErrorElement = dialog.querySelector('[data-role="confirm-error"]');

        confirmButton.addEventListener("click", async () =>
        {
            const submittedCode = String(dialog.querySelector('[data-role="confirmation-code"]').value ?? "").trim();

            if (!/^\d{6}$/.test(submittedCode))
            {
                confirmErrorElement.textContent = "Please enter the 6-digit code from the email.";
                confirmErrorElement.hidden = false;
                return;
            }

            confirmErrorElement.hidden = true;
            confirmButton.disabled = true;

            let responseBody = {};
            let statusCode = 0;

            try
            {
                const response = await fetch("/Legal/IntellectualPropertyComplaint/Verify",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ contactEmail: contactEmail, code: submittedCode })
                });

                statusCode = response.status;
                responseBody = await response.json();
            }
            catch (verifyError)
            {
                confirmButton.disabled = false;
                confirmErrorElement.textContent = "Couldn't reach the server. Check your connection and try again.";
                confirmErrorElement.hidden = false;
                return;
            }

            if (statusCode < 200 || statusCode >= 300 || responseBody.success !== true)
            {
                confirmButton.disabled = false;
                confirmErrorElement.textContent = ReportIssueDialog.#describeError(responseBody, statusCode);
                confirmErrorElement.hidden = false;
                return;
            }

            complaintState.complaintId = String(responseBody.complaintId ?? "");
            complaintState.evidenceUploadToken = String(responseBody.evidenceUploadToken ?? "");

            ReportIssueDialog.#showEvidenceStep(dialog, complaintState, reference, selectedFiles);
        });
    }

    /**
     * Step three: optional evidence, now that the address is confirmed.
     *
     * Offered rather than required. A complaint without a scanned copyright
     * certificate is still a complaint, and blocking on one would filter for
     * complainants with a lawyer rather than for complainants with a case.
     *
     * @param {HTMLElement} dialog
     * @param {object} complaintState
     * @param {string} reference
     * @param {File[]} selectedFiles
     * @returns {void}
     */
    static #showEvidenceStep(dialog, complaintState, reference, selectedFiles)
    {
        dialog.querySelector('[data-panel="report"]').innerHTML = `
            <div class="report-issue-submitted">
                <h3>Address confirmed.</h3>
                <p>Complaint <strong>${ReportIssueDialog.#escapeHtml(reference)}</strong> is now with our Grievance Officer.</p>
                <p>If you have anything that helps establish your claim — a copy of the work, a registration
                   certificate, a screenshot of the material — you can attach it now. This is optional.</p>

                <div class="report-issue-field">
                    <div class="report-issue-drop-zone" data-role="evidence-drop-zone">
                        <span>Drop files here, or click to choose (up to ${ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT} images or PDFs)</span>
                    </div>
                    <input type="file" multiple accept="${ReportIssueDialog.ACCEPTED_MIME_TYPES}" data-role="evidence-file-input" hidden>
                    <ul class="report-issue-attachments" data-role="evidence-list"></ul>
                </div>

                <div class="report-issue-error" data-role="evidence-error" hidden></div>
                <div class="report-issue-progress" data-role="evidence-progress" hidden></div>

                <div class="report-issue-actions">
                    <button type="button" class="cancel-button" data-role="skip-evidence">No, I'm done</button>
                    <button type="button" class="ok-button" data-role="upload-evidence">Attach evidence</button>
                </div>
            </div>
        `;

        const evidenceFiles = [...selectedFiles];
        const evidenceDropZone = dialog.querySelector('[data-role="evidence-drop-zone"]');
        const evidenceFileInput = dialog.querySelector('[data-role="evidence-file-input"]');
        const evidenceListElement = dialog.querySelector('[data-role="evidence-list"]');
        const evidenceErrorElement = dialog.querySelector('[data-role="evidence-error"]');
        const evidenceProgressElement = dialog.querySelector('[data-role="evidence-progress"]');
        const uploadButton = dialog.querySelector('[data-role="upload-evidence"]');

        function renderEvidence()
        {
            evidenceListElement.innerHTML = evidenceFiles
                .map((file, fileIndex) =>
                    `<li class="report-issue-attachment">
                        <span class="report-issue-attachment-name">${ReportIssueDialog.#escapeHtml(file.name)}</span>
                        <span class="report-issue-attachment-size">${ReportIssueDialog.#formatBytes(file.size)}</span>
                        <button type="button" class="report-issue-attachment-remove" data-index="${fileIndex}" aria-label="Remove attachment">×</button>
                    </li>`)
                .join("");
        }

        renderEvidence();

        evidenceDropZone.addEventListener("click", () => evidenceFileInput.click());
        evidenceFileInput.addEventListener("change", () =>
        {
            for (const file of Array.from(evidenceFileInput.files || []))
            {
                if (evidenceFiles.length < ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT)
                {
                    evidenceFiles.push(file);
                }
            }

            evidenceFileInput.value = "";
            renderEvidence();
        });

        evidenceListElement.addEventListener("click", (clickEvent) =>
        {
            const removeButton = clickEvent.target.closest(".report-issue-attachment-remove");

            if (removeButton)
            {
                evidenceFiles.splice(Number(removeButton.dataset.index), 1);
                renderEvidence();
            }
        });

        dialog.querySelector('[data-role="skip-evidence"]').addEventListener("click", () => dialog.close());

        uploadButton.addEventListener("click", () =>
        {
            if (evidenceFiles.length === 0)
            {
                dialog.close();
                return;
            }

            uploadButton.disabled = true;
            evidenceErrorElement.hidden = true;

            const formData = new FormData();
            formData.append("complaintId", complaintState.complaintId);
            formData.append("evidenceUploadToken", complaintState.evidenceUploadToken);

            for (const file of evidenceFiles)
            {
                formData.append("attachments", file);
            }

            const request = new XMLHttpRequest();
            request.open("POST", "/Legal/IntellectualPropertyComplaint/Evidence");

            request.upload.onprogress = (progressEvent) =>
            {
                if (!progressEvent.lengthComputable)
                {
                    return;
                }

                evidenceProgressElement.hidden = false;
                evidenceProgressElement.textContent = `Uploading… ${Math.round((progressEvent.loaded / progressEvent.total) * 100)}%`;
            };

            request.onload = () =>
            {
                evidenceProgressElement.hidden = true;

                if (request.status >= 200 && request.status < 300)
                {
                    dialog.close();
                    return;
                }

                let responseJson = {};
                try
                {
                    responseJson = JSON.parse(request.responseText || "{}");
                }
                catch (parseError)
                {
                    responseJson = {};
                }

                uploadButton.disabled = false;
                // The complaint itself is unaffected by a failed upload, and
                // saying so keeps a complainant from thinking the whole notice
                // has to be re-filed.
                evidenceErrorElement.textContent = `${ReportIssueDialog.#describeError(responseJson, request.status)} Your complaint is unaffected — you can reply to our acknowledgment email with the files instead.`;
                evidenceErrorElement.hidden = false;
            };

            request.onerror = () =>
            {
                evidenceProgressElement.hidden = true;
                uploadButton.disabled = false;
                evidenceErrorElement.textContent = "Couldn't reach the server. Your complaint is unaffected — you can reply to our acknowledgment email with the files instead.";
                evidenceErrorElement.hidden = false;
            };

            request.send(formData);
        });
    }

    /**
     * @param {HTMLSelectElement} selectElement
     * @param {{bPublicMode: boolean, initialIssueTypeName: string}} options
     * @returns {void}
     */
    static #populateIssueTypes(selectElement, options)
    {
        // UNKNOWN is a storage-level default, never something a person picks.
        const availableTypeNames = options.bPublicMode
            ? ReportIssueDialog.PUBLIC_ISSUE_TYPE_NAMES
            : Object.keys(supportTicketTypes).filter(typeName => supportTicketTypes[typeName] !== supportTicketTypes.UNKNOWN);

        selectElement.innerHTML = availableTypeNames
            .map(typeName => `<option value="${typeName}">${ReportIssueDialog.#escapeHtml(ReportIssueDialog.#describeIssueType(typeName))}</option>`)
            .join("");

        selectElement.value = availableTypeNames.includes(options.initialIssueTypeName)
            ? options.initialIssueTypeName
            : availableTypeNames[0];
    }

    /**
     * Fills the contact address from the signed-in account, when there is one
     * and the field is still empty.
     *
     * Prefilled rather than hidden, because a complaint may be filed on behalf
     * of a rights owner who is not the account holder — so the address has to
     * stay editable — while the common case of someone complaining about their
     * own work should not be made to type an address we already know.
     *
     * Never overwrites what the user has typed: this runs again on every change
     * of the issue type, and clobbering a hand-entered address because somebody
     * flipped the dropdown and flipped it back would be worse than not helping
     * at all.
     *
     * @param {HTMLElement} dialog
     * @returns {void}
     */
    static #prefillContactEmail(dialog)
    {
        const contactInput = dialog.querySelector('[data-role="contact-email"]');

        if (!contactInput || contactInput.value.trim().length > 0)
        {
            return;
        }

        const currentUser = window["user"];

        if (!currentUser || typeof currentUser.getAdditionalData !== "function")
        {
            return;
        }

        const accountEmail = String(currentUser.getAdditionalData()?.email ?? "").trim();

        if (accountEmail.length > 0)
        {
            contactInput.value = accountEmail;
        }
    }

    /**
     * @param {string} typeName
     * @returns {string}
     */
    static #describeIssueType(typeName)
    {
        return ReportIssueDialog.ISSUE_TYPE_LABELS[typeName] || enumerationToTitleCase(typeName);
    }

    /**
     * The placeholder for the description box.
     *
     * The account-access wording carries the password warning in the PLACEHOLDER
     * rather than only in a label above it, because the placeholder is the text
     * physically inside the box someone is about to type a password into — which
     * is the only place it is read at the moment it matters.
     *
     * @param {string} typeName
     * @returns {string}
     */
    static #describePlaceholder(typeName)
    {
        if (typeName === "ACCOUNT_ACCESS")
        {
            return "Describe what happens when you try to sign in. Never enter your password or a sign-in code here — we will never ask for either.";
        }

        return "Describe what you were doing, what you expected, and what happened instead.";
    }

    /**
     * @param {HTMLElement} dialog
     * @returns {void}
     */
    static #bindTabs(dialog)
    {
        for (const tabButton of dialog.querySelectorAll(".report-issue-tab"))
        {
            tabButton.addEventListener("click", () =>
            {
                for (const otherTab of dialog.querySelectorAll(".report-issue-tab"))
                {
                    otherTab.classList.toggle("report-issue-tab-active", otherTab === tabButton);
                }

                for (const panel of dialog.querySelectorAll(".report-issue-panel"))
                {
                    panel.hidden = panel.dataset.panel !== tabButton.dataset.tab;
                }
            });
        }
    }

    /**
     * Replaces the form with a confirmation once a report lands, and refreshes the
     * status list so the new entry is visible on the other tab straight away.
     *
     * @param {HTMLElement} dialog
     * @param {object} responseJson
     * @param {{bPublicMode: boolean}} options
     * @returns {void}
     */
    static #showSubmittedState(dialog, responseJson, options)
    {
        const remaining = Number(responseJson?.remaining);
        const remainingNote = !options.bPublicMode && Number.isFinite(remaining)
            ? `You can send ${remaining} more report${remaining === 1 ? "" : "s"} today.`
            : "";

        // An anonymous reporter has no "Your reports" tab to check, so they are
        // pointed at the only channel they actually have.
        const followUpHtml = options.bPublicMode
            ? `<p>We'll reply to the email address you gave us.</p>`
            : `<p>You can check the status any time under <strong>Your reports</strong>.</p>`;

        dialog.querySelector('[data-panel="report"]').innerHTML = `
            <div class="report-issue-submitted">
                <h3>Thanks — we've got it.</h3>
                <p>We group reports about the same problem together, so you may see this listed alongside others describing the same thing.</p>
                ${followUpHtml}
                <p class="report-issue-subtitle">${ReportIssueDialog.#escapeHtml(remainingNote)}</p>
                <div class="report-issue-actions">
                    <button type="button" class="ok-button report-issue-submit" data-role="done">Done</button>
                </div>
            </div>
        `;

        dialog.querySelector('[data-role="done"]').addEventListener("click", () => dialog.close());

        if (!options.bPublicMode)
        {
            ReportIssueDialog.#loadMyReports(dialog);
        }
    }

    /**
     * @param {HTMLElement} dialog
     * @returns {Promise<void>}
     */
    static async #loadMyReports(dialog)
    {
        const container = dialog.querySelector('[data-role="my-reports"]');

        if (!container)
        {
            return;
        }

        let responseJson = null;

        try
        {
            const response = await fetch("/Support/MyReports");
            responseJson = await response.json();
        }
        catch (loadError)
        {
            container.textContent = "Couldn't load your reports right now.";
            return;
        }

        const reports = Array.isArray(responseJson?.reports) ? responseJson.reports : [];

        if (reports.length === 0)
        {
            container.innerHTML = `<p class="report-issue-subtitle">You haven't reported anything yet.</p>`;
            return;
        }

        container.innerHTML = reports.map(report => ReportIssueDialog.#renderReportCard(report)).join("");
    }

    /**
     * @param {object} report
     * @returns {string}
     */
    static #renderReportCard(report)
    {
        const status = ReportIssueDialog.#describeStatus(report);
        const submittedOn = new Date(report.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
        const adminMessage = report.ticketStatus === supportTicketStatus.RESOLVED ? report.resolutionMessage : report.declineMessage;
        const creditNote = Number(report.creditAmount) > 0
            ? `<p class="report-issue-card-credit">+${report.creditAmount} credits added as a thank you.</p>`
            : "";

        return `
            <article class="report-issue-card">
                <header class="report-issue-card-header">
                    <span class="report-issue-card-type">${ReportIssueDialog.#escapeHtml(ReportIssueDialog.#describeIssueType(ReportIssueDialog.#issueTypeName(report.issueType)))}</span>
                    <span class="report-issue-card-status report-issue-card-status-${status.variant}">${ReportIssueDialog.#escapeHtml(status.label)}</span>
                </header>
                <p class="report-issue-card-description">${ReportIssueDialog.#escapeHtml(report.description)}</p>
                ${adminMessage ? `<blockquote class="report-issue-card-message">${ReportIssueDialog.#escapeHtml(adminMessage)}</blockquote>` : ""}
                ${creditNote}
                <footer class="report-issue-card-footer">Reported ${ReportIssueDialog.#escapeHtml(submittedOn)}</footer>
            </article>
        `;
    }

    /**
     * @param {object} report
     * @returns {{label: string, variant: string}}
     */
    static #describeStatus(report)
    {
        if (report.groupingStatus === supportTicketReportStatus.GROUPING_FAILED)
        {
            return { label: "Received", variant: "pending" };
        }

        if (report.ticketStatus === supportTicketStatus.RESOLVED)
        {
            return { label: "Resolved", variant: "resolved" };
        }

        if (report.ticketStatus === supportTicketStatus.DECLINED)
        {
            return { label: "Closed", variant: "declined" };
        }

        return { label: "Under review", variant: "pending" };
    }

    /**
     * @param {number} issueTypeValue
     * @returns {string}
     */
    static #issueTypeName(issueTypeValue)
    {
        const matchedName = Object.keys(supportTicketTypes).find(typeName => supportTicketTypes[typeName] === issueTypeValue);
        return matchedName && matchedName !== "UNKNOWN" ? matchedName : "OTHER";
    }

    /**
     * A deliberately loose shape check. The server validates properly; this only
     * catches the typo before a round trip, and being stricter here would reject
     * addresses that are perfectly valid and rare.
     *
     * @param {string} emailAddress
     * @returns {boolean}
     */
    static #isPlausibleEmail(emailAddress)
    {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(emailAddress ?? "").trim());
    }

    /**
     * Turns a server error code into something a reporter can act on. The quota
     * case is the one that actually matters — it is the only rejection a
     * well-behaved user will realistically hit.
     *
     * @param {object} responseJson
     * @param {number} statusCode
     * @returns {string}
     */
    static #describeError(responseJson, statusCode)
    {
        const errorCode = String(responseJson?.error ?? "");

        if (errorCode === "SUPPORT_QUOTA_EXCEEDED")
        {
            const hours = Math.max(1, Math.round(Number(responseJson?.retryAfterSeconds || 0) / 3600));
            return `You've reached the limit of ${responseJson?.limit ?? 2} reports a day. You can send another in about ${hours} hour${hours === 1 ? "" : "s"}.`;
        }

        if (errorCode === "SUPPORT_TOO_MANY_ATTACHMENTS")
        {
            return `Please attach no more than ${responseJson?.maximumCount ?? ReportIssueDialog.MAXIMUM_ATTACHMENT_COUNT} files.`;
        }

        if (errorCode === "SUPPORT_ATTACHMENT_TOO_LARGE")
        {
            return `"${responseJson?.reason ?? "That file"}" is too large. Each attachment must be under ${ReportIssueDialog.#formatBytes(ReportIssueDialog.MAXIMUM_FILE_BYTES)}.`;
        }

        if (errorCode === "SUPPORT_INVALID_ATTACHMENT")
        {
            return `"${responseJson?.reason ?? "That file"}" isn't a supported type. Attach images or PDFs.`;
        }

        if (errorCode === "INVALID_CODE")
        {
            const attemptsRemaining = Number(responseJson?.attemptsRemaining);
            return Number.isFinite(attemptsRemaining)
                ? `That code isn't right. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} left.`
                : "That code isn't right. Please check the email and try again.";
        }

        if (errorCode === "EXPIRED")
        {
            return "That code has expired. Your complaint is still recorded — our Grievance Officer will contact you at the address you gave.";
        }

        if (errorCode === "TOO_MANY_ATTEMPTS")
        {
            return "Too many incorrect attempts. Your complaint is still recorded — our Grievance Officer will contact you at the address you gave.";
        }

        if (errorCode === "COMPLAINT_NOT_VERIFIED")
        {
            return "That confirmation is no longer valid. You can reply to our acknowledgment email with your files instead.";
        }

        if (errorCode === "RATE_LIMITED")
        {
            return "You've sent a lot of requests in a short time. Please wait a few minutes and try again.";
        }

        if (errorCode === "INVALID_EMAIL")
        {
            return "That email address doesn't look right. Please check it and try again.";
        }

        if (responseJson?.reason === "descriptionTooShort")
        {
            return `Please describe the issue in at least ${responseJson?.minimumLength ?? ReportIssueDialog.MINIMUM_DESCRIPTION_LENGTH} characters.`;
        }

        if (responseJson?.reason === "descriptionTooLong")
        {
            return `Please shorten the description to ${responseJson?.maximumLength ?? ReportIssueDialog.MAXIMUM_DESCRIPTION_LENGTH} characters or fewer.`;
        }

        if (responseJson?.reason === "workDescription" || responseJson?.reason === "locationDescription")
        {
            return `Please add more detail — at least ${responseJson?.minimumLength ?? 20} characters — so we can identify what you're reporting.`;
        }

        if (responseJson?.reason === "statements")
        {
            return "Please confirm both statements — we can only act on a complaint that carries them.";
        }

        if (statusCode === 401)
        {
            return "Please sign in again to send a report.";
        }

        return "Something went wrong sending your report. Please try again.";
    }

    /**
     * @param {number} byteCount
     * @returns {string}
     */
    static #formatBytes(byteCount)
    {
        const megabytes = byteCount / (1024 * 1024);
        return megabytes >= 1 ? `${Math.round(megabytes)} MB` : `${Math.max(1, Math.round(byteCount / 1024))} KB`;
    }

    /**
     * @param {*} rawValue
     * @returns {string}
     */
    static #escapeHtml(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

export default ReportIssueDialog;
