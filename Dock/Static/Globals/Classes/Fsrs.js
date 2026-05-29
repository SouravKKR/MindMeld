class Fsrs
{
    #difficulty = 0;
    #stability = 0;
    #repetitions = 0;
    #lapses = 0;
    #lastReview = null;
    #due = null;

    static #MIN_INTERVAL = 0.001;

    static #weights = 
    [
        0.4025, 1.4614, 3.326, 17.8385, 
        5.0723, 1.1831, 0.9592, 0.0697, 
        1.524, 0.154, 1.0461, 2.2158, 
        0.0065, 0.3298, 1.4528, 0.2315, 2.1814
    ];

    static #maximumInterval = 36500;
    static #requestedRetention = 0.9;

    static fromJson(json)
    {
        // Coerce date fields back to Date objects. BSON preserves Date
        // types through a round-trip, but any code path that serialises
        // through JSON (export / import, network sync payloads, manual
        // reads from older formats) turns them into ISO strings. Without
        // this coercion, `string > number` comparisons against
        // `Date.now()` silently produce NaN and break the spaced-
        // repetition priority queue (the comparator returns NaN, which
        // is not consistently < 0 or > 0 — the heap then leaves
        // future-dated cards at the root even when past-due cards exist
        // further down).
        const dueValue        = json.due        ? new Date(json.due)        : null;
        const lastReviewValue = json.lastReview ? new Date(json.lastReview) : null;
        return new Fsrs(json.difficulty, json.stability, json.repetitions, json.lapses, lastReviewValue, dueValue);
    }

    constructor(difficulty = 0, stability = 0, repetitions = 0, lapses = 0, lastReview = null, due = null) 
    {
        this.#difficulty = difficulty;
        this.#stability = stability;
        this.#repetitions = repetitions;
        this.#lapses = lapses;
        this.#lastReview = lastReview;
        this.#due = due;
    }

    #mapScale(rating) 
    {
        if (rating < 0.2) return 1;
        if (rating < 0.5) return 2;
        if (rating < 0.85) return 3;

        return 4;            
    }

    #applyFuzz(interval) 
    {
        if (interval < 2.5) return interval; // Don't fuzz very short intervals
        
        const fuzzRange = 0.05;

        const min = interval * (1 - fuzzRange);
        const max = interval * (1 + fuzzRange);

        return Math.max(Fsrs.#MIN_INTERVAL, Math.round(Math.random() * (max - min) + min));
    }

    #getRetrievability(t, s)
    {
        return Math.pow(1 + t / (9 * s), -1);
    }

    #nextInterval(s) 
    {
        const interval = 9 * s * (1 / Fsrs.#requestedRetention - 1);
        const rawInterval = Math.min(Math.max(Fsrs.#MIN_INTERVAL, interval), Fsrs.#maximumInterval);

        return this.#applyFuzz(rawInterval);
    }

    isLearning()
    {
        return this.#repetitions < 3 || this.#stability < 2;
    }

    review(userRating) 
    {
        const now = new Date();
        const grade = this.#mapScale(userRating);

        const newFsrs = new Fsrs(this.#difficulty, this.#stability, this.#repetitions, this.#lapses, this.#lastReview, this.#due);

        const t = newFsrs.#lastReview ? Math.max(0, (now - new Date(newFsrs.#lastReview)) / (1000 * 60 * 60 * 24)) : 0;

        if (newFsrs.#repetitions === 0) 
        {
            newFsrs.#difficulty = Math.min(Math.max(Fsrs.#weights[4] - (grade - 3) * Fsrs.#weights[5], 1), 10);
            newFsrs.#stability = Fsrs.#weights[grade - 1];
        } 
        else 
        {
            const r = newFsrs.#getRetrievability(t, newFsrs.#stability); 
            const meanReversion = Fsrs.#weights[7];
            const nextD = newFsrs.#difficulty - Fsrs.#weights[6] * (grade - 3);

            newFsrs.#difficulty = Math.min(Math.max(meanReversion * Fsrs.#weights[4] + (1 - meanReversion) * nextD, 1), 10);
                        
            if (grade === 1) 
            { 
                newFsrs.#stability = Fsrs.#weights[11] * Math.pow(newFsrs.#difficulty, -Fsrs.#weights[12]) * (Math.pow(newFsrs.#stability + 1, Fsrs.#weights[13]) - 1) * Math.exp(Fsrs.#weights[14] * (1 - r));
            } 
            else 
            { 
                const hardPenalty = grade === 2 ? Fsrs.#weights[15] : 1;
                const easyBonus = grade === 4 ? Fsrs.#weights[16] : 1;
                newFsrs.#stability = newFsrs.#stability * (1 + Math.exp(Fsrs.#weights[8]) * (11 - newFsrs.#difficulty) * Math.pow(newFsrs.#stability, -Fsrs.#weights[9]) * (Math.exp(Fsrs.#weights[10] * (1 - r)) - 1) * hardPenalty * easyBonus);
            }

            newFsrs.#stability = Math.max(newFsrs.#stability, 0.1);
        }

        let interval = 0;

        interval = newFsrs.#nextInterval(newFsrs.#stability);

        //Control the interval for the first repetition
        if(newFsrs.isLearning())
        {
            if (grade === 1) interval = 0.001;
            else if (grade === 2) interval = 0.003;
            else if (grade === 3) interval = 1;
            else interval = 2;
        }

        newFsrs.#due = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);
        newFsrs.#lastReview = now;
        newFsrs.#repetitions += 1;

        if (grade === 1) newFsrs.#lapses += 1;

        return newFsrs;
    }


    getState()
    {
        return {
            difficulty: this.#difficulty,
            stability: this.#stability,
            repetitions: this.#repetitions,
            lapses: this.#lapses,
            lastReview: this.#lastReview,
            due: this.#due
        };
    }

    toJson()
    {
        return this.getState();
    }
    
}

export default Fsrs;
