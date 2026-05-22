import AutoGenerationSettings from './AutoGenerationSettings.js';
import { automaticGenerationModes } from '../../../Enumerations/AutomaticGenerationModes.js';
import ExtractableInformationSource from '../../Decorators/ExtractableInformationSource.js';

class GeneralGenerationSettings extends AutoGenerationSettings
{
    #generationMode;
    #inheritImageCurriculumFromInformationSources;
    #captureImagesEnabled;
    #goodQualityDeckShortNames;

    constructor({type = null, additionalInstructions = '', description = '', informationSources = [], enhanceImages = false, imageSources = [], subjectName = '', examName = '', generationMode = 0, inheritImageCurriculumFromInformationSources = true, captureImagesEnabled = true, goodQualityDeckShortNames = false} = {})
    {
        super({type, additionalInstructions, description, informationSources, enhanceImages, imageSources, subjectName, examName});
        this.setGenerationMode(generationMode);
        this.setInheritImageCurriculumFromInformationSources(inheritImageCurriculumFromInformationSources);
        this.setCaptureImagesEnabled(captureImagesEnabled);
        this.setGoodQualityDeckShortNames(goodQualityDeckShortNames);
    }

    getGenerationMode()
    {
        return this.#generationMode;
    }

    setGenerationMode(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(automaticGenerationModes);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#generationMode = value;
    }

    getInheritImageCurriculumFromInformationSources()
    {
        return this.#inheritImageCurriculumFromInformationSources;
    }

    setInheritImageCurriculumFromInformationSources(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#inheritImageCurriculumFromInformationSources = value;
    }

    getCaptureImagesEnabled()
    {
        return this.#captureImagesEnabled;
    }

    setCaptureImagesEnabled(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#captureImagesEnabled = value;
    }

    getGoodQualityDeckShortNames()
    {
        return this.#goodQualityDeckShortNames;
    }

    setGoodQualityDeckShortNames(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#goodQualityDeckShortNames = value;
    }

    toJson()
    {
        return {
            ...super.toJson(),
            generationMode: this.getGenerationMode() !== null ? Number(this.getGenerationMode()) : null,
            inheritImageCurriculumFromInformationSources: this.getInheritImageCurriculumFromInformationSources(),
            captureImagesEnabled: this.getCaptureImagesEnabled(),
            goodQualityDeckShortNames: this.getGoodQualityDeckShortNames(),
        };
    }

    static fromJson(json)
    {
        const instance = new GeneralGenerationSettings({
            type: json.type ?? null,
            additionalInstructions: json.additionalInstructions ?? null,
            description: json.description ?? null,
            informationSources: json.informationSources != null ? json.informationSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            enhanceImages: json.enhanceImages ?? null,
            imageSources: json.imageSources != null ? json.imageSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            subjectName: json.subjectName ?? null,
            examName: json.examName ?? null,
            generationMode: json.generationMode ?? null,
            inheritImageCurriculumFromInformationSources: json.inheritImageCurriculumFromInformationSources ?? null,
            captureImagesEnabled: json.captureImagesEnabled ?? null,
            goodQualityDeckShortNames: json.goodQualityDeckShortNames ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }
}

export default GeneralGenerationSettings;
