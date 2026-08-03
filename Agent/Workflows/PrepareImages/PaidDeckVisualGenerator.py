import asyncio
import re

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Generation.VisualMethodRouter import VisualMethodRouter
from Globals.Constants.ReasoningEffortLevels import ReasoningEffortLevels
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.VisualGenerationMethods import VisualGenerationMethods
from Globals.Utility.StripJsonMarkdown import strip_json_markdown

from Workflows.PrepareImages.VisualNeedInferrer import VisualNeedInferrer


class PaidDeckVisualGenerator:
    """
    Phase 4: produces the visuals this deck needs — those the Phase 1 coverage
    summaries DECLARED, plus those VisualNeedInferrer judged the topic needs.

    The second source is not a nicety. Paid-deck mode's only input is a syllabus,
    and a syllabus names topics rather than figures, so declarations alone leave
    inherently visual subjects shipping as pure prose. Inference supplies the
    judgement the input does not carry; declarations always survive it untouched,
    and every visual records which of the two it came from.

    Runs inside PrepareImages in place of PDF figure extraction. What it emits is
    the SAME figure dict shape the extractor emits — perceptualImageHash,
    captionText, imageBytes, pageNumber=None — so every stage after it (vision
    validation, embedding, page-less placement, injection) is untouched. The one
    addition is `markupHtml`: when present the injector inlines the markup
    instead of a base64 image, which is what keeps SVG text as real, selectable,
    crisp text rather than pixels.

    The routing itself lives in VisualMethodRouter. This class owns the three
    things routing does not:

      0. WHERE THE WORK COMES FROM. Declared visuals are honoured verbatim;
         inferred ones are added only where a topic has room and a genuine
         need. Both then follow the identical routing, generation, review and
         placement path — an inferred diagram is held to the same standard as
         a requested one, and is dropped just as readily if it fails review.

      1. HIGH REASONING EFFORT on the symbolic path, set explicitly rather than
         inherited. Diagram quality is the failure mode that matters most here,
         and it is the one place in this feature where the extra reasoning is
         clearly worth the cost.

      2. THE ESCAPE HATCH. The model may decline: decompose into simpler correct
         diagrams, or return a labelled description rendered as text. SVG
         degrades badly on intricate diagrams even for capable models, so
         declining is handled as a first-class outcome rather than treated as a
         failure — a confident wrong picture is the worst available result.

      3. RASTERISATION FOR REVIEW. Generated SVG is rendered to PNG so the vision
         review looks at what a student would actually see. That catches the
         failures source inspection cannot — renders blank, text overlapping
         geometry, content outside the viewBox — and it also supplies the
         imageBytes the existing placement machinery needs.
    """

    # Concurrent visuals in flight. Symbolic generation at high effort is slow,
    # so this is deliberately modest; the provider semaphore is the real cap.
    MAXIMUM_CONCURRENT_VISUALS = 3

    # Render width used for the review raster. Matches the prompt's stated
    # legibility target so "legible at 600px" is checked at 600px.
    REVIEW_RASTER_DPI = 110

    # A generated visual has no source page, so it is placed through the same
    # page-less path web-sourced images use.
    SOURCE_HASH_MARKER = "__generated__"

    def __init__(self, subject_name: str, coverage_summaries: dict, exam_name: str = "", action_log = None):
        self.__subject_name = (subject_name or "").strip() or "the subject"
        self.__exam_name = (exam_name or "").strip()
        self.__coverage_summaries = coverage_summaries or {"topics": []}
        self.__action_log = action_log

    async def generate_all(self) -> list:
        """
        Returns a list of figure dicts, one per successfully produced visual.
        Declined visuals that came back as a labelled description are returned
        too, carrying markupHtml built from that description — a stated
        substitution the reviewer can see, rather than a silent omission.
        """
        # The syllabus this deck was built from lists topics, not figures, so the
        # visuals DECLARED in the coverage summaries are sparse by nature. Infer
        # the ones a competent textbook would include before generating anything;
        # declared visuals pass through untouched and inference only ever adds.
        self.__coverage_summaries = await VisualNeedInferrer(
            subject_name = self.__subject_name,
            exam_name = self.__exam_name,
            action_log = self.__action_log,
        ).augment(self.__coverage_summaries)

        requests = self.__collect_requests()

        if not requests:
            print("[PaidDeckVisualGenerator] No topic declared or needed a visual.")
            return []

        declared_count = sum(1 for visual_request in requests if visual_request["origin"] == VisualNeedInferrer.ORIGIN_DECLARED)
        print(
            f"[PaidDeckVisualGenerator] Generating {len(requests)} visual(s) "
            f"({declared_count} declared, {len(requests) - declared_count} inferred)..."
        )

        semaphore = asyncio.Semaphore(PaidDeckVisualGenerator.MAXIMUM_CONCURRENT_VISUALS)

        async def generate_one(visual_request):
            async with semaphore:
                return await self.__generate_one(visual_request)

        results = await asyncio.gather(*[generate_one(visual_request) for visual_request in requests])

        produced_figures = [figure for figure in results if figure is not None]
        accepted_figures = await self.__review_all(produced_figures)

        print(
            f"[PaidDeckVisualGenerator] {len(produced_figures)} of {len(requests)} visual(s) produced; "
            f"{len(accepted_figures)} passed vision review."
        )
        return accepted_figures

    async def __review_all(self, figures: list) -> list:
        """
        Vision review of every generated diagram, against the specification it
        was generated from. This is the Phase 6 visual check, run here because
        here is where the rendered pixels exist.

        A visual that fails review is DROPPED, not shipped with a warning. A
        missing figure leaves a lesson complete but plainer; a wrong figure
        teaches something false to someone who paid for it. The failure is
        recorded in the action trail either way, so the review gate shows what
        was dropped and why.

        Labelled descriptions are not reviewed: there is no image to look at, and
        the fact that a diagram was declined is already recorded explicitly.
        """
        semaphore = asyncio.Semaphore(PaidDeckVisualGenerator.MAXIMUM_CONCURRENT_VISUALS)
        accepted_figures = []

        async def review_one(figure):
            if figure.get("_wasDeclined") is True or not figure.get("imageBytes"):
                figure["_visionReviewOutcome"] = "Not reviewed — a labelled description was substituted for a diagram."
                accepted_figures.append(figure)
                return

            async with semaphore:
                review = await self.__review_one(figure)

            figure["_visionReviewOutcome"] = review["summary"]

            if review["acceptable"]:
                accepted_figures.append(figure)

        await asyncio.gather(*[review_one(figure) for figure in figures])
        return accepted_figures

    async def __review_one(self, figure: dict) -> dict:
        model_string, provider_class = ModelPool.PAID_DECK_VISUAL_VERIFICATION_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.PAID_DECK_VISUAL_REVIEW_SYSTEM),
                AutomationContent(AutomationContentTypes.IMAGE, figure["imageBytes"]),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.PAID_DECK_VISUAL_REVIEW_USER
                        .replace("{topic_chain}", " > ".join(figure.get("_topicChain") or []))
                        .replace("{visual_description}", figure.get("_visualDescription") or ""),
                ),
            ],
        )

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            # An unreviewable diagram is not an accepted diagram. Failing open
            # here would mean the one check standing between a wrong figure and a
            # paying student is skipped whenever the reviewer is unavailable.
            outcome = f"Vision review could not be completed ({call_error}) — rejected rather than shipped unreviewed."
            await self.__record_review(figure, model_string, outcome, False)
            return {"acceptable": False, "summary": outcome}

        parsed = strip_json_markdown(response.get_output(0).get_data()) if response is not None else None

        if not isinstance(parsed, dict):
            outcome = "Vision review returned an unusable response — rejected rather than shipped unreviewed."
            await self.__record_review(figure, model_string, outcome, False)
            return {"acceptable": False, "summary": outcome}

        b_acceptable = (
            parsed.get("acceptable") is True
            and parsed.get("labelsComplete") is not False
            and parsed.get("labelsLegible") is not False
            and parsed.get("depictsWhatItClaims") is not False
        )

        problems = parsed.get("problems") if isinstance(parsed.get("problems"), list) else []
        summary = str(parsed.get("summary") or "").strip() or ("Accepted." if b_acceptable else "Rejected.")

        if not b_acceptable and problems:
            summary = f"{summary} Problems: {'; '.join(str(problem) for problem in problems[:5])}"

        await self.__record_review(figure, model_string, summary, b_acceptable)
        return {"acceptable": b_acceptable, "summary": summary}

    async def __record_review(self, figure, model_string, outcome, b_acceptable):
        if self.__action_log is None:
            return
        await self.__action_log.record_visual(
            topic_chain = figure.get("_topicChain") or [],
            description = figure.get("_visualDescription") or "",
            kind_name = figure.get("_visualKind") or "",
            method_name = figure.get("_visualMethod") or "",
            model_identifier = model_string,
            reasoning_effort = None,
            vision_review_outcome = outcome,
            b_succeeded = b_acceptable,
            origin = figure.get("_visualOrigin") or VisualNeedInferrer.ORIGIN_DECLARED,
        )

    def __collect_requests(self) -> list:
        collected_requests = []
        for topic_summary in (self.__coverage_summaries.get("topics") or []):
            topic_chain = topic_summary.get("topicChain") or []
            for visual in (topic_summary.get("visuals") or []):
                collected_requests.append({
                    "topicChain": topic_chain,
                    "description": visual.get("description") or "",
                    "kind": visual.get("kind") or "",
                    # DECLARED (the coverage summary named it) vs INFERRED (the
                    # pipeline judged the topic needed it). Carried to the audit
                    # trail so the record does not present a judgement as an
                    # instruction.
                    "origin": visual.get("origin") or VisualNeedInferrer.ORIGIN_DECLARED,
                })
        return collected_requests

    @staticmethod
    def __needs_escalation(figure) -> bool:
        """
        True when the routed format produced nothing usable — either it returned
        no figure at all, or it returned only a description. Both mean the topic
        is about to lose its visual, which is what escalation exists to prevent.
        """
        return figure is None or figure.get("_wasDeclined") is True

    async def __generate_one(self, visual_request: dict):
        method = VisualMethodRouter.resolve_method(visual_request["kind"])

        if method == VisualGenerationMethods.RASTER_IMAGE:
            # Illustrative visuals go through the existing image-generation path
            # (GoogleEnterpriseAiProvider's image branch, the same one
            # EnhanceImages drives). Not reimplemented here — this class only
            # decides that the raster route applies and hands over the request.
            figure = await self.__generate_raster(visual_request)
        else:
            figure = await self.__generate_symbolic(visual_request, method)

        # A failure here is usually a statement about the FORMAT, not about the
        # visual. SMILES carries one bare molecule, so "butane as skeletal,
        # dash-wedge, Newman and Fischer" or "nine groups with their names"
        # cannot be expressed in it at all — the model has no option but to
        # decline, however drawable the figure actually is. The raster route
        # likewise returns nothing when image generation refuses or errors.
        # INLINE_SVG can carry panels, wedges, projections and labels, so the
        # request is re-put in that format before the topic loses its figure.
        if PaidDeckVisualGenerator.__needs_escalation(figure) and method != VisualGenerationMethods.INLINE_SVG:
            escalated_figure = await self.__generate_symbolic(visual_request, VisualGenerationMethods.INLINE_SVG)

            if escalated_figure is not None and escalated_figure.get("_wasDeclined") is not True:
                return escalated_figure

            figure = escalated_figure if escalated_figure is not None else figure

        # A figure that is still only a description is dropped. Rendering the
        # description instead put a wall of specification prose where the reader
        # expected a picture — longer than the lesson around it, and unreadable
        # as content. A missing figure is a gap; that was a defect on the page.
        if figure is not None and figure.get("_wasDeclined") is True:
            await self.__record(
                visual_request, VisualGenerationMethods.INLINE_SVG, None, None,
                "Declined in both its routed format and SVG — dropped rather than shown as description text.",
                False,
            )
            return None

        return figure

    async def __generate_symbolic(self, visual_request: dict, method: VisualGenerationMethods):
        topic_chain = visual_request["topicChain"]
        model_string, provider_class = ModelPool.PAID_DECK_SYMBOLIC_VISUAL_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.PAID_DECK_SYMBOLIC_VISUAL_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.PAID_DECK_SYMBOLIC_VISUAL_USER
                        .replace("{subject_name}", self.__subject_name)
                        .replace("{topic_chain}", " > ".join(topic_chain))
                        .replace("{output_format}", method.name)
                        .replace("{visual_description}", visual_request["description"]),
                    # Explicitly HIGH, never inherited. See the class docstring.
                    {"reasoning_effort": ReasoningEffortLevels.HIGH},
                ),
            ],
        )

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            await self.__record(visual_request, method, model_string, None, f"Generation failed: {call_error}", False)
            return None

        if response is None:
            await self.__record(visual_request, method, model_string, None, "No response from provider.", False)
            return None

        parsed = strip_json_markdown(response.get_output(0).get_data())

        if not isinstance(parsed, dict):
            await self.__record(visual_request, method, model_string, None, "Unusable response shape.", False)
            return None

        status = str(parsed.get("status") or "").strip().lower()
        caption = str(parsed.get("caption") or visual_request["description"]).strip()

        if status == "described":
            description_text = str(parsed.get("description") or "").strip()
            if not description_text:
                await self.__record(visual_request, method, model_string, None, "Declined with no description supplied.", False)
                return None

            decline_reason = str(parsed.get("declineReason") or "").strip()
            await self.__record(
                visual_request, VisualGenerationMethods.LABELLED_DESCRIPTION, model_string,
                None, f"Declined to draw; supplied a labelled description. Reason: {decline_reason}", True,
            )
            return self.__build_description_figure(visual_request, caption, description_text)

        if status == "decomposed":
            parts = parsed.get("parts")
            if not isinstance(parts, list) or not parts:
                await self.__record(visual_request, method, model_string, None, "Declined with no parts supplied.", False)
                return None

            # Decomposed parts stay together as ONE composite figure — together
            # they are the visual the topic asked for, and splitting them across
            # the lesson would separate halves of one explanation.
            #
            # Each part keeps its OWN caption. For a comparison plate ("nine
            # functional groups, one molecule each, named") the pairing of
            # drawing to name IS the entire instructional content; concatenating
            # bare markup and dropping the captions yields a row of anonymous
            # structures that teaches nothing.
            composite_parts = []

            for part in parts:
                if not isinstance(part, dict):
                    continue

                part_markup = PaidDeckVisualGenerator.__sanitize_markup(str(part.get("markup") or ""), method)

                if not part_markup:
                    continue

                composite_parts.append({
                    "markup": part_markup,
                    "caption": str(part.get("caption") or "").strip(),
                })

            if not composite_parts:
                await self.__record(visual_request, method, model_string, None, "Decomposed parts carried no usable markup.", False)
                return None

            combined_markup = "".join(part["markup"] for part in composite_parts)
            return await self.__finalize_symbolic(
                visual_request, method, model_string, combined_markup, caption, response,
                composite_parts = composite_parts,
            )

        markup = PaidDeckVisualGenerator.__sanitize_markup(str(parsed.get("markup") or ""), method)

        if not markup:
            await self.__record(visual_request, method, model_string, None, "Returned no usable markup.", False)
            return None

        return await self.__finalize_symbolic(visual_request, method, model_string, markup, caption, response)

    async def __finalize_symbolic(self, visual_request, method, model_string, markup, caption, response, composite_parts = None):
        """
        Turns produced markup into a figure dict, rasterising SVG so the vision
        review has real pixels to work with.

        For a SINGLE SVG, a rasterisation failure is a REJECTION of the diagram
        rather than a missing preview: markup that will not render is markup that
        would have appeared as a blank space in a paid deck.

        A COMPOSITE is different. Its combined markup is several `<svg>` elements
        end to end, which is not one parseable SVG document, so rasterising it
        was never going to succeed — treating that as a rejection silently
        discarded every decomposed diagram. Each panel is therefore rasterised
        individually, and only a composite whose panels ALL fail to render is
        rejected.
        """
        raster_bytes = None

        if method == VisualGenerationMethods.INLINE_SVG:
            if composite_parts:
                for part in composite_parts:
                    raster_bytes = PaidDeckVisualGenerator.__rasterize_svg(part["markup"])
                    if raster_bytes is not None:
                        break
            else:
                raster_bytes = PaidDeckVisualGenerator.__rasterize_svg(markup)

            if raster_bytes is None:
                await self.__record(
                    visual_request, method, model_string, None,
                    "Generated SVG could not be rendered — discarded rather than shipped as a blank figure.",
                    False,
                )
                return None

        panel_note = f" as {len(composite_parts)} composite panel(s)" if composite_parts else ""

        await self.__record(
            visual_request, method, model_string, ReasoningEffortLevels.HIGH,
            f"Produced {method.name} markup ({len(markup)} characters){panel_note}.", True,
            usage_metadata = response.get_usage_metadata(),
        )

        return self.__build_figure(visual_request, caption, markup, raster_bytes, method, composite_parts)

    async def __generate_raster(self, visual_request: dict):
        """
        Illustrative/conceptual visuals. Delegates to the existing image path via
        the provider's generate_image metadata flag — the same branch
        EnhanceImages and DiagramImageEnhancer already use. There is deliberately
        no second image generator in this codebase.
        """
        topic_chain = visual_request["topicChain"]
        model_string, provider_class = ModelPool.STUDY_MATERIAL_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    f"A clean, labelled educational illustration for a {self.__subject_name} study deck.\n"
                    f"Topic: {' > '.join(topic_chain)}.\n"
                    f"It must show: {visual_request['description']}\n"
                    f"Label every part shown. No watermark, no signature, no decorative border.",
                    {"generate_image": True},
                ),
            ],
        )

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            await self.__record(visual_request, VisualGenerationMethods.RASTER_IMAGE, model_string, None, f"Image generation failed: {call_error}", False)
            return None

        if response is None or not response.get_outputs():
            await self.__record(visual_request, VisualGenerationMethods.RASTER_IMAGE, model_string, None, "Image generation produced nothing.", False)
            return None

        image_bytes = None
        for output in response.get_outputs():
            if output.get_content_type() == AutomationContentTypes.IMAGE and isinstance(output.get_data(), bytes):
                image_bytes = output.get_data()
                break

        if image_bytes is None:
            await self.__record(visual_request, VisualGenerationMethods.RASTER_IMAGE, model_string, None, "Image generation returned no image bytes.", False)
            return None

        await self.__record(
            visual_request, VisualGenerationMethods.RASTER_IMAGE, model_string, None,
            f"Produced a raster illustration ({len(image_bytes)} bytes).", True,
        )

        return self.__build_figure(visual_request, visual_request["description"], None, image_bytes, VisualGenerationMethods.RASTER_IMAGE)

    def __build_figure(self, visual_request, caption, markup, image_bytes, method, composite_parts = None) -> dict:
        return {
            "pageNumber": None,
            "boundingBoxCoordinates": None,
            "captionText": caption,
            "figureRef": None,
            "perceptualImageHash": PaidDeckVisualGenerator.__build_stable_hash(visual_request, method),
            "imageBytes": image_bytes,
            "markupHtml": markup,
            # Present only for a decomposed visual. Each entry is {markup, caption},
            # and the injector lays them out as a captioned grid rather than
            # inlining `markupHtml` as one anonymous run of panels.
            "compositeParts": composite_parts,
            "informationSourceHash": PaidDeckVisualGenerator.SOURCE_HASH_MARKER,
            "_isGeneratedVisual": True,
            "_visualKind": visual_request["kind"],
            "_visualMethod": method.name,
            "_topicChain": visual_request["topicChain"],
            "_visualDescription": visual_request["description"],
            "_visualOrigin": visual_request.get("origin") or VisualNeedInferrer.ORIGIN_DECLARED,
        }

    def __build_description_figure(self, visual_request, caption, description_text) -> dict:
        """
        The escape hatch's output. Rendered as a labelled text block rather than
        a picture, and explicitly marked so the review gate and the audit report
        both show that a diagram was asked for and deliberately not drawn.
        """
        escaped_description = (
            description_text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        markup = (
            f'<div class="generated-visual-description">'
            f'<strong>Described figure:</strong> {escaped_description}'
            f'</div>'
        )
        figure = self.__build_figure(visual_request, caption, markup, None, VisualGenerationMethods.LABELLED_DESCRIPTION)
        figure["_wasDeclined"] = True
        return figure

    @staticmethod
    def __build_stable_hash(visual_request, method) -> str:
        """
        Deterministic identity for a generated visual, standing in for the
        perceptual hash a PDF-extracted figure carries. Derived from the topic,
        description and method so re-running a stage produces the same key and
        the figure de-duplicates against itself rather than piling up.
        """
        import hashlib

        identity = "|".join([
            " > ".join(visual_request["topicChain"]),
            visual_request["description"],
            method.name,
        ])
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]

    # Markup that must never reach the client, checked here rather than relying
    # only on the frontend sanitiser. Defence in depth: the sanitiser is the
    # enforcement point, this is the "we did not even generate it" point.
    __FORBIDDEN_MARKUP_PATTERN = re.compile(
        r"<\s*(script|foreignObject|image|iframe|use)\b|\son\w+\s*=|javascript:|xlink:href",
        re.IGNORECASE,
    )

    @staticmethod
    def __sanitize_markup(raw_markup: str, method: VisualGenerationMethods) -> str:
        """
        Strips code fences and rejects markup carrying anything scriptable.

        Rejection is total — a partially-cleaned SVG is not worth the risk, and a
        model that returned a script tag in a diagram has produced output we have
        no reason to trust the rest of.
        """
        markup = (raw_markup or "").strip()

        if not markup:
            return ""

        fence_match = re.match(r"^```[a-zA-Z]*\s*\n?(.*?)\n?```$", markup, re.DOTALL)
        if fence_match:
            markup = fence_match.group(1).strip()

        if PaidDeckVisualGenerator.__FORBIDDEN_MARKUP_PATTERN.search(markup):
            print("[PaidDeckVisualGenerator] Generated markup contained a forbidden construct — discarding it.")
            return ""

        if method == VisualGenerationMethods.INLINE_SVG and "<svg" not in markup.lower():
            return ""

        if method == VisualGenerationMethods.KATEX:
            return f'<span class="katex-expression">\\({markup}\\)</span>'

        if method == VisualGenerationMethods.SMILES:
            return f'<span class="smiles-structure" data-smiles="{markup}"></span>'

        if method == VisualGenerationMethods.MERMAID:
            return f'<pre class="mermaid">{markup}</pre>'

        return markup

    @staticmethod
    def __rasterize_svg(svg_markup: str):
        """
        Renders SVG to PNG with PyMuPDF so the vision review sees what a student
        would see. Returns None when the markup will not render — which is itself
        the verdict, not a missing nicety.
        """
        try:
            import fitz

            svg_document = fitz.open(stream = svg_markup.encode("utf-8"), filetype = "svg")
            try:
                pixel_map = svg_document.load_page(0).get_pixmap(dpi = PaidDeckVisualGenerator.REVIEW_RASTER_DPI)
                return pixel_map.tobytes("png")
            finally:
                svg_document.close()
        except Exception as rasterize_error:
            print(f"[PaidDeckVisualGenerator] SVG did not render: {rasterize_error}")
            return None

    async def __record(self, visual_request, method, model_string, reasoning_effort, outcome, b_succeeded, usage_metadata = None):
        if self.__action_log is None:
            return
        await self.__action_log.record_visual(
            topic_chain = visual_request["topicChain"],
            description = visual_request["description"],
            kind_name = visual_request["kind"],
            method_name = method.name,
            model_identifier = model_string,
            reasoning_effort = reasoning_effort,
            vision_review_outcome = None,
            b_succeeded = b_succeeded,
            origin = visual_request.get("origin") or VisualNeedInferrer.ORIGIN_DECLARED,
        )
        await self.__action_log.record_llm_call(
            phase_name = "VISUAL_GENERATION",
            model_identifier = model_string,
            prompt_identifier = "PAID_DECK_SYMBOLIC_VISUAL_SYSTEM",
            reasoning_effort = reasoning_effort,
            usage_metadata = usage_metadata,
            outcome = f"{' > '.join(visual_request['topicChain'])}: {outcome}",
            b_succeeded = b_succeeded,
        )
