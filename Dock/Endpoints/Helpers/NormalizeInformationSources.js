const PageRange = require("../../Globals/Classes/Decorators/PageRange");
const ExtractableInformationSource = require("../../Globals/Classes/Decorators/ExtractableInformationSource");


function isFullDocumentRange(pageRange)
{
    return pageRange.getStartPage() === 0 && pageRange.getEndPage() === 0;
}


function unionRanges(pageRanges)
{
    if (!pageRanges || pageRanges.length === 0)
    {
        return [];
    }

    if (pageRanges.some(isFullDocumentRange))
    {
        return [];
    }

    const sorted = [...pageRanges].sort((firstRange, secondRange) =>
    {
        return firstRange.getStartPage() - secondRange.getStartPage();
    });

    const merged = [];
    let currentStart = sorted[0].getStartPage();
    let currentEnd = sorted[0].getEndPage();

    for (let rangeIndex = 1; rangeIndex < sorted.length; rangeIndex++)
    {
        const nextStart = sorted[rangeIndex].getStartPage();
        const nextEnd = sorted[rangeIndex].getEndPage();

        if (nextStart <= currentEnd + 1)
        {
            currentEnd = Math.max(currentEnd, nextEnd);
        }
        else
        {
            merged.push(new PageRange({startPage: currentStart, endPage: currentEnd}));
            currentStart = nextStart;
            currentEnd = nextEnd;
        }
    }

    merged.push(new PageRange({startPage: currentStart, endPage: currentEnd}));
    return merged;
}


/**
 * Groups multiple ExtractableInformationSource entries with the same underlying
 * informationSource (matched on hash, falling back to id, then name) and unions
 * their pageRanges. Returns a new array of ExtractableInformationSource.
 *
 * Entries without a hash/id/name fingerprint pass through unchanged.
 */
function normalizeInformationSources(extractableSources)
{
    if (!Array.isArray(extractableSources) || extractableSources.length === 0)
    {
        return [];
    }

    const groupsByFingerprint = new Map();
    const ungrouped = [];

    for (const extractableSource of extractableSources)
    {
        const informationSource = extractableSource.getInformationSource();
        if (!informationSource)
        {
            ungrouped.push(extractableSource);
            continue;
        }

        const fingerprint = informationSource.getHash() || informationSource.getId() || informationSource.getName();

        if (!fingerprint)
        {
            ungrouped.push(extractableSource);
            continue;
        }

        if (!groupsByFingerprint.has(fingerprint))
        {
            groupsByFingerprint.set(fingerprint, {
                informationSource: informationSource,
                pageRanges: [],
            });
        }

        const group = groupsByFingerprint.get(fingerprint);
        const sourcePageRanges = extractableSource.getPageRanges() || [];

        if (sourcePageRanges.length === 0)
        {
            group.pageRanges.push(new PageRange({startPage: 0, endPage: 0}));
        }
        else
        {
            for (const pageRange of sourcePageRanges)
            {
                group.pageRanges.push(pageRange);
            }
        }
    }

    const normalized = [];

    for (const group of groupsByFingerprint.values())
    {
        const unionedRanges = unionRanges(group.pageRanges);

        normalized.push(new ExtractableInformationSource({
            informationSource: group.informationSource,
            pageRanges: unionedRanges,
        }));
    }

    return [...normalized, ...ungrouped];
}


module.exports = { normalizeInformationSources, unionRanges };
