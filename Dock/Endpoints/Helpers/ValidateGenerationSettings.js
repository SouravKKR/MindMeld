const GeneralGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/GeneralGenerationSettings");
const FlashcardGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/FlashcardGenerationSettings");
const StudyMaterialGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/StudyMaterialGenerationSettings");
const MockTestGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings");

const MAXIMUM_INFORMATION_SOURCES = 5;
const MAXIMUM_PAGE_RANGES_PER_SOURCE = 10;


function validatePageRanges(extractableSource, sourceLabel)
{
    const pageRanges = extractableSource.getPageRanges() || [];

    if (!Array.isArray(pageRanges))
    {
        throw new Error(`${sourceLabel}: pageRanges must be an array.`);
    }

    if (pageRanges.length > MAXIMUM_PAGE_RANGES_PER_SOURCE)
    {
        throw new Error(`${sourceLabel}: too many page ranges (${pageRanges.length}); maximum is ${MAXIMUM_PAGE_RANGES_PER_SOURCE}.`);
    }

    for (let rangeIndex = 0; rangeIndex < pageRanges.length; rangeIndex++)
    {
        const pageRange = pageRanges[rangeIndex];
        const startPage = pageRange.getStartPage();
        const endPage = pageRange.getEndPage();

        // [0,0] is the full-document sentinel — accept it
        if (startPage === 0 && endPage === 0)
        {
            continue;
        }

        // Reject one-sided zero sentinels — that's ambiguous
        if (startPage === 0 || endPage === 0)
        {
            throw new Error(`${sourceLabel} range #${rangeIndex + 1}: one-sided zero sentinel is invalid. Use {0,0} for full document or both >= 1 for explicit pages.`);
        }

        if (startPage < 1)
        {
            throw new Error(`${sourceLabel} range #${rangeIndex + 1}: startPage must be >= 1 (got ${startPage}).`);
        }

        if (endPage < startPage)
        {
            throw new Error(`${sourceLabel} range #${rangeIndex + 1}: endPage (${endPage}) must be >= startPage (${startPage}).`);
        }
    }
}


/**
 * Validates different types of generation settings used for auto-generation tasks.
 *
 * @param {GeneralGenerationSettings} generalSettings
 * @param {FlashcardGenerationSettings} flashcardSettings
 * @param {StudyMaterialGenerationSettings} studyMaterialSettings
 * @param {MockTestGenerationSettings} mockTestSettings
 *
 * @returns {boolean}
 *
 * @throws {Error} if any settings are invalid.
 */
function validateGenerationSettings(generalSettings, flashcardSettings, studyMaterialSettings, mockTestSettings)
{
    const informationSources = generalSettings.getInformationSources() || [];
    const imageSources = generalSettings.getImageSources() || [];
    const description = (generalSettings.getDescription() || "").trim();

    if (informationSources.length === 0 && description.length === 0)
    {
        throw new Error("Provide at least one information source or a non-empty description of what to generate.");
    }

    if (informationSources.length > MAXIMUM_INFORMATION_SOURCES)
    {
        throw new Error(`You can select a maximum of ${MAXIMUM_INFORMATION_SOURCES} information sources.`);
    }

    for (let sourceIndex = 0; sourceIndex < informationSources.length; sourceIndex++)
    {
        validatePageRanges(informationSources[sourceIndex], `Information source #${sourceIndex + 1}`);
    }

    for (let sourceIndex = 0; sourceIndex < imageSources.length; sourceIndex++)
    {
        validatePageRanges(imageSources[sourceIndex], `Image source #${sourceIndex + 1}`);
    }

    if (!flashcardSettings && !studyMaterialSettings && !mockTestSettings)
    {
        throw new Error("You need to select at least one type of auto-generation task.");
    }

    return true;
}


module.exports = { validateGenerationSettings };
