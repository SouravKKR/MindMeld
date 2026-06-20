import TaskSettings from '../TaskSettings.js';
import ExtractableInformationSource from '../../Decorators/ExtractableInformationSource.js';

class AutoGenerationSettings extends TaskSettings
{
    #additionalInstructions;
    #description;
    #informationSources;
    #enhanceImages;
    #imageSources;
    #subjectName;
    #examName;

    constructor({type = null, additionalInstructions = '', description = '', informationSources = [], enhanceImages = false, imageSources = [], subjectName = '', examName = ''} = {})
    {
        super({type});
        this.setAdditionalInstructions(additionalInstructions);
        this.setDescription(description);
        this.setInformationSources(informationSources);
        this.setEnhanceImages(enhanceImages);
        this.setImageSources(imageSources);
        this.setSubjectName(subjectName);
        this.setExamName(examName);
    }

    getAdditionalInstructions()
    {
        return this.#additionalInstructions;
    }

    setAdditionalInstructions(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#additionalInstructions = value;
    }

    getDescription()
    {
        return this.#description;
    }

    setDescription(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#description = value;
    }

    getInformationSources()
    {
        return this.#informationSources;
    }

    setInformationSources(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#informationSources = value;
    }

    getEnhanceImages()
    {
        return this.#enhanceImages;
    }

    setEnhanceImages(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#enhanceImages = value;
    }

    getImageSources()
    {
        return this.#imageSources;
    }

    setImageSources(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#imageSources = value;
    }

    getSubjectName()
    {
        return this.#subjectName;
    }

    setSubjectName(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#subjectName = value;
    }

    getExamName()
    {
        return this.#examName;
    }

    setExamName(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#examName = value;
    }

    toJson()
    {
        return {
            ...super.toJson(),
            additionalInstructions: this.getAdditionalInstructions(),
            description: this.getDescription(),
            informationSources: this.getInformationSources() !== null ? this.getInformationSources().map(item => item.toJson()) : null,
            enhanceImages: this.getEnhanceImages(),
            imageSources: this.getImageSources() !== null ? this.getImageSources().map(item => item.toJson()) : null,
            subjectName: this.getSubjectName(),
            examName: this.getExamName(),
        };
    }

    static fromJson(json)
    {
        const instance = new AutoGenerationSettings({
            type: json.type ?? null,
            additionalInstructions: json.additionalInstructions ?? null,
            description: json.description ?? null,
            informationSources: json.informationSources != null ? json.informationSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            enhanceImages: json.enhanceImages ?? null,
            imageSources: json.imageSources != null ? json.imageSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            subjectName: json.subjectName ?? null,
            examName: json.examName ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }
}

export default AutoGenerationSettings;
