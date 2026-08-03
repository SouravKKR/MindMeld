/**
 * BrandNameSanitizer
 *
 * Detects and redacts third-party coaching-institute and publisher marks in text
 * that becomes visible beyond the account that authored it.
 *
 * Why this exists. Users upload material from named coaching institutes, and the
 * names travel with it — in deck titles, tags and the original filenames. While
 * that text stays inside the uploading account it is private use and carries no
 * trademark exposure. The moment any of it becomes visible to another user
 * (a share link, an export, a public listing, a marketplace title), the platform
 * is publishing a third party's registered mark in a commercial context, which
 * is a materially different position.
 *
 * The intended posture, deliberately conservative:
 *   - DETECT everywhere, so an operator can see where marks are appearing.
 *   - REDACT only on egress to another tenant. Never rewrite what a user sees of
 *     their own material — mangling someone's own deck title is a bug, not a
 *     safeguard.
 *
 * Nominative use — naming an exam or institute to describe what material is FOR
 * ("prepared for the JEE syllabus") is generally legitimate. This class cannot
 * tell nominative use from implied endorsement, which is why detection is
 * advisory and the caller decides. Do not wire redaction into a path without
 * deciding that publication, not description, is what is happening there.
 */
class BrandNameSanitizer
{
    /**
     * Registered marks of Indian coaching institutes and education publishers
     * whose material is commonly uploaded. Kept as a static member per the
     * repository convention that shared constants belong to their owning class.
     *
     * Only distinctive marks belong here. Generic academic words ("physics",
     * "classes", "academy") would match constantly and make the signal useless.
     */
    static REGISTERED_MARKS =
    [
        "narayana",
        "allen",
        "fiitjee",
        "aakash",
        "byju",
        "byjus",
        "resonance",
        "bansal",
        "vibrant",
        "sri chaitanya",
        "chaitanya",
        "vidyamandir",
        "motion education",
        "unacademy",
        "physics wallah",
        "pw",
        "vedantu",
        "embibe",
        "toppr",
        "cengage",
        "arihant",
        "disha publication",
        "mtg",
        "s chand",
        "pradeep publications",
        "hc verma",
        "dc pandey",
        "op tandon",
        "ms chauhan",
        "rd sharma",
        "ml khanna"
    ];

    static REDACTION_PLACEHOLDER = "[institute]";

    static #compiledPattern = null;

    /**
     * Builds (once) a single alternation matching any registered mark on word
     * boundaries, longest-first so "sri chaitanya" wins over "chaitanya".
     */
    static #getCompiledPattern()
    {
        if (BrandNameSanitizer.#compiledPattern !== null)
        {
            return BrandNameSanitizer.#compiledPattern;
        }

        const marksByLengthDescending = [...BrandNameSanitizer.REGISTERED_MARKS]
            .sort((firstMark, secondMark) => secondMark.length - firstMark.length)
            .map(mark => mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .map(mark => mark.replace(/\s+/g, "\\s+"));

        BrandNameSanitizer.#compiledPattern = new RegExp(`\\b(?:${marksByLengthDescending.join("|")})\\b`, "gi");
        return BrandNameSanitizer.#compiledPattern;
    }

    /**
     * Returns every registered mark found in the text, lowercased and
     * de-duplicated. Empty array when the text is clean or not a string.
     *
     * @param {string} text
     * @return {string[]}
     */
    static findRegisteredMarks(text)
    {
        if (typeof text !== "string" || text.length === 0)
        {
            return [];
        }

        const pattern = BrandNameSanitizer.#getCompiledPattern();
        pattern.lastIndex = 0;

        const matches = text.match(pattern) || [];
        return [...new Set(matches.map(match => match.toLowerCase().replace(/\s+/g, " ")))];
    }

    /**
     * True when the text contains any registered mark.
     * @param {string} text
     * @return {boolean}
     */
    static containsRegisteredMark(text)
    {
        return BrandNameSanitizer.findRegisteredMarks(text).length > 0;
    }

    /**
     * Replaces every registered mark with the redaction placeholder.
     *
     * Use ONLY on egress to another tenant. Returns the input unchanged when it
     * is not a string, so it is safe to apply to optional fields.
     *
     * @param {string} text
     * @return {string}
     */
    static redact(text)
    {
        if (typeof text !== "string" || text.length === 0)
        {
            return text;
        }

        const pattern = BrandNameSanitizer.#getCompiledPattern();
        pattern.lastIndex = 0;

        return text.replace(pattern, BrandNameSanitizer.REDACTION_PLACEHOLDER);
    }
}

module.exports = BrandNameSanitizer;
