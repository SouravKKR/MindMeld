/**
 * CredentialScrubber — removes the things people type into a "what went wrong"
 * box that nobody should ever have stored.
 *
 * ── Why this exists on the report path specifically ─────────────────────────
 *
 * An account-access report is the one report type whose reporter is describing
 * a credential failure, and people describe those literally: "my password
 * Hunter2 stopped working", "the code it sent me was 483920". The unauthenticated
 * form makes that far more likely, because the person filling it in is not
 * signed in and is thinking about exactly one thing.
 *
 * What happens to that text afterwards is what makes it worth scrubbing: it is
 * embedded by a model for duplicate detection, stored beside every other
 * report, and read by whichever administrator picks the ticket up. None of
 * those needed the password, and all of them are places it should not be.
 *
 * ── This is a mitigation, not a filter ─────────────────────────────────────
 *
 * It is deliberately CHEAP: a handful of patterns for the shapes credentials
 * actually take in a sentence. It will not catch a password typed on its own
 * line with no label, and it is not trying to — a thorough scrubber would need
 * to guess which words are secret, and every wrong guess silently destroys part
 * of a report someone needs read. Removing the obvious cases is a real
 * reduction in exposure; pretending to remove all of them would not be.
 *
 * Replacement, not deletion: the administrator should be able to see that
 * something was said and taken out, rather than read a sentence that has
 * quietly changed meaning.
 */
class CredentialScrubber
{
    static REDACTION_MARKER = "[redacted]";

    /**
     * The labelled forms. Each matches a word that announces a secret, an
     * optional connector, and then the value — bounded to one whitespace-free
     * run so the pattern cannot swallow the rest of the sentence.
     */
    static LABELLED_SECRET_PATTERNS =
    [
        /\b(pass(?:word|phrase|wd|code)?|pwd)\b\s*(?:is|was|=|:|-)?\s*["']?([^\s"']{3,128})["']?/gi,
        /\b(otp|one[-\s]?time\s+(?:code|password|pin)|verification\s+code|security\s+code|auth(?:entication)?\s+code)\b\s*(?:is|was|=|:|-)?\s*["']?([A-Za-z0-9]{4,12})["']?/gi,
        /\b(pin)\b\s*(?:is|was|=|:|-)?\s*["']?(\d{4,12})["']?/gi,
        /\b(api[-\s]?key|access[-\s]?token|bearer|secret|session\s*id|cookie)\b\s*(?:is|was|=|:|-)?\s*["']?([^\s"']{8,256})["']?/gi
    ];

    /**
     * A bare six-digit run, which in this context is almost always the sign-in
     * code the reporter was sent. Kept separate from the labelled patterns
     * because it is the one rule that fires without a label and therefore the
     * one most likely to be wrong — it deliberately does not match longer digit
     * runs, so order numbers, amounts and phone numbers pass through.
     */
    static BARE_SIX_DIGIT_CODE_PATTERN = /(?<![\d-])\d{6}(?![\d-])/g;

    /**
     * @param {string} rawText
     * @returns {string}
     */
    static scrub(rawText)
    {
        let scrubbedText = String(rawText ?? "");

        for (const secretPattern of CredentialScrubber.LABELLED_SECRET_PATTERNS)
        {
            // The label is kept and only the value replaced, so "my password
            // [redacted] stopped working" still reads as the sentence it was —
            // which is the half of it the administrator actually needs.
            scrubbedText = scrubbedText.replace(secretPattern, (wholeMatch, labelText) => `${labelText} ${CredentialScrubber.REDACTION_MARKER}`);
        }

        scrubbedText = scrubbedText.replace(CredentialScrubber.BARE_SIX_DIGIT_CODE_PATTERN, CredentialScrubber.REDACTION_MARKER);

        return scrubbedText;
    }

    /**
     * True when scrubbing would change the text. Lets the client warn the
     * reporter before they submit rather than silently altering what they wrote.
     *
     * @param {string} rawText
     * @returns {boolean}
     */
    static containsCredential(rawText)
    {
        return CredentialScrubber.scrub(rawText) !== String(rawText ?? "");
    }
}

module.exports = CredentialScrubber;
