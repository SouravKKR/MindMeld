/**
 * Resolves the frozen marking-scheme blob for a generated mock test from the
 * caller's MockTestGenerationSettings instance. Routing every read through the
 * generated getters (rather than direct property access on the private-field
 * class instance) is what makes the user's configured marking rule actually
 * land on the persisted document.
 */
class MarkingSchemeExtractor
{
    static #DEFAULT_CORRECT_MARKS = 4;
    static #DEFAULT_WRONG_MARKS = -1;
    static #DEFAULT_UNATTEMPTED_MARKS = 0;
    static #DEFAULT_PARTIAL_MARKS = 0;

    /**
     * Extracts the marking-scheme blob from the mock-test generation settings.
     * Returns a fully-resolved scheme — missing fields are filled from defaults
     * so MockTest.fromJson sees a stable shape regardless of caller payload.
     */
    static extractMarkingScheme(mockTestGenerationSettings)
    {
        // The argument is a MockTestGenerationSettings class instance — its
        // members live behind private fields (`#correctMarks` etc.) reachable
        // only through getters. Direct property reads on the instance return
        // undefined, which previously short-circuited every typeof check and
        // fed the user the hardcoded `4 / -1 / 0 / 0` defaults regardless of
        // what they configured in the UI. Route through the generated
        // getters so the user's actual marking rule lands on the document.
        const readNumber = (getterName, fallback) =>
        {
            if (mockTestGenerationSettings && typeof mockTestGenerationSettings[getterName] === "function")
            {
                const value = mockTestGenerationSettings[getterName]();
                if (typeof value === "number" && Number.isFinite(value))
                {
                    return value;
                }
            }
            return fallback;
        };

        const correctMarks = readNumber("getCorrectMarks", MarkingSchemeExtractor.#DEFAULT_CORRECT_MARKS);
        const wrongMarks = readNumber("getWrongMarks", MarkingSchemeExtractor.#DEFAULT_WRONG_MARKS);
        const unattemptedMarks = readNumber("getUnattemptedMarks", MarkingSchemeExtractor.#DEFAULT_UNATTEMPTED_MARKS);
        const partialMarks = readNumber("getPartialMarks", MarkingSchemeExtractor.#DEFAULT_PARTIAL_MARKS);

        const rawPerTypeOverrides = (mockTestGenerationSettings && typeof mockTestGenerationSettings.getPerTypeMarkingOverrides === "function")
            ? mockTestGenerationSettings.getPerTypeMarkingOverrides()
            : null;
        const perTypeMarkingOverrides = rawPerTypeOverrides && typeof rawPerTypeOverrides === "object"
            ? rawPerTypeOverrides
            : {};

        const rawSectionStructure = (mockTestGenerationSettings && typeof mockTestGenerationSettings.getSectionStructure === "function")
            ? mockTestGenerationSettings.getSectionStructure()
            : null;
        const sectionStructure = Array.isArray(rawSectionStructure)
            ? rawSectionStructure
            : [];

        return {
            correctMarks,
            wrongMarks,
            unattemptedMarks,
            partialMarks,
            perTypeMarkingOverrides,
            // The persisted MockTest still calls this array `perSectionMarkingOverrides`
            // (its hand-written model is unchanged). The live settings field is the
            // renamed `sectionStructure` — entries now carry questionCount + totalMarks
            // alongside the marking-rule fields. Pass through verbatim; older readers
            // that only consume the marking-rule keys are unaffected by the extra
            // properties.
            perSectionMarkingOverrides: sectionStructure
        };
    }

    /**
     * Finds the per-section override whose `questionTypes` filter matches the
     * given question-type integer value. The override entry stores QuestionTypes
     * enum names; we translate the typeValue to its name via `typeKeyByValue`
     * (an injected name→intValue map) and check membership. Returns null when
     * no section override applies.
     */
    static findSectionOverrideForType(perSectionMarkingOverrides, typeValue, typeKeyByValue)
    {
        if (!Array.isArray(perSectionMarkingOverrides) || perSectionMarkingOverrides.length === 0)
        {
            return null;
        }

        const typeKey = typeKeyByValue[typeValue];
        if (!typeKey)
        {
            return null;
        }

        for (const entry of perSectionMarkingOverrides)
        {
            if (!entry || !Array.isArray(entry.questionTypes))
            {
                continue;
            }
            if (entry.questionTypes.includes(typeKey))
            {
                return entry;
            }
        }

        return null;
    }
}

module.exports = MarkingSchemeExtractor;
