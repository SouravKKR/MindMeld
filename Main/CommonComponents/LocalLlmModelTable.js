import { localLlmDownloadStates } from "../Globals/Enumerations/LocalLlmDownloadStates.js";
import LocalLlmCapability from "../Globals/Classes/LocalLlm/LocalLlmCapability.js";
import LocalLlmDownloadEvents from "../Globals/Events/LocalLlmDownloadEvents.js";
import LocalLlmDownloadManager from "../Globals/Classes/LocalLlm/LocalLlmDownloadManager.js";
import PreferredLocalLlmModel from "../Globals/Classes/LocalLlm/PreferredLocalLlmModel.js";


/**
 * LocalLlmModelTable
 *
 * The Free tier's on-device models, one row each, with what this device holds
 * and what can be done about it.
 *
 * It replaced a dropdown, and the reason is worth keeping. A `<select>` can
 * express only one thing — which model is chosen — while a learner managing a
 * couple of gigabytes of weights needs four: which models exist, which are on
 * this device, which one is answering questions, and how to get rid of one.
 * Folding all of that into a single choice meant picking a model implicitly
 * committed you to downloading it, there was no way to remove one, and
 * switching while a download ran read back the wrong model's state and
 * announced the tier was unavailable while it was demonstrably working.
 *
 * So the actions are separate and named: Download fetches, Use switches,
 * Delete removes. Choosing a model you do not have does not start a download,
 * and downloading one does not switch you onto it.
 *
 * IT ONLY EVER LISTS WHAT THE DEVICE CAN RUN, from
 * LocalLlmModelSelector.listEligibleModels — the same admission the automatic
 * pick uses, so the offer and the enforcement cannot drift. A machine that
 * cannot hold the 3B is never shown it.
 */
class LocalLlmModelTable extends HTMLElement
{
    static tagName = "local-llm-model-table";

    // How often the progress figure is re-read while a download runs. The
    // fraction is deliberately not persisted per tick and no event carries it
    // to this component, so it is polled — a second is frequent enough to look
    // live and rare enough to cost nothing.
    static PROGRESS_POLL_INTERVAL_MILLISECONDS = 1000;

    static #bHasBoundWindowListeners = false;

    #eligibleModels = [];
    #pendingDeletionModelKey = null;
    #busyModelKey = null;
    #progressPollHandle = null;

    async connectedCallback()
    {
        this.innerHTML = `<div class="local-llm-model-table-body"></div>`;

        LocalLlmModelTable.#bindWindowListenersOnce();

        // Awaited, not assumed. Everything below reads what this device holds
        // out of the inventory, and the inventory is loaded from storage by
        // initialize() — memoised, so this is free when something else already
        // did it. Without it the table depends on whichever surface happened
        // to run first, and opening Settings before touching the tier picker
        // renders every model as "Not downloaded" on a device that holds them
        // all: the exact wrong answer, shown confidently, with a Download
        // button offering to re-fetch gigabytes that are already there.
        await LocalLlmCapability.initialize();
        await PreferredLocalLlmModel.hydrate();
        await this.#render();

        // Corrects the recorded state against what storage actually holds, in
        // the background. It can involve a command round-trip per model, so
        // the table paints from the record first and repaints if reality
        // disagrees — rather than showing an empty panel while it asks.
        this.#reconcileAgainstStorage();
    }

    disconnectedCallback()
    {
        this.#stopProgressPolling();
    }

    /**
     * Bound once per class, not per instance, and re-reading the DOM at fire
     * time. This control is rebuilt every time the AI tab is opened, so
     * per-instance window listeners would accumulate closures over detached
     * elements — the pattern HomePage documents.
     */
    static #bindWindowListenersOnce()
    {
        if (LocalLlmModelTable.#bHasBoundWindowListeners)
        {
            return;
        }
        LocalLlmModelTable.#bHasBoundWindowListeners = true;

        const refreshMounted = () =>
        {
            for (const mountedElement of document.querySelectorAll(LocalLlmModelTable.tagName))
            {
                mountedElement.refresh();
            }
        };

        window.addEventListener(LocalLlmDownloadEvents.CAPABILITY_CHANGED, refreshMounted);
        window.addEventListener(LocalLlmDownloadEvents.PREFERRED_MODEL_CHANGED, refreshMounted);
        window.addEventListener(LocalLlmDownloadEvents.INVENTORY_CHANGED, refreshMounted);
        window.addEventListener(LocalLlmDownloadEvents.COMPLETED, refreshMounted);
        window.addEventListener(LocalLlmDownloadEvents.FAILED, refreshMounted);
    }

    refresh()
    {
        this.#render().catch((renderError) =>
        {
            console.warn(`[LocalLlmModelTable] Could not refresh: ${renderError?.message || renderError}`);
        });
    }

