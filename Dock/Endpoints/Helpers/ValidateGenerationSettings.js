const GeneralGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/GeneralGenerationSettings");
const FlashcardGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/FlashcardGenerationSettings");
const StudyMaterialGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/StudyMaterialGenerationSettings");
const MockTestGenerationSettings = require("../../Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings");
const PublicUrlValidator = require("../../Globals/Classes/Security/PublicUrlValidator");
const PaidDeckGenerationGate = require("../../Globals/Classes/Generation/PaidDeckGenerationGate");
const MockTestSectionGeometry = require("../../Globals/Classes/Generation/MockTestSectionGeometry");
const { informationSourceTypes } = require("../../Globals/Enumerations/InformationSourceTypes");
const { automationLevels } = require("../../Globals/Enumerations/AutomationLevels");

const MAXIMUM_INFORMATION_SOURCES = 5;
const MAXIMUM_PAGE_RANGES_PER_SOURCE = 10;
const MAXIMUM_REFERENCE_SOURCES = 5;

// A paper divided into more parts than this is not a paper any more, and each
// section costs a pass over the generated pool during assembly. The editor
// offers no upper bound of its own, so this is where a pasted or scripted
// payload stops being accepted.
const MAXIMUM_SECTIONS = 30;

// The only source types a mock-test reference may be. Kept as an explicit
// allow-list rather than a deny-list because the failure mode of the latter is
// silent: a type added to the enumeration later would become an accepted
// reference input without anyone deciding that it should be.
const ALLOWED_REFERENCE_SOURCE_TYPES = new Set([
    informationSourceTypes.QUESTION_PAPER,
    informationSourceTypes.SPECIFIC_URL_ON_THE_INTERNET
]);


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
 * Validates the mock-test reference papers.
 *
 * These live on their own member rather than on informationSources because the
 * generation page mirrors the general source list into every secondary settings
 * object wholesale, which would overwrite anything stored alongside it. They are
 * therefore a list the general rules above never see, and need their own caps.
 *
 * Refused outright in paid-deck mode. A reference paper is third-party
 * expression, and the route by which one may legitimately reach sellable content
 * is the licensed-source channel, where a licence is declared and retained as
 * proof. Accepting one here would put an undeclared document into the pipeline
 * through a door that asks no questions.
 *
 * @param {MockTestGenerationSettings|null} mockTestSettings
 * @param {boolean} bPaidDeckMode
 * @throws {Error} on the first violation.
 */
function validateReferenceSources(mockTestSettings, bPaidDeckMode)
{
    if (!mockTestSettings || typeof mockTestSettings.getReferenceSources !== "function")
    {
        return;
    }

    const referenceSources = mockTestSettings.getReferenceSources() || [];

    if (referenceSources.length === 0)
    {
        return;
    }

    if (bPaidDeckMode)
    {
        throw new Error(
            "Paid deck mode does not accept reference papers on the mock-test settings. "
            + "Attach the paper as a licensed source instead, so its licence is declared "
            + "and retained as proof of the basis on which it was used."
        );
    }

    if (referenceSources.length > MAXIMUM_REFERENCE_SOURCES)
    {
        throw new Error(`You can select a maximum of ${MAXIMUM_REFERENCE_SOURCES} reference papers.`);
    }

    for (let sourceIndex = 0; sourceIndex < referenceSources.length; sourceIndex++)
    {
        const sourceLabel = `Reference paper #${sourceIndex + 1}`;
        const extractableSource = referenceSources[sourceIndex];
        const informationSource = extractableSource.getInformationSource();
        const sourceType = informationSource ? informationSource.getSourceType() : null;

        if (!ALLOWED_REFERENCE_SOURCE_TYPES.has(sourceType))
        {
            throw new Error(
                `${sourceLabel}: a reference paper must be an uploaded question paper / mock test, `
                + "or a link to one."
            );
        }

        validatePageRanges(extractableSource, sourceLabel);
        validateInformationSourceUrl(extractableSource, sourceLabel);
    }
}


/**
 * Validates the mock-test section structure.
 *
 * A section says how many questions it holds, what each is worth, and what the
 * section totals — but only two of those are ever entered, and the third is
 * derived. That makes it possible to ask for something arithmetically
 * impossible ("20 marks, in questions worth 7-9 marks each"), or for the
 * sections to disagree with the paper's own question count.
 *
 * The editor already blocks both, but a client is never trusted: the settings
 * arriving here are the ones that become the Agent task payload, and a section
 * structure that cannot be satisfied would otherwise be discovered only as a
 * half-empty paper after the credits had been spent.
 *
 * MockTestSectionGeometry is the shared arithmetic, so the message the user
 * sees is the same one the editor would have shown.
 *
 * @param {MockTestGenerationSettings|null} mockTestSettings
 * @throws {Error} on the first violation.
 */
function validateSectionStructure(mockTestSettings)
{
    if (!mockTestSettings || typeof mockTestSettings.getSectionStructure !== "function")
    {
        return;
    }

    const sectionStructure = mockTestSettings.getSectionStructure() || [];

    if (!Array.isArray(sectionStructure) || sectionStructure.length === 0)
    {
        return;
    }

    if (sectionStructure.length > MAXIMUM_SECTIONS)
    {
        throw new Error(`A mock test can have at most ${MAXIMUM_SECTIONS} sections.`);
    }

    // The paper's own question count only has to agree with the sections when
    // the user pinned it. On AUTOMATIC the sections are what decide the paper's
    // size, so there are not two numbers that could disagree.
    const bPaperQuestionTargetIsManual = mockTestSettings.getNumQuestionsMethod() === automationLevels.MANUAL;

    const structureFailure = MockTestSectionGeometry.describeStructureValidationFailure(
        sectionStructure,
        mockTestSettings.getNumQuestionsPerTest(),
        bPaperQuestionTargetIsManual
    );

    if (structureFailure !== null)
    {
        throw new Error(structureFailure);
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
    validateReferenceSources(mockTestSettings, bPaidDeckMode);
    validateSectionStructure(mockTestSettings);

    if (!flashcardSettings && !studyMaterialSettings && !mockTestSettings)
    {
        throw new Error("You need to select at least one type of auto-generation task.");
    }

    return true;
}


module.exports = { validateGenerationSettings };
