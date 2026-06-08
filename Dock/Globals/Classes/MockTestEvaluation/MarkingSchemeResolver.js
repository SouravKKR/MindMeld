const { questionTypes } = require("../../Enumerations/QuestionTypes");

/**
 * Three-tier marking-rule lookup operating on the raw JSON shape that
 * mock tests are stored in on the Dock (Mongo / sync). Mirrors the
 * frontend's MockTest.resolveMarkingRuleForQuestion logic so the offline
 * grader and the LLM-task payload builder both award marks identically
 * regardless of which side ran them.
 *
 * Lookup order:
 *   1. perSectionMarkingOverrides[*]  (matched by id, then by name)
 *   2. perTypeMarkingOverrides[typeKey]
 *   3. flat scheme defaults (correctMarks / wrongMarks / unattemptedMarks / partialMarks)
 */
class MarkingSchemeResolver
{
    static DEFAULT_MARKING_SCHEME = Object.freeze({
        correctMarks: 1,
        wrongMarks: 0,
        unattemptedMarks: 0,
        partialMarks: 0,
        perTypeMarkingOverrides: {},
        perSectionMarkingOverrides: []
    });

    static normalizeMarkingScheme(rawMarkingScheme)
    {
        if (!rawMarkingScheme || typeof rawMarkingScheme !== "object")
        {
            return { ...MarkingSchemeResolver.DEFAULT_MARKING_SCHEME };
        }

        return {
            correctMarks: typeof rawMarkingScheme.correctMarks === "number" ? rawMarkingScheme.correctMarks : MarkingSchemeResolver.DEFAULT_MARKING_SCHEME.correctMarks,
            wrongMarks: typeof rawMarkingScheme.wrongMarks === "number" ? rawMarkingScheme.wrongMarks : MarkingSchemeResolver.DEFAULT_MARKING_SCHEME.wrongMarks,
            unattemptedMarks: typeof rawMarkingScheme.unattemptedMarks === "number" ? rawMarkingScheme.unattemptedMarks : MarkingSchemeResolver.DEFAULT_MARKING_SCHEME.unattemptedMarks,
            partialMarks: typeof rawMarkingScheme.partialMarks === "number" ? rawMarkingScheme.partialMarks : MarkingSchemeResolver.DEFAULT_MARKING_SCHEME.partialMarks,
            perTypeMarkingOverrides: rawMarkingScheme.perTypeMarkingOverrides && typeof rawMarkingScheme.perTypeMarkingOverrides === "object" ? rawMarkingScheme.perTypeMarkingOverrides : {},
            perSectionMarkingOverrides: Array.isArray(rawMarkingScheme.perSectionMarkingOverrides) ? rawMarkingScheme.perSectionMarkingOverrides : []
        };
    }

    static resolveTypeKey(questionAdditionalData)
    {
        if (!questionAdditionalData)
        {
            return null;
        }
        if (typeof questionAdditionalData.typeKey === "string" && questionAdditionalData.typeKey.length > 0)
        {
            return questionAdditionalData.typeKey;
        }
        if (Number.isFinite(questionAdditionalData.type))
        {
            for (const candidateKey of Object.keys(questionTypes))
            {
                if (questionTypes[candidateKey] === questionAdditionalData.type)
                {
                    return candidateKey;
                }
            }
        }
        return null;
    }

    static resolveRule(rawMarkingScheme, questionAdditionalData, sectionContext)
    {
        const scheme = MarkingSchemeResolver.normalizeMarkingScheme(rawMarkingScheme);
        const baseRule = {
            correctMarks: scheme.correctMarks,
            wrongMarks: scheme.wrongMarks,
            unattemptedMarks: scheme.unattemptedMarks,
            partialMarks: scheme.partialMarks
        };

        if (sectionContext)
        {
            const sectionOverride = (scheme.perSectionMarkingOverrides || []).find((sectionEntry) =>
            {
                if (!sectionEntry)
                {
                    return false;
                }
                if (sectionEntry.sectionItemId && sectionContext.id === sectionEntry.sectionItemId)
                {
                    return true;
                }
                if (sectionEntry.name && sectionContext.label === sectionEntry.name)
                {
                    return true;
                }
                return false;
            });

            if (sectionOverride)
            {
                return MarkingSchemeResolver.overlayRule(baseRule, sectionOverride);
            }
        }

        const typeKey = MarkingSchemeResolver.resolveTypeKey(questionAdditionalData);
        if (typeKey && scheme.perTypeMarkingOverrides && scheme.perTypeMarkingOverrides[typeKey])
        {
            return MarkingSchemeResolver.overlayRule(baseRule, scheme.perTypeMarkingOverrides[typeKey]);
        }

        return baseRule;
    }

    static overlayRule(baseRule, overlayRule)
    {
        return {
            correctMarks: typeof overlayRule.correctMarks === "number" ? overlayRule.correctMarks : baseRule.correctMarks,
            wrongMarks: typeof overlayRule.wrongMarks === "number" ? overlayRule.wrongMarks : baseRule.wrongMarks,
            unattemptedMarks: typeof overlayRule.unattemptedMarks === "number" ? overlayRule.unattemptedMarks : baseRule.unattemptedMarks,
            partialMarks: typeof overlayRule.partialMarks === "number" ? overlayRule.partialMarks : baseRule.partialMarks
        };
    }
}

module.exports = MarkingSchemeResolver;
