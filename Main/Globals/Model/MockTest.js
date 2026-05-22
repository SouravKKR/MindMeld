import DialogBox from "../../CommonComponents/DialogBox.js";
import { getRandomUuid } from "../UtilityFunctions/GetRandomUuid.js";
import Deck from "./Deck.js";
import Lifecycle from "./Lifecycle.js";
import SyncEvents from "../Events/SyncEvents.js";
import { entityTypes } from "../Enumerations/EntityTypes.js";
import MockTestAttempt from "./MockTestEntities/MockTestAttempt.js";
import MockTestItemFactory from "./MockTestEntities/MockTestItemFactory.js";

class MockTest
{
    #id = "";
    #deckId = "";
    #title = "";
    #duration = 0; // Duration in minutes. 0 = unconfigured (user sets it before starting)
    #items = []; // The blueprint array of questions/sections
    #history = []; // Array of MockTestAttempt
    #lifecycle = null;
    // Frozen-at-generation marking rule. Three-tier lookup:
    //   perSectionMarkingOverrides → perTypeMarkingOverrides → flat defaults.
    // Legacy mocks deserialize with sensible fallbacks (correct = 1, others = 0).
    #markingScheme = null;

    static DEFAULT_MARKING_SCHEME = Object.freeze({
        correctMarks: 1,
        wrongMarks: 0,
        unattemptedMarks: 0,
        partialMarks: 0,
        perTypeMarkingOverrides: {},
        perSectionMarkingOverrides: []
    });

    static generateId()
    {
        return getRandomUuid();
    }

    static fromJson(json)
    {
        const lifecycle = Lifecycle.fromJson(json.lifecycle);
        const items = (json.items || []).map(itemJson => MockTestItemFactory.fromJson(itemJson));
        const history = (json.history || []).map(attemptJson => MockTestAttempt.fromJson(attemptJson));
        const markingScheme = MockTest.#normalizeMarkingScheme(json.markingScheme);
        return new MockTest(json.id, json.deckId, json.title, json.duration ?? 0, items, history, lifecycle, markingScheme);
    }

    static #normalizeMarkingScheme(rawMarkingScheme)
    {
        if (!rawMarkingScheme || typeof rawMarkingScheme !== "object")
        {
            return { ...MockTest.DEFAULT_MARKING_SCHEME };
        }

        return {
            correctMarks: typeof rawMarkingScheme.correctMarks === "number" ? rawMarkingScheme.correctMarks : MockTest.DEFAULT_MARKING_SCHEME.correctMarks,
            wrongMarks: typeof rawMarkingScheme.wrongMarks === "number" ? rawMarkingScheme.wrongMarks : MockTest.DEFAULT_MARKING_SCHEME.wrongMarks,
            unattemptedMarks: typeof rawMarkingScheme.unattemptedMarks === "number" ? rawMarkingScheme.unattemptedMarks : MockTest.DEFAULT_MARKING_SCHEME.unattemptedMarks,
            partialMarks: typeof rawMarkingScheme.partialMarks === "number" ? rawMarkingScheme.partialMarks : MockTest.DEFAULT_MARKING_SCHEME.partialMarks,
            perTypeMarkingOverrides: rawMarkingScheme.perTypeMarkingOverrides && typeof rawMarkingScheme.perTypeMarkingOverrides === "object" ? rawMarkingScheme.perTypeMarkingOverrides : {},
            perSectionMarkingOverrides: Array.isArray(rawMarkingScheme.perSectionMarkingOverrides) ? rawMarkingScheme.perSectionMarkingOverrides : []
        };
    }

    constructor(id, deckId, title = "Mock Test", duration = 0, items = [], history = [], lifecycle = new Lifecycle(), markingScheme = null)
    {
        this.#id = id || MockTest.generateId();
        this.#deckId = deckId;
        this.#title = title;
        this.#duration = duration;
        this.#items = items;
        this.#history = history;
        this.#lifecycle = lifecycle;
        this.#markingScheme = MockTest.#normalizeMarkingScheme(markingScheme);
    }

