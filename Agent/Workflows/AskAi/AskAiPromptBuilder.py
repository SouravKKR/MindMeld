import re
import html
from Globals.Enumerations.AskAiPromptModes import AskAiPromptModes
from Globals.Enumerations.AskAiContextKinds import AskAiContextKinds
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

    HTML_STYLE_BLOCK = (
        "Output a single self-contained HTML fragment. Do not include "
        "<html>, <head>, <body>, <style>, or <script> tags. Use only the "
        "following semantic structural tags: h2, h3, p, ul, ol, li, pre, "
        "code, strong, em, blockquote. Do not emit any color-related "
        "attributes or inline styles (no color, background, background-color, "
        "border-color, fill, or stroke). Do not emit class or id attributes. "
        "Keep paragraphs short and well-structured. Begin output with the "
        "first content tag — no preamble."
    )

    # Richer allow-list used by FORMAT mode, which is explicitly about
    # re-rendering content with stronger visual structure. The frontend's
    # AskAiStreamRenderer recognises these tags and the two layout
    # classes; anything else still gets stripped by the sanitiser.
    HTML_STYLE_BLOCK_RICH = (
        "Output a single self-contained HTML fragment. Do not include "
        "<html>, <head>, <body>, <style>, or <script> tags. Allowed tags: "
        "h2, h3, p, ul, ol, li, pre, code, strong, em, blockquote, br, "
        "table, thead, tbody, tr, th, td, figure, figcaption, div. Do not "
        "emit any color-related attributes or inline styles (no color, "
        "background, background-color, border-color, fill, or stroke). "
        "The only class attributes permitted are \"ask-ai-grid\" on an "
        "outer <div> and \"ask-ai-grid-item\" on each child <div> for a "
        "card-grid layout — no other classes, no ids. Begin output with "
        "the first content tag — no preamble."
    )

    @staticmethod
    def build(prompt_mode: int, context_kind: int, context_payload: dict, selected_text: str, user_query: str, retrieved_chunks: list[dict]) -> tuple[str, str]:
        information_source_block = AskAiPromptBuilder.__build_information_source_block(retrieved_chunks)
        safe_selected_text       = AskAiPromptBuilder.__sanitise_for_prompt(selected_text)
        # SUMMARIZE / FORMAT / MAKE_MNEMONIC / GIVE_EXAMPLES / GLOSSARY are
        # inherently whole-entity — operating on a single highlighted
        # phrase doesn't make sense for them, so any selectedText passed
        # in is ignored.
        b_whole_entity_only_mode = prompt_mode in (
            AskAiPromptModes.SUMMARIZE,
            AskAiPromptModes.FORMAT,
            AskAiPromptModes.MAKE_MNEMONIC,
            AskAiPromptModes.GIVE_EXAMPLES,
            AskAiPromptModes.GLOSSARY,
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

        return system_prompt, user_prompt

    @staticmethod
    def __build_card_user_prompt(prompt_mode, b_whole_entity, question_text, answer_text, safe_selected_text, user_query, information_source_block) -> str:
        safe_user_query = AskAiPromptBuilder.__sanitise_for_prompt(user_query or "")

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
            template = PromptPool.ASK_AI_MAKE_MNEMONIC_CARD_USER
            return (
                template
                .replace("{question}",                 question_text)
                .replace("{answer}",                   answer_text)
                .replace("{user_query}",               safe_user_query)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.GIVE_EXAMPLES:
            template = PromptPool.ASK_AI_GIVE_EXAMPLES_CARD_USER
            return (
                template
                .replace("{question}",                 question_text)
                .replace("{answer}",                   answer_text)
                .replace("{user_query}",               safe_user_query)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.GLOSSARY:
            template = PromptPool.ASK_AI_GLOSSARY_CARD_USER
            return (
                template
                .replace("{question}",                 question_text)
                .replace("{answer}",                   answer_text)
                .replace("{user_query}",               safe_user_query)
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
        safe_user_query = AskAiPromptBuilder.__sanitise_for_prompt(user_query or "")

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
            template = PromptPool.ASK_AI_MAKE_MNEMONIC_STUDY_MATERIAL_USER
            return (
                template
                .replace("{material_excerpt}",         material_excerpt)
                .replace("{user_query}",               safe_user_query)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.GIVE_EXAMPLES:
            template = PromptPool.ASK_AI_GIVE_EXAMPLES_STUDY_MATERIAL_USER
            return (
                template
                .replace("{material_excerpt}",         material_excerpt)
                .replace("{user_query}",               safe_user_query)
                .replace("{information_source_block}", information_source_block)
                .replace("{html_style_block}",         AskAiPromptBuilder.HTML_STYLE_BLOCK)
            )

        if prompt_mode == AskAiPromptModes.GLOSSARY:
            template = PromptPool.ASK_AI_GLOSSARY_STUDY_MATERIAL_USER
            return (
                template
                .replace("{material_excerpt}",         material_excerpt)
                .replace("{user_query}",               safe_user_query)
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
