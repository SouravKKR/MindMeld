const AutoGenerationSettings = require('./AutoGenerationSettings');
const { automationLevels } = require('../../../Enumerations/AutomationLevels');
const ExtractableInformationSource = require('../../Decorators/ExtractableInformationSource');

class MockTestGenerationSettings extends AutoGenerationSettings
{
    #numTestsMethod;
    #numberOfTests;
    #difficultyMethod;
    #veryEasyQuestions;
    #easyQuestions;
    #mediumQuestions;
    #hardQuestions;
    #veryHardQuestions;
    #questionTypesMethod;
    #questionTypesWithWeights;
    #numQuestionsMethod;
    #numQuestionsPerTest;
    #correctMarks;
    #wrongMarks;
    #unattemptedMarks;
    #partialMarks;
    #perTypeMarkingOverrides;
    #sectionStructure;
    #showSolvingSteps;
    #durationMinutes;
    #mockTestName;
    #recursive;
    #skipRootDeck;

    constructor({type = null, additionalInstructions = '', description = '', informationSources = [], enhanceImages = false, imageSources = [], subjectName = '', examName = '', numTestsMethod = 0, numberOfTests = 2, difficultyMethod = 0, veryEasyQuestions = 1, easyQuestions = 1, mediumQuestions = 1, hardQuestions = 1, veryHardQuestions = 1, questionTypesMethod = 0, questionTypesWithWeights = {}, numQuestionsMethod = 0, numQuestionsPerTest = 30, correctMarks = 4, wrongMarks = -1, unattemptedMarks = 0, partialMarks = 0, perTypeMarkingOverrides = {}, sectionStructure = [], showSolvingSteps = true, durationMinutes = 0, mockTestName = '', recursive = false, skipRootDeck = false} = {})
    {
        super({type, additionalInstructions, description, informationSources, enhanceImages, imageSources, subjectName, examName});
        this.setNumTestsMethod(numTestsMethod);
        this.setNumberOfTests(numberOfTests);
        this.setDifficultyMethod(difficultyMethod);
        this.setVeryEasyQuestions(veryEasyQuestions);
        this.setEasyQuestions(easyQuestions);
        this.setMediumQuestions(mediumQuestions);
        this.setHardQuestions(hardQuestions);
        this.setVeryHardQuestions(veryHardQuestions);
        this.setQuestionTypesMethod(questionTypesMethod);
        this.setQuestionTypesWithWeights(questionTypesWithWeights);
        this.setNumQuestionsMethod(numQuestionsMethod);
        this.setNumQuestionsPerTest(numQuestionsPerTest);
        this.setCorrectMarks(correctMarks);
        this.setWrongMarks(wrongMarks);
        this.setUnattemptedMarks(unattemptedMarks);
        this.setPartialMarks(partialMarks);
        this.setPerTypeMarkingOverrides(perTypeMarkingOverrides);
        this.setSectionStructure(sectionStructure);
        this.setShowSolvingSteps(showSolvingSteps);
        this.setDurationMinutes(durationMinutes);
        this.setMockTestName(mockTestName);
        this.setRecursive(recursive);
        this.setSkipRootDeck(skipRootDeck);
    }

    getNumTestsMethod()
    {
        return this.#numTestsMethod;
    }

    setNumTestsMethod(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(automationLevels);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#numTestsMethod = value;
    }

    getNumberOfTests()
    {
        return this.#numberOfTests;
    }

