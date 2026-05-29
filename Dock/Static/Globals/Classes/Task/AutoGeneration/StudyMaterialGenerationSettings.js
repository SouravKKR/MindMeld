import AutoGenerationSettings from './AutoGenerationSettings.js';
import { studyMaterialDetailLevels } from '../../../Enumerations/StudyMaterialDetailLevels.js';
import ExtractableInformationSource from '../../Decorators/ExtractableInformationSource.js';

class StudyMaterialGenerationSettings extends AutoGenerationSettings
{
    #detailLevels;

    constructor({type = null, additionalInstructions = '', description = '', informationSources = [], enhanceImages = false, imageSources = [], subjectName = '', examName = '', detailLevels = [0,1]} = {})
    {
        super({type, additionalInstructions, description, informationSources, enhanceImages, imageSources, subjectName, examName});
        this.setDetailLevels(detailLevels);
    }

    getDetailLevels()
    {
        return this.#detailLevels;
    }

    setDetailLevels(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#detailLevels = value;
    }

    toJson()
    {
        return {
            ...super.toJson(),
            detailLevels: this.getDetailLevels() !== null ? this.getDetailLevels().map(item => Number(item)) : null,
        };
    }

    static fromJson(json)
    {
        const instance = new StudyMaterialGenerationSettings({
            type: json.type ?? null,
            additionalInstructions: json.additionalInstructions ?? null,
            description: json.description ?? null,
            informationSources: json.informationSources != null ? json.informationSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            enhanceImages: json.enhanceImages ?? null,
            imageSources: json.imageSources != null ? json.imageSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            subjectName: json.subjectName ?? null,
            examName: json.examName ?? null,
            detailLevels: json.detailLevels ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }
}

export default StudyMaterialGenerationSettings;
