import re
import html
from Globals.Enumerations.AskAiPromptModes import AskAiPromptModes
from Globals.Enumerations.AskAiContextKinds import AskAiContextKinds
from Globals.Enumerations.AskAiLanguages import AskAiLanguages
from Globals.Classes.Automation.Pools.PromptPool import PromptPool


class AskAiPromptBuilder:
    """
    Builder for every Explain / Ask / Summarize prompt the AskAi streaming
    worker sends to Gemini. Templates live as `.txt` files in
    Agent/Globals/Classes/Automation/Pools/Prompts/ alongside every other
    workflow's prompts; this class picks the right one and fills its
    {placeholders} via .replace — the same idiom FlashcardGenerationWorker
    and GenerateMockTests use.

    Two distinct scopes are supported, picked by whether `selected_text`
    is non-empty:

      - SELECTION scope (selected_text non-empty): the learner highlighted
        a fragment in a card / study material via the
        TextSelectionContextMenu and asked about that fragment. Templates
        live under ASK_AI_{EXPLAIN|ASK}_{CARD|STUDY_MATERIAL}_USER.txt.

      - WHOLE scope (selected_text empty): the learner clicked a button on
        the StudySessionBottomPanel to act on the entire current entity.
        Templates live under
        ASK_AI_{EXPLAIN|ASK}_{CARD|STUDY_MATERIAL}_WHOLE_USER.txt and
        ASK_AI_SUMMARIZE_{CARD|STUDY_MATERIAL}_USER.txt.

    SUMMARIZE is always whole-entity (summarizing a single highlighted
    phrase makes no sense), so it ignores selected_text entirely.

    Returns (system_prompt, user_prompt) ready to hand to
    GeminiProvider.stream_text. The structural-HTML style block and the
    optional information-source-grounding block are built in Python (their
    content depends on runtime data) and substituted via the template's
    {html_style_block} / {information_source_block} placeholders.
    """

    MATERIAL_CONTENT_CHAR_LIMIT = 6000
    QUESTION_CHAR_LIMIT         = 4000
    ANSWER_CHAR_LIMIT           = 4000

    # Generic LaTeX steer — appended to BOTH style blocks so every mode and
    # context inherits it. Mirrors the wording in
    # STUDY_MATERIAL_GENERATION_SYSTEM.txt / FLASHCARD_GENERATION_SYSTEM.txt
    # (KaTeX renders these on the client). Kept deliberately generic ("a
    # suitable candidate") rather than naming categories like equations or
    # reactions — the model decides what warrants notation.
    LATEX_GUIDANCE = (
        " Where any content is a suitable candidate for mathematical or "
        "scientific notation, write it as LaTeX — \\( \\) for inline and "
        "\\[ \\] for block (KaTeX renders this on the client). Place the "
        "LaTeX directly inside the delimiters; never wrap it in <pre> or "
        "<code>."
    )

    # Web-image steer — appended to the user prompt ONLY when google-search
    # grounding is on (Pro / Pro Plus). Basic has no web search, so it could
    # only ever invent dead URLs; gating here keeps it from trying. The
    # frontend renderer whitelists <img> and drops any image whose URL is
    # malformed or fails to load, so a hallucinated link degrades to "no
    # image" rather than a broken icon.
    WEB_IMAGE_GUIDANCE = (
        "Web search is available to you. When a relevant image from the web "
        "would aid understanding — and always when the learner explicitly "
        "asks for one — embed it inline using "
        "<img src=\"DIRECT_IMAGE_URL\" alt=\"short description\">. Use only "
        "direct links to actual image files (.jpg / .png / .webp / .svg) from "
        "reputable sources you actually found via search; never invent, guess, "
        "or approximate a URL. If no clearly relevant real image exists, omit "
        "images entirely. The <img> tag is permitted in addition to the "
        "structural tags listed above."
    )

    # Output-language steer — appended to the user prompt LAST (strongest
    # position) only when the learner picked a non-English language. When
    # the language is English this is never used, so the prompt is
    # byte-identical to the pre-language behaviour. Two variants: the pure
    # one keeps the whole answer in the target language; the bilingual one
    # ("Combine with English") asks for a natural code-mixed style. Both
    # leave the HTML / LaTeX / code constraints from the style block
    # intact — only the human-readable prose changes language.
    LANGUAGE_GUIDANCE = (
        "Write your entire response in {language_name}. Translate every piece "
        "of natural-language content — headings, sentences, list items, labels "
        "— into {language_name}. Keep all HTML tags, attributes, LaTeX "
        "delimiters, and code / identifiers exactly as instructed above; only "
        "the human-readable text changes language."
    )
    LANGUAGE_GUIDANCE_BILINGUAL = (
        "Write your response primarily in {language_name}, but mix in English "
        "naturally for technical terms, proper nouns, standard keywords, and "
        "any concept that is clearer or more conventional in English — a "
        "natural bilingual, code-mixed style (for example, a {language_name} "
        "explanation that keeps the English term it is defining). Keep all HTML "
        "tags, attributes, LaTeX delimiters, and code / identifiers exactly as "
        "instructed above; only the human-readable text changes language."
    )

    # The "OUTPUT IS HTML, NOT MARKDOWN" clause is load-bearing — the
    # model otherwise mixes markdown syntax (**bold**, `code`, leading
    # # / - / *) into its HTML wrapper, which the sanitiser passes
    # through as literal text. The learner then sees raw asterisks and
    # backticks on screen.
    HTML_STYLE_BLOCK = (
        "Output is HTML, NOT markdown. Output a single self-contained "
        "HTML fragment. Do not include <html>, <head>, <body>, <style>, "
        "or <script> tags. Use only the following semantic structural "
        "tags: h2, h3, p, ul, ol, li, pre, code, strong, em, blockquote. "
        "NEVER emit markdown syntax — no **bold**, no *italic*, no _italic_, "
        "no `backticks`, no leading # for headings, no leading -, *, or +, "
        "for bullets, no leading 1. for numbered lists. Use the HTML tag "
        "instead: <strong>...</strong> for bold, <em>...</em> for italic, "
        "<code>...</code> for inline code, <h2>/<h3> for headings, "
        "<ul><li>...</li></ul> for bullets, <ol><li>...</li></ol> for "
        "numbered lists. Literal asterisks or underscores in your output "
        "render as visible characters to the learner — never emit them as "
        "formatting markers. Do not emit any color-related attributes or "
        "inline styles (no color, background, background-color, border-color, "
        "fill, or stroke). Do not emit class or id attributes. Keep "
        "paragraphs short and well-structured. Begin output with the first "
        "content tag — no preamble."
        + LATEX_GUIDANCE
    )

    # Richer allow-list used by FORMAT mode, which is explicitly about
    # re-rendering content with stronger visual structure. The frontend's
    # AskAiStreamRenderer recognises these tags and the two layout
    # classes; anything else still gets stripped by the sanitiser.
    HTML_STYLE_BLOCK_RICH = (
        "Output is HTML, NOT markdown. Output a single self-contained "
        "HTML fragment. Do not include <html>, <head>, <body>, <style>, "
        "or <script> tags. Allowed tags: h2, h3, p, ul, ol, li, pre, code, "
        "strong, em, blockquote, br, table, thead, tbody, tr, th, td, "
        "figure, figcaption, div. NEVER emit markdown syntax — no **bold**, "
        "no *italic*, no _italic_, no `backticks`, no leading # for "
        "headings, no leading -, *, or + for bullets, no leading 1. for "
        "numbered lists. Use the HTML tag instead: <strong>...</strong>, "
        "<em>...</em>, <code>...</code>, <h2>/<h3>, <ul><li>, <ol><li>. "
        "Literal asterisks or underscores in your output render as visible "
        "characters to the learner. Do not emit any color-related attributes "
        "or inline styles (no color, background, background-color, "
        "border-color, fill, or stroke). The only class attributes permitted "
        "are \"ask-ai-grid\" on an outer <div> and \"ask-ai-grid-item\" on "
        "each child <div> for a card-grid layout — no other classes, no "
        "ids. Begin output with the first content tag — no preamble."
        + LATEX_GUIDANCE
    )

    @staticmethod
    def build(prompt_mode: int, context_kind: int, context_payload: dict, selected_text: str, user_query: str, retrieved_chunks: list[dict], b_enable_google_search: bool = False, selected_language: str = "ENGLISH", b_combine_with_english: bool = False) -> tuple[str, str]:
        information_source_block = AskAiPromptBuilder.__build_information_source_block(retrieved_chunks)
        safe_selected_text       = AskAiPromptBuilder.__sanitise_for_prompt(selected_text)
        # SUMMARIZE and FORMAT genuinely need the whole entity in view
        # — summarising or reformatting a lone phrase is meaningless.
        # GIVE_EXAMPLES / GLOSSARY / MAKE_MNEMONIC used to be in this
        # list too, but they DO benefit from a highlighted fragment:
        # the learner usually wants examples / definitions / mnemonics
        # scoped to the specific term they selected, not the whole
        # card / lesson. Routing them through the selection-aware
        # templates when `selected_text` is non-empty fixes the
        # "asked about X, got an answer about something else that
        # happens to also appear in this card" class of bug.
        b_whole_entity_only_mode = prompt_mode in (
            AskAiPromptModes.SUMMARIZE,
            AskAiPromptModes.FORMAT,
        )
        b_whole_entity = len(safe_selected_text) == 0 or b_whole_entity_only_mode

        system_prompt = PromptPool.ASK_AI_SYSTEM

        if context_kind == AskAiContextKinds.CARD:
            question_text = AskAiPromptBuilder.__sanitise_for_prompt(context_payload.get("question", ""))[: AskAiPromptBuilder.QUESTION_CHAR_LIMIT]
            answer_text   = AskAiPromptBuilder.__sanitise_for_prompt(context_payload.get("answer", ""))[: AskAiPromptBuilder.ANSWER_CHAR_LIMIT]

            user_prompt = AskAiPromptBuilder.__build_card_user_prompt(
                prompt_mode              = prompt_mode,
                b_whole_entity           = b_whole_entity,
                question_text            = question_text,
                answer_text              = answer_text,
                safe_selected_text       = safe_selected_text,
                user_query               = user_query,
                information_source_block = information_source_block,
            )
        else:
            material_excerpt = AskAiPromptBuilder.__html_to_plain_text(context_payload.get("content", ""))
            if len(material_excerpt) > AskAiPromptBuilder.MATERIAL_CONTENT_CHAR_LIMIT:
                material_excerpt = material_excerpt[: AskAiPromptBuilder.MATERIAL_CONTENT_CHAR_LIMIT] + " …"

            user_prompt = AskAiPromptBuilder.__build_study_material_user_prompt(
                prompt_mode              = prompt_mode,
                b_whole_entity           = b_whole_entity,
                material_excerpt         = material_excerpt,
                safe_selected_text       = safe_selected_text,
                user_query               = user_query,
                information_source_block = information_source_block,
            )

        # Web images are only viable when google-search grounding is on
        # (Pro / Pro Plus). Append the steer last so it overrides the
        # style block's structural-tags-only enumeration with the <img>
        # exception.
        if b_enable_google_search:
            user_prompt = user_prompt + "\n\n" + AskAiPromptBuilder.WEB_IMAGE_GUIDANCE

        # Output-language steer goes LAST so it is the final, strongest
        # instruction. English (the default) is a deliberate no-op — the
        # prompt is left untouched, identical to the pre-language call.
        # The enum membership guard means an unexpected / tampered string
        # can never be substituted into the prompt.
        normalized_language = (selected_language or "ENGLISH").upper()
        if normalized_language != "ENGLISH" and normalized_language in AskAiLanguages.__members__:
            language_name     = normalized_language.capitalize()
            guidance_template = (AskAiPromptBuilder.LANGUAGE_GUIDANCE_BILINGUAL
                                 if b_combine_with_english
                                 else AskAiPromptBuilder.LANGUAGE_GUIDANCE)
            user_prompt = user_prompt + "\n\n" + guidance_template.replace("{language_name}", language_name)

        return system_prompt, user_prompt

    @staticmethod
    def __build_card_user_prompt(prompt_mode, b_whole_entity, question_text, answer_text, safe_selected_text, user_query, information_source_block) -> str:
        safe_user_query  = AskAiPromptBuilder.__sanitise_for_prompt(user_query or "")
        user_query_block = AskAiPromptBuilder.__build_user_query_block(user_query)

        if prompt_mode == AskAiPromptModes.SUMMARIZE:
            template = PromptPool.ASK_AI_SUMMARIZE_CARD_USER
            return (
                template
                .replace("{question}",                 question_text)
                .replace("{answer}",                   answer_text)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.FORMAT:
            template = PromptPool.ASK_AI_FORMAT_CARD_USER
            return (
                template
                .replace("{question}",                  question_text)
                .replace("{answer}",                    answer_text)
                .replace("{user_query}",                safe_user_query)
                .replace("{information_source_block}",  information_source_block)
                .replace("{html_style_block_rich}",     AskAiPromptBuilder.HTML_STYLE_BLOCK_RICH)
            )

        if prompt_mode == AskAiPromptModes.MAKE_MNEMONIC:
            template = (
                PromptPool.ASK_AI_MAKE_MNEMONIC_CARD_WHOLE_USER
                if b_whole_entity
                else PromptPool.ASK_AI_MAKE_MNEMONIC_CARD_USER
            )
            return (
                template
                .replace("{question}",                 question_text)
                .replace("{answer}",                   answer_text)
                .replace("{selected_text}",            safe_selected_text)
                .replace("{user_query_block}",         user_query_block)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.GIVE_EXAMPLES:
            template = (
                PromptPool.ASK_AI_GIVE_EXAMPLES_CARD_WHOLE_USER
                if b_whole_entity
                else PromptPool.ASK_AI_GIVE_EXAMPLES_CARD_USER
            )
            return (
                template
                .replace("{question}",                 question_text)
                .replace("{answer}",                   answer_text)
                .replace("{selected_text}",            safe_selected_text)
                .replace("{user_query_block}",         user_query_block)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.GLOSSARY:
            template = (
                PromptPool.ASK_AI_GLOSSARY_CARD_WHOLE_USER
                if b_whole_entity
                else PromptPool.ASK_AI_GLOSSARY_CARD_USER
            )
            return (
                template
                .replace("{question}",                 question_text)
                .replace("{answer}",                   answer_text)
                .replace("{selected_text}",            safe_selected_text)
                .replace("{user_query_block}",         user_query_block)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.EXPLAIN:
            template = PromptPool.ASK_AI_EXPLAIN_CARD_WHOLE_USER if b_whole_entity else PromptPool.ASK_AI_EXPLAIN_CARD_USER
            return (
                template
                .replace("{question}",                 question_text)
                .replace("{answer}",                   answer_text)
                .replace("{selected_text}",            safe_selected_text)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        # ASK
        template = PromptPool.ASK_AI_ASK_CARD_WHOLE_USER if b_whole_entity else PromptPool.ASK_AI_ASK_CARD_USER
        return (
            template
            .replace("{question}",                 question_text)
            .replace("{answer}",                   answer_text)
            .replace("{selected_text}",            safe_selected_text)
            .replace("{user_query}",               safe_user_query)
            .replace("{information_source_block}", information_source_block)
            .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
        )

    @staticmethod
    def __build_study_material_user_prompt(prompt_mode, b_whole_entity, material_excerpt, safe_selected_text, user_query, information_source_block) -> str:
        safe_user_query  = AskAiPromptBuilder.__sanitise_for_prompt(user_query or "")
        user_query_block = AskAiPromptBuilder.__build_user_query_block(user_query)

        if prompt_mode == AskAiPromptModes.SUMMARIZE:
            template = PromptPool.ASK_AI_SUMMARIZE_STUDY_MATERIAL_USER
            return (
                template
                .replace("{material_excerpt}",         material_excerpt)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.FORMAT:
            template = PromptPool.ASK_AI_FORMAT_STUDY_MATERIAL_USER
            return (
                template
                .replace("{material_excerpt}",          material_excerpt)
                .replace("{user_query}",                safe_user_query)
                .replace("{information_source_block}",  information_source_block)
                .replace("{html_style_block_rich}",     AskAiPromptBuilder.HTML_STYLE_BLOCK_RICH)
            )

        if prompt_mode == AskAiPromptModes.MAKE_MNEMONIC:
            template = (
                PromptPool.ASK_AI_MAKE_MNEMONIC_STUDY_MATERIAL_WHOLE_USER
                if b_whole_entity
                else PromptPool.ASK_AI_MAKE_MNEMONIC_STUDY_MATERIAL_USER
            )
            return (
                template
                .replace("{material_excerpt}",         material_excerpt)
                .replace("{selected_text}",            safe_selected_text)
                .replace("{user_query_block}",         user_query_block)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.GIVE_EXAMPLES:
            template = (
                PromptPool.ASK_AI_GIVE_EXAMPLES_STUDY_MATERIAL_WHOLE_USER
                if b_whole_entity
                else PromptPool.ASK_AI_GIVE_EXAMPLES_STUDY_MATERIAL_USER
            )
            return (
                template
                .replace("{material_excerpt}",         material_excerpt)
                .replace("{selected_text}",            safe_selected_text)
                .replace("{user_query_block}",         user_query_block)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.GLOSSARY:
            template = (
                PromptPool.ASK_AI_GLOSSARY_STUDY_MATERIAL_WHOLE_USER
                if b_whole_entity
                else PromptPool.ASK_AI_GLOSSARY_STUDY_MATERIAL_USER
            )
            return (
                template
                .replace("{material_excerpt}",         material_excerpt)
                .replace("{selected_text}",            safe_selected_text)
                .replace("{user_query_block}",         user_query_block)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.EXPLAIN:
            template = PromptPool.ASK_AI_EXPLAIN_STUDY_MATERIAL_WHOLE_USER if b_whole_entity else PromptPool.ASK_AI_EXPLAIN_STUDY_MATERIAL_USER
            return (
                template
                .replace("{material_excerpt}",         material_excerpt)
                .replace("{selected_text}",            safe_selected_text)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        # ASK
        template = PromptPool.ASK_AI_ASK_STUDY_MATERIAL_WHOLE_USER if b_whole_entity else PromptPool.ASK_AI_ASK_STUDY_MATERIAL_USER
        return (
            template
            .replace("{material_excerpt}",         material_excerpt)
            .replace("{selected_text}",            safe_selected_text)
            .replace("{user_query}",               safe_user_query)
            .replace("{information_source_block}", information_source_block)
            .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
        )

    @staticmethod
    def __build_information_source_block(retrieved_chunks: list[dict]) -> str:
        if not retrieved_chunks:
            return ""

        formatted_chunks = []
        for retrieved_chunk in retrieved_chunks:
            source_name  = retrieved_chunk.get("sourceName", "Unnamed source")
            page_number  = retrieved_chunk.get("pageNumber")
            chunk_text   = retrieved_chunk.get("content", "")
            page_segment = f", page {page_number}" if page_number is not None else ""
            formatted_chunks.append(f"[Source: {source_name}{page_segment}]\n{chunk_text}")

        joined_chunks = "\n\n".join(formatted_chunks)

        return (
            "Use ONLY the following grounding excerpts from the learner's uploaded "
            "sources as your authoritative reference. If the excerpts do not answer "
            "the question, say so plainly rather than inventing.\n\n"
            "--- BEGIN SOURCE EXCERPTS ---\n"
            f"{joined_chunks}\n"
            "--- END SOURCE EXCERPTS ---\n\n"
        )

    @staticmethod
    def __build_user_query_block(user_query: str) -> str:
        """
        Build the {user_query_block} substitution. Empty when the user
        typed nothing — the placeholder line collapses out of the
        rendered prompt so absence is invisible to the LLM. Otherwise
        emit a strong steer that elevates whatever the user typed to
        the PRIMARY subject of the output. The previous "Additional
        instructions (optional): {user_query}" line was treated by the
        LLM as a side hint, which let the wider entity body dominate
        and produced examples / definitions / mnemonics about whatever
        concept happened to be most prominent in the card instead of
        the topic the learner actually asked about.
        """
        safe = AskAiPromptBuilder.__sanitise_for_prompt(user_query or "")
        if not safe:
            return ""
        return (
            f"TOPIC FOCUS: {safe}\n"
            "Treat the topic above as the PRIMARY subject of the output. "
            "Examples / definitions / mnemonics must illustrate this "
            "specifically, even if it is only one part of the wider "
            "content. Use the surrounding flashcard or lesson only as "
            "background context — never as the subject of the output."
        )

    @staticmethod
    def __sanitise_for_prompt(raw_text: str) -> str:
        """
        Collapse whitespace and decode HTML entities. Selected text from
        a contenteditable card surface can carry hard newlines and
        non-breaking spaces; the LLM doesn't need those, and they make
        the prompt harder to read in logs.
        """
        if not raw_text:
            return ""
        decoded = html.unescape(str(raw_text))
        return re.sub(r"\s+", " ", decoded).strip()

    @staticmethod
    def __html_to_plain_text(html_fragment: str) -> str:
        """
        Strip a study material's stored HTML to plain text for prompt
        consumption. Cheap regex strip is adequate — the LLM doesn't
        need structural fidelity, just the prose.
        """
        if not html_fragment:
            return ""
        without_scripts = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", html_fragment, flags=re.IGNORECASE | re.DOTALL)
        without_tags    = re.sub(r"<[^>]+>", " ", without_scripts)
        decoded         = html.unescape(without_tags)
        return re.sub(r"\s+", " ", decoded).strip()