    async #reconcileAgainstStorage()
    {
        try
        {
            let bAnythingChanged = false;

            for (const candidate of this.#eligibleModels)
            {
                const bChanged = await LocalLlmCapability.reconcileModelAgainstStorage(candidate.modelKey);
                bAnythingChanged = bAnythingChanged || bChanged;
            }

            if (bAnythingChanged)
            {
                await this.#render();
            }
        }
        catch (reconcileError)
        {
            console.warn(`[LocalLlmModelTable] Could not reconcile against storage: ${reconcileError?.message || reconcileError}`);
        }
    }

    async #render()
    {
        const bodyElement = this.querySelector(".local-llm-model-table-body");
        if (!bodyElement)
        {
            return;
        }

        this.#eligibleModels = await LocalLlmCapability.listEligibleModels();

        if (this.#eligibleModels.length === 0)
        {
            // Not an error state — a device with no model that fits. The tier
            // picker's own status line already explains which wall was hit, and
            // repeating it here in a table with no rows would be noise.
            this.hidden = true;
            this.#stopProgressPolling();
            return;
        }
        this.hidden = false;

        const activeModelKey = LocalLlmCapability.getSelectedModelKey();
        const bAutomatic = PreferredLocalLlmModel.getModelKey() === null;

        bodyElement.innerHTML = `
            <div class="local-llm-model-row local-llm-model-row-header">
                <span class="local-llm-model-cell-name">Model</span>
                <span class="local-llm-model-cell-size">Size</span>
                <span class="local-llm-model-cell-status">Status</span>
                <span class="local-llm-model-cell-actions"></span>
            </div>
            ${this.#eligibleModels.map((candidate) => this.#renderRow(candidate, activeModelKey)).join("")}
            <div class="local-llm-model-table-note">${this.#buildFooterText(bAutomatic, activeModelKey)}</div>
        `;

        this.#bindRowActions();
        this.#synchroniseProgressPolling();
    }

    #renderRow(candidate, activeModelKey)
    {
        const modelState = LocalLlmCapability.getModelState(candidate.modelKey);
        const bActive = candidate.modelKey === activeModelKey;
        const bPendingDeletion = this.#pendingDeletionModelKey === candidate.modelKey;

        const rowClassNames = ["local-llm-model-row"];
        if (bActive)
        {
            rowClassNames.push("local-llm-model-row-active");
        }

        return `
            <div class="${rowClassNames.join(" ")}" data-model-key="${candidate.modelKey}">
                <span class="local-llm-model-cell-name">${candidate.parameterLabel}</span>
                <span class="local-llm-model-cell-size">${candidate.approximateTotalLabel}</span>
                <span class="local-llm-model-cell-status">${this.#buildStatusText(candidate, modelState, bActive)}</span>
                <span class="local-llm-model-cell-actions">
                    ${bPendingDeletion
                        ? this.#buildDeletionConfirmationMarkup(candidate)
                        : this.#buildActionsMarkup(candidate, modelState, bActive)}
                </span>
            </div>
        `;
    }

    #buildStatusText(candidate, modelState, bActive)
    {
        if (this.#busyModelKey === candidate.modelKey)
        {
            return `<span class="local-llm-model-status-busy">Working…</span>`;
        }

        switch (modelState)
        {
            case localLlmDownloadStates.DOWNLOADING:
            {
                const percent = Math.round(
                    Math.max(0, Math.min(1, LocalLlmCapability.getModelProgressFraction(candidate.modelKey))) * 100
                );
                return `<span class="local-llm-model-status-downloading">Downloading… ${percent}%</span>`;
            }

            case localLlmDownloadStates.READY:
                return bActive
                    ? `<span class="local-llm-model-status-active">In use</span>`
                    : `<span class="local-llm-model-status-ready">On this device</span>`;

            case localLlmDownloadStates.FAILED:
                return `<span class="local-llm-model-status-failed">Download failed</span>`;

            default:
                // An active model that is not downloaded is the ordinary
                // starting state, and saying "in use" there would be a lie —
                // nothing can answer until the weights arrive.
                return `<span class="local-llm-model-status-absent">Not downloaded</span>`;
        }
    }

    #buildActionsMarkup(candidate, modelState, bActive)
    {
        const bAnyDownloadRunning = LocalLlmDownloadManager.isRunning();
        const bThisDownloadRunning = modelState === localLlmDownloadStates.DOWNLOADING && bAnyDownloadRunning;

        if (bThisDownloadRunning)
        {
            return `<button type="button" class="local-llm-model-action" data-action="cancel">Cancel</button>`;
        }

        const actionMarkup = [];

        if (modelState === localLlmDownloadStates.READY)
        {
            if (!bActive)
            {
                actionMarkup.push(`<button type="button" class="local-llm-model-action" data-action="use">Use</button>`);
            }
            actionMarkup.push(`<button type="button" class="local-llm-model-action local-llm-model-action-danger" data-action="delete">Delete</button>`);
        }
        else
        {
            // Disabled rather than hidden while another model downloads: a
            // button that vanishes reads as a bug, and the reason it cannot be
            // pressed — one download at a time — is worth stating.
            const disabledAttribute = bAnyDownloadRunning ? " disabled" : "";
            const titleAttribute = bAnyDownloadRunning
                ? ` title="Another model is downloading. One at a time."`
                : "";
            actionMarkup.push(`<button type="button" class="local-llm-model-action" data-action="download"${disabledAttribute}${titleAttribute}>${modelState === localLlmDownloadStates.FAILED ? "Retry" : "Download"}</button>`);

            if (!bActive)
            {
                actionMarkup.push(`<button type="button" class="local-llm-model-action" data-action="use">Use</button>`);
            }
        }

        return actionMarkup.join("");
    }

    /**
     * Deletion asks twice, in the row itself.
     *
     * It throws away a download measured in gigabytes that may have taken an
     * hour over a phone connection, and it is one click away from Use. A
     * native confirm() dialog would do the job but is blockable and looks
     * nothing like the rest of the app, so the row becomes its own
     * confirmation.
     */
    #buildDeletionConfirmationMarkup(candidate)
    {
        return `
            <span class="local-llm-model-confirm-text">Delete ${candidate.approximateTotalLabel}?</span>
            <button type="button" class="local-llm-model-action local-llm-model-action-danger" data-action="confirm-delete">Delete</button>
            <button type="button" class="local-llm-model-action" data-action="cancel-delete">Keep</button>
        `;
    }

    #buildFooterText(bAutomatic, activeModelKey)
    {
        if (bAutomatic)
        {
            const activeCandidate = this.#eligibleModels.find((candidate) => candidate.modelKey === activeModelKey);
            const activeLabel = activeCandidate ? activeCandidate.parameterLabel : "the best model this device can run";
            return `Choosing automatically — currently ${activeLabel}. Picking a model above fixes that choice to it.`;
        }

        return `Using the model you picked. <button type="button" class="local-llm-model-link" data-action="automatic">Choose automatically instead</button>`;
    }

    #bindRowActions()
    {
        for (const actionButton of this.querySelectorAll("[data-action]"))
        {
            actionButton.addEventListener("click", () =>
            {
                const action = actionButton.getAttribute("data-action");
                const modelKey = actionButton.closest("[data-model-key]")?.getAttribute("data-model-key") || null;

                this.#handleAction(action, modelKey).catch((actionError) =>
                {
                    console.warn(`[LocalLlmModelTable] "${action}" failed: ${actionError?.message || actionError}`);
                });
            });
        }
    }

    async #handleAction(action, modelKey)
    {
        if (action === "automatic")
        {
            await PreferredLocalLlmModel.setModelKey(null);
            await LocalLlmCapability.reresolve();
            await this.#render();
            return;
        }

        if (!modelKey)
        {
            return;
        }

        if (action === "use")
        {
            await this.#useModel(modelKey);
            return;
        }

        if (action === "download")
        {
            // Not awaited. A download runs for minutes and the table must stay
            // interactive throughout — that is the whole point of fixing the
            // switching bug. State arrives through INVENTORY_CHANGED and the
            // progress poll.
            LocalLlmDownloadManager.start(modelKey);
            await this.#render();
            return;
        }

        if (action === "cancel")
        {
            LocalLlmDownloadManager.cancel();
            await this.#render();
            return;
        }

        if (action === "delete")
        {
            this.#pendingDeletionModelKey = modelKey;
            await this.#render();
            return;
        }

        if (action === "cancel-delete")
        {
            this.#pendingDeletionModelKey = null;
            await this.#render();
            return;
        }

        if (action === "confirm-delete")
        {
            await this.#deleteModel(modelKey);
        }
    }

    /**
     * Switches the tier onto a model, WITHOUT requiring it to be downloaded.
     *
     * Selecting a model that is not on the device is allowed on purpose: it is
     * how a learner says "this is the one I want", and the download then
     * happens when they ask for it, or when they next use Free. Refusing the
     * selection until the bytes are present would put a gigabyte between the
     * learner and a decision that costs nothing to record.
     */
    async #useModel(modelKey)
    {
        this.#busyModelKey = modelKey;
        await this.#render();

        try
        {
            await PreferredLocalLlmModel.setModelKey(modelKey);
            await LocalLlmCapability.reresolve();
        }
        finally
        {
            this.#busyModelKey = null;
            await this.#render();
        }
    }

    async #deleteModel(modelKey)
    {
        this.#pendingDeletionModelKey = null;
        this.#busyModelKey = modelKey;
        await this.#render();

        try
        {
            await LocalLlmCapability.deleteModel(modelKey);
        }
        catch (deletionError)
        {
            // Surfaced in the row rather than swallowed. "Delete" that quietly
            // does nothing is the failure mode that makes people delete the
            // whole app instead.
            console.warn(`[LocalLlmModelTable] Could not delete "${modelKey}": ${deletionError?.message || deletionError}`);
            this.#busyModelKey = null;
            await this.#render();
            this.#showRowError(modelKey, deletionError?.message || "Could not delete this model.");
            return;
        }

        this.#busyModelKey = null;
        await this.#render();
    }

    /**
     * Written as text rather than markup. Everything else in this table is
     * built from the catalogue, but this string comes back from a driver — and
     * on the native path that means it originated in an operating-system error
     * that can contain a file path or any other character. Interpolated into
     * innerHTML, an angle bracket in a Windows error would silently swallow
     * the rest of the message the learner needs to read.
     */
    #showRowError(modelKey, message)
    {
        const statusCell = this.querySelector(`[data-model-key="${modelKey}"] .local-llm-model-cell-status`);
        if (!statusCell)
        {
            return;
        }

        const errorElement = document.createElement("span");
        errorElement.className = "local-llm-model-status-failed";
        errorElement.textContent = message;

        statusCell.replaceChildren(errorElement);
    }

    #synchroniseProgressPolling()
    {
        const bDownloadRunning = LocalLlmCapability.getDownloadingModelKey() !== null;

        if (bDownloadRunning && this.#progressPollHandle === null)
        {
            this.#progressPollHandle = window.setInterval(() =>
            {
                this.#render().catch(() => {});
            }, LocalLlmModelTable.PROGRESS_POLL_INTERVAL_MILLISECONDS);
            return;
        }

        if (!bDownloadRunning)
        {
            this.#stopProgressPolling();
        }
    }

    #stopProgressPolling()
    {
        if (this.#progressPollHandle !== null)
        {
            window.clearInterval(this.#progressPollHandle);
            this.#progressPollHandle = null;
        }
    }
}

customElements.define(LocalLlmModelTable.tagName, LocalLlmModelTable);

export default LocalLlmModelTable;
