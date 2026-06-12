const Persistence = require("../Persistence");
const PersistenceConstants = require("../../Constants/PersistenceConstants");

/**
 * Loads the staged JSON files a generation task writes to the task folder
 * (flashcards, study materials, mock-test topic chains, the syllabus, and
 * the beautified short-name map). Every loader is defensive: malformed or
 * missing files are skipped rather than allowed to abort the import.
 */
class GeneratedFileLoader
{
    static #BEAUTIFIED_SHORT_NAMES_FILE_NAME = "BeautifiedShortNames.json";

    static async loadFlashcardFiles(mainTaskId)
    {
        const prefix = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.FLASHCARDS_DIRECTORY}/`;
        const filePaths = await Persistence.list(prefix);

        const files = [];

        for (const filePath of filePaths)
        {
            const buffer = await Persistence.read(filePath);
            const file = JSON.parse(buffer.toString("utf-8"));

            if (!Array.isArray(file.topicChain) || file.topicChain.length === 0 || !Array.isArray(file.cards))
            {
                console.log(`[MoveToDatabase] Skipping malformed flashcard file: ${filePath}`);
                continue;
            }

            files.push(file);
        }

        return files;
    }

    static async loadStudyMaterialFiles(mainTaskId)
    {
        const prefix = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.STUDY_MATERIALS_DIRECTORY}/`;
        const filePaths = await Persistence.list(prefix);

        const files = [];

        for (const filePath of filePaths)
        {
            const buffer = await Persistence.read(filePath);
            const file = JSON.parse(buffer.toString("utf-8"));

            if (!file.topicChain || !file.content)
            {
                continue;
            }

            files.push(file);
        }

        return files;
    }

    // Mock test workers write one file per leaf topic at MockTestQuestions/<unit>/<topic>.json,
    // each carrying its topicChain. We need those chains in the shared deck hierarchy so that
    // recursive mock test generation can route questions to the correct subdeck even when the
    // user has flashcards/study materials switched off (mock-test-only generation).
    static async loadMockTestTopicChains(mainTaskId)
    {
        const prefix = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.MOCK_TEST_QUESTIONS_DIRECTORY}/`;

        let filePaths;
        try
        {
            filePaths = await Persistence.list(prefix);
        }
        catch (listError)
        {
            return [];
        }

        const chains = [];
        for (const filePath of filePaths)
        {
            try
            {
                const buffer = await Persistence.read(filePath);
                const file = JSON.parse(buffer.toString("utf-8"));
                if (Array.isArray(file.topicChain) && file.topicChain.length > 0)
                {
                    chains.push(file.topicChain);
                }
            }
            catch (readError)
            {
                // Malformed file — already logged downstream in MockTestAssembler.upsertMockTests
            }
        }

        return chains;
    }

    static async loadSyllabus(mainTaskId)
    {
        const syllabusPath = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.SYLLABUS_FILE_NAME}`;

        try
        {
            const buffer = await Persistence.read(syllabusPath);
            return JSON.parse(buffer.toString("utf-8"));
        }
        catch (error)
        {
            console.warn(`[MoveToDatabase] Syllabus.json not found for task ${mainTaskId} — syllabus ordering will not be applied.`);
            return null;
        }
    }

    static async loadBeautifiedShortNames(mainTaskId)
    {
        const beautifiedPath = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${GeneratedFileLoader.#BEAUTIFIED_SHORT_NAMES_FILE_NAME}`;

        try
        {
            const buffer = await Persistence.read(beautifiedPath);
            const parsedDocument = JSON.parse(buffer.toString("utf-8"));

            if (!parsedDocument || typeof parsedDocument !== "object")
            {
                return null;
            }

            const beautifiedMap = new Map();
            for (const [deckKey, candidateShortName] of Object.entries(parsedDocument))
            {
                if (typeof candidateShortName === "string" && candidateShortName.length > 0)
                {
                    beautifiedMap.set(deckKey, candidateShortName);
                }
            }

            return beautifiedMap.size > 0 ? beautifiedMap : null;
        }
        catch (beautifiedReadError)
        {
            return null;
        }
    }
}

module.exports = GeneratedFileLoader;
