const GeneralGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/GeneralGenerationSettings");
const FlashcardGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/FlashcardGenerationSettings");
const StudyMaterialGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/StudyMaterialGenerationSettings");
const MockTestGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings");
const PublicUrlValidator = require("../../Globals/Classes/Security/PublicUrlValidator");
const PaidDeckGenerationGate = require("../../Globals/Classes/Generation/PaidDeckGenerationGate");
const { informationSourceTypes } = require("../../Globals/Enumerations/InformationSourceTypes");

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
 * Rejects a SPECIFIC_URL_ON_THE_INTERNET source whose URL is malformed or points
 * somewhere the Agent will refuse to fetch.
 *
 * The authoritative SSRF gate is the Agent's SafeUrlValidator, which resolves
 * every redirect hop at fetch time. This check exists so the user is told
 * immediately, and so a URL that could never work is not persisted onto the
 * source (where it would be replayed on every regeneration).
 */
function validateInformationSourceUrl(extractableSource, sourceLabel)
{
    const informationSource = extractableSource.getInformationSource();

    if (!informationSource || informationSource.getSourceType() !== informationSourceTypes.SPECIFIC_URL_ON_THE_INTERNET)
    {
        return;
    }

    PublicUrlValidator.validate(informationSource.getName(), sourceLabel);
}


/**
 * Applies the source caps and the URL check to a per-type settings object.
 *
 * Each of flashcard / study-material / mock-test settings extends
 * AutoGenerationSettings and therefore carries its OWN informationSources and
 * imageSources, parsed straight from its slice of the request body — and it is
 * that raw slice which becomes the Agent task payload. Validating only the
 * general settings would leave those lists unchecked, so every settings object
 * that can carry sources is validated here.
 */
function validateSourcesOnSettings(settings, settingsLabel)
{
    if (!settings)
    {
        return;
    }

    const settingsInformationSources = settings.getInformationSources() || [];
    const settingsImageSources = settings.getImageSources() || [];

    if (settingsInformationSources.length > MAXIMUM_INFORMATION_SOURCES)
    {
        throw new Error(`${settingsLabel}: you can select a maximum of ${MAXIMUM_INFORMATION_SOURCES} information sources.`);
    }

    if (settingsImageSources.length > MAXIMUM_INFORMATION_SOURCES)
    {
        throw new Error(`${settingsLabel}: you can select a maximum of ${MAXIMUM_INFORMATION_SOURCES} image sources.`);
    }

    for (let sourceIndex = 0; sourceIndex < settingsInformationSources.length; sourceIndex++)
    {
        validateInformationSourceUrl(settingsInformationSources[sourceIndex], `${settingsLabel} information source #${sourceIndex + 1}`);
    }

    for (let sourceIndex = 0; sourceIndex < settingsImageSources.length; sourceIndex++)
    {
        validateInformationSourceUrl(settingsImageSources[sourceIndex], `${settingsLabel} image source #${sourceIndex + 1}`);
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

    // Paid-deck mode restricts the source surface before any of the general
    // rules apply, so its (stricter) requirements are checked first and its
    // messages are the ones the user sees. The admin-role half of the gate lives
    // in Generate.js, where the authenticated user is available — this half is
    // pure settings validation and belongs here, so no call path that validates
    // settings can skip it.
    const bPaidDeckMode = PaidDeckGenerationGate.isRequested(generalSettings);

    // Only the INFORMATION sources are validated here. Image sources are not
    // rejected in paid-deck mode — they are stripped by Generate.js, because the
    // generation page mirrors information sources into them by default and a
    // rejection would fail a request over a value the user never chose. See
    // PaidDeckGenerationGate.stripImageSources.
    if (bPaidDeckMode)
    {
        PaidDeckGenerationGate.validateSourceTypes(informationSources);
    }

    if (!bPaidDeckMode && informationSources.length === 0 && description.length === 0)
    {
        throw new Error("Provide at least one information source or a non-empty description of what to generate.");
    }

    if (informationSources.length > MAXIMUM_INFORMATION_SOURCES)
    {
        throw new Error(`You can select a maximum of ${MAXIMUM_INFORMATION_SOURCES} information sources.`);
    }

    for (let sourceIndex = 0; sourceIndex < informationSources.length; sourceIndex++)
    {
        const sourceLabel = `Information source #${sourceIndex + 1}`;
        validatePageRanges(informationSources[sourceIndex], sourceLabel);
        validateInformationSourceUrl(informationSources[sourceIndex], sourceLabel);
    }

    for (let sourceIndex = 0; sourceIndex < imageSources.length; sourceIndex++)
    {
        const sourceLabel = `Image source #${sourceIndex + 1}`;
        validatePageRanges(imageSources[sourceIndex], sourceLabel);
        validateInformationSourceUrl(imageSources[sourceIndex], sourceLabel);
    }

    validateSourcesOnSettings(flashcardSettings, "Flashcard generation");
    validateSourcesOnSettings(studyMaterialSettings, "Study material generation");
    validateSourcesOnSettings(mockTestSettings, "Mock test generation");

    if (!flashcardSettings && !studyMaterialSettings && !mockTestSettings)
    {
        throw new Error("You need to select at least one type of auto-generation task.");
    }

    return true;
}


module.exports = { validateGenerationSettings };
