class SolvingStepsDirective:
    """
    Generates the prompt block that tells the LLM whether to include a
    `solvingSteps` field on every question or to leave it blank. The
    directive replaces the `{show_solving_steps_block}` placeholder in
    both the fresh-generation and rephrase mock-test prompts.

    Centralised here so the wording stays consistent across prompts and
    can evolve without hunting through worker logic. The class is
    intentionally instance-free — the directive is a function of a
    single boolean, no state to carry.
    """

    SHOW_SOLVING_STEPS_BLOCK = (
        "INCLUDE step-by-step solving in the `solvingSteps` field for every question that admits a worked solution — "
        "calculations, derivations, equation manipulation, proof, code tracing, schematic reasoning, multi-step "
        "elimination on tricky MCQs, and so on. Each step must be self-contained, justified, and lead the student "
        "from the question statement to the expected answer. Use line breaks between steps; do not just restate the "
        "expected answer. For purely subjective / opinion / recall-only questions where there is no procedural path "
        "(e.g. \"Define X\", \"List the causes of Y\"), set `solvingSteps` to an empty string \"\". Never omit the "
        "field — it must be present on every object."
    )

    HIDE_SOLVING_STEPS_BLOCK = (
        "Set `solvingSteps` to an empty string \"\" on every question — the user has chosen NOT to receive worked "
        "solutions. Never omit the field; the JSON schema still requires it. Do not put the worked solution into "
        "`answerReason` either — `answerReason` is the marking rubric, not the solving path."
    )

    @classmethod
    def for_flag(cls, b_show_solving_steps: bool) -> str:
        return cls.SHOW_SOLVING_STEPS_BLOCK if b_show_solving_steps else cls.HIDE_SOLVING_STEPS_BLOCK
