const { sectionQuestionCountModes } = require("../../Enumerations/SectionQuestionCountModes");
const { sectionMarksModes } = require("../../Enumerations/SectionMarksModes");


/**
 * MockTestSectionGeometry
 *
 * Hand-mirrored from Main/Globals/Classes/MockTestSectionGeometry.js. The two
 * copies MUST agree: the editor blocks submission on these rules, this copy
 * re-checks them server-side because a client is never trusted, and
 * MockTestAssembler realises the same bands at assembly time.
 *
 * The single arithmetic authority for a mock-test section entry: how many
 * questions it can hold, how many marks each of those questions may carry, and
 * whether the combination the user asked for is achievable at all.
 *
 * A section always describes three quantities — question count, marks per
 * question, and the section's total marks — but only two are ever entered:
 *
 *   UNIFORM_PER_QUESTION  count + marks per question are entered,
 *                         total marks is derived (count x marksPerQuestion).
 *   RANGE_PER_QUESTION    a marks band per question + a total-marks budget are
 *                         entered, and the question count is derived as
 *                         ceil(total / maximum) .. floor(total / minimum).
 *
 * Entries written before marks modes existed carry only questionCount and
 * totalMarks. They are read as UNIFORM_PER_QUESTION with marks per question
 * back-derived from those two, so an already-queued task keeps meaning exactly
 * what it meant when it was submitted.
 */
class MockTestSectionGeometry
{
    /**
     * Marks and totals are floats entered through number inputs, so exact
     * division is not something we can rely on: 20 / 4 can arrive as
     * 4.999999999999999. Every ceil/floor here is nudged by this tolerance so a
     * band that is exactly achievable is never reported as one question short.
     */
    static FLOATING_POINT_TOLERANCE = 0.000001;

    static MINIMUM_QUESTION_COUNT = 1;

    static resolveMarksMode(sectionEntry)
    {
        if (sectionEntry && sectionEntry.marksMode === sectionMarksModes.RANGE_PER_QUESTION)
        {
            return sectionMarksModes.RANGE_PER_QUESTION;
        }
        return sectionMarksModes.UNIFORM_PER_QUESTION;
    }

    static resolveQuestionCountMode(sectionEntry)
    {
        if (sectionEntry && sectionEntry.questionCountMode === sectionQuestionCountModes.RANGE)
        {
            return sectionQuestionCountModes.RANGE;
        }
        return sectionQuestionCountModes.FIXED;
    }

    static isQuestionCountDerived(sectionEntry)
    {
        return MockTestSectionGeometry.resolveMarksMode(sectionEntry) === sectionMarksModes.RANGE_PER_QUESTION;
    }

    static resolveMarksPerQuestion(sectionEntry, fallbackMarksPerQuestion)
    {
        const configuredMarks = sectionEntry ? sectionEntry.marksPerQuestion : null;
        if (typeof configuredMarks === "number" && Number.isFinite(configuredMarks) && configuredMarks > 0)
        {
            return configuredMarks;
        }

        const legacyTotalMarks = sectionEntry ? sectionEntry.totalMarks : null;
        const legacyQuestionCount = sectionEntry ? sectionEntry.questionCount : null;
        if (typeof legacyTotalMarks === "number" && Number.isFinite(legacyTotalMarks) && legacyTotalMarks > 0
            && typeof legacyQuestionCount === "number" && Number.isFinite(legacyQuestionCount) && legacyQuestionCount > 0)
        {
            return legacyTotalMarks / legacyQuestionCount;
        }

        return (typeof fallbackMarksPerQuestion === "number" && Number.isFinite(fallbackMarksPerQuestion) && fallbackMarksPerQuestion > 0)
            ? fallbackMarksPerQuestion
            : 0;
    }

    static resolveMarksPerQuestionBand(sectionEntry)
    {
        const rawMinimum = sectionEntry ? sectionEntry.marksPerQuestionMin : null;
        const rawMaximum = sectionEntry ? sectionEntry.marksPerQuestionMax : null;

        const minimumMarks = (typeof rawMinimum === "number" && Number.isFinite(rawMinimum) && rawMinimum > 0) ? rawMinimum : 0;
        const maximumMarks = (typeof rawMaximum === "number" && Number.isFinite(rawMaximum) && rawMaximum >= minimumMarks) ? rawMaximum : minimumMarks;

        return { minimum: minimumMarks, maximum: maximumMarks };
    }

    static resolveTotalMarksBudget(sectionEntry)
    {
        const configuredTotal = sectionEntry ? sectionEntry.totalMarks : null;
        return (typeof configuredTotal === "number" && Number.isFinite(configuredTotal) && configuredTotal > 0) ? configuredTotal : 0;
    }

