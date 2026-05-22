import ExtractableInformationSource from "./Decorators/ExtractableInformationSource.js";
import InformationSource from "../Model/InformationSource.js";
import { informationSourceTypes } from "../Enumerations/InformationSourceTypes.js";


/**
 * GenerationTemplate
 *
 * Curated bundle of auto-generation settings for a specific exam profile
 * (e.g. JEE Mains, Engineering (India)). The data lives in MongoDB —
 * specifically the `generationTemplates` collection — and is fetched by
 * the picker dialog via the Dock `/Templates/Search` and `/Templates/Get`
 * endpoints. The on-disk seed file at `Dock/SeedData/GenerationTemplates.json`
 * supplies new entries on Dock boot. This class wraps one such data
 * blob and exposes the apply / revert operations the generation page
 * needs.
 *
 * Applying a template overwrites the flashcard / study-material / mock-test
 * field values that the template knows about. Subject name, description,
 * information sources, image sources, and the captureImagesEnabled flag
 * stay with the user. The one exception is additionalInformationSources,
 * which is merged into the information-source list so search-based PYQ
 * harvest fires when the template implies it (e.g. JEE Mains adds an
 * ANYWHERE_ON_THE_INTERNET source so the agent finds previous-year papers
 * dynamically via web search — no hardcoded URLs that might rot).
 */
class GenerationTemplate
{
    #displayName;
    #tagline;
    #generalPatch;
    #flashcardPatch;
    #studyMaterialPatch;
    #mockTestPatch;
    #additionalInformationSources;

    constructor(data = {})
    {
        this.#displayName = data.displayName || "";
        this.#tagline = data.tagline || "";
        this.#generalPatch = data.generalPatch || {};
        this.#flashcardPatch = data.flashcardPatch || {};
        this.#studyMaterialPatch = data.studyMaterialPatch || {};
        this.#mockTestPatch = data.mockTestPatch || {};
        this.#additionalInformationSources = data.additionalInformationSources || [];
    }

    getDisplayName()
    {
        return this.#displayName;
    }

    getTagline()
    {
        return this.#tagline;
    }

