from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider
from Globals.Classes.ImageProcessing.ImageRegionCropper import ImageRegionCropper
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes

from Workflows.EnhanceImages.UnifiedAssetExtraction import UnifiedAssetExtraction


class AssetEnhancer:

    EXTRACTION_MODEL_NAME = "gemini-3.1-flash-lite"
    IMAGE_GENERATION_MODEL_NAME = "gemini-3.1-flash-image-preview"

    EXTRACTION_TEMPERATURE = 0.1
    EXTRACTION_MAX_OUTPUT_TOKENS = 16384

    BRAND_STYLE_TEMPLATE = (
        "\n"
        "Style: Minimalist educational vector illustration, clean lines, flat design, "
        "modern software UI style.\n"
        "Color Palette: Dark charcoal background (#1E1E1E), crisp white text labels "
        "(#FFFFFF), with electric blue (#00D2FF) as the primary accent color for key "
        "focus elements and connection arrows.\n"
        "Composition: 2D flat perspective, clean lines, flat design, modern UI style, "
        "perfect spatial distribution.\n"
        "Execution: Clean digital art, maximum educational clarity. No photorealism, "
        "no 3D renders. All text must be perfectly legible and correctly spelled "
        "exactly as requested.\n"
    )

    EXTRACTION_PROMPT = (
        "Inspect the provided asset and classify it into one of two cases:\n\n"
        "1. DIAGRAM: the image contains any illustrative or graphical elements (charts, plots, "
        "architecture layouts, schematics, maps, flowcharts, etc.). Extract the visible structure "
        "into nodes, connections, and groups, and write a descriptive caption.\n\n"
        "2. TEXT_DATA: the image has zero illustrative elements -- pure source code, terminal "
        "output, or plain text tables. Transcribe the text exactly (tables as markdown).\n\n"
        "CORE PRINCIPLE FOR DIAGRAMS: preserve the geometry of the source. Your job is to record "
        "what is actually drawn in the image, exactly as it is drawn, so the downstream pipeline "
        "can re-draw it. Do not summarize, simplify, re-style, or substitute. Every shape, every "
        "line, every text label, every container frame that is visible in the source must appear "
        "in your output.\n\n"
        "EXTRACTION RULES:\n"
        "- Capture every visible node (shape with a label, OR bare text that has an arrow "
        "  touching it). For bare-text nodes with no surrounding shape, set "
        "  component_type='text_only_label'. For shaped nodes, set component_type to a short "
        "  snake_case identifier that matches what is actually drawn -- do not substitute one "
        "  shape or icon class for another.\n"
        "- If one visible border encloses several lines of stacked text, that is ONE node. "
        "  Put the lines into `label`, joined by '\\n'. Do not split it into multiple sibling nodes.\n"
        "- Capture every visible arrow or line. Record its direction (from_node -> to_node) and "
        "  describe its visible style in connection_style. If multiple arrows visually converge "
        "  to the same target (whether through a junction, a merge symbol, or any other shape), "
        "  record each one as its own connection entry from its source to the shared target -- "
        "  never collapse them into a single entry.\n"
        "- Capture every visible container/grouping frame in groups[] with its label (if any), "
        "  border style, contained node IDs, and bounding box.\n"
        "- Capture the diagram's own on-figure title if present.\n\n"
        "IGNORE these (they are NOT diagram content):\n"
        "- Author / instructor attributions, department names, institution names.\n"
        "- Watermarks, logos, copyright lines, slide / page numbers, footers.\n"
        "- Question stems or assignment instructions printed around the figure.\n"
        "- Course / subject codes, slide deck titles, lecture numbers, dates.\n"
        "- Figure captions printed outside the figure border. Use them to inform core_topic / "
        "  caption only; do not add them as nodes.\n\n"
        "DIAGRAM SUBJECT REGION: populate `diagram_subject_region_percent` with the bounding "
        "rectangle that snugly encloses just the diagram itself -- its shapes, arrows, container "
        "frames, and in-figure title. Values are 0-100 percentages of the SOURCE image's width "
        "and height (top_percent, left_percent, bottom_percent, right_percent). EXCLUDE everything "
        "in the IGNORE list above: surrounding body text, marginal text, captions printed outside "
        "the figure border, page numbers, watermarks, headers, footers, and adjacent columns of "
        "unrelated text. If the diagram already fills the entire source image edge-to-edge, omit "
        "this field (leave it null). Add a small visual margin of roughly 1-2 percent on each side "
        "so arrowheads at the diagram's edge are not clipped.\n\n"
        "TIE-BREAKER: if you are unsure whether a piece of text is diagram content or ambient "
        "text, ask whether it has an arrow touching it, sits inside/on a shape, or labels a "
        "container frame. If yes to any, it is diagram content -- capture it.\n\n"
        "BE EXHAUSTIVE: dense or complex diagrams must be enumerated in full -- do not summarize "
        "or selectively pick the 'important' elements. Any node you skip will silently disappear "
        "from the final image. Err on the side of over-extraction.\n\n"
        "FINAL AUDIT before returning: re-scan the image and confirm that every visible shape, "
        "every visible arrow, every edge label, every container frame, and every text-only label "
        "appears in nodes[], connections[], or groups[]. For each node, count incoming and "
        "outgoing arrowheads in the image and verify connections[] reflects those exact counts; "
        "if they disagree, add the missing arrows."
    )

    # The image model treats numeric percentages embedded in the prompt as
    # LITERAL text to render on the canvas (observed: "[X: 25.0%, Y: 35.0%]"
    # labels leaking above every node in output). Mapping percentages to a
    # natural-language 3x3 zone grid gives the model spatial intent without
    # leaking digits onto the rendered image.
    #
    # Snake_case component_type strings (e.g. "header_box",
    # "central_process_box") look like identifiers to the image model, which
    # then renders them as literal text inside the shapes. Strip the
    # underscores and route a few common classifiers to short natural-language
    # shape descriptions so the prompt reads as instructions, not as labels.
    COMPONENT_TYPE_SHAPE_MAP = {
        "header_box": "wide rounded title banner",
        "title_banner": "wide rounded title banner",
        "central_process_box": "large rounded rectangle",
        "process_box": "rounded rectangle",
        "container_box": "rounded rectangle",
        "box": "rounded rectangle",
        "database": "cylindrical database icon",
        "cloud": "cloud-shaped container",
        "decision_diamond": "diamond shape",
        "bar_chart_column": "vertical bar of a bar chart",
        "graph_axis": "labeled chart axis line",
    }

    def __init__(self):
        self.__automation_caller = AutomationCaller(GeminiProvider())

    async def enhance(self, image_bytes: bytes) -> dict:
        """
        Run the full Stage-1 + Stage-2 enhancement pipeline on a single
        image. Returns one of:

          - {"kind": "DIAGRAM",                "imageBytes": <regenerated PNG/JPEG bytes>}
          - {"kind": "TEXT_DATA",              "markdown":   <extracted markdown text>}
          - {"kind": "DIAGRAM_TEXT_FALLBACK",  "markdown":   <text description of the diagram>}

        Stage 1 (extraction) failures still raise -- without an extraction
        we have nothing to fall back to. Stage 2 (image generation)
        failures are recovered as DIAGRAM_TEXT_FALLBACK: the model
        intermittently returns an empty image stream (preview model
        quirks, content-policy filters), and losing one figure to a text
        substitute is far better than killing the whole task.
        """
        extraction = await self.__run_extraction_stage(image_bytes)

        if extraction.content_case == "TEXT_DATA":
            markdown_text = extraction.extracted_text_content or ""
            return {
                "kind": "TEXT_DATA",
                "markdown": markdown_text,
            }

        if extraction.content_case != "DIAGRAM":
            raise RuntimeError(
                f"AssetEnhancer: unrecognized content_case '{extraction.content_case}' "
                f"-- expected 'DIAGRAM' or 'TEXT_DATA'."
            )

        try:
            regenerated_image_bytes = await self.__run_image_generation_stage(
                extraction,
                image_bytes,
            )
        except Exception as image_generation_failure:
            print(
                f"[AssetEnhancer] Stage 2 image generation failed "
                f"({image_generation_failure}) -- falling back to a text "
                f"description of the diagram so the figure still appears."
            )
            fallback_markdown = AssetEnhancer.__build_diagram_text_fallback(extraction)
            return {
                "kind": "DIAGRAM_TEXT_FALLBACK",
                "markdown": fallback_markdown,
            }

        return {
            "kind": "DIAGRAM",
            "imageBytes": regenerated_image_bytes,
        }

    @staticmethod
    def __build_diagram_text_fallback(extraction: UnifiedAssetExtraction) -> str:
        """
        Render the Stage 1 extraction as a clean markdown description so
        the student sees the diagram's structure even when image
        regeneration produced no image. Same data the image model would
        have consumed -- just laid out as text.
        """
        markdown_lines: list[str] = []

        diagram_topic = (extraction.core_topic or "").strip()
        if diagram_topic:
            markdown_lines.append(f"**{diagram_topic}**")
            markdown_lines.append("")

        diagram_caption = (extraction.caption or "").strip()
        if diagram_caption:
            markdown_lines.append(diagram_caption)
            markdown_lines.append("")

        diagram_nodes = extraction.nodes or []
        if diagram_nodes:
            markdown_lines.append("**Elements:**")
            sorted_nodes = sorted(
                diagram_nodes,
                key = lambda node: (node.y_percent, node.x_percent),
            )
            for current_node in sorted_nodes:
                node_label = (current_node.label or "").replace("\n", " / ").strip()
                if node_label:
                    markdown_lines.append(f"- {node_label}")
            markdown_lines.append("")

        diagram_connections = extraction.connections or []
        if diagram_connections:
            markdown_lines.append("**Flow:**")
            for current_connection in diagram_connections:
                from_label = AssetEnhancer.__resolve_label_for_node_id(
                    current_connection.from_node, diagram_nodes,
                )
                to_label = AssetEnhancer.__resolve_label_for_node_id(
                    current_connection.to_node, diagram_nodes,
                )
                from_label_clean = (from_label or "").replace("\n", " / ").strip() or "?"
                to_label_clean = (to_label or "").replace("\n", " / ").strip() or "?"
                connection_label = (current_connection.label or "").strip()
                if connection_label:
                    markdown_lines.append(
                        f"- {from_label_clean} → {to_label_clean} ({connection_label})"
                    )
                else:
                    markdown_lines.append(f"- {from_label_clean} → {to_label_clean}")
            markdown_lines.append("")

        return "\n".join(markdown_lines).strip()

    async def __run_extraction_stage(self, image_bytes: bytes) -> UnifiedAssetExtraction:
        extraction_request = AutomationRequest(
            AssetEnhancer.EXTRACTION_MODEL_NAME,
            [
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    AssetEnhancer.EXTRACTION_PROMPT,
                    metadata = {
                        "response_schema": UnifiedAssetExtraction,
                        "temperature": AssetEnhancer.EXTRACTION_TEMPERATURE,
                        "max_output_tokens": AssetEnhancer.EXTRACTION_MAX_OUTPUT_TOKENS,
                    },
                ),
                AutomationContent(AutomationContentTypes.IMAGE, image_bytes),
            ],
        )

        extraction_response = await self.__automation_caller.call(
            extraction_request,
            validator = None,
            retries = 2,
        )

        if extraction_response is None:
            raise RuntimeError("AssetEnhancer: Stage 1 returned no response from Gemini.")

        raw_extraction_text = extraction_response.get_output(0).get_data()
        if not isinstance(raw_extraction_text, str) or not raw_extraction_text.strip():
            raise RuntimeError(
                "AssetEnhancer: Stage 1 returned an empty/non-string payload."
            )

        # Pydantic-level enforcement on top of the SDK schema. This catches
        # the rare case where the schema is respected at type level but a
        # required field is null / a list is empty when the prompt forbids
        # it.
        return UnifiedAssetExtraction.model_validate_json(raw_extraction_text)

    async def __run_image_generation_stage(
        self,
        extraction: UnifiedAssetExtraction,
        source_image_bytes: bytes,
    ) -> bytes:
        # Crop the reference image down to just the diagram subject before
        # handing it to the image model. When ImageExtractor's YOLO crop is
        # loose (or, in the worst case, grabbed an entire textbook page),
        # the model otherwise dutifully redraws all the ambient text /
        # paragraphs visible in the reference. The Stage-1 extractor has
        # already located the subject region for us; fall back to the full
        # image if the region is absent or invalid (see ImageRegionCropper
        # for the fail-soft behaviour).
        effective_source_image_bytes = ImageRegionCropper.crop_to_subject_region(
            source_image_bytes,
            extraction.diagram_subject_region_percent,
        )

        blueprint_prompt = AssetEnhancer.__build_blueprint_prompt(extraction)
        rendering_guardrail = AssetEnhancer.__build_rendering_guardrail()

        final_generation_prompt = (
            f"{AssetEnhancer.BRAND_STYLE_TEMPLATE}\n\n"
            f"You are re-drawing the diagram shown in the attached reference image, in the brand "
            f"style described above. Use the reference image for STRUCTURE (boxes, arrows, "
            f"containers, line styles, directionality) and use the blueprint below for EXACT "
            f"labels and the layout checklist.\n\n"
            f"Diagram Layout Requirements:\n{blueprint_prompt}"
            f"{rendering_guardrail}"
        )

        image_generation_request = AutomationRequest(
            AssetEnhancer.IMAGE_GENERATION_MODEL_NAME,
            [
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    final_generation_prompt,
                    metadata = {"generate_image": True},
                ),
                AutomationContent(AutomationContentTypes.IMAGE, effective_source_image_bytes),
            ],
        )

        image_generation_response = await self.__automation_caller.call(
            image_generation_request,
            validator = None,
            retries = 2,
        )

        if image_generation_response is None:
            raise RuntimeError("AssetEnhancer: Stage 2 returned no response from Gemini.")

        for output_content in image_generation_response.get_outputs():
            if output_content.get_content_type() == AutomationContentTypes.IMAGE:
                generated_bytes = output_content.get_data()
                if isinstance(generated_bytes, (bytes, bytearray)) and len(generated_bytes) > 0:
                    return bytes(generated_bytes)

        raise RuntimeError(
            "AssetEnhancer: Stage 2 produced no image data -- the model returned no "
            "inline IMAGE part."
        )

    @staticmethod
    def __humanize_component_type(raw_component_type: str) -> str:
        normalized_lookup_key = (raw_component_type or "").strip().lower()
        if normalized_lookup_key in AssetEnhancer.COMPONENT_TYPE_SHAPE_MAP:
            return AssetEnhancer.COMPONENT_TYPE_SHAPE_MAP[normalized_lookup_key]
        return normalized_lookup_key.replace("_", " ") or "rounded rectangle"

    @staticmethod
    def __describe_canvas_zone(x_percent: float, y_percent: float) -> str:
        if y_percent < 33.34:
            vertical_band = "top"
        elif y_percent < 66.67:
            vertical_band = "middle"
        else:
            vertical_band = "bottom"

        if x_percent < 33.34:
            horizontal_band = "left"
        elif x_percent < 66.67:
            horizontal_band = "center"
        else:
            horizontal_band = "right"

        if vertical_band == "middle" and horizontal_band == "center":
            return "the dead center of the canvas"
        if vertical_band == "middle":
            return f"the {horizontal_band}-center area"
        if horizontal_band == "center":
            return f"the {vertical_band}-center area"
        return f"the {vertical_band}-{horizontal_band} area"

    @staticmethod
    def __build_blueprint_prompt(extraction: UnifiedAssetExtraction) -> str:
        diagram_topic_name = extraction.core_topic or "Educational Diagram"
        diagram_nodes_list = extraction.nodes or []
        diagram_connections_list = extraction.connections or []
        diagram_groups_list = extraction.groups or []

        # Sort nodes in natural reading order (top-to-bottom, then
        # left-to-right) so the model receives elements in the same order a
        # human would scan the diagram. This noticeably stabilizes layout
        # fidelity.
        sorted_nodes_for_prompt = sorted(
            diagram_nodes_list,
            key = lambda node: (node.y_percent, node.x_percent),
        )

        blueprint_prompt = f"Topic: {diagram_topic_name}\nElements to include:\n"

        for current_node in sorted_nodes_for_prompt:
            canvas_zone_description = AssetEnhancer.__describe_canvas_zone(
                current_node.x_percent,
                current_node.y_percent,
            )
            humanized_shape_description = AssetEnhancer.__humanize_component_type(
                current_node.component_type,
            )

            # Text-only terminal labels (no surrounding box) need different
            # rendering instructions than shaped nodes -- otherwise the
            # model wraps a box around them and breaks the visual
            # semantics.
            if (current_node.component_type or "").strip().lower() == "text_only_label":
                blueprint_prompt += (
                    f"- In {canvas_zone_description}, place the bare text \"{current_node.label}\" "
                    f"with NO surrounding box, frame, or shape. It should appear as a free-floating "
                    f"text label.\n"
                )
            else:
                blueprint_prompt += (
                    f"- In {canvas_zone_description}, draw a {humanized_shape_description} "
                    f"and place ONLY the text \"{current_node.label}\" inside it. "
                    f"Do not add any other words, numbers, brackets, or annotations on or near it.\n"
                )

        if diagram_groups_list:
            blueprint_prompt += "\nContainer Frames (wrapping groups of inner nodes):\n"
            for current_group in diagram_groups_list:
                contained_node_labels = []
                for contained_node_id in current_group.contained_node_ids or []:
                    matched_node = next(
                        (node for node in diagram_nodes_list if node.id == contained_node_id),
                        None,
                    )
                    if matched_node is not None:
                        contained_node_labels.append(f"\"{matched_node.label}\"")
                contained_summary = (
                    ", ".join(contained_node_labels)
                    if contained_node_labels
                    else "its inner nodes"
                )
                border_descriptor = (current_group.border_style or "dashed").lower()
                group_label_text = current_group.label or ""
                if group_label_text:
                    label_instruction = (
                        f" Label this frame with the text \"{group_label_text}\" placed at its "
                        f"top-left corner (slightly outside or overlapping the top edge)."
                    )
                else:
                    label_instruction = " The frame has no text label."
                blueprint_prompt += (
                    f"- Draw a {border_descriptor}-bordered rounded rectangle that fully encloses "
                    f"these inner nodes: {contained_summary}.{label_instruction}\n"
                )

        blueprint_prompt += "\nConnections and Flow:\n"

        for current_connection in diagram_connections_list:
            from_node_label = AssetEnhancer.__resolve_label_for_node_id(
                current_connection.from_node,
                diagram_nodes_list,
            )
            to_node_label = AssetEnhancer.__resolve_label_for_node_id(
                current_connection.to_node,
                diagram_nodes_list,
            )

            if current_connection.label:
                label_instruction_text = (
                    f" Write exactly \"{current_connection.label}\" along this line, and nothing else."
                )
            else:
                label_instruction_text = ""

            blueprint_prompt += (
                f"- Draw a {current_connection.connection_style} from "
                f"\"{from_node_label}\" to \"{to_node_label}\".{label_instruction_text}\n"
            )

        return blueprint_prompt

    @staticmethod
    def __resolve_label_for_node_id(node_id_to_resolve: str, diagram_nodes_list: list) -> str:
        for node in diagram_nodes_list:
            if node.id == node_id_to_resolve:
                return node.label
        return node_id_to_resolve

    @staticmethod
    def __build_rendering_guardrail() -> str:
        # Hard-coded guard at the END of the prompt -- last-token attention
        # bias makes this the most effective place to forbid coordinate-
        # string leaks and to lock in the use of the attached reference
        # image.
        return (
            "\nSTRICT RENDERING RULES:\n"
            "- An ATTACHED REFERENCE IMAGE accompanies this prompt. Treat it as ground truth for "
            "the diagram's geometry: shapes, sizes, relative positions, arrow paths, arrow "
            "directions, line styles, container frames, nesting, and which elements connect to "
            "which. Preserve all of this faithfully in the regenerated image.\n"
            "- Do not omit any element visible in the reference. If you can see it in the "
            "reference, it must appear in the output -- including any element the blueprint "
            "below failed to list. The blueprint is a checklist, not an exhaustive specification.\n"
            "- Do not copy the reference image's pixels, fonts, colors, or styling. Re-draw "
            "the entire diagram from scratch in the brand style described above.\n"
            "- The textual blueprint below is the authoritative source of LABEL spellings. If the "
            "reference image's OCR appears to disagree with a label in the blueprint, trust the "
            "blueprint label.\n"
            "- If a node's label contains newline characters, draw a single shape and stack the "
            "lines vertically inside it. Do not split a multi-line label into multiple shapes.\n"
            "- The ONLY text that may appear in the final image is: the title, the exact node "
            "labels listed below, and the exact connection labels listed below.\n"
            "- The reference image may contain text that is NOT part of the diagram itself "
            "(author/instructor attributions, department or institution names, watermarks, "
            "logos, page or slide numbers, footers, question stems or assignment prompts, "
            "course codes, dates, figure captions printed outside the figure border). You MUST "
            "ignore all such text. Reproduce only the diagram itself.\n"
            "- Do not render any coordinates, percentages, position descriptors, zone names, or "
            "any other layout metadata anywhere on the canvas.\n"
            "- Do not render any shape-type or component-classifier words anywhere on the canvas. "
            "Words describing shape or structure are instructions for you, not labels for the "
            "viewer.\n"
            "- Spell every label EXACTLY as written in the blueprint, including capitalization "
            "and spacing.\n"
        )
