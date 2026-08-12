import LocalLlmCapability from "../Globals/Classes/LocalLlm/LocalLlmCapability.js";
import LocalLlmDownloadEvents from "../Globals/Events/LocalLlmDownloadEvents.js";
import PreferredLocalLlmModel from "../Globals/Classes/LocalLlm/PreferredLocalLlmModel.js";


/**
 * LocalLlmModelSelect
 *
 * Picks WHICH on-device model the Free tier runs, from the ones this device can
 * actually hold.
 *
 * The tier picker beside it answers "which AI"; this answers "which of the
 * models that fit". They are deliberately separate: asking a question stays a
 * single choice — pick Free, ask — and this sits in Settings for the person who
 * wants the smaller download, or the larger model, and knows which trade they
 * want. Nothing on the query path reads it.
 *
 * IT ONLY EVER LISTS WHAT THE DEVICE CAN RUN. The options come from
 * LocalLlmModelSelector.listEligibleModels, which is the same admission the
 * automatic pick uses — same memory floors, same device-class rules, same
 * backend support. So a machine that cannot hold the 3B is not offered it, and
 * the restriction cannot drift from the one the selector enforces, because
 * there is only one of them.
 *
 * Choosing a model the device has not downloaded does not start a download.
 * That stays where it already is — the status line under the tier picker,
 * which the learner clicks when they mean it. A settings dropdown that
 * silently began a two-gigabyte transfer would be a surprise, and this control
 * is often opened just to look.
 */
class LocalLlmModelSelect extends HTMLElement
{
    static tagName = "local-llm-model-select";

    // Chosen when no preference is stored: the selector's own ranked best.
    // A real option rather than an empty one, because "whatever suits this
    // device" is a decision a learner may want to return to after trying a
    // specific model, and it keeps following the hardware if they move the
    // app to a different machine.
    static #AUTOMATIC_OPTION_VALUE = "__automatic__";

    static #bHasBoundWindowListeners = false;

    #selectElement = null;
    #noteElement = null;

    async connectedCallback()
    {
        this.innerHTML = `
            <select class="local-llm-model-select-input" aria-label="On-device AI model"></select>
            <div class="local-llm-model-select-note"></div>
        `;

        this.#selectElement = this.querySelector(".local-llm-model-select-input");
        this.#noteElement = this.querySelector(".local-llm-model-select-note");

        this.#selectElement.addEventListener("change", () => this.#handleChange());

        LocalLlmModelSelect.#bindWindowListenersOnce();

        await PreferredLocalLlmModel.hydrate();
        await this.#render();
    }

    /**
     * Bound once per class, not per instance, and re-reading the DOM at fire
     * time. Repeated mounts — this control is rebuilt every time the AI tab is
     * opened — would otherwise accumulate listeners closing over detached
     * elements, which is the pattern HomePage documents and the reason its
     * static block exists.
     */
    static #bindWindowListenersOnce()
    {
        if (LocalLlmModelSelect.#bHasBoundWindowListeners)
        {
            return;
        }
        LocalLlmModelSelect.#bHasBoundWindowListeners = true;

        const rerenderMounted = () =>
        {
            for (const mountedElement of document.querySelectorAll(LocalLlmModelSelect.tagName))
            {
                mountedElement.refresh();
            }
        };

        window.addEventListener(LocalLlmDownloadEvents.CAPABILITY_CHANGED, rerenderMounted);
        window.addEventListener(LocalLlmDownloadEvents.PREFERRED_MODEL_CHANGED, rerenderMounted);
        window.addEventListener(LocalLlmDownloadEvents.COMPLETED, rerenderMounted);
    }

    refresh()
    {
        this.#render().catch((renderError) =>
        {
            console.warn(`[LocalLlmModelSelect] Could not refresh: ${renderError?.message || renderError}`);
        });
    }

    async #render()
    {
        if (!this.#selectElement)
        {
            return;
        }

        const eligibleModels = await LocalLlmCapability.listEligibleModels();

        // Nothing to choose between is not an error state — it is a device with
        // one option, or none. Either way a dropdown would be furniture, and
        // the tier picker's own status line already explains why.
        if (eligibleModels.length <= 1)
        {
            this.hidden = true;
            return;
        }
        this.hidden = false;

        const storedModelKey = PreferredLocalLlmModel.getModelKey();
        const automaticChoice = eligibleModels.find((candidate) => candidate.bAutomaticChoice);

        const optionsMarkup = [
            `<option value="${LocalLlmModelSelect.#AUTOMATIC_OPTION_VALUE}">`
                + `Automatic (${automaticChoice ? automaticChoice.parameterLabel : "best for this device"})`
            + `</option>`,
            ...eligibleModels.map((candidate) =>
                `<option value="${candidate.modelKey}">`
                    + `${candidate.parameterLabel} — ${candidate.approximateTotalLabel}`
                + `</option>`),
        ].join("");

        this.#selectElement.innerHTML = optionsMarkup;
        this.#selectElement.value = storedModelKey && eligibleModels.some((candidate) => candidate.modelKey === storedModelKey)
            ? storedModelKey
            : LocalLlmModelSelect.#AUTOMATIC_OPTION_VALUE;

        this.#renderNote(eligibleModels);
    }

    /**
     * Says what picking a different model will cost, before it costs it.
     *
     * The weights are hundreds of megabytes to two gigabytes and each model is
     * fetched separately, so switching is not free and the learner should know
     * that from the control rather than from a progress bar afterwards.
     */
    #renderNote(eligibleModels)
    {
        const selectedValue = this.#selectElement.value;
        const downloadedModelKey = LocalLlmCapability.getSelectedModelKey();

        if (selectedValue === LocalLlmModelSelect.#AUTOMATIC_OPTION_VALUE)
        {
            this.#noteElement.textContent = "Picks the best model this device can run. Follows the hardware if you use the app elsewhere.";
            return;
        }

        const selectedCandidate = eligibleModels.find((candidate) => candidate.modelKey === selectedValue);
        if (!selectedCandidate)
        {
            this.#noteElement.textContent = "";
            return;
        }

        this.#noteElement.textContent = selectedCandidate.modelKey === downloadedModelKey
            ? `Ready on this device. Larger models give fuller answers and take longer to run.`
            : `Not on this device yet — ${selectedCandidate.approximateTotalLabel} to download when you next use Free.`;
    }

    async #handleChange()
    {
        const selectedValue = this.#selectElement.value;

        await PreferredLocalLlmModel.setModelKey(
            selectedValue === LocalLlmModelSelect.#AUTOMATIC_OPTION_VALUE ? null : selectedValue);

        // Re-resolve so the tier picker's status line immediately reflects the
        // new model — including dropping back to "click to download" when the
        // chosen one is not on the device.
        await LocalLlmCapability.reresolve();
        await this.#render();
    }
}

customElements.define(LocalLlmModelSelect.tagName, LocalLlmModelSelect);

export default LocalLlmModelSelect;
