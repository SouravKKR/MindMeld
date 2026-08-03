const { getRandomUuid } = require("../../UtilityFunctions.js/GetRandomUuid");
const SyncQueryEngine = require("../Database/SyncQueryEngine");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const GenerationProvenance = require("./GenerationProvenance");

/**
 * Persists generated cards and study materials onto the shared deck
 * hierarchy. Card upserts are de-duplicated against any cards already
 * present on a reused (merge-path) deck so a re-generation never inserts a
 * second copy of an identical question.
 */
class GeneratedEntityUpserter
{
    static #DEFAULT_CARD_BASE_DIFFICULTY = 1500;
    static #STANDARD_STUDY_MATERIAL_DETAIL_LEVEL = 1;

    static #normalizeQuestionText(rawQuestion)
    {
        if (typeof rawQuestion !== "string")
        {
            return "";
        }
        return rawQuestion.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    }

    static async upsertCards(userId, flashcardFiles, resolveLeafDeckId, syllabusPositionIndex, now, reusedDeckIds = null, sourceContentHashes = [])
    {
        const cardCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);

        const normalizedExistingQuestionsByDeckId = new Map();
        const reusedDeckIdSet = (reusedDeckIds instanceof Set) ? reusedDeckIds : new Set();

        for (const flashcardFile of flashcardFiles)
        {
            const leafDeckId = resolveLeafDeckId(flashcardFile.topicChain);
            const syllabusPosition = syllabusPositionIndex?.get(flashcardFile.topicChain.join(" > ")) ?? 0;

            if (reusedDeckIdSet.has(leafDeckId) && !normalizedExistingQuestionsByDeckId.has(leafDeckId))
            {
                // Card rows are stored as { userId, data: {...card}, serverUpdatedAt },
                // so the question and owning deck live under `data.*`.
                const existingCardDocuments = await cardCollection.find(
                    { userId: userId, "data.deckId": leafDeckId },
                    { projection: { _id: 0, "data.question": 1 } },
                ).toArray();

                const normalizedSet = new Set(existingCardDocuments.map(existingCardDocument => GeneratedEntityUpserter.#normalizeQuestionText(existingCardDocument.data?.question)));
                normalizedExistingQuestionsByDeckId.set(leafDeckId, normalizedSet);
            }

            const existingNormalized = normalizedExistingQuestionsByDeckId.get(leafDeckId) || new Set();

            for (const card of flashcardFile.cards)
            {
                const normalizedQuestion = GeneratedEntityUpserter.#normalizeQuestionText(card.question);
                if (existingNormalized.has(normalizedQuestion))
                {
                    continue;
                }
                existingNormalized.add(normalizedQuestion);

                const cardData =
                {
                    id: getRandomUuid(),
                    question: card.question,
                    answer: card.answer,
                    tags: [],
                    deckId: leafDeckId,
                    baseDifficulty: GeneratedEntityUpserter.#DEFAULT_CARD_BASE_DIFFICULTY,
                    additionalData: GenerationProvenance.applyTo({ ...(card.additionalData ?? {}), syllabusPosition }, sourceContentHashes),
                    lifecycle:
                    {
                        creationDate: now,
                        lastModified: now,
                        views: 0,
                        attempts: 0,
                        timeSpentInSeconds: 0
                    },
                    progress:
                    {
                        progressPoints: []
                    }
                };

                await SyncQueryEngine.upsertCard(userId, cardData);
            }
        }
    }

    static async upsertStudyMaterials(userId, studyMaterialFiles, resolveLeafDeckId, syllabusPositionIndex, now, sourceContentHashes = [])
    {
        for (const file of studyMaterialFiles)
        {
            const deckId = resolveLeafDeckId(file.topicChain);
            const syllabusPosition = syllabusPositionIndex?.get(file.topicChain.join(" > ")) ?? 0;
            const detailLevel = (typeof file.detailLevel === "number") ? file.detailLevel : GeneratedEntityUpserter.#STANDARD_STUDY_MATERIAL_DETAIL_LEVEL;

            const studyMaterialData =
            {
                id: getRandomUuid(),
                content: file.content,
                deckId: deckId,
                syllabusPosition,
                detailLevel,
                additionalData: GenerationProvenance.applyTo({}, sourceContentHashes),
                lifecycle:
                {
                    creationDate: now,
                    lastModified: now,
                    views: 0,
                    attempts: 0,
                    timeSpentInSeconds: 0
                }
            };

            await SyncQueryEngine.upsertStudyMaterial(userId, studyMaterialData);
        }
    }
}

module.exports = GeneratedEntityUpserter;
