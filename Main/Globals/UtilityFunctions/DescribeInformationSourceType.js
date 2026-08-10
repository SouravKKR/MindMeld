import { enumerationToTitleCase } from "./EnumerationToTitleCase.js";

// Display names for information-source types whose enumeration key does not,
// on its own, say what the type is for.
//
// QUESTION_PAPER title-cases to "Question Paper", which reads as "a past exam
// paper" and hides the fact that an ordinary mock test is the same input —
// GenerateMockTests extracts both into one seed pool and rephrases from it. The
// enumeration key stays QUESTION_PAPER, because renaming it would rewrite
// stored rows for what is only a wording change; the label alone moves.
//
// This lives in its own module rather than on InformationSourceSelector so that
// InformationSourceExistingSelector can use it too. The two components already
// reach each other through the uploader, and importing the selector from the
// existing-selector would close that loop.
const INFORMATION_SOURCE_TYPE_LABEL_OVERRIDES =
{
    QUESTION_PAPER: "Question Paper / Mock Test"
};

// The label shown for one informationSourceTypes key. Anything without an
// override falls through to enumerationToTitleCase, so the map above stays a
// short list of exceptions rather than a second copy of the enumeration.
export function describeInformationSourceType(sourceTypeKey)
{
    return INFORMATION_SOURCE_TYPE_LABEL_OVERRIDES[sourceTypeKey]
        || enumerationToTitleCase(sourceTypeKey);
}
