"""
BannedTermLexicon

Owns the vendored LDNOOBW word list and turns it into ONE compiled regular
expression, built once per process and memoised on the class. Every scan the
content guardrail performs is a single pass of that expression, so this is the
file that decides both what counts as a hit and how much CPU the guardrail costs.

Why a trie rather than a plain alternation. `term1|term2|...|term333` makes the
regex engine retry every branch that shares a first character at every candidate
position, and "s" alone starts about forty entries. Collapsing the terms into a
character trie first turns that into a single walk down a shared-prefix tree, so
the cost stops scaling with how many terms happen to begin with the same letter.

Why two patterns. Case-insensitive matching is not free: Python re-checks the
case folding of every candidate character, and on this pattern that alone costs
2.2x. Lowercasing the text once and matching a case-sensitive pattern is far
cheaper — but only sound while the lowercase mapping is length-preserving, since
every offset produced here is used to slice the ORIGINAL string. Unicode has no
lowercase contractions, so equal lengths imply a 1:1 character mapping; the
scanner compares lengths and falls back to the IGNORECASE pattern on the rare
string (U+0130, capital I with dot above) that expands.

Measured over a 57 KB response, one pass:

    naive alternation + IGNORECASE      31.7 ms      <- the obvious implementation
    trie              + IGNORECASE       4.0 ms
    trie              + lowercased       1.9 ms      <- what this ships (17x)

Why lookarounds rather than \\b. `(?<!\\w)term(?!\\w)` and `\\bterm\\b` agree for
terms made only of word characters, but not for entries that begin or end with a
symbol — LDNOOBW ships `s&m` and a raised-middle-finger emoji. The lookaround form
also states the actual intent: the term must not be glued to a longer word. This
is what keeps `shit` out of `shitake`, `cunt` out of `Scunthorpe`, `anal` out of
`analysis`, `porn` out of `pornography` and `paki` out of `Pakistan`, with no
special-casing anywhere.

Deliberately absent: stemming, fuzzy matching, and leetspeak normalisation. The
upstream list already carries the inflections that matter (`bitch` and `bitches`
are both entries), and every one of those techniques buys marginal recall in
exchange for exactly the false-positive class this file exists to avoid.
"""

import os
import re


