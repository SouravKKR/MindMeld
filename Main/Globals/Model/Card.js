import DialogBox from "../../CommonComponents/DialogBox.js";
import { getRandomUuid } from "../UtilityFunctions/GetRandomUuid.js";
import Deck from "./Deck.js";
import Lifecycle from "./Lifecycle.js";
import Progress from "./Progress.js";
import SyncEvents from "../Events/SyncEvents.js";
import PaidDeckFieldCipher from "../Classes/Crypto/PaidDeckFieldCipher.js";
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

    // Transient in-memory plaintext for a paid deck's encrypted content,
    // populated by decryptForStudy() at study-open and NEVER serialised. For a
    // normal (plaintext) deck #question / #answer are plain strings and these
    // stay null. For a paid deck they hold the AES-GCM envelope objects until
    // the deck is unlocked + decrypted, after which these caches feed the
    // synchronous accessors.
    #decryptedQuestion = null;
    #decryptedAnswer = null;
     
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
        return Card.#readContentField(this.#question, this.#decryptedQuestion);
    }

    getAnswer()
    {
        return Card.#readContentField(this.#answer, this.#decryptedAnswer);
    }

    /**
     * Resolves a content field to its display string. A plaintext field (normal
     * deck) is returned as-is. An encrypted field (paid deck) returns the
     * decrypted cache when the deck has been unlocked + decryptForStudy() has
     * run, otherwise a locked placeholder — so paid content is never exposed in
     * plaintext until the buyer unlocks the deck this session.
     */
    static #readContentField(storedValue, decryptedCache)
    {
        if (PaidDeckFieldCipher.isEncryptedField(storedValue))
        {
            return decryptedCache !== null ? decryptedCache : PaidDeckFieldCipher.LOCKED_PLACEHOLDER;
        }
        return storedValue;
    }

    /**
     * Pre-decrypts this card's encrypted content fields into the transient
     * in-memory caches the synchronous accessors read from. Called once when a
     * study session (or Ask-AI / mock-test answer key / curated view) opens a
     * paid deck, mirroring how the rest of the study UI consumes getQuestion()
     * / getAnswer() synchronously. A no-op for a normal (plaintext) deck or a
     * locked deck (decrypt throws -> cache stays null -> accessor shows the
     * locked placeholder).
     */
    async decryptForStudy()
    {
        const paidDeckId = this.getDeck()?.getAdditionalData?.()?.paidDeckId;
        if (!paidDeckId)
        {
            return;
        }

        // Idempotent: only decrypt fields not already cached this session, so a
        // re-run (e.g. another Study click) is a no-op instead of re-running
        // WebCrypto over the whole deck.
        if (this.#decryptedQuestion === null && PaidDeckFieldCipher.isEncryptedField(this.#question))
        {
            try
            {
                this.#decryptedQuestion = await PaidDeckFieldCipher.decryptField(paidDeckId, this.#question);
            }
            catch (decryptError)
            {
                this.#decryptedQuestion = null;
            }
        }

        if (this.#decryptedAnswer === null && PaidDeckFieldCipher.isEncryptedField(this.#answer))
        {
            try
            {
                this.#decryptedAnswer = await PaidDeckFieldCipher.decryptField(paidDeckId, this.#answer);
            }
            catch (decryptError)
            {
                this.#decryptedAnswer = null;
            }
        }
    }

    /**
     * True when this card has encrypted content not yet decrypted this session
     * — used to count real work before showing a decrypt progress bar (and to
     * skip the bar entirely when everything is already cached).
     */
    needsDecryption()
    {
        return (this.#decryptedQuestion === null && PaidDeckFieldCipher.isEncryptedField(this.#question))
            || (this.#decryptedAnswer === null && PaidDeckFieldCipher.isEncryptedField(this.#answer));
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
        // Paid-deck content is server-authored and read-only on the device —
        // refuse to overwrite it so no edit path can ever write plaintext into
        // a paid card at rest (the encrypted envelope must stay intact).
        if (this.getDeck()?.getAdditionalData?.()?.paidDeckId)
        {
            return;
        }
        this.#question = question;
        this.#lifecycle?.touch();
    }

    setAnswer(answer)
    {
        if (this.getDeck()?.getAdditionalData?.()?.paidDeckId)
        {
            return;
        }
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
        // getDueDate() may return a Date (the normal BSON-round-tripped
        // case) OR an ISO string (when the data was JSON-serialised at
        // some point — exports, sync payloads, legacy storage). Mixing
        // those types in a comparator silently produces NaN and breaks
        // the spaced-repetition priority queue. Funnel through
        // `new Date(value).getTime()` so the comparison is always a
        // pair of timestamp numbers.
        return new Date(this.getDueDate()).getTime() <= (Date.now() + twoMinutes);
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
        // Paid decks now persist + sync exactly like normal decks: the content
        // fields are already ciphertext envelopes (#question / #answer), so
        // toJson() emits ciphertext and progress rides the normal pipeline. The
        // server preserves its plaintext content and only takes the progress.
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