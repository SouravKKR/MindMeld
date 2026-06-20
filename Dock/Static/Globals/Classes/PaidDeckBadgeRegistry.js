import { paidDeckFeatureBadges } from "../Enumerations/PaidDeckFeatureBadges.js";

/**
 * PaidDeckBadgeRegistry
 *
 * Single source of truth mapping each PaidDeckFeatureBadges enum value
 * to its display label, icon asset path, and a short helper description.
 *
 * Consumed by:
 *   - PaidDeckEditDialog / PaidDeckUploadDialog (admin badge picker)
 *   - PaidDeckBadgeChip (renders one badge on the details page)
 *   - PaidDeckDetailsPage (iterates selected badges)
 */
class PaidDeckBadgeRegistry
{
    static #ICON_BASE_PATH = "./Globals/Assets/Images/Icons/PaidDeckBadges";

    static #entriesByValue = new Map();

    static
    {
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.VERIFIED_BY_SUBJECT_EXPERT, "Verified by Subject Expert", "VerifiedExpertIcon.svg", "Reviewed and approved by a qualified domain expert.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.CURATED_BY_TEACHERS, "Curated by Teachers", "CuratedByTeachersIcon.svg", "Content selected and organised by classroom teachers.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.PEER_REVIEWED, "Peer Reviewed", "PeerReviewedIcon.svg", "Cross-checked by multiple educators before publication.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_DIAGRAMS, "Includes Diagrams", "DiagramIcon.svg", "Cards and study materials use visual diagrams.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_IMAGES, "Includes Images", "IncludesImagesIcon.svg", "Contains photographs and supporting imagery.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_FORMULA_SHEETS, "Includes Formula Sheets", "FormulaSheetIcon.svg", "Compiled quick-reference formula sheets are bundled in.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_DERIVATIONS, "Includes Derivations", "DerivationsIcon.svg", "Step-by-step derivations are shown for key results.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_FLOWCHARTS, "Includes Flowcharts", "FlowchartIcon.svg", "Process and decision flowcharts are part of the content.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_TABLES, "Includes Tables", "TableIcon.svg", "Comparison and reference tables are provided.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_SOLVED_EXAMPLES, "Includes Solved Examples", "SolvedExamplesIcon.svg", "Worked-out examples accompany every major concept.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_QUICK_REVISION_NOTES, "Includes Quick Revision Notes", "QuickRevisionIcon.svg", "Condensed last-minute revision notes are included.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INCLUDES_TIPS_AND_TRICKS, "Includes Tips and Tricks", "TipsAndTricksIcon.svg", "Shortcut techniques and exam-day tips are highlighted.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.BASED_ON_OFFICIAL_SYLLABUS, "Based on Official Syllabus", "OfficialSyllabusIcon.svg", "Content follows the official prescribed syllabus.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.COVERS_FULL_SYLLABUS, "Covers Full Syllabus", "FullSyllabusIcon.svg", "Every topic in the prescribed syllabus is covered.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.COVERS_PREVIOUS_YEAR_QUESTIONS, "Previous Year Questions", "PreviousYearQuestionsIcon.svg", "Includes problems from past years' question papers.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.EXAM_PATTERN_FOCUSED, "Exam Pattern Focused", "ExamPatternIcon.svg", "Specifically structured around the target exam pattern.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.BEGINNER_FRIENDLY, "Beginner Friendly", "BeginnerFriendlyIcon.svg", "Starts from the basics, no prior knowledge assumed.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.INTERMEDIATE_LEVEL, "Intermediate Level", "IntermediateLevelIcon.svg", "Builds on fundamentals; some background is expected.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.ADVANCED_LEVEL, "Advanced Level", "AdvancedLevelIcon.svg", "Designed for advanced learners and exam toppers.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.CONCEPT_HEAVY, "Concept Heavy", "ConceptHeavyIcon.svg", "Emphasises deep conceptual understanding.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.PROBLEM_SOLVING_FOCUSED, "Problem Solving Focused", "ProblemSolvingIcon.svg", "Centered on numerical and analytical problem solving.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.THEORY_FOCUSED, "Theory Focused", "TheoryFocusedIcon.svg", "Strong on theoretical foundations and explanations.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.PRACTICE_HEAVY, "Practice Heavy", "PracticeHeavyIcon.svg", "Large volume of practice problems and drills.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.UPDATED_FOR_CURRENT_YEAR, "Updated for Current Year", "CurrentYearIcon.svg", "Refreshed to reflect this year's syllabus and pattern.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.REGULARLY_UPDATED, "Regularly Updated", "RegularlyUpdatedIcon.svg", "Updated periodically as new material becomes relevant.");
        PaidDeckBadgeRegistry.#register(paidDeckFeatureBadges.BILINGUAL, "Bilingual", "BilingualIcon.svg", "Available in multiple languages.");
    }

    static #register(badgeValue, label, iconFileName, description)
    {
        PaidDeckBadgeRegistry.#entriesByValue.set(badgeValue,
        {
            value: badgeValue,
            label: label,
            iconPath: `${PaidDeckBadgeRegistry.#ICON_BASE_PATH}/${iconFileName}`,
            description: description
        });
    }

    static getMetadata(badgeValue)
    {
        const numericValue = typeof badgeValue === "string" ? Number(badgeValue) : badgeValue;
        return PaidDeckBadgeRegistry.#entriesByValue.get(numericValue) || null;
    }

    static getAll()
    {
        return Array.from(PaidDeckBadgeRegistry.#entriesByValue.values());
    }

    static isValidBadgeValue(badgeValue)
    {
        const numericValue = typeof badgeValue === "string" ? Number(badgeValue) : badgeValue;
        return PaidDeckBadgeRegistry.#entriesByValue.has(numericValue);
    }
}

export default PaidDeckBadgeRegistry;
