import DialogBox from "../../CommonComponents/DialogBox.js";
import { getRandomUuid } from "../UtilityFunctions/GetRandomUuid.js";
import Deck from "./Deck.js";
import Lifecycle from "./Lifecycle.js";
import SyncEvents from "../Events/SyncEvents.js";
import { entityTypes } from "../Enumerations/EntityTypes.js";
import { studyMaterialDetailLevels } from "../Enumerations/StudyMaterialDetailLevels.js";

class StudyMaterial
{
    #id = "";
    #content = "";
    #deckId = "";
    #lifecycle = null;
    #syllabusPosition = 0;
    #detailLevel = studyMaterialDetailLevels.STANDARD;

    /**
     * Creates a StudyMaterial instance from a plain JSON object.
     * @param {object} json - The JSON object to deserialise.
     * @returns {StudyMaterial} The deserialised StudyMaterial.
     */
    static fromJson(json)
    {
        const lifecycle = Lifecycle.fromJson(json.lifecycle);
        const detailLevel = (typeof json.detailLevel === "number") ? json.detailLevel : studyMaterialDetailLevels.STANDARD;
        return new StudyMaterial(json.id, json.content, json.deckId, lifecycle, json.syllabusPosition ?? 0, detailLevel);
    }

    /**
     * Generates a unique id for a study material.
     * @returns {string} A unique id.
     */
    static generateId()
    {
        return getRandomUuid();
    }

    toJson()
    {
        return {
            id: this.#id,
            content: this.#content,
            deckId: this.#deckId,
            lifecycle: this.#lifecycle.toJson(),
            syllabusPosition: this.#syllabusPosition,
            detailLevel: this.#detailLevel
        };
    }

    getSyllabusPosition()
    {
        return this.#syllabusPosition;
    }

    getDetailLevel()
    {
        return this.#detailLevel;
    }

    setDetailLevel(detailLevel)
    {
        this.#detailLevel = detailLevel;
        this.#lifecycle?.touch();
    }

    getId()
    {
        return this.#id;
    }

    getContent()
    {
        return this.#content;
    }

    getDeckId()
    {
        return this.#deckId;
    }

    /**
     * Returns the lifecycle of the study material.
     * @returns {Lifecycle} The lifecycle of the study material.
     */
    getLifecycle()
    {
        return this.#lifecycle;
    }

    /**
     * Returns the deck this study material belongs to.
     * @returns {Deck} The deck this study material belongs to.
     */
    getDeck()
    {
        return Deck.getById(this.#deckId);
    }

    setContent(content)
    {
        this.#content = content;
        this.#lifecycle?.touch();
    }

    setDeckId(deckId)
    {
        this.#deckId = deckId;
    }

    /**
     * Records time spent reading this study material and optionally saves.
     * @param {number} timeSpentInSeconds - Time spent reading, in seconds.
     * @param {boolean} bSave - Whether to persist the change immediately.
     */
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
        if (!this.#content)
        {
            if (showAlerts)
            {
                DialogBox.alert("Invalid Study Material", "A study material must have content.");
            }

            return false;
        }

        return true;
    }

    async save()
    {
        const owningDeck = this.getDeck();
        if (!owningDeck)
        {
            // Stale deckId — the material's recorded parent isn't in
            // Deck.#idMap. Don't crash the study session; just skip
            // persistence. Deck.addStudyMaterial re-stamps deckId on load,
            // so this branch should only fire for in-flight orphans.
            console.warn(`[StudyMaterial] save() skipped: material ${this.getId()} has no owning deck (deckId=${this.#deckId}).`);
            return;
        }

        await owningDeck.save(false);

        window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED,
        {
            detail:
            {
                entityId: this.getId(),
                entityType: entityTypes.STUDY_MATERIAL,
                data: this.toJson()
            }
        }));
    }

    async delete()
    {
        const owningDeck = this.getDeck();
        if (!owningDeck)
        {
            console.warn(`[StudyMaterial] delete() skipped: material ${this.getId()} has no owning deck (deckId=${this.#deckId}).`);
            return;
        }

        owningDeck.removeStudyMaterial(this);
        await owningDeck.save(false);

        window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED,
        {
            detail:
            {
                entityId: this.getId(),
                entityType: entityTypes.STUDY_MATERIAL
            }
        }));
    }

    /**
     * Creates a new StudyMaterial object.
     * @param {string} id - The id of the study material.
     * @param {string} content - The HTML content of the study material.
     * @param {string} deckId - The id of the deck this study material belongs to.
     * @param {Lifecycle} lifecycle - The lifecycle of the study material.
     * @param {number} syllabusPosition - The zero-based position of this material in the original syllabus ordering.
     * @param {number} detailLevel - StudyMaterialDetailLevels enum value (default STANDARD).
     */
    constructor(id, content, deckId, lifecycle, syllabusPosition = 0, detailLevel = studyMaterialDetailLevels.STANDARD)
    {
        this.#id = id;
        this.#content = content;
        this.#deckId = deckId;
        this.#lifecycle = lifecycle;
        this.#syllabusPosition = syllabusPosition;
        this.#detailLevel = detailLevel;
    }
}

export default StudyMaterial;