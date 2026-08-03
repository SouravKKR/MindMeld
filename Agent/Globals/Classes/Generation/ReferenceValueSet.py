import re


class ReferenceValueSet:
    """
    A small, deliberately narrow set of physical constants and standard values,
    checked in CODE rather than by a model.

    Why this exists alongside the LLM verification pass. One model checking
    another shares its failure modes: the same tokenizer, the same training data,
    the same confident-and-wrong failure on a digit. For the handful of values
    where being wrong is both most likely and most damaging — a constant a
    student memorises and then uses in every calculation for a year — a real,
    deterministic comparison is worth more than a second opinion.

    Why it stays narrow. The value of this check is that it is exhaustive within
    its scope and never fires spuriously. Growing it into a general fact-checker
    would mean tolerance tuning, unit inference and context sensitivity, and the
    first false positive on a legitimate approximation would train reviewers to
    ignore the whole category. Add entries only when the constant is standard,
    unambiguous, and genuinely likely to appear.

    Deliberate non-goals: this does NOT check formulae (a formula has too many
    valid equivalent forms), definitions (wording varies legitimately), or
    derived results (they depend on the problem). Those are the LLM pass's job.
    """

    # (canonical name, accepted value, unit, relative tolerance, matching patterns)
    #
    # Tolerance is RELATIVE and generous enough to accept the rounded forms a
    # syllabus legitimately teaches (g = 9.8 as well as 9.81), while still
    # catching a transposed digit or a wrong exponent — which is the actual
    # failure mode being guarded against.
    REFERENCE_VALUES = [
        {
            "name": "Speed of light in vacuum",
            "value": 2.99792458e8,
            "unit": "m/s",
            "relativeTolerance": 0.01,
            "patterns": [r"speed of light", r"\bc\s*=\s*3", r"\bc\s*≈\s*3"],
        },
        {
            "name": "Standard acceleration due to gravity",
            "value": 9.80665,
            "unit": "m/s^2",
            "relativeTolerance": 0.03,
            "patterns": [r"acceleration due to gravity", r"\bg\s*=\s*9", r"gravitational acceleration"],
        },
        {
            "name": "Planck constant",
            "value": 6.62607015e-34,
            "unit": "J s",
            "relativeTolerance": 0.01,
            "patterns": [r"planck(?:'s)? constant", r"\bh\s*=\s*6\.6"],
        },
        {
            "name": "Elementary charge",
            "value": 1.602176634e-19,
            "unit": "C",
            "relativeTolerance": 0.01,
            "patterns": [r"elementary charge", r"charge (?:of|on) (?:an? )?electron", r"\be\s*=\s*1\.6"],
        },
        {
            "name": "Avogadro constant",
            "value": 6.02214076e23,
            "unit": "1/mol",
            "relativeTolerance": 0.01,
            "patterns": [r"avogadro", r"N_?A\s*=\s*6\.0"],
        },
        {
            "name": "Molar gas constant",
            "value": 8.314462618,
            "unit": "J/(mol K)",
            "relativeTolerance": 0.01,
            "patterns": [r"(?:universal |molar )?gas constant", r"\bR\s*=\s*8\.3"],
        },
        {
            "name": "Boltzmann constant",
            "value": 1.380649e-23,
            "unit": "J/K",
            "relativeTolerance": 0.01,
            "patterns": [r"boltzmann", r"k_?B\s*=\s*1\.38"],
        },
        {
            "name": "Electron rest mass",
            "value": 9.1093837015e-31,
            "unit": "kg",
            "relativeTolerance": 0.01,
            "patterns": [r"(?:rest )?mass of (?:an? )?electron", r"m_?e\s*=\s*9\.1"],
        },
        {
            "name": "Proton rest mass",
            "value": 1.67262192369e-27,
            "unit": "kg",
            "relativeTolerance": 0.01,
            "patterns": [r"(?:rest )?mass of (?:a )?proton", r"m_?p\s*=\s*1\.67"],
        },
        {
            "name": "Faraday constant",
            "value": 96485.33212,
            "unit": "C/mol",
            "relativeTolerance": 0.01,
            "patterns": [r"faraday constant", r"\bF\s*=\s*96"],
        },
        {
            "name": "Standard molar volume of an ideal gas at STP",
            "value": 22.414,
            "unit": "L/mol",
            "relativeTolerance": 0.02,
            "patterns": [r"molar volume", r"22\.4\s*(?:L|litre|liter|dm)"],
        },
        {
            "name": "Atomic mass of carbon-12",
            "value": 12.0,
            "unit": "u",
            "relativeTolerance": 0.001,
            "patterns": [r"carbon-?12", r"atomic mass unit"],
        },
        {
            "name": "Relative atomic mass of hydrogen",
            "value": 1.008,
            "unit": "u",
            "relativeTolerance": 0.02,
            "patterns": [r"atomic mass of hydrogen", r"relative atomic mass of hydrogen"],
        },
        {
            "name": "Relative atomic mass of oxygen",
            "value": 15.999,
            "unit": "u",
            "relativeTolerance": 0.02,
            "patterns": [r"atomic mass of oxygen", r"relative atomic mass of oxygen"],
        },
    ]

    # Numbers written in ordinary or scientific notation, including the "x 10^n"
    # and "× 10⁻³⁴" forms a generated passage actually uses.
    __NUMBER_PATTERN = re.compile(
        r"(-?\d+(?:[.,]\d+)?)\s*(?:[x×*]\s*10\s*(?:\^|\*\*|<sup>)?\s*(-?\d+)|[eE]\s*(-?\d+))?"
    )

    # Characters that appear inside a numeric literal in generated HTML and would
    # otherwise split one number into two.
    __SUPERSCRIPT_TRANSLATION = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁻", "0123456789-")

    @staticmethod
    def check_text(text: str) -> list:
        """
        Returns a list of mismatch dicts for every reference value that the text
        mentions by name AND states a number for that disagrees with the accepted
        value beyond tolerance.

        Both conditions are required. A passage that names a constant without
        quoting a value is not a mismatch, and a number that happens to appear
        near unrelated prose is not either — the pattern has to match and a
        candidate number has to be present in the same sentence.

        Returns an empty list for empty input, and never raises: a checker that
        can fail a generation run over its own regex is worse than no checker.
        """
        if not text:
            return []

        try:
            return ReferenceValueSet.__check_text_internal(text)
        except Exception as check_error:
            print(f"[ReferenceValueSet] Check failed ({check_error}) — reporting no mismatches.")
            return []

    @staticmethod
    def __check_text_internal(text: str) -> list:
        plain_text = re.sub(r"<[^>]+>", " ", text)
        plain_text = plain_text.translate(ReferenceValueSet.__SUPERSCRIPT_TRANSLATION)

        # Sentence-level scope. A constant's name and its value appear together;
        # checking document-wide would pair a name in one paragraph with an
        # unrelated number in another and fire constantly.
        sentences = re.split(r"(?<=[.;:!?])\s+|\n+", plain_text)

        mismatches = []

        for reference_value in ReferenceValueSet.REFERENCE_VALUES:
            for sentence in sentences:
                lowered_sentence = sentence.lower()

                if not any(re.search(pattern, lowered_sentence) for pattern in reference_value["patterns"]):
                    continue

                candidate_numbers = ReferenceValueSet.__extract_numbers(sentence)
                if not candidate_numbers:
                    continue

                # Accept the sentence if ANY number in it matches. A worked
                # example legitimately contains other numbers alongside the
                # constant, so requiring every number to match would fire on
                # correct content.
                if any(
                    ReferenceValueSet.__is_within_tolerance(candidate, reference_value)
                    for candidate in candidate_numbers
                ):
                    continue

                mismatches.append({
                    "name": reference_value["name"],
                    "acceptedValue": reference_value["value"],
                    "unit": reference_value["unit"],
                    "statedNumbers": candidate_numbers[:6],
                    "sentence": sentence.strip()[:300],
                })
                break

        return mismatches

    @staticmethod
    def __extract_numbers(sentence: str) -> list:
        extracted_numbers = []

        for match in ReferenceValueSet.__NUMBER_PATTERN.finditer(sentence):
            mantissa_text = match.group(1).replace(",", "")
            try:
                mantissa = float(mantissa_text)
            except ValueError:
                continue

            exponent_text = match.group(2) or match.group(3)
            if exponent_text:
                try:
                    mantissa *= 10 ** int(exponent_text)
                except (ValueError, OverflowError):
                    continue

            extracted_numbers.append(mantissa)

        return extracted_numbers

    @staticmethod
    def __is_within_tolerance(candidate: float, reference_value: dict) -> bool:
        accepted = reference_value["value"]
        if accepted == 0:
            return candidate == 0
        return abs(candidate - accepted) / abs(accepted) <= reference_value["relativeTolerance"]
