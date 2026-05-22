const GeneralGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/GeneralGenerationSettings");
const FlashcardGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/FlashcardGenerationSettings");
const StudyMaterialGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/StudyMaterialGenerationSettings");
const MockTestGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings");

const TaskDescriptor = require("../../Globals/Classes/Task/TaskDescriptor");
const { automaticGenerationModes } = require("../../Globals/Enumerations/AutomaticGenerationModes");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");

/**
 * Generates task descriptors based on the provided generation settings.
 *
 * @param {GeneralGenerationSettings} generalSettings 
 * Base configuration applicable to all generation types (e.g., difficulty, language, length).
 *
 * @param {FlashcardGenerationSettings} flashcardSettings 
 * Configuration specific to flashcard generation (e.g., number of cards, format, question type).
 *
 * @param {StudyMaterialGenerationSettings} studyMaterialSettings 
 * Configuration for study material generation (e.g., depth, sections, explanations).
 *
 * @param {MockTestGenerationSettings} mockTestSettings 
 * Configuration for mock test generation (e.g., number of questions, time limit, scoring rules).
 *
 * @returns {TaskDescriptor[]} 
 * Returns an array of TaskDescriptor objects representing the generated tasks.
 */
function getGenerationTaskDescriptors(generalSettings, flashcardSettings, studyMaterialSettings, mockTestSettings)
{
    switch(generalSettings.getGenerationMode())
    {
        case automaticGenerationModes.SIMPLE:
        {
            // TODO: implement    
        }
        break;

        case automaticGenerationModes.ADVANCED:
        {
            taskTypes
            
        }

    }
    return [];
}

module.exports = { getGenerationTaskDescriptors };