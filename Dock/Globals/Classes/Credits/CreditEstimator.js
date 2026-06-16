const CreditConfigurationStore = require("./CreditConfigurationStore");
const { taskTypes } = require("../../Enumerations/TaskTypes");
const { automationLevels } = require("../../Enumerations/AutomationLevels");


/**
 * CreditEstimator
 *
 * Predicts the credit cost of a "Generate with AI" run BEFORE it runs, for the
 * Compute Cost button. The estimate is built from the same generation settings
 * the /Generate request carries, and it reads the LIVE credit config so the
 * per-token / per-second rates always match what billing will actually charge.
 *
 * Shape of the work: cost is dominated by the number of generated items
 * (cards / questions / topics) times the model's per-item cost, plus the
 * document-preparation (CPU duration) tasks, plus optional image enhancement.
 *
 *   estimate = Σ_types (itemCount × normalizedTokens(item, difficulty) × tokenRate)
 *            + Σ_prep  (estimatedSeconds × durationRate)
 *            + (imageEnhancement ? flat : 0)
 *
 * The CALIBRATION constants below are heuristic seeds. They are deliberately
 * isolated so they can be refined over time from the historical
 * (settings → actual cost) data the credit-usage tracking now records — that
 * is what tightens the estimate toward the ±10% target.
 */
class CreditEstimator
{
    // Calibrated from real generations. The key insight from the usage data:
    // INPUT cost is dominated by the document content re-sent with each topic
    // cell's prompt — it scales with the document size, NOT the card count — so
    // input is modelled as (content tokens × a per-type re-read factor). OUTPUT
    // scales with the generated items (cards / questions), except study material
    // which is long-form and scales with the document too. These are seeds tuned
    // to observed runs; refine as more (settings → cost) data accumulates.
    static CALIBRATION =
    {
        tokensPerPage: 750,
        wordsPerPage: 550,

        flashcardOutputTokensPerCard: 125,
        flashcardInputRereadFactor: 7,        // content re-read ≈ 7× across flashcard cells

        mockOutputTokensPerQuestion: 145,
        mockInputRereadFactor: 16,            // mock prompts re-send the most content

        studyOutputRereadFactor: 4.5,         // long-form lessons: output ≈ 4.5× content
        studyInputRereadFactor: 9,

        embeddingSecondsPerPage: 3.5,
        mapTopicsSecondsPerPage: 3.0,
        syllabusSeconds: 12,
        imageEnhancementCreditsFlat: 2.0,
        // Used when the document page count is unknown (no explicit page ranges
        // = "whole document") so the content-driven terms aren't zero.
        assumedPagesWhenUnknown: 25,
        fallbackCardCount: 50,
    };

    // Difficulty → billing weight, mirroring the Agent's ModelPricing compressed
    // weights (MARGIN_COMPRESSION 0.70) and ModelPool routing: VERY_HARD → pro,
    // HARD → 3.1-flash-lite, the rest → 2.5-flash-lite. Keep in sync with those.
    static DIFFICULTY_OUTPUT_WEIGHT = { VERY_EASY: 1, EASY: 1, MEDIUM: 1, HARD: 2.92, VERY_HARD: 21.3 };
    static DIFFICULTY_INPUT_WEIGHT = { VERY_EASY: 1, EASY: 1, MEDIUM: 1, HARD: 1.93, VERY_HARD: 14.3 };

    // Representative blend when difficulty is AUTOMATIC (mostly easy/medium with
    // a little hard) — keeps the estimate from assuming all-pro or all-easy.
    static DEFAULT_OUTPUT_WEIGHT = 1.4;
    static DEFAULT_INPUT_WEIGHT = 1.3;

    static ESTIMATE_BAND = 0.10;
    static IMAGE_ENHANCEMENT_BAND = 0.25;

    /**
     * @param {object} body - the generationSettingsMap (same body as /Generate)
     * @returns {Promise<{estimatedCredits:number|null, low:number, high:number, breakdown:Array, currency:string|null, pricePerCredit:number|null}>}
     */
    static async estimate(body)
    {
        const configuration = await CreditConfigurationStore.load();
        if (!configuration)
        {
            return { estimatedCredits: null, low: 0, high: 0, breakdown: [], currency: null, pricePerCredit: null };
        }

        const calibration = CreditEstimator.CALIBRATION;
        const general = (body && body.generalGeneration) || {};
        const knownPages = CreditEstimator.#countPages(general.informationSources);
        const pageCount = knownPages > 0 ? knownPages : calibration.assumedPagesWhenUnknown;
        // Total document content tokens — the quantity input cost scales with,
        // because each topic cell re-sends the content with its prompt.
        const contentTokens = pageCount * calibration.tokensPerPage;

        const breakdown = [];

        if (body && body.flashcardGeneration)
        {
            const cardCount = CreditEstimator.#resolveFlashcardCount(body.flashcardGeneration, pageCount);
            const weights = CreditEstimator.#resolveDifficultyWeights(body.flashcardGeneration.questionDifficultyWithWeights);
            const credits = CreditEstimator.#estimateTokenType(
                configuration, taskTypes.FLASHCARD_GENERATION_WORKER,
                contentTokens * calibration.flashcardInputRereadFactor,
                cardCount * calibration.flashcardOutputTokensPerCard,
                weights
            );
            breakdown.push({ label: "Flashcards", credits: credits });
        }

