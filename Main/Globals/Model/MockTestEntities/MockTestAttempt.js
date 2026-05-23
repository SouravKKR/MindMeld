import { getRandomUuid } from "../../UtilityFunctions/GetRandomUuid.js";
import MockTestItemFactory from "./MockTestItemFactory.js";

class MockTestAttempt
{
    #id = "";
    #attemptDate = null;
    #items = [];
    #score = 0;
    #maxScore = 0;
    // Free-form bag for per-attempt metadata that does not warrant a
    // dedicated field. Offline-mode attempts stash uploaded scan file
    // paths here under `uploadedFiles: string[]` so the deferred OCR +
    // LLM evaluation pipeline can pick them up later.
    #additionalData = {};

    constructor(id, attemptDate = new Date(), items = [], score = 0, maxScore = 0, additionalData = {})
    {
        this.#id = id || getRandomUuid();
        this.#attemptDate = new Date(attemptDate);
        this.#items = items;
        this.#score = score;
        this.#maxScore = maxScore;
        this.#additionalData = additionalData || {};
    }

    getId() { return this.#id; }
    getAttemptDate() { return this.#attemptDate; }
    getItems() { return this.#items; }
    getScore() { return this.#score; }
    getMaxScore() { return this.#maxScore; }
    getAdditionalData() { return this.#additionalData; }

    setItems(items) { this.#items = items; }
    setScore(score) { this.#score = score; }
    setMaxScore(maxScore) { this.#maxScore = maxScore; }
    setAdditionalData(additionalData) { this.#additionalData = additionalData || {}; }

    /**
     * Placeholder method to evaluate the items answered by the user.
     * Eventually, this might call an LLM with the #answer and #expectedAnswer
     * to assign a #score out of #marks for each MockTestQuestion.
     */
    evaluate()
    {
        console.log(`[MockTestAttempt] Evaluating attempt: ${this.#id}`);
        // TODO: Iterate over this.#items, score questions, and update this.#score
    }

    toJson()
    {
        return {
            id: this.#id,
            attemptDate: this.#attemptDate.toISOString(),
            items: this.#items.map(item => item.toJson()),
            score: this.#score,
            maxScore: this.#maxScore,
            additionalData: this.#additionalData
        };
    }

    static fromJson(json)
    {
        const items = (json.items || []).map(itemJson => MockTestItemFactory.fromJson(itemJson));
        return new MockTestAttempt(json.id, json.attemptDate, items, json.score, json.maxScore, json.additionalData || {});
    }
}

export default MockTestAttempt;
