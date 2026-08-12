from Globals.Enumerations.SourceUsageModes import SourceUsageModes


class SourceUsageSelector:
    """
    What a declared paid-deck source may be used for, on the Agent side.

    THIS MIRRORS Dock/Globals/Classes/PaidDeck/SourceUsageGate.js AND DOES NOT
    REPLACE IT. Dock decides what a run is allowed to do with a document, refuses
    the request when the licence does not support it, and stamps the resulting
    usageMode onto the stored row. By the time the Agent reads that row the
    decision has already been made and evidenced. What is needed here is the much
    smaller question of which stage reads which row — so this class carries the
    partition and the wording, and none of the licence rules. Duplicating those
    would create a second place able to disagree with the gate about what is
    permitted, and the disagreement would be silent.

    THE TWO PREDICATES ARE NOT OPPOSITES. A source can be both, or either, and
    the defaults deliberately differ: an unreadable or absent mode is NOT content
    but IS verification. That asymmetry is the same one the gate keeps, for the
    same reason — a row written before the field existed was attached to be
    checked against, and guessing "content" from a malformed value would mean
    generating sellable material on the strength of a field nobody can read.
    """

    CONTENT_BEARING_USAGE_MODES = frozenset({
        SourceUsageModes.CONTENT_AND_VERIFICATION,
        SourceUsageModes.CONTENT_ONLY,
    })

    VERIFICATION_ONLY_PHRASE = "Read for verification only; not an input to generation."

    CONTENT_AND_VERIFICATION_PHRASE = (
        "Also a licensed input to generation: topics it covers were written from its passages under the "
        "declared licence, and section 1c of the audit report names which."
    )

    CONTENT_ONLY_PHRASE = (
        "A licensed input to generation only; deliberately not used to check the deck, so nothing below "
        "was checked against it."
    )

    @staticmethod
    def normalise_usage_mode(usage_mode):
        """
        The stored value as a known enumeration member, or VERIFICATION_ONLY.

        Tolerant on purpose. A row may carry no usageMode at all (written before
        the field existed), a value this build does not know (written by a newer
        Dock during a staggered deploy), or something malformed. All of them fail
        closed to the narrowest mode rather than raising, because a verification
        pass that crashes on one odd row checks nothing at all.
        """
        if isinstance(usage_mode, SourceUsageModes):
            return usage_mode

        if isinstance(usage_mode, bool) or not isinstance(usage_mode, int):
            return SourceUsageModes.VERIFICATION_ONLY

        try:
            return SourceUsageModes(usage_mode)
        except ValueError:
            return SourceUsageModes.VERIFICATION_ONLY

    @staticmethod
    def is_content_usage(usage_mode) -> bool:
        """True when the deck's content may be WRITTEN from the source."""
        return SourceUsageSelector.normalise_usage_mode(usage_mode) in SourceUsageSelector.CONTENT_BEARING_USAGE_MODES

    @staticmethod
    def is_verification_usage(usage_mode) -> bool:
        """True when the finished deck is CHECKED AGAINST the source."""
        return SourceUsageSelector.normalise_usage_mode(usage_mode) != SourceUsageModes.CONTENT_ONLY

    @staticmethod
    def build_verification_source_filter() -> dict:
        """
        The Mongo fragment selecting the rows a verification pass may read.

        WHY $nin AND NOT AN EXPLICIT ALLOW-LIST. A legacy row has no usageMode
        field at all, and in Mongo a missing field compares as null — so it
        matches this exclusion and is included, which is exactly what
        is_verification_usage says about it. An allow-list of {0, 1} would
        silently drop every one of those rows and quietly stop checking older
        decks against the documents they were attached to. A value this build
        does not recognise is likewise included, which is the same fail-open
        direction: an unreadable mode may broaden what a deck is checked against,
        never what it is written from.

        Returned as a fragment rather than written inline at the call site so the
        rule can be asserted by the offline harness, which has no database.
        """
        return {"usageMode": {"$nin": [int(SourceUsageModes.CONTENT_ONLY)]}}

    @staticmethod
    def describe_usage(usage_mode) -> str:
        """
        The sentence the action log records about how a source was read.

        Kept beside the predicates because the wording is a claim about what the
        pipeline did, and a claim that drifts from the partition above is worse
        than no claim: the audit report is read by people checking exactly this.
        """
        normalised_usage_mode = SourceUsageSelector.normalise_usage_mode(usage_mode)

        if normalised_usage_mode == SourceUsageModes.CONTENT_AND_VERIFICATION:
            return SourceUsageSelector.CONTENT_AND_VERIFICATION_PHRASE

        if normalised_usage_mode == SourceUsageModes.CONTENT_ONLY:
            return SourceUsageSelector.CONTENT_ONLY_PHRASE

        return SourceUsageSelector.VERIFICATION_ONLY_PHRASE