        if (body && body.mockTestGeneration)
        {
            const questionCount = CreditEstimator.#resolveMockQuestionCount(body.mockTestGeneration, pageCount);
            const weights = { output: CreditEstimator.DEFAULT_OUTPUT_WEIGHT, input: CreditEstimator.DEFAULT_INPUT_WEIGHT };
            const credits = CreditEstimator.#estimateTokenType(
                configuration, taskTypes.MOCK_TEST_GENERATION_WORKER,
                contentTokens * calibration.mockInputRereadFactor,
                questionCount * calibration.mockOutputTokensPerQuestion,
                weights
            );
            breakdown.push({ label: "Mock tests", credits: credits });
        }

        if (body && body.studyMaterialGeneration)
        {
            // Study material is long-form: both its input and output scale with
            // the document (and the number of detail levels), not a card count.
            const detailLevelCount = Array.isArray(body.studyMaterialGeneration.detailLevels) && body.studyMaterialGeneration.detailLevels.length > 0
                ? body.studyMaterialGeneration.detailLevels.length
                : 1;
            const weights = { output: CreditEstimator.DEFAULT_OUTPUT_WEIGHT, input: CreditEstimator.DEFAULT_INPUT_WEIGHT };
            const credits = CreditEstimator.#estimateTokenType(
                configuration, taskTypes.STUDY_MATERIAL_GENERATION_WORKER,
                contentTokens * calibration.studyInputRereadFactor * detailLevelCount,
                contentTokens * calibration.studyOutputRereadFactor * detailLevelCount,
                weights
            );
            breakdown.push({ label: "Study material", credits: credits });
        }

        const preparationCredits =
            CreditEstimator.#estimateDurationType(configuration, taskTypes.PREPARE_FOR_SIMILARITY_SEARCH, pageCount * calibration.embeddingSecondsPerPage)
            + CreditEstimator.#estimateDurationType(configuration, taskTypes.MAP_TOPICS_WITH_CONTENT, pageCount * calibration.mapTopicsSecondsPerPage)
            + CreditEstimator.#estimateDurationType(configuration, taskTypes.PROCESS_SYLLABUS, calibration.syllabusSeconds);
        if (preparationCredits > 0)
        {
            breakdown.push({ label: "Document preparation", credits: preparationCredits });
        }

        let bWideBand = false;
        if (general.enhanceImages === true && CreditEstimator.#taskCharges(configuration, taskTypes.ENHANCE_IMAGES))
        {
            breakdown.push({ label: "Image enhancement", credits: calibration.imageEnhancementCreditsFlat });
            bWideBand = true;
        }

        const total = CreditEstimator.#round(breakdown.reduce((sum, item) => sum + item.credits, 0));
        const band = bWideBand ? CreditEstimator.IMAGE_ENHANCEMENT_BAND : CreditEstimator.ESTIMATE_BAND;

        const baseEntry = configuration.getBaseCreditPriceEntry();

        return {
            estimatedCredits: total,
            low: CreditEstimator.#round(total * (1 - band)),
            high: CreditEstimator.#round(total * (1 + band)),
            breakdown: breakdown.map(item => ({ label: item.label, credits: CreditEstimator.#round(item.credits) })),
            currency: baseEntry ? baseEntry.getCurrency() : null,
            pricePerCredit: baseEntry ? baseEntry.getPricePerCredit() : null,
        };
    }

    static #countPages(informationSources)
    {
        if (!Array.isArray(informationSources))
        {
            return 0;
        }
        let totalPages = 0;
        for (const source of informationSources)
        {
            const ranges = source && Array.isArray(source.pageRanges) ? source.pageRanges : [];
            for (const range of ranges)
            {
                const startPage = Number(range && range.startPage) || 0;
                const endPage = Number(range && range.endPage) || 0;
                if (endPage >= startPage && startPage > 0)
                {
                    totalPages += (endPage - startPage + 1);
                }
            }
        }
        return totalPages;
    }

    static #resolveFlashcardCount(flashcardJson, pageCount)
    {
        const calibration = CreditEstimator.CALIBRATION;
        if (Number(flashcardJson.numCardsMethod) === automationLevels.MANUAL)
        {
            const explicit = Number(flashcardJson.numQuestionsToGenerate);
            if (Number.isFinite(explicit) && explicit > 0)
            {
                return explicit;
            }
        }
        // AUTOMATIC (or missing): the worker derives ~1 card per 100 words.
        const autoCards = Math.round((pageCount * calibration.wordsPerPage) / 100);
        return autoCards > 0 ? autoCards : calibration.fallbackCardCount;
    }

    static #resolveMockQuestionCount(mockJson, pageCount)
    {
        const testCount = Number(mockJson.numberOfTests) > 0 ? Number(mockJson.numberOfTests) : 1;
        if (Number(mockJson.numQuestionsMethod) === automationLevels.MANUAL)
        {
            const perTest = Number(mockJson.numQuestionsPerTest);
            if (Number.isFinite(perTest) && perTest > 0)
            {
                return testCount * perTest;
            }
        }
        const perTestAuto = Math.max(10, Math.round((pageCount * CreditEstimator.CALIBRATION.wordsPerPage) / 200));
        return testCount * perTestAuto;
    }

    static #resolveDifficultyWeights(difficultyWeights)
    {
        if (!difficultyWeights || typeof difficultyWeights !== "object")
        {
            return { output: CreditEstimator.DEFAULT_OUTPUT_WEIGHT, input: CreditEstimator.DEFAULT_INPUT_WEIGHT };
        }

        let totalWeight = 0;
        let outputSum = 0;
        let inputSum = 0;
        for (const difficultyName of Object.keys(difficultyWeights))
        {
            const weight = Number(difficultyWeights[difficultyName]) || 0;
            if (weight <= 0)
            {
                continue;
            }
            totalWeight += weight;
            outputSum += weight * (CreditEstimator.DIFFICULTY_OUTPUT_WEIGHT[difficultyName] ?? 1);
            inputSum += weight * (CreditEstimator.DIFFICULTY_INPUT_WEIGHT[difficultyName] ?? 1);
        }

        if (totalWeight <= 0)
        {
            return { output: CreditEstimator.DEFAULT_OUTPUT_WEIGHT, input: CreditEstimator.DEFAULT_INPUT_WEIGHT };
        }
        return { output: outputSum / totalWeight, input: inputSum / totalWeight };
    }

    static #estimateTokenType(configuration, taskTypeValue, rawInputTokens, rawOutputTokens, weights)
    {
        const rule = configuration.getRuleForTask(taskTypeValue);
        if (!rule || !rule.getEnabled())
        {
            return 0;
        }
        const inputRate = CreditEstimator.#rateForDimension(rule, "INPUT_TOKENS");
        const outputRate = CreditEstimator.#rateForDimension(rule, "OUTPUT_TOKENS");

        // Raw token estimates are scaled to normalized billing units by the
        // difficulty/model weight before applying the per-token rate.
        const normalizedInputTokens = rawInputTokens * weights.input;
        const normalizedOutputTokens = rawOutputTokens * weights.output;

        return (normalizedInputTokens * inputRate) + (normalizedOutputTokens * outputRate);
    }

    static #estimateDurationType(configuration, taskTypeValue, estimatedSeconds)
    {
        const rule = configuration.getRuleForTask(taskTypeValue);
        if (!rule || !rule.getEnabled())
        {
            return 0;
        }
        return Math.max(0, estimatedSeconds) * CreditEstimator.#rateForDimension(rule, "DURATION_SECONDS");
    }

    static #taskCharges(configuration, taskTypeValue)
    {
        const rule = configuration.getRuleForTask(taskTypeValue);
        return Boolean(rule && rule.getEnabled() && rule.getTerms().length > 0);
    }

    /**
     * Credits charged per one unit of a cost dimension under a rule = the sum,
     * over terms that reference that dimension, of (credits ÷ divisor). Mirrors
     * CreditSpendTerm.evaluate for a single unit of the metric.
     */
    static #rateForDimension(rule, dimensionName)
    {
        let rate = 0;
        for (const term of rule.getTerms())
        {
            const divisors = term.getDivisors() || {};
            const divisor = Number(divisors[dimensionName]);
            if (Number.isFinite(divisor) && divisor > 0)
            {
                rate += term.getCredits() / divisor;
            }
        }
        return rate;
    }

    static #round(value)
    {
        return Math.round((Number(value) || 0) * 100) / 100;
    }
}

module.exports = CreditEstimator;