    static resolveQuestionCountBand(sectionEntry)
    {
        if (MockTestSectionGeometry.resolveMarksMode(sectionEntry) === sectionMarksModes.RANGE_PER_QUESTION)
        {
            const marksBand = MockTestSectionGeometry.resolveMarksPerQuestionBand(sectionEntry);
            const totalMarksBudget = MockTestSectionGeometry.resolveTotalMarksBudget(sectionEntry);

            if (marksBand.minimum <= 0 || marksBand.maximum <= 0 || totalMarksBudget <= 0)
            {
                return { minimum: 0, maximum: 0 };
            }

            const minimumCount = Math.max(
                MockTestSectionGeometry.MINIMUM_QUESTION_COUNT,
                Math.ceil(totalMarksBudget / marksBand.maximum - MockTestSectionGeometry.FLOATING_POINT_TOLERANCE)
            );
            const maximumCount = Math.floor(totalMarksBudget / marksBand.minimum + MockTestSectionGeometry.FLOATING_POINT_TOLERANCE);

            if (maximumCount < minimumCount)
            {
                return { minimum: 0, maximum: 0 };
            }

            return { minimum: minimumCount, maximum: maximumCount };
        }

        if (MockTestSectionGeometry.resolveQuestionCountMode(sectionEntry) === sectionQuestionCountModes.RANGE)
        {
            const rawMinimum = sectionEntry ? sectionEntry.questionCountMin : null;
            const rawMaximum = sectionEntry ? sectionEntry.questionCountMax : null;

            const minimumCount = (typeof rawMinimum === "number" && Number.isFinite(rawMinimum) && rawMinimum > 0) ? Math.floor(rawMinimum) : 0;
            const maximumCount = (typeof rawMaximum === "number" && Number.isFinite(rawMaximum) && rawMaximum >= minimumCount) ? Math.floor(rawMaximum) : minimumCount;

            return { minimum: minimumCount, maximum: maximumCount };
        }

        const rawCount = sectionEntry ? sectionEntry.questionCount : null;
        const fixedCount = (typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0) ? Math.floor(rawCount) : 0;

        return { minimum: fixedCount, maximum: fixedCount };
    }

    static resolveTotalMarksBand(sectionEntry, fallbackMarksPerQuestion)
    {
        if (MockTestSectionGeometry.resolveMarksMode(sectionEntry) === sectionMarksModes.RANGE_PER_QUESTION)
        {
            const totalMarksBudget = MockTestSectionGeometry.resolveTotalMarksBudget(sectionEntry);
            return { minimum: totalMarksBudget, maximum: totalMarksBudget };
        }

        const marksPerQuestion = MockTestSectionGeometry.resolveMarksPerQuestion(sectionEntry, fallbackMarksPerQuestion);
        const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);