    setNumberOfTests(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 2;
            }
        }
        this.#numberOfTests = value;
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

    getVeryEasyQuestions()
    {
        return this.#veryEasyQuestions;
    }

    setVeryEasyQuestions(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 1;
            }
        }
        this.#veryEasyQuestions = value;
    }

    getEasyQuestions()
    {
        return this.#easyQuestions;
    }

    setEasyQuestions(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 1;
            }
        }
        this.#easyQuestions = value;
    }

    getMediumQuestions()
    {
        return this.#mediumQuestions;
    }

    setMediumQuestions(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 1;
            }
        }
        this.#mediumQuestions = value;
    }

    getHardQuestions()
    {
        return this.#hardQuestions;
    }

    setHardQuestions(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 1;
            }
        }
        this.#hardQuestions = value;
    }

    getVeryHardQuestions()
    {
        return this.#veryHardQuestions;
    }

    setVeryHardQuestions(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 1;
            }
        }
        this.#veryHardQuestions = value;
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

    getNumQuestionsMethod()
    {
        return this.#numQuestionsMethod;
    }

    setNumQuestionsMethod(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(automationLevels);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#numQuestionsMethod = value;
    }

    getNumQuestionsPerTest()
    {
        return this.#numQuestionsPerTest;
    }

    setNumQuestionsPerTest(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 30;
            }
        }
        this.#numQuestionsPerTest = value;
    }

    getCorrectMarks()
    {
        return this.#correctMarks;
    }

    setCorrectMarks(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 4;
            }
        }
        this.#correctMarks = value;
    }

    getWrongMarks()
    {
        return this.#wrongMarks;
    }

    setWrongMarks(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = -1;
            }
        }
        this.#wrongMarks = value;
    }

    getUnattemptedMarks()
    {
        return this.#unattemptedMarks;
    }

    setUnattemptedMarks(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 0;
            }
        }
        this.#unattemptedMarks = value;
    }

    getPartialMarks()
    {
        return this.#partialMarks;
    }

    setPartialMarks(value)
    {
        if (value !== null)
        {
            value = parseFloat(value);
            if (isNaN(value))
            {
                value = 0;
            }
        }
        this.#partialMarks = value;
    }

    getPerTypeMarkingOverrides()
    {
        return this.#perTypeMarkingOverrides;
    }

    setPerTypeMarkingOverrides(value)
    {
        this.#perTypeMarkingOverrides = value;
    }

    getSectionStructure()
    {
        return this.#sectionStructure;
    }

    setSectionStructure(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#sectionStructure = value;
    }

    getShowSolvingSteps()
    {
        return this.#showSolvingSteps;
    }

    setShowSolvingSteps(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#showSolvingSteps = value;
    }

    getDurationMinutes()
    {
        return this.#durationMinutes;
    }

    setDurationMinutes(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 0;
            }
        }
        this.#durationMinutes = value;
    }

    getMockTestName()
    {
        return this.#mockTestName;
    }

    setMockTestName(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#mockTestName = value;
    }

    getRecursive()
    {
        return this.#recursive;
    }

    setRecursive(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#recursive = value;
    }

    getSkipRootDeck()
    {
        return this.#skipRootDeck;
    }

    setSkipRootDeck(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#skipRootDeck = value;
    }

    toJson()
    {
        return {
            ...super.toJson(),
            numTestsMethod: this.getNumTestsMethod() !== null ? Number(this.getNumTestsMethod()) : null,
            numberOfTests: this.getNumberOfTests(),
            difficultyMethod: this.getDifficultyMethod() !== null ? Number(this.getDifficultyMethod()) : null,
            veryEasyQuestions: this.getVeryEasyQuestions(),
            easyQuestions: this.getEasyQuestions(),
            mediumQuestions: this.getMediumQuestions(),
            hardQuestions: this.getHardQuestions(),
            veryHardQuestions: this.getVeryHardQuestions(),
            questionTypesMethod: this.getQuestionTypesMethod() !== null ? Number(this.getQuestionTypesMethod()) : null,
            questionTypesWithWeights: this.getQuestionTypesWithWeights(),
            numQuestionsMethod: this.getNumQuestionsMethod() !== null ? Number(this.getNumQuestionsMethod()) : null,
            numQuestionsPerTest: this.getNumQuestionsPerTest(),
            correctMarks: this.getCorrectMarks(),
            wrongMarks: this.getWrongMarks(),
            unattemptedMarks: this.getUnattemptedMarks(),
            partialMarks: this.getPartialMarks(),
            perTypeMarkingOverrides: this.getPerTypeMarkingOverrides(),
            sectionStructure: this.getSectionStructure(),
            showSolvingSteps: this.getShowSolvingSteps(),
            durationMinutes: this.getDurationMinutes(),
            mockTestName: this.getMockTestName(),
            recursive: this.getRecursive(),
            skipRootDeck: this.getSkipRootDeck(),
        };
    }

    static fromJson(json)
    {
        const instance = new MockTestGenerationSettings({
            type: json.type ?? null,
            additionalInstructions: json.additionalInstructions ?? null,
            description: json.description ?? null,
            informationSources: json.informationSources != null ? json.informationSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            enhanceImages: json.enhanceImages ?? null,
            imageSources: json.imageSources != null ? json.imageSources.map(item => ExtractableInformationSource.fromJson(item)) : null,
            subjectName: json.subjectName ?? null,
            examName: json.examName ?? null,
            numTestsMethod: json.numTestsMethod ?? null,
            numberOfTests: json.numberOfTests ?? null,
            difficultyMethod: json.difficultyMethod ?? null,
            veryEasyQuestions: json.veryEasyQuestions ?? null,
            easyQuestions: json.easyQuestions ?? null,
            mediumQuestions: json.mediumQuestions ?? null,
            hardQuestions: json.hardQuestions ?? null,
            veryHardQuestions: json.veryHardQuestions ?? null,
            questionTypesMethod: json.questionTypesMethod ?? null,
            questionTypesWithWeights: json.questionTypesWithWeights ?? null,
            numQuestionsMethod: json.numQuestionsMethod ?? null,
            numQuestionsPerTest: json.numQuestionsPerTest ?? null,
            correctMarks: json.correctMarks ?? null,
            wrongMarks: json.wrongMarks ?? null,
            unattemptedMarks: json.unattemptedMarks ?? null,
            partialMarks: json.partialMarks ?? null,
            perTypeMarkingOverrides: json.perTypeMarkingOverrides ?? null,
            sectionStructure: json.sectionStructure ?? null,
            showSolvingSteps: json.showSolvingSteps ?? null,
            durationMinutes: json.durationMinutes ?? null,
            mockTestName: json.mockTestName ?? null,
            recursive: json.recursive ?? null,
            skipRootDeck: json.skipRootDeck ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }
}

module.exports = MockTestGenerationSettings;
