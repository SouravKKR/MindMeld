import { topicStrength } from "../Enumerations/TopicStrength.js";
import TopicInsight from "./TopicInsight.js";
import PromptPool from "../../ThirdParty/BrowserLlm/PromptPool.js";

const MASTERY_WEAK_THRESHOLD   = 50;
const MASTERY_STRONG_THRESHOLD = 65;

class TopicAnalyzer
{
    static #CARDS_PER_TIER             = 5;
    static #VOLATILE_MIN_CARDS         = 2;
    static #VOLATILITY_SWING_THRESHOLD = 0.25;

    #llmClient;

    constructor(llmClient)
    {
        this.#llmClient = llmClient;
    }

    async analyze(deck, onProgress = null)
    {
        const allStudied = this.#getStudiedCards(deck);
        if (allStudied.length === 0) return { weak: [], strong: [], volatile: [] };

        // Phase 1 — one LLM call per mastery tier; each call outputs exactly one topic name
        onProgress?.("Identifying deck topics…");
        const topicNames = await this.#discoverTopics(allStudied);
        if (topicNames.length === 0) return { weak: [], strong: [], volatile: [] };

        // Phase 2 — assign every studied card to its closest topic
        let topics;

        if (topicNames.length === 1)
        {
            const mastery = this.#computeGroupMastery(allStudied);
            topics = [{ name: topicNames[0], mastery, cardCount: allStudied.length, isVolatile: false }];
        }
        else
        {
            const cardGroups = await this.#assignCardsToTopics(allStudied, topicNames, onProgress);
            topics = [];
            for (let i = 0; i < topicNames.length; i++)
            {
                const group = cardGroups[i];
                if (group.length === 0) continue;
                topics.push({
                    name:       topicNames[i],
                    mastery:    this.#computeGroupMastery(group),
                    cardCount:  group.length,
                    isVolatile: group.filter(c => this.#isVolatile(c)).length >= TopicAnalyzer.#VOLATILE_MIN_CARDS,
                });
            }
        }

        // Phase 3 — classify by mastery threshold; volatile is orthogonal to weak/strong
        const weak = topics
            .filter(t => t.mastery < MASTERY_WEAK_THRESHOLD)
            .sort((a, b) => a.mastery - b.mastery)
            .map(t => new TopicInsight(t.name, topicStrength.WEAK, t.mastery, t.cardCount));

        const strong = topics
            .filter(t => t.mastery >= MASTERY_STRONG_THRESHOLD)
            .sort((a, b) => b.mastery - a.mastery)
            .map(t => new TopicInsight(t.name, topicStrength.STRONG, t.mastery, t.cardCount));

        const volatile = topics
            .filter(t => t.isVolatile)
            .map(t => new TopicInsight(t.name, topicStrength.VOLATILE, t.mastery, t.cardCount));

        return { weak, strong, volatile };
    }

    // Split all studied cards into 3 mastery tiers and run one discovery call per tier.
    // Asking for one topic name at a time prevents small LLMs from echoing prompt structure.
    async #discoverTopics(allStudied)
    {
        const sorted = [...allStudied].sort((a, b) => this.#scoreCard(a) - this.#scoreCard(b));
        const third  = Math.max(1, Math.floor(sorted.length / 3));

        const tiers = [
            sorted.slice(0,         third).slice(0, TopicAnalyzer.#CARDS_PER_TIER),
            sorted.slice(third,  2 * third).slice(0, TopicAnalyzer.#CARDS_PER_TIER),
            sorted.slice(2 * third        ).slice(0, TopicAnalyzer.#CARDS_PER_TIER),
        ].filter(t => t.length > 0);

        const [systemPrompt, userPromptTemplate] = await Promise.all([
            PromptPool.get("TOPIC_DISCOVERY_SYSTEM"),
            PromptPool.get("TOPIC_EXTRACTION_USER"),
        ]);

        const names = [];
        for (const tier of tiers)
        {
            const userPrompt = PromptPool.fill(userPromptTemplate, { card_content: this.#formatCardsForExtraction(tier) });
            const rawText    = await this.#llmClient.complete(systemPrompt, userPrompt);
            const name       = this.#parseSingleTopic(rawText);
            if (name && !this.#isDuplicateTopic(name, names)) names.push(name);
        }

        return names;
    }

    // Jaccard similarity on word sets: drop a name if it overlaps > 50% with any already accepted.
    #isDuplicateTopic(candidate, accepted)
    {
        const tokenize = s => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean));
        const cWords   = tokenize(candidate);

        return accepted.some(existing =>
        {
            const eWords      = tokenize(existing);
            const intersection = [...cWords].filter(w => eWords.has(w)).length;
            const union        = new Set([...cWords, ...eWords]).size;
            return union > 0 && intersection / union > 0.5;
        });
    }

    // Take the first non-empty line and strip any list formatting the LLM may have added.
    #parseSingleTopic(rawText)
    {
        const line = rawText
            .split("\n")
            .map(l => l.trim())
            .filter(l => l.length > 0)[0] ?? "";

        return line
            .replace(/^\d+[.)]\s*/, "")
            .replace(/^[-*•]\s*/, "")
            .trim();
    }

    #getStudiedCards(deck)
    {
        return deck.getCards(true).filter(
            c => c.getProgress().getCurrentProgressPoint().getFsrsState()["repetitions"] > 0
        );
    }

    // FSRS 30-day retrievability: P(recall after 30 days without review).
    //   - Lapse resets stability to < 0.5  → R(30d) ≈ 13%
    //   - Solid card at S=30              → R(30d) ≈ 90%
    static #r30(stability)
    {
        return Math.pow(1 + 30 / (9 * Math.max(stability, 0.1)), -1);
    }

    #scoreCard(card)
    {
        const fsrs = card.getProgress().getCurrentProgressPoint().getFsrsState();
        if (fsrs.repetitions === 0) return 0;
        return TopicAnalyzer.#r30(fsrs.stability);
    }

    #computeGroupMastery(cards)
    {
        if (cards.length === 0) return 0;
        const sum = cards.reduce((acc, c) => acc + this.#scoreCard(c) * 100, 0);
        return Math.round(sum / cards.length);
    }

    #isVolatile(card)
    {
        const points = card.getProgress().getProgressPoints();
        if (points.length < 3) return false;

        const r30s = points.map(p => TopicAnalyzer.#r30(p.getFsrsState().stability));

        for (let i = 1; i < r30s.length; i++)
        {
            if (Math.abs(r30s[i] - r30s[i - 1]) > TopicAnalyzer.#VOLATILITY_SWING_THRESHOLD)
                return true;
        }

        return false;
    }

    #stripHtml(html)
    {
        return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }

    #formatCardsForExtraction(cards)
    {
        return cards.map(c => this.#stripHtml(c.getAnswer())).join("\n");
    }

    #parseTopicIndex(rawText, topicCount)
    {
        const match = rawText.match(/\d/);
        if (!match) return 0;
        return Math.min(parseInt(match[0], 10), topicCount - 1);
    }

    async #assignCardsToTopics(cards, topicNames, onProgress = null)
    {
        const [systemPrompt, userPromptTemplate] = await Promise.all([
            PromptPool.get("TOPIC_ASSIGNMENT_SYSTEM"),
            PromptPool.get("TOPIC_ASSIGNMENT_USER"),
        ]);

        const topicsList = topicNames.map((name, i) => `${i}: ${name}`).join("\n");
        const groups     = Array.from({ length: topicNames.length }, () => []);

        for (let i = 0; i < cards.length; i++)
        {
            onProgress?.(`Classifying cards… (${i + 1} / ${cards.length})`);
            const answer     = this.#stripHtml(cards[i].getAnswer());
            const userPrompt = PromptPool.fill(userPromptTemplate, { topics_list: topicsList, answer });
            const rawText    = await this.#llmClient.complete(systemPrompt, userPrompt);
            const index      = this.#parseTopicIndex(rawText, topicNames.length);
            groups[index].push(cards[i]);
        }

        return groups;
    }
}

export default TopicAnalyzer;