class BannedTermLexicon:

    # Where the vendored list lives, relative to the Agent root. The file name
    # carries the upstream commit, so the glob is on a prefix — see
    # Agent/ThirdParty/Ldnoobw/README.md, which requires the previous generation
    # to be deleted on upgrade so this can never merge two versions of the list.
    WORD_LIST_DIRECTORY_RELATIVE_PATH = os.path.join("ThirdParty", "Ldnoobw")
    WORD_LIST_FILE_NAME_PREFIX = "en-"
    WORD_LIST_FILE_NAME_SUFFIX = ".txt"

    # Our own subtractions, kept beside this class rather than inside the
    # vendored directory so the third-party bytes stay byte-identical to upstream.
    ALLOWLIST_FILE_NAME = "AcademicTermAllowlist.txt"

    # Stand-in for a space while the trie is being built. A term is a sequence of
    # characters as far as the trie is concerned, but a space in a multi-word
    # entry has to become a flexible separator in the final pattern. Substituting
    # a character that cannot occur in the list, then replacing it once the
    # pattern string exists, keeps the trie a plain character trie.
    SPACE_PLACEHOLDER_CHARACTER = "\x00"

    # What a space in a multi-word entry is allowed to match. Line wrapping and
    # hyphenation are normal in generated HTML, so "hand job" has to be found
    # across a newline or a hyphen too.
    SPACE_REPLACEMENT_PATTERN = r"[\s\-]+"

    __cached_pattern_source = None
    __cached_lowercase_pattern = None
    __cached_case_insensitive_pattern = None
    __cached_active_term_count = 0
    __cached_allowlisted_term_count = 0
    __cached_maximum_term_length = 0
    __cached_b_included_clinical_terms = None

    @staticmethod
    def is_clinical_term_inclusion_enabled() -> bool:
        # Off by default: the allowlist is applied and the clinical/academic
        # entries never match. Turning this on scans the full upstream list and
        # sends every "sex", "rape" and "xx" to the verification model.
        return (os.getenv("CONTENT_GUARDRAIL_INCLUDE_CLINICAL_TERMS") or "").strip().lower() in ("1", "true", "yes")

    @staticmethod
    def get_lowercase_pattern() -> re.Pattern | None:
        """
        The primary scanner. MUST be applied to text that has already been
        lowercased — the terms are lowercase and this pattern carries no
        IGNORECASE flag. ContentGuardrailScanner owns that contract.

        Returns None when the word list is missing or empty. That is treated as
        "scan nothing" rather than an error: a packaging mistake must not take
        down every generation running on the box.

        Compiled once per process. The rebuild check on the clinical-terms flag
        exists for the verification harness, which flips the environment variable
        between assertions; in a worker the flag never changes and the branch is
        a single comparison.
        """
        BannedTermLexicon.__ensure_pattern_source()

        if BannedTermLexicon.__cached_pattern_source is None:
            return None

        if BannedTermLexicon.__cached_lowercase_pattern is None:
            BannedTermLexicon.__cached_lowercase_pattern = BannedTermLexicon.__compile(
                BannedTermLexicon.__cached_pattern_source,
                re.UNICODE,
            )

        return BannedTermLexicon.__cached_lowercase_pattern

    @staticmethod
    def get_case_insensitive_pattern() -> re.Pattern | None:
        """
        The fallback scanner, applied to the ORIGINAL text when lowercasing it
        would shift character offsets. Compiled lazily because the strings that
        need it are vanishingly rare, so the usual process never pays for it.
        """
        BannedTermLexicon.__ensure_pattern_source()

        if BannedTermLexicon.__cached_pattern_source is None:
            return None

        if BannedTermLexicon.__cached_case_insensitive_pattern is None:
            BannedTermLexicon.__cached_case_insensitive_pattern = BannedTermLexicon.__compile(
                BannedTermLexicon.__cached_pattern_source,
                re.IGNORECASE | re.UNICODE,
            )

        return BannedTermLexicon.__cached_case_insensitive_pattern

    @staticmethod
    def get_maximum_term_length() -> int:
        """
        The character length of the longest active term, in the text as written.
        A multi-word entry is measured with one character per separator, and the
        separator can match a run (`[\\s\\-]+`), so this is a lower bound on how
        wide a match can be. StreamingContentGuardrail adds its own margin.

        It exists so the streaming path can guarantee no banned term straddles a
        release point: hold back at least this many characters and any term that
        crosses the cut is still wholly inside the buffer that was scanned.
        """
        BannedTermLexicon.__ensure_pattern_source()
        return BannedTermLexicon.__cached_maximum_term_length

    @staticmethod
    def get_active_term_count() -> int:
        BannedTermLexicon.__ensure_pattern_source()
        return BannedTermLexicon.__cached_active_term_count

    @staticmethod
    def get_allowlisted_term_count() -> int:
        BannedTermLexicon.__ensure_pattern_source()
        return BannedTermLexicon.__cached_allowlisted_term_count

    @staticmethod
    def reset_cache() -> None:
        # Only the verification harness calls this, so a changed environment
        # variable or a rewritten fixture list forces a rebuild.
        BannedTermLexicon.__cached_pattern_source = None
        BannedTermLexicon.__cached_lowercase_pattern = None
        BannedTermLexicon.__cached_case_insensitive_pattern = None
        BannedTermLexicon.__cached_b_included_clinical_terms = None

    @staticmethod
    def __ensure_pattern_source() -> None:
        b_include_clinical_terms = BannedTermLexicon.is_clinical_term_inclusion_enabled()

        if BannedTermLexicon.__cached_b_included_clinical_terms != b_include_clinical_terms:
            BannedTermLexicon.reset_cache()

        if BannedTermLexicon.__cached_b_included_clinical_terms is not None:
            return

        banned_terms = BannedTermLexicon.__read_word_list()
        allowlisted_terms = set() if b_include_clinical_terms else BannedTermLexicon.__read_allowlist()

        active_terms = sorted(term for term in banned_terms if term not in allowlisted_terms)

        BannedTermLexicon.__cached_active_term_count = len(active_terms)
        BannedTermLexicon.__cached_allowlisted_term_count = len(allowlisted_terms)
        BannedTermLexicon.__cached_maximum_term_length = max((len(term) for term in active_terms), default = 0)
        BannedTermLexicon.__cached_b_included_clinical_terms = b_include_clinical_terms

        if not active_terms:
            print("[BannedTermLexicon] No active terms - the guardrail scan will match nothing.")
            BannedTermLexicon.__cached_pattern_source = None
            return

        BannedTermLexicon.__cached_pattern_source = BannedTermLexicon.__build_pattern_source(active_terms)

        print(
            f"[BannedTermLexicon] Built scanner over {len(active_terms)} active term(s), "
            f"{len(allowlisted_terms)} allowlisted."
        )

    @staticmethod
    def __compile(pattern_source: str, flags: int) -> re.Pattern | None:
        try:
            return re.compile(pattern_source, flags)
        except re.error as compile_error:
            print(f"[BannedTermLexicon] Failed to compile the scanner: {compile_error}")
            return None

    @staticmethod
    def __get_agent_root_directory() -> str:
        # This file is Agent/Globals/Classes/Compliance/BannedTermLexicon.py, so
        # the Agent root is three directories up from its own folder. Matches the
        # anchoring idiom used by StreamAskAiResponse.py and GeneratePaidDeckField.py.
        return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))

    @staticmethod
    def __read_word_list() -> set[str]:
        word_list_directory = os.path.join(
            BannedTermLexicon.__get_agent_root_directory(),
            BannedTermLexicon.WORD_LIST_DIRECTORY_RELATIVE_PATH,
        )

        if not os.path.isdir(word_list_directory):
            print(f"[BannedTermLexicon] Word list directory missing at {word_list_directory} - guardrail disabled.")
            return set()

        collected_terms = set()

        try:
            file_names = sorted(os.listdir(word_list_directory))
        except Exception as listing_error:
            # Callers document that scanning never raises, so an unreadable
            # directory degrades to "no terms" rather than propagating.
            print(f"[BannedTermLexicon] Could not list {word_list_directory}: {listing_error}")
            return set()

        for file_name in file_names:
            if not file_name.startswith(BannedTermLexicon.WORD_LIST_FILE_NAME_PREFIX):
                continue
            if not file_name.endswith(BannedTermLexicon.WORD_LIST_FILE_NAME_SUFFIX):
                continue
            collected_terms.update(BannedTermLexicon.__read_terms_from_file(os.path.join(word_list_directory, file_name)))

        if not collected_terms:
            print(f"[BannedTermLexicon] No word list file matched in {word_list_directory} - guardrail disabled.")

        return collected_terms

    @staticmethod
    def __read_allowlist() -> set[str]:
        allowlist_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), BannedTermLexicon.ALLOWLIST_FILE_NAME)

        if not os.path.exists(allowlist_path):
            # A missing allowlist is safe in the strict direction — every term
            # stays active and the verification model absorbs the extra calls.
            print(f"[BannedTermLexicon] Allowlist missing at {allowlist_path} - scanning the full list.")
            return set()

        return BannedTermLexicon.__read_terms_from_file(allowlist_path)

    @staticmethod
    def __read_terms_from_file(file_path: str) -> set[str]:
        collected_terms = set()

        try:
            with open(file_path, "r", encoding = "utf-8") as term_file:
                for raw_line in term_file:
                    term = raw_line.strip().lower()
                    if not term or term.startswith("#"):
                        continue
                    # Collapse any internal whitespace run to a single space so a
                    # term and its allowlist entry compare equal regardless of how
                    # either file was written.
                    collected_terms.add(re.sub(r"\s+", " ", term))
        except Exception as read_error:
            print(f"[BannedTermLexicon] Failed to read {file_path}: {read_error}")
            return set()

        return collected_terms

    @staticmethod
    def __build_pattern_source(active_terms: list[str]) -> str | None:
        """
        Builds the scanner's pattern string, compiled later under whichever flags
        the caller needs. Terms are split into two groups because they need
        different boundary rules:

          - Terms containing at least one word character get the
            (?<!\\w) ... (?!\\w) anchoring that stops substring matches.
          - Terms made entirely of symbols (the emoji) get no anchoring at all;
            requiring a non-word character on either side would make them
            unmatchable next to a letter, which is the opposite of the intent.
        """
        word_character_terms = []
        symbol_only_terms = []

        for term in active_terms:
            if re.search(r"\w", term, re.UNICODE):
                word_character_terms.append(term.replace(" ", BannedTermLexicon.SPACE_PLACEHOLDER_CHARACTER))
            else:
                symbol_only_terms.append(term)

        alternation_fragments = []

        if word_character_terms:
            anchored_body = BannedTermLexicon.__build_trie_pattern(word_character_terms)
            alternation_fragments.append(rf"(?<!\w)(?:{anchored_body})(?!\w)")

        if symbol_only_terms:
            symbol_body = BannedTermLexicon.__build_trie_pattern(symbol_only_terms)
            alternation_fragments.append(rf"(?:{symbol_body})")

        if not alternation_fragments:
            return None

        pattern_source = "|".join(alternation_fragments)

        return pattern_source.replace(
            BannedTermLexicon.SPACE_PLACEHOLDER_CHARACTER,
            BannedTermLexicon.SPACE_REPLACEMENT_PATTERN,
        )

    @staticmethod
    def __build_trie_pattern(terms: list[str]) -> str:
        trie_root = {}

        for term in terms:
            current_node = trie_root
            for character in term:
                current_node = current_node.setdefault(character, {})
            # Empty-string key marks "a term ends here".
            current_node[""] = {}

        return BannedTermLexicon.__render_trie_node(trie_root)

    @staticmethod
    def __render_trie_node(trie_node: dict) -> str | None:
        """
        Renders one trie level to a regex fragment, or None when the level is a
        pure terminal (nothing follows). Single-character dead ends are gathered
        into a character class so `cock`/`cocks` becomes `cocks?` rather than
        `cock|cocks`.
        """
        if len(trie_node) == 1 and "" in trie_node:
            return None

        alternatives = []
        single_character_endings = []
        b_term_ends_here = "" in trie_node

        for character in sorted(character for character in trie_node if character != ""):
            child_fragment = BannedTermLexicon.__render_trie_node(trie_node[character])
            escaped_character = re.escape(character)

            # The space placeholder becomes a multi-character pattern later, so it
            # can never be folded into a character class — [ ... ] around
            # [\s\-]+ would nest brackets and break the compile.
            b_can_join_character_class = (
                child_fragment is None
                and character != BannedTermLexicon.SPACE_PLACEHOLDER_CHARACTER
            )

            if b_can_join_character_class:
                single_character_endings.append(escaped_character)
            elif child_fragment is None:
                alternatives.append(escaped_character)
            else:
                alternatives.append(escaped_character + child_fragment)

        if len(single_character_endings) == 1:
            alternatives.append(single_character_endings[0])
        elif len(single_character_endings) > 1:
            alternatives.append("[" + "".join(single_character_endings) + "]")

        if len(alternatives) == 1:
            rendered = alternatives[0]
            # A bare character class is already an atom; anything longer needs
            # grouping before an optional-suffix marker can apply to all of it.
            b_needs_group = not (rendered.startswith("[") and rendered.endswith("]")) and len(rendered) > 1
            if b_term_ends_here:
                return f"(?:{rendered})?" if b_needs_group else f"{rendered}?"
            return f"(?:{rendered})" if b_needs_group else rendered

        joined = "|".join(alternatives)

        # The group is greedy, so a longer continuation is always attempted
        # before the "term ends here" branch. Combined with the trailing (?!\w)
        # that makes `cumshots` match the longer entry rather than stopping at
        # `cumshot` and failing the boundary check.
        return f"(?:{joined})?" if b_term_ends_here else f"(?:{joined})"