    getId() { return this.#id; }
    getDeckId() { return this.#deckId; }
    getTitle() { return this.#title; }
    getDuration() { return this.#duration; }
    getItems() { return this.#items; }
    getHistory() { return this.#history; }
    getLifecycle() { return this.#lifecycle; }
    getMarkingScheme() { return this.#markingScheme; }

    getDeck() { return Deck.getById(this.#deckId); }

    setDeckId(deckId) { this.#deckId = deckId; }

    setTitle(title) 
    { 
        this.#title = title; 
        this.#lifecycle?.touch();
    }

    setDuration(duration)
    {
        this.#duration = duration;
        this.#lifecycle?.touch();
    }

    setItems(items)
    {
        this.#items = items;
        this.#lifecycle?.touch();
    }

    setMarkingScheme(markingScheme)
    {
        this.#markingScheme = MockTest.#normalizeMarkingScheme(markingScheme);
        this.#lifecycle?.touch();
    }

    /**
     * Resolves the effective marking rule for a single question. Honors the
     * three-tier lookup: section override → per-question-type override →
     * flat defaults. The section pointer is matched by id against
     * perSectionMarkingOverrides[*].sectionItemId; if not pre-bound, the
     * caller can pass a `sectionLabel` to look up by name as a fallback.
     */
    resolveMarkingRuleForQuestion(question, sectionContext = null)
    {
        const scheme = this.#markingScheme;
        const baseRule = {
            correctMarks: scheme.correctMarks,
            wrongMarks: scheme.wrongMarks,
            unattemptedMarks: scheme.unattemptedMarks,
            partialMarks: scheme.partialMarks
        };

        if (sectionContext)
        {
            const sectionOverride = (scheme.perSectionMarkingOverrides || []).find((sectionEntry) =>
            {
                if (!sectionEntry)
                {
                    return false;
                }
                if (sectionEntry.sectionItemId && sectionContext.id === sectionEntry.sectionItemId)
                {
                    return true;
                }
                if (sectionEntry.name && sectionContext.label === sectionEntry.name)
                {
                    return true;
                }
                return false;
            });

            if (sectionOverride)
            {
                return MockTest.#overlayMarkingRule(baseRule, sectionOverride);
            }
        }

        const typeKey = question?.additionalData?.typeKey;
        if (typeKey && scheme.perTypeMarkingOverrides && scheme.perTypeMarkingOverrides[typeKey])
        {
            return MockTest.#overlayMarkingRule(baseRule, scheme.perTypeMarkingOverrides[typeKey]);
        }

        return baseRule;
    }

    static #overlayMarkingRule(baseRule, overlayRule)
    {
        return {
            correctMarks: typeof overlayRule.correctMarks === "number" ? overlayRule.correctMarks : baseRule.correctMarks,
            wrongMarks: typeof overlayRule.wrongMarks === "number" ? overlayRule.wrongMarks : baseRule.wrongMarks,
            unattemptedMarks: typeof overlayRule.unattemptedMarks === "number" ? overlayRule.unattemptedMarks : baseRule.unattemptedMarks,
            partialMarks: typeof overlayRule.partialMarks === "number" ? overlayRule.partialMarks : baseRule.partialMarks
        };
    }

    addAttempt(attempt) 
    {
        this.#history.push(attempt);
        this.#lifecycle?.touch();
    }

    async view(timeSpentInSeconds, bSave = true) 
    {
        this.#lifecycle.spendTime(timeSpentInSeconds);
        this.#lifecycle.view();

        if (bSave) 
        {
            await this.save();
        }
    }

    validate(showAlerts = false) 
    {
        if (!this.#items || this.#items.length === 0) 
        {
            if (showAlerts) 
            {
                DialogBox.alert("Invalid Mock Test", "A mock test must have at least one question or item.");
            }
            return false;
        }
        return true;
    }

    async save() 
    {
        await this.getDeck().save(false);

        window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED, 
        {
            detail: 
            {
                entityId: this.getId(),
                entityType: entityTypes.MOCK_TEST,
                data: this.toJson()
            }
        }));
    }

    async delete() 
    {
        this.getDeck().removeMockTest(this);
        await this.getDeck().save(false);

        window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED, 
        {
            detail: 
            {
                entityId: this.getId(),
                entityType: entityTypes.MOCK_TEST
            }
        }));
    }

    toJson()
    {
        return {
            id: this.#id,
            deckId: this.#deckId,
            title: this.#title,
            duration: this.#duration,
            items: this.#items.map(item => item.toJson()),
            history: this.#history.map(attempt => attempt.toJson()),
            lifecycle: this.#lifecycle.toJson(),
            markingScheme: this.#markingScheme
        };
    }
}

export default MockTest;