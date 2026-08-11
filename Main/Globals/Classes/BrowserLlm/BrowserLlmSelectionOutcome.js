import { browserLlmUnavailableReasons } from "../../Enumerations/BrowserLlmUnavailableReasons.js";


/**
 * BrowserLlmSelectionOutcome
 *
 * What BrowserLlmModelSelector decided, and why. Either a catalogue model key
 * was chosen, or none was and `unavailableReason` says which wall the device
 * hit — "no WebGPU and no WebAssembly" and "the model this device could run
 * has not been provisioned on the server" are very different problems, and
 * collapsing them into a single UNSUPPORTED state is what made the old code
 * unable to tell a user anything useful.
 *
 * `bDegraded` is true when the device qualified for a model, but not the best
 * one THIS DEPLOYMENT offers. Comparing against what is actually provisioned
 * rather than against the whole catalogue keeps the flag meaningful: on a
 * server that only hosts the small model, nobody could have done better, so
 * saying "degraded" would be noise. That is not a failure either way — it is
 * the mechanism that lets a mid-range phone run the Free tier at all — but
 * the learner is told, so "the answers are shorter than on my laptop" has a
 * visible explanation rather than looking like a bug.
 */
class BrowserLlmSelectionOutcome
{
    #modelKey = null;
    #preferredModelKey = null;
    #bDegraded = false;
    #unavailableReason = browserLlmUnavailableReasons.NONE;
    #degradeNote = null;

    constructor({ modelKey = null, preferredModelKey = null, unavailableReason = browserLlmUnavailableReasons.NONE, degradeNote = null } = {})
    {
        this.#modelKey = modelKey;
        this.#preferredModelKey = preferredModelKey;
        this.#bDegraded = modelKey !== null && preferredModelKey !== null && modelKey !== preferredModelKey;
        this.#unavailableReason = unavailableReason;
        this.#degradeNote = degradeNote;
    }

    getModelKey()
    {
        return this.#modelKey;
    }

    getPreferredModelKey()
    {
        return this.#preferredModelKey;
    }

    isDegraded()
    {
        return this.#bDegraded;
    }

    isAvailable()
    {
        return this.#modelKey !== null;
    }

    getUnavailableReason()
    {
        return this.#unavailableReason;
    }

    /**
     * One plain sentence about the compromise this device is running under,
     * or null when it got the best model available. Sourced from the chosen
     * catalogue entry's own `displayNote`, so a new model ships its own
     * wording rather than needing a branch here.
     */
    getHonestNote()
    {
        return this.#bDegraded ? this.#degradeNote : null;
    }
}

export default BrowserLlmSelectionOutcome;
