class Lifecycle
{
    #creationDate = new Date();
    #lastModified = new Date();
    #views = 0;
    #attempts = 0;
    #timeSpentInSeconds = 0;

    constructor(creationDate = new Date(), lastModified = new Date(), views = 0, attempts = 0, timeSpentInSeconds = 0)
    {
        this.#creationDate = creationDate;
        this.#lastModified = lastModified;
        this.#views = views;
        this.#attempts = attempts;
        this.#timeSpentInSeconds = timeSpentInSeconds;
    }

    getCreationDate()
    {
        return this.#creationDate;
    }

    getLastModified()
    {
        return this.#lastModified;
    }

    setLastModified(lastModified)
    {
        this.#lastModified = lastModified;
    }

    getViews()
    {
        return this.#views;
    }

    view()
    {
        this.#views++;
        this.touch();
    }

    getAttempts()
    {
        return this.#attempts;
    }

    attempt()
    {
        this.#attempts++;
        this.touch();
    }

    getTimeSpentInSeconds()
    {
        return this.#timeSpentInSeconds;
    }

    spendTime(timeSpentInSeconds)
    {
        this.#timeSpentInSeconds += timeSpentInSeconds;
        this.touch();
    }
    
    touch()
    {
        this.#lastModified = new Date();
    }

    reset()
    {
        this.#views = 0;
        this.#attempts = 0;
        this.#timeSpentInSeconds = 0;
        this.touch();
    }

    static fromJson(json)
    {
        return new Lifecycle(new Date(json.creationDate), new Date(json.lastModified), json.views, json.attempts, json.timeSpentInSeconds);
    }
    
    toJson()
    {
        return {
            creationDate: this.#creationDate.toISOString(),
            lastModified: this.#lastModified.toISOString(),
            views: this.#views,
            attempts: this.#attempts,
            timeSpentInSeconds: this.#timeSpentInSeconds
        }
    }
}

export default Lifecycle;