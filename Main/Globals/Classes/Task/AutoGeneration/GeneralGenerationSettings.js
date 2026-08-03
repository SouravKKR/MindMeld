const AutoGenerationSettings = require('./AutoGenerationSettings');
const { automaticGenerationModes } = require('../../../Enumerations/AutomaticGenerationModes');
const ExtractableInformationSource = require('../../Decorators/ExtractableInformationSource');

class GeneralGenerationSettings extends AutoGenerationSettings
{
    #generationMode;
    #inheritImageCurriculumFromInformationSources;
    #captureImagesEnabled;
    #goodQualityDeckShortNames;
    #paidDeckMode;

    constructor({type = null, additionalInstructions = '', description = '', informationSources = [], enhanceImages = false, imageSources = [], subjectName = '', examName = '', generationMode = 0, inheritImageCurriculumFromInformationSources = true, captureImagesEnabled = false, goodQualityDeckShortNames = false, paidDeckMode = false} = {})
    {
        super({type, additionalInstructions, description, informationSources, enhanceImages, imageSources, subjectName, examName});
        this.setGenerationMode(generationMode);
        this.setInheritImageCurriculumFromInformationSources(inheritImageCurriculumFromInformationSources);
        this.setCaptureImagesEnabled(captureImagesEnabled);
        this.setGoodQualityDeckShortNames(goodQualityDeckShortNames);
        this.setPaidDeckMode(paidDeckMode);
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

    getPaidDeckMode()
    {
        return this.#paidDeckMode;
    }

    setPaidDeckMode(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#paidDeckMode = value;
    }

    toJson()
    {
        return {
            ...super.toJson(),
            generationMode: this.getGenerationMode() !== null ? Number(this.getGenerationMode()) : null,
            inheritImageCurriculumFromInformationSources: this.getInheritImageCurriculumFromInformationSources(),
            captureImagesEnabled: this.getCaptureImagesEnabled(),
            goodQualityDeckShortNames: this.getGoodQualityDeckShortNames(),
            paidDeckMode: this.getPaidDeckMode(),
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
            goodQualityDeckShortNames: json.goodQualityDeckShortNames ?? null,
            paidDeckMode: json.paidDeckMode ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }
}

module.exports = GeneralGenerationSettings;
