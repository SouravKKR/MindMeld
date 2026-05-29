import DialogBox from "./DialogBox.js";


/**
 * ReleaseNotesDialog
 *
 * Static helper that renders a stacked archive of release notes in a
 * single DialogBox.modal popup. Used by two surfaces:
 *
 *   1. ReleaseNotesBootstrap — auto-opens on first load after the user
 *      logs in, showing only entries the user has not seen yet from
 *      the current major release. Marks everything currently visible
 *      as seen on dismiss. Does NOT show the major-version dropdown.
 *   2. OptionsSidebar — opens on demand, scoped to one major release
 *      at a time, with a dropdown for switching between majors that
 *      the user is allowed to see. Never mutates the seen pointer.
 *
 * Notes are always rendered in the exact order passed in. The caller
 * (and the backing /ReleaseNotes/List endpoint) is responsible for
 * supplying them in descending versionSortKey order — newest first.
 *
 * The contentHtml string is injected via innerHTML. Authors are gated
 * behind the EnsureAdmin server plugin, so this trust matches the
 * existing LegalDocument rendering model.
 */
class ReleaseNotesDialog
{
    /**
     * @param {Array<object>} notes - Release notes to display, newest first.
     * @param {object} options
     * @param {boolean} options.markSeenOnClose - When true, POST the
     *   highest visible versionSortKey to /UpdateUserAdditionalData on
     *   close so subsequent visits skip these notes.
     * @param {number|null} options.maxSortKey - Pre-computed maximum
     *   versionSortKey from `notes`. Saves a re-scan.
     * @param {Array<number>} options.availableMajorVersions - When
     *   supplied (and length > 1), renders a dropdown for switching
     *   between major releases. The auto-popup omits this.
     * @param {number|null} options.selectedMajorVersion - The major
     *   the supplied `notes` belong to. Pre-selects the dropdown.
     * @param {(major: number) => Promise<Array<object>>} options.onMajorChanged -
     *   Called when the user picks a different major from the dropdown.
     *   Must resolve to the new list of notes for that major. The dialog
     *   re-renders the article list in place.
     */
    static show(notes, options = {})
    {
        const {
            markSeenOnClose = false,
            maxSortKey = null,
            availableMajorVersions = null,
            selectedMajorVersion = null,
            onMajorChanged = null
        } = options;

        const safeNotes = Array.isArray(notes) ? notes : [];

        if (safeNotes.length === 0)
        {
            DialogBox.alert("Release Notes", "No release notes yet.");
            return null;
        }

        const showDropdown =
            Array.isArray(availableMajorVersions)
            && availableMajorVersions.length > 1
            && typeof onMajorChanged === "function";

        const dialogHtml = ReleaseNotesDialog.#buildHtml(safeNotes, {
            showDropdown,
            availableMajorVersions,
            selectedMajorVersion
        });

        const dialog = DialogBox.modal(dialogHtml);

        if (showDropdown)
        {
            const majorSelect = dialog.querySelector(".release-notes-dialog-major-select");
            if (majorSelect)
            {
                majorSelect.addEventListener("change", async () =>
                {
                    const nextMajor = Number(majorSelect.value);
                    if (!Number.isFinite(nextMajor))
                    {
                        return;
                    }

                    const listContainer = dialog.querySelector(".release-notes-dialog-list");
                    if (listContainer)
                    {
                        listContainer.innerHTML =
                            `<div class="release-notes-dialog-loading">Loading…</div>`;
                    }

                    let nextNotes;
                    try
                    {
                        nextNotes = await onMajorChanged(nextMajor);
                    }
                    catch (fetchError)
                    {
                        if (listContainer)
                        {
                            listContainer.innerHTML =
                                `<div class="release-notes-dialog-loading">Could not load release notes: ${ReleaseNotesDialog.#escape(fetchError?.message || "Unknown error")}.</div>`;
                        }
                        return;
                    }

                    if (!Array.isArray(nextNotes))
                    {
                        nextNotes = [];
                    }

                    if (listContainer)
                    {
                        listContainer.innerHTML = nextNotes.length === 0
                            ? `<div class="release-notes-dialog-loading">No release notes for this version.</div>`
                            : nextNotes.map(note => ReleaseNotesDialog.#buildArticleHtml(note)).join("");
                    }
                });
            }
        }

        if (markSeenOnClose)
        {
            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                const resolvedMaxSortKey = maxSortKey ?? ReleaseNotesDialog.#computeMaxSortKey(safeNotes);
                closeButton.addEventListener("click", () =>
                {
                    ReleaseNotesDialog.#markSeen(resolvedMaxSortKey);
                });
            }
        }

        return dialog;
    }

    static #computeMaxSortKey(notes)
    {
        let maximum = Number.NEGATIVE_INFINITY;
        for (const note of notes)
        {
            const sortKey = Number(note.versionSortKey);
            if (Number.isFinite(sortKey) && sortKey > maximum)
            {
                maximum = sortKey;
            }
        }
        return Number.isFinite(maximum) ? maximum : null;
    }

    static async #markSeen(maxSortKey)
    {
        if (maxSortKey === null || !Number.isFinite(maxSortKey))
        {
            return;
        }

        const currentUser = window["user"];
        if (currentUser && typeof currentUser.getAdditionalData === "function")
        {
            const additionalData = currentUser.getAdditionalData() || {};
            additionalData.lastSeenReleaseNoteVersionSortKey = maxSortKey;
            if (typeof currentUser.setAdditionalData === "function")
            {
                currentUser.setAdditionalData(additionalData);
            }
        }

        try
        {
            await fetch("/UpdateUserAdditionalData",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    partialAdditionalData: { lastSeenReleaseNoteVersionSortKey: maxSortKey }
                })
            });
        }
        catch (persistError)
        {
            console.warn("[ReleaseNotesDialog] Could not persist last-seen pointer:", persistError);
        }
    }

    static #buildHtml(notes, { showDropdown, availableMajorVersions, selectedMajorVersion })
    {
        const articles = notes.map(note => ReleaseNotesDialog.#buildArticleHtml(note)).join("");

        let dropdownHtml = "";
        if (showDropdown)
        {
            const optionsHtml = availableMajorVersions.map(major =>
            {
                const isSelected = major === selectedMajorVersion ? " selected" : "";
                return `<option value="${ReleaseNotesDialog.#escape(String(major))}"${isSelected}>v${ReleaseNotesDialog.#escape(String(major))}.x</option>`;
            }).join("");

            dropdownHtml = `
                <label class="release-notes-dialog-major-picker">
                    <span>Major release</span>
                    <select class="release-notes-dialog-major-select">${optionsHtml}</select>
                </label>
            `;
        }

        return `
            <div class="release-notes-dialog">
                <div class="release-notes-dialog-header">
                    <h1 class="release-notes-dialog-heading">What's new</h1>
                    ${dropdownHtml}
                </div>
                <div class="release-notes-dialog-list">${articles}</div>
            </div>
        `;
    }

    static #buildArticleHtml(note)
    {
        const version = ReleaseNotesDialog.#escape(note.version || "");
        const title = ReleaseNotesDialog.#escape(note.title || "");
        const releaseDateLabel = ReleaseNotesDialog.#formatDate(note.releaseDate);
        const contentHtml = typeof note.contentHtml === "string" ? note.contentHtml : "";
        const testBadge = note.test === true
            ? `<span class="release-notes-dialog-test-badge">TEST</span>`
            : "";

        return `
            <article class="release-notes-dialog-article">
                <header class="release-notes-dialog-article-header">
                    <span class="release-notes-dialog-version">v${version}</span>
                    ${testBadge}
                    <h2 class="release-notes-dialog-title">${title}</h2>
                    <time class="release-notes-dialog-date">${ReleaseNotesDialog.#escape(releaseDateLabel)}</time>
                </header>
                <div class="release-notes-dialog-body">${contentHtml}</div>
            </article>
        `;
    }

    static #formatDate(value)
    {
        if (!value)
        {
            return "";
        }
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime()))
        {
            return "";
        }
        return parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    }

    static #escape(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default ReleaseNotesDialog;
