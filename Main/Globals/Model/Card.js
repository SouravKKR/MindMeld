import DialogBox from "../../CommonComponents/DialogBox.js";
import { getRandomUuid } from "../UtilityFunctions/GetRandomUuid.js";
import Deck from "./Deck.js";
import Lifecycle from "./Lifecycle.js";
import Progress from "./Progress.js";
import SyncEvents from "../Events/SyncEvents.js";
import { entityTypes } from "../Enumerations/EntityTypes.js";

class Card
{
    #id = "";
    #question = "";
    #answer = "";
    #tags = [];
    #deckId = "";
    #baseDifficulty = 1500;
    #progress = null;
    #lifecycle = null;
    #additionalData = {};
     
    static #defaultBaseDifficulty = 1500;

    static fromJson(json)
    {
        const progress = Progress.fromJson(json.progress);
        const lifecycle = Lifecycle.fromJson(json.lifecycle);
        
        if(!json.baseDifficulty || json.baseDifficulty <= 0)
        {
            json.baseDifficulty = Card.#defaultBaseDifficulty;
        }

        return new Card(json.id, json.question, json.answer, json.tags, json.deckId, json.baseDifficulty, progress, lifecycle, json.additionalData);
    }

    static getDefaultBaseDifficulty()
    {
        return this.#defaultBaseDifficulty;
    }

    toJson()
    {
        return {
            id: this.#id,
            question: this.#question,
            answer: this.#answer,
            tags: this.#tags,
            deckId: this.#deckId,
            baseDifficulty: this.#baseDifficulty,
            progress: this.#progress.toJson(),
            lifecycle: this.#lifecycle.toJson(),
            additionalData: this.#additionalData
        }
    }

    /**
     * Generates a unique id for a card.
     * @returns {string} A unique id for a card.
     */
    static generateId()
    {
        return getRandomUuid();
    }
    
    getId()
    {
        return this.#id;
    }

    getDeckId()
    {
        return this.#deckId;
    }

    getDeck()
    {
        return Deck.getById(this.#deckId);
    }

    getQuestion()
    {
        return this.#question;
    }

    getAnswer()
    {
        return this.#answer;
    }

    getTags()
    {
        return this.#tags;
    }

    /**
     * Returns the progress of the card.
     * @returns {Progress} The progress of the card.
     */
    getProgress()
    {
        return this.#progress;
    }

    /**
     * Returns the lifecycle of the card.
     * @returns {Lifecycle} The lifecycle of the card.
     */
    getLifecycle()
    {
        return this.#lifecycle;
    }

    getBaseDifficulty()
    {
        return this.#baseDifficulty;
    }

    getAdditionalData()
    {
        return this.#additionalData;
    }

    isReview()
    {
        return this.#additionalData.review == true;
    }
    
    setAdditionalDataField(key, value)
    {
        this.#additionalData[key] = value;
        this.#lifecycle?.touch();
    }

    setAdditionalData(data)
    {
        this.#additionalData = data;
        this.#lifecycle?.touch();
    }

    getDueDate()
    {
        const fsrsState = this.#progress.getFsrsState();

        if(fsrsState.due)
        {
            return fsrsState.due;
        }
        else
        {
            return this.#lifecycle.getCreationDate();
        }
    }

    setQuestion(question)
    {
        this.#question = question;
        this.#lifecycle?.touch();
    }

    setAnswer(answer)
    {
        this.#answer = answer;
        this.#lifecycle?.touch();
    }

    setTags(tags)
    {
        this.#tags = tags;
        this.#lifecycle?.touch();
    }

    setProgress(progress)
    {
        this.#progress = progress;
    }

    setBaseDifficulty(baseDifficulty)
    {
        this.#baseDifficulty = baseDifficulty;
    }
    
    setDeckId(deckId)
    {
        this.#deckId = deckId;
    }

    move(oldDeck, newDeck)
    {
        newDeck.addCard(this);
        oldDeck.removeCard(this);
    }

    async delete()
    {
        this.getDeck().removeCard(this);
        await this.getDeck().save(false);

        window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_DELETED, 
        { 
            detail: 
            { 
                entityId: this.getId(), 
                entityType: entityTypes.CARD 
            } 
        }));
    }
    
    isDue()
    {
        const twoMinutes = 120 * 1000;
        return this.getDueDate() <= (Date.now() + twoMinutes);
    }
    
    validate(showAlerts = false)
    {
        if(!this.#question)
        {
            if(showAlerts)
            {
                DialogBox.alert("Invalid Card", "A card must have a question.");
            }

            return false;
        }

        if(!this.#answer)
        {
            if(showAlerts)
            {
                DialogBox.alert("Invalid Card", "A card must have an answer.");
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
                entityType: entityTypes.CARD, 
                data: this.toJson() 
            } 
        }));
    }

    async attempt(userRating, timeSpentInSeconds, bSave = true)
    {
        const currentProgressPoint = this.#progress.getCurrentProgressPoint();
        const newProgressPoint = currentProgressPoint.generateNext(userRating, this);

        this.view(timeSpentInSeconds, false);

        this.#progress.append(newProgressPoint);

        if(bSave)
        {
            await this.save();
        }
    }

    async view(timeSpentInSeconds, bSave = true)
    {
        this.#lifecycle.spendTime(timeSpentInSeconds);
        this.#lifecycle.view();

        if(bSave)
        {
            await this.save();
        }
    }

    async reset()
    {
        this.#lifecycle.reset();
        this.#progress.reset();

        await this.save();
    }
    
    /**
     * Creates a new Card object.
     * @param {string} id - The id of the card.
     * @param {string} question - The question associated with the card.
     * @param {string} answer - The answer associated with the card.
     * @param {string[]} tags - Tags associated with the card.
     * @param {string} deckId - The id of the deck that the card belongs to.
     * @param {number} baseDifficulty - The base difficulty of the card according to ratings on glicko 2.
     * @param {Progress} progress - The progress of the card.
     * @param {Lifecycle} lifecycle - The lifecycle of the card.
     * @param {object} additionalData - Additional data associated with the card.
     */
    constructor(id, question, answer, tags, deckId, baseDifficulty, progress, lifecycle, additionalData = {})
    {
        this.#id = id;
        this.#question = question;
        this.#answer = answer;
        this.#tags = tags;
        this.#deckId = deckId;
        this.#baseDifficulty = baseDifficulty; 
        this.#progress = progress;
        this.#lifecycle = lifecycle;
        this.#additionalData = additionalData;
    } 
}

export default Card;