    /**
     * Applies the template to the four live settings instances on the
     * generation page. Each settings instance is mutated in place via
     * its public setter API, so the encapsulation of those classes is
     * preserved.
     */
    applyTo(settingsBundle)
    {
        const general = settingsBundle?.general ?? null;
        const flashcard = settingsBundle?.flashcard ?? null;
        const studyMaterial = settingsBundle?.studyMaterial ?? null;
        const mockTest = settingsBundle?.mockTest ?? null;

        GenerationTemplate.#applyPatch(general, this.#generalPatch);
        GenerationTemplate.#applyPatch(flashcard, this.#flashcardPatch);
        GenerationTemplate.#applyPatch(studyMaterial, this.#studyMaterialPatch);
        GenerationTemplate.#applyPatch(mockTest, this.#mockTestPatch);

        if (this.#additionalInformationSources.length > 0 && general)
        {
            GenerationTemplate.#appendInformationSources(general, this.#additionalInformationSources);
        }
    }

    /**
     * Snapshots every field this template will touch, applies the template,
     * and returns a closure that — when invoked later — restores those
     * fields to their pre-application values and removes any information
     * sources the template added.
     *
     * AutomaticGenerationPage stores the returned closure and invokes it
     * when the user leaves TEMPLATE mode, so template-applied values do
     * not linger as the page's "advanced" defaults.
     *
     * Info-source revert is signature-based (sourceType + name), so a
     * user-added source that happens to be present alongside the template's
     * source is preserved — only signatures introduced by the apply step
     * are removed.
     */
    applyToWithRevertHandle(settingsBundle)
    {
        const general = settingsBundle?.general ?? null;
        const flashcard = settingsBundle?.flashcard ?? null;
        const studyMaterial = settingsBundle?.studyMaterial ?? null;
        const mockTest = settingsBundle?.mockTest ?? null;

        const generalPreState = GenerationTemplate.#capturePreState(general, this.#generalPatch);
        const flashcardPreState = GenerationTemplate.#capturePreState(flashcard, this.#flashcardPatch);
        const studyMaterialPreState = GenerationTemplate.#capturePreState(studyMaterial, this.#studyMaterialPatch);
        const mockTestPreState = GenerationTemplate.#capturePreState(mockTest, this.#mockTestPatch);

        const preApplySourceSignatures = GenerationTemplate.#captureSourceSignatures(general);

        this.applyTo(settingsBundle);

        const postApplySourceSignatures = GenerationTemplate.#captureSourceSignatures(general);
        const templateAddedSourceSignatures = new Set();
        for (const signature of postApplySourceSignatures)
        {
            if (!preApplySourceSignatures.has(signature))
            {
                templateAddedSourceSignatures.add(signature);
            }
        }

        return () =>
        {
            GenerationTemplate.#restorePreState(general, generalPreState);
            GenerationTemplate.#restorePreState(flashcard, flashcardPreState);
            GenerationTemplate.#restorePreState(studyMaterial, studyMaterialPreState);
            GenerationTemplate.#restorePreState(mockTest, mockTestPreState);

            if (general && templateAddedSourceSignatures.size > 0)
            {
                const currentSources = general.getInformationSources() || [];
                const filteredSources = currentSources.filter((extractable) =>
                {
                    const signature = GenerationTemplate.#sourceSignature(extractable);
                    return !templateAddedSourceSignatures.has(signature);
                });

                if (filteredSources.length !== currentSources.length)
                {
                    general.setInformationSources(filteredSources);
                }
            }
        };
    }

    static #capturePreState(settings, patch)
    {
        if (!settings || !patch)
        {
            return {};
        }

        const preState = {};

        for (const setterName of Object.keys(patch))
        {
            if (typeof settings[setterName] !== "function")
            {
                continue;
            }

            const getterName = "get" + setterName.slice(3);
            if (typeof settings[getterName] !== "function")
            {
                continue;
            }

            preState[setterName] = settings[getterName]();
        }

        return preState;
    }

    static #restorePreState(settings, preState)
    {
        if (!settings || !preState)
        {
            return;
        }

        for (const setterName of Object.keys(preState))
        {
            if (typeof settings[setterName] === "function")
            {
                settings[setterName](preState[setterName]);
            }
        }
    }

    static #captureSourceSignatures(settings)
    {
        const signatures = new Set();

        if (!settings)
        {
            return signatures;
        }

        const sources = settings.getInformationSources() || [];
        for (const extractable of sources)
        {
            signatures.add(GenerationTemplate.#sourceSignature(extractable));
        }

        return signatures;
    }

    static #sourceSignature(extractable)
    {
        const informationSource = extractable?.getInformationSource?.();
        if (!informationSource)
        {
            return "";
        }

        const sourceType = informationSource.getSourceType();
        const sourceName = (informationSource.getName() || "").trim();
        return `${sourceType}::${sourceName}`;
    }

    static #applyPatch(settings, patch)
    {
        if (!settings)
        {
            return;
        }

        for (const setterName of Object.keys(patch))
        {
            const value = patch[setterName];

            if (typeof settings[setterName] === "function")
            {
                settings[setterName](value);
            }
        }
    }

    /**
     * Adds each template source to the general settings, skipping duplicates.
     * Singleton source types (ANYWHERE_ON_THE_INTERNET, REPUTED_EXTERNAL_SOURCES,
     * AI_GENERATED) are only added if no source of that type is already present.
     * Specific-URL types check the name field for collisions.
     */
    static #appendInformationSources(generalSettings, sourceDescriptors)
    {
        const existingSources = generalSettings.getInformationSources() || [];
        const existingSingletonTypes = new Set();
        const existingSpecificUrls = new Set();

        for (const extractable of existingSources)
        {
            const informationSource = extractable?.getInformationSource?.();
            if (!informationSource)
            {
                continue;
            }

            const existingType = informationSource.getSourceType();
            if (GenerationTemplate.#isSingletonSourceType(existingType))
            {
                existingSingletonTypes.add(existingType);
            }
            else if (existingType === informationSourceTypes.SPECIFIC_URL_ON_THE_INTERNET)
            {
                existingSpecificUrls.add((informationSource.getName() || "").trim());
            }
        }

        const additions = [];

        for (const descriptor of sourceDescriptors)
        {
            const sourceType = descriptor?.sourceType;
            const sourceName = (descriptor?.name || "").trim();

            if (sourceType === undefined || sourceType === null)
            {
                continue;
            }

            if (GenerationTemplate.#isSingletonSourceType(sourceType))
            {
                if (existingSingletonTypes.has(sourceType))
                {
                    continue;
                }
                existingSingletonTypes.add(sourceType);
            }
            else if (sourceType === informationSourceTypes.SPECIFIC_URL_ON_THE_INTERNET)
            {
                if (sourceName.length === 0 || existingSpecificUrls.has(sourceName))
                {
                    continue;
                }
                existingSpecificUrls.add(sourceName);
            }
            else
            {
                // Types not handled here (PROVIDED_DOCUMENTS, CURRICULUM_OR_SYLLABUS)
                // require a real uploaded file and can't be auto-added by a template.
                continue;
            }

            const newSource = new InformationSource({
                name: sourceName,
                sourceType: sourceType,
            });

            additions.push(new ExtractableInformationSource({ informationSource: newSource, pageRanges: [] }));
        }

        if (additions.length > 0)
        {
            generalSettings.setInformationSources([...existingSources, ...additions]);
        }
    }

    static #isSingletonSourceType(sourceType)
    {
        return sourceType === informationSourceTypes.ANYWHERE_ON_THE_INTERNET
            || sourceType === informationSourceTypes.REPUTED_EXTERNAL_SOURCES
            || sourceType === informationSourceTypes.AI_GENERATED;
    }
}

export default GenerationTemplate;
