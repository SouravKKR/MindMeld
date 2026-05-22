import { topicStrength } from "../Enumerations/TopicStrength.js";

class TopicInsight
{
    #topicName = "";
    #strength = topicStrength.WEAK;
    #masteryPercent = 0;
    #cardCount = 0;

    constructor(topicName, strength, masteryPercent, cardCount)
    {
        this.#topicName = topicName;
        this.#strength = strength;
        this.#masteryPercent = masteryPercent;
        this.#cardCount = cardCount;
    }

    getTopicName()      { return this.#topicName; }
    getStrength()       { return this.#strength; }
    getMasteryPercent() { return this.#masteryPercent; }
    getCardCount()      { return this.#cardCount; }
}

export default TopicInsight;
