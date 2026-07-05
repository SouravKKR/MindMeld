const AutoGenerationSettings = require('./AutoGenerationSettings');
const { automationLevels } = require('../../../Enumerations/AutomationLevels');
const ExtractableInformationSource = require('../../Decorators/ExtractableInformationSource');

class FlashcardGenerationSettings extends AutoGenerationSettings
{
    #numCardsMethod;
    #numQuestionsToGenerate;
    #questionTypesMethod;
    #questionTypesWithWeights;
    #difficultyMethod;
    #questionDifficultyWithWeights;
    #bMarkQuestionsForReview;

    constructor({type = null, additionalInstructions = '', description = '', informationSources = [], enhanceImages = false, imageSources = [], subjectName = '', examName = '', numCardsMethod = 0, numQuestionsToGenerate = 20, questionTypesMethod = 0, questionTypesWithWeights = {}, difficultyMethod = 0, questionDifficultyWithWeights = {}, bMarkQuestionsForReview = true} = {})
    {
        super({type, additionalInstructions, description, informationSources, enhanceImages, imageSources, subjectName, examName});
        this.setNumCardsMethod(numCardsMethod);
        this.setNumQuestionsToGenerate(numQuestionsToGenerate);
        this.setQuestionTypesMethod(questionTypesMethod);
        this.setQuestionTypesWithWeights(questionTypesWithWeights);
        this.setDifficultyMethod(difficultyMethod);
        this.setQuestionDifficultyWithWeights(questionDifficultyWithWeights);
        this.setBMarkQuestionsForReview(bMarkQuestionsForReview);
    }

    getNumCardsMethod()
    {
        return this.#numCardsMethod;
    }

    setNumCardsMethod(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(automationLevels);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#numCardsMethod = value;
    }

    getNumQuestionsToGenerate()
    {
        return this.#numQuestionsToGenerate;
    }

    setNumQuestionsToGenerate(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 20;
            }
        }
        this.#numQuestionsToGenerate = value;
    }

    getQuestionTypesMethod()
    {
        return this.#questionTypesMethod;
    }

    setQuestionTypesMethod(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(automationLevels);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#questionTypesMethod = value;
    }

    getQuestionTypesWithWeights()
    {
        return this.#questionTypesWithWeights;
    }

    setQuestionTypesWithWeights(value)
    {
        this.#questionTypesWithWeights = value;
    }

    getDifficultyMethod()
    {
        return this.#difficultyMethod;
    }

    setDifficultyMethod(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(automationLevels);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#difficultyMethod = value;
    }

    getQuestionDifficultyWithWeights()
    {
        return this.#questionDifficultyWithWeights;
    }

    setQuestionDifficultyWithWeights(value)
    {
        this.#questionDifficultyWithWeights = value;
    }

    getBMarkQuestionsForReview()
    {
        return this.#bMarkQuestionsForReview;
    }

    setBMarkQuestionsForReview(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#bMarkQuestionsForReview = value;
    }

    toJson()
    {
        return {
            ...super.toJson(),
            numCardsMethod: this.getNumCardsMethod() !== null ? Number(this.getNumCardsMethod()) : null,
            numQuestionsToGenerate: this.getNumQuestionsToGenerate(),
            questionTypesMethod: this.getQuestionTypesMethod() !== null ? Number(this.getQuestionTypesMethod()) : null,
            questionTypesWithWeights: this.getQuestionTypesWithWeights(),
            difficultyMethod: this.getDifficultyMethod() !== null ? Number(this.getDifficultyMethod()) : null,
            questionDifficultyWithWeights: this.getQuestionDifficultyWithWeights(),
            bMarkQuestionsForReview: this.getBMarkQuestionsForReview(),
        };
    }

    static fromJson(json)
    {
        const instance = new FlashcardGenerationSettings({
            type: json.type ?? null,
            additionalInstructions: json.additionalInstructions ?? null,
            description: json.description ?? null,
            informationSources: json.informationSources != null ? json.informationSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            enhanceImages: json.enhanceImages ?? null,
            imageSources: json.imageSources != null ? json.imageSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            subjectName: json.subjectName ?? null,
            examName: json.examName ?? null,
            numCardsMethod: json.numCardsMethod ?? null,
            numQuestionsToGenerate: json.numQuestionsToGenerate ?? null,
            questionTypesMethod: json.questionTypesMethod ?? null,
            questionTypesWithWeights: json.questionTypesWithWeights ?? null,
            difficultyMethod: json.difficultyMethod ?? null,
            questionDifficultyWithWeights: json.questionDifficultyWithWeights ?? null,
            bMarkQuestionsForReview: json.bMarkQuestionsForReview ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }
}

module.exports = FlashcardGenerationSettings;