        return {
            minimum: countBand.minimum * marksPerQuestion,
            maximum: countBand.maximum * marksPerQuestion
        };
    }

    static resolveExpectedQuestionCount(sectionEntry)
    {
        const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);

        if (countBand.maximum <= countBand.minimum)
        {
            return countBand.minimum;
        }

        if (MockTestSectionGeometry.resolveMarksMode(sectionEntry) === sectionMarksModes.UNIFORM_PER_QUESTION
            && MockTestSectionGeometry.resolveQuestionCountMode(sectionEntry) === sectionQuestionCountModes.RANGE)
        {
            const configuredWeights = (sectionEntry && sectionEntry.questionCountWeights) || {};
            let weightedTotal = 0;
            let weightSum = 0;

            for (let candidateCount = countBand.minimum; candidateCount <= countBand.maximum; candidateCount++)
            {
                const rawWeight = configuredWeights[String(candidateCount)];
                const candidateWeight = (typeof rawWeight === "number" && Number.isFinite(rawWeight) && rawWeight >= 0) ? rawWeight : 1;
                weightedTotal += candidateCount * candidateWeight;
                weightSum += candidateWeight;
            }

            if (weightSum > 0)
            {
                return Math.round(weightedTotal / weightSum);
            }
        }

        return Math.round((countBand.minimum + countBand.maximum) / 2);
    }

    static describeValidationFailure(sectionEntry, sectionLabel)
    {
        if (!sectionEntry || typeof sectionEntry !== "object")
        {
            return `${sectionLabel}: the section is empty.`;
        }

        const sectionName = typeof sectionEntry.name === "string" ? sectionEntry.name.trim() : "";
        if (sectionName.length === 0)
        {
            return `${sectionLabel}: give the section a name.`;
        }

        if (MockTestSectionGeometry.resolveMarksMode(sectionEntry) === sectionMarksModes.RANGE_PER_QUESTION)
        {
            const marksBand = MockTestSectionGeometry.resolveMarksPerQuestionBand(sectionEntry);
            const totalMarksBudget = MockTestSectionGeometry.resolveTotalMarksBudget(sectionEntry);

            if (marksBand.minimum <= 0)
            {
                return `${sectionLabel}: set the smallest number of marks a question can carry.`;
            }

            if (marksBand.maximum < marksBand.minimum)
            {
                return `${sectionLabel}: the largest marks per question (${marksBand.maximum}) is below the smallest (${marksBand.minimum}).`;
            }

            if (totalMarksBudget <= 0)
            {
                return `${sectionLabel}: set the total marks this section is worth.`;
            }

            const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);
            if (countBand.minimum <= 0 || countBand.maximum < countBand.minimum)
            {
                return `${sectionLabel}: ${MockTestSectionGeometry.formatMarks(totalMarksBudget)} marks cannot be split into questions worth `
                    + `${MockTestSectionGeometry.formatMarks(marksBand.minimum)}-${MockTestSectionGeometry.formatMarks(marksBand.maximum)} marks each. `
                    + "Widen the marks range or change the total.";
            }

            return null;
        }

        const marksPerQuestion = MockTestSectionGeometry.resolveMarksPerQuestion(sectionEntry, 0);
        if (marksPerQuestion <= 0)
        {
            return `${sectionLabel}: set how many marks each question is worth.`;
        }

        if (MockTestSectionGeometry.resolveQuestionCountMode(sectionEntry) === sectionQuestionCountModes.RANGE)
        {
            const rawMinimum = sectionEntry.questionCountMin;
            const rawMaximum = sectionEntry.questionCountMax;

            if (!(typeof rawMinimum === "number" && Number.isFinite(rawMinimum)) || rawMinimum < MockTestSectionGeometry.MINIMUM_QUESTION_COUNT)
            {
                return `${sectionLabel}: the smallest number of questions must be at least ${MockTestSectionGeometry.MINIMUM_QUESTION_COUNT}.`;
            }

            if (!(typeof rawMaximum === "number" && Number.isFinite(rawMaximum)) || rawMaximum < rawMinimum)
            {
                return `${sectionLabel}: the largest number of questions (${rawMaximum}) is below the smallest (${rawMinimum}).`;
            }

            return null;
        }

        const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);
        if (countBand.minimum < MockTestSectionGeometry.MINIMUM_QUESTION_COUNT)
        {
            return `${sectionLabel}: set how many questions the section holds.`;
        }

        return null;
    }

    static describeStructureValidationFailure(sectionStructure, paperQuestionTarget, bPaperQuestionTargetIsManual)
    {
        const sections = Array.isArray(sectionStructure) ? sectionStructure : [];

        if (sections.length === 0)
        {
            return null;
        }

        for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++)
        {
            const sectionFailure = MockTestSectionGeometry.describeValidationFailure(sections[sectionIndex], `Section ${sectionIndex + 1}`);
            if (sectionFailure !== null)
            {
                return sectionFailure;
            }
        }

        if (!bPaperQuestionTargetIsManual)
        {
            return null;
        }

        if (!(typeof paperQuestionTarget === "number" && Number.isFinite(paperQuestionTarget)) || paperQuestionTarget <= 0)
        {
            return null;
        }

        const totalBand = MockTestSectionGeometry.resolveStructureQuestionCountBand(sections);

        if (paperQuestionTarget < totalBand.minimum || paperQuestionTarget > totalBand.maximum)
        {
            const bandDescription = totalBand.minimum === totalBand.maximum
                ? `${totalBand.minimum}`
                : `${totalBand.minimum}-${totalBand.maximum}`;

            return `The sections hold ${bandDescription} question(s) but the paper is set to ${paperQuestionTarget}. `
                + "Change the paper's question count to match, or adjust the sections.";
        }

        return null;
    }

    static resolveStructureQuestionCountBand(sectionStructure)
    {
        const sections = Array.isArray(sectionStructure) ? sectionStructure : [];

        let minimumTotal = 0;
        let maximumTotal = 0;

        for (const sectionEntry of sections)
        {
            const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);
            minimumTotal += countBand.minimum;
            maximumTotal += countBand.maximum;
        }

        return { minimum: minimumTotal, maximum: maximumTotal };
    }

    static resolveStructureTotalMarksBand(sectionStructure, fallbackMarksPerQuestion)
    {
        const sections = Array.isArray(sectionStructure) ? sectionStructure : [];

        let minimumTotal = 0;
        let maximumTotal = 0;

        for (const sectionEntry of sections)
        {
            const marksBand = MockTestSectionGeometry.resolveTotalMarksBand(sectionEntry, fallbackMarksPerQuestion);
            minimumTotal += marksBand.minimum;
            maximumTotal += marksBand.maximum;
        }

        return { minimum: minimumTotal, maximum: maximumTotal };
    }

    static formatMarks(value)
    {
        if (!Number.isFinite(value))
        {
            return "0";
        }
        if (Number.isInteger(value))
        {
            return String(value);
        }
        return String(Math.round(value * 100) / 100);
    }
}

module.exports = MockTestSectionGeometry;
