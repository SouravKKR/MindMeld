"""
RefineVisual — stdin/stdout one-shot worker that redraws, replaces or removes
ONE diagram inside an existing passage.

Spawned per-request by Dock from the refinement UI.

Wire protocol:

  stdin  ── one JSON object:
            { action, beforeHtml, visualId, figureOrdinal, expectedCaptionText,
              description, visualKind, subjectName, topicChain, captionText }

            action is REFINE (redraw from the reviewer's revised description),
            REPLACE (draw something different in its place) or REMOVE.

  stdout ── exactly one JSON line:
            { "revisedHtml": "...", "summary": "...", "concerns": "...",
              "visionReviewOutcome": "...", "visualMethod": "...",
              "modelIdentifier": "..." }
            or { "error": "..." }. Exit 0 on success, non-zero otherwise.

  stderr ── human-readable progress.

A redrawn diagram goes through the SAME production path as one the generation
pipeline drew: the same kind-to-format routing, the same markup screen, the same
rasterisation, and above all the same vision review that looks at the rendered
pixels and asks whether the labels are complete, legible and depict what the
figure claims. A refinement path with a weaker gate than the pipeline it patches
would mean the way to get a bad diagram published is to ask for it twice.

REMOVE makes no model call at all. Deleting an element is deterministic, and
spending a premium vision-model round trip to confirm that a figure the reviewer
asked to delete should be deleted would be theatre.
"""

import asyncio
import json
import sys
from pathlib import Path

_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from Globals.Utility.EnvironmentLoader import EnvironmentLoader


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    sys.stderr.write(f"[RefineVisual worker] {message}\n")
    sys.stderr.flush()


def _read_request_body() -> dict:
    raw_text = sys.stdin.read()
    if not raw_text or not raw_text.strip():
        raise ValueError("Empty stdin payload — Dock did not write a request body.")
    return json.loads(raw_text)


class VisualRefiner:
    """
    Produces the replacement markup for one figure by driving the same generator
    the deck pipeline uses, then splices it into the passage.
    """

    ACTION_REFINE = "REFINE"
    ACTION_REPLACE = "REPLACE"
    ACTION_REMOVE = "REMOVE"

    ALLOWED_ACTIONS = {ACTION_REFINE, ACTION_REPLACE, ACTION_REMOVE}

    # Figure numbering only feeds the "Fig. N" fallback caption, and a
    # single-figure refinement has no numbering context to draw on. The reviewer
    # supplies a caption in practice; this keeps the fallback from reading as a
    # confident claim about the figure's position in the lesson.
    REPLACEMENT_FIGURE_NUMBER = 1

    @staticmethod
    def remove_figure(before_html: str, figure: dict) -> dict:
        from Globals.Classes.Generation.FigureLocator import FigureLocator

        return {
            "revisedHtml": FigureLocator.remove(before_html, figure),
            "summary": "Removed the figure.",
            "concerns": "",
            "visionReviewOutcome": "Not applicable — the figure was removed, not redrawn.",
            "visualMethod": "",
            "modelIdentifier": "",
        }

    @classmethod
    async def redraw_figure(
        cls,
        before_html: str,
        figure: dict,
        description: str,
        visual_kind: str,
        caption_text: str,
        subject_name: str,
        exam_name: str,
        topic_chain: list,
    ) -> dict:
        from Globals.Classes.Generation.FigureLocator import FigureLocator
        from Workflows.PrepareImages.PaidDeckVisualGenerator import PaidDeckVisualGenerator

        # A one-topic, one-visual coverage summary: the same input shape the
        # pipeline builds for a whole deck, narrowed to the single figure that
        # was asked for. Inference is off, so the generator produces exactly
        # this visual and nothing it thinks the topic also needs.
        coverage_summaries = {
            "topics": [
                {
                    "topicChain": topic_chain,
                    "visuals": [
                        {
                            "description": description,
                            "kind": visual_kind,
                        }
                    ],
                }
            ]
        }

        generator = PaidDeckVisualGenerator(
            subject_name = subject_name,
            coverage_summaries = coverage_summaries,
            exam_name = exam_name,
            action_log = None,
            b_infer_additional_visuals = False,
        )

        accepted_figures = await generator.generate_all()

        if not accepted_figures:
            rejected_figures = generator.get_rejected_figures()

            if rejected_figures:
                raise RuntimeError(
                    "The redrawn diagram did not pass visual review: "
                    f"{rejected_figures[0].get('_visionReviewOutcome') or 'no reason recorded'}"
                )

            raise RuntimeError(
                "No diagram could be produced for that description. A different visual kind, "
                "or a description that names what must be labelled, usually helps."
            )

        produced_figure = accepted_figures[0]

        # The caption the reviewer typed wins over the generator's own: they are
        # looking at the lesson and know what the figure is being called in the
        # prose around it.
        effective_caption = (caption_text or "").strip() or (produced_figure.get("captionText") or "")

        replacement_markup = cls.__build_figure_markup(produced_figure, effective_caption)

        if not replacement_markup:
            raise RuntimeError("The diagram was produced but could not be rendered into the passage.")

        return {
            "revisedHtml": FigureLocator.replace(before_html, figure, replacement_markup),
            "summary": f"Redrew the figure as {produced_figure.get('_visualMethod') or 'a diagram'}.",
            "concerns": "",
            "visionReviewOutcome": produced_figure.get("_visionReviewOutcome") or "",
            "visualMethod": produced_figure.get("_visualMethod") or "",
            "modelIdentifier": cls.__resolve_model_identifier(),
        }

    @staticmethod
    def __build_figure_markup(produced_figure: dict, caption_text: str) -> str:
        """
        Renders the produced figure through the same builders the pipeline uses,
        so a refined diagram is indistinguishable in the markup from one that
        was generated in the original run.
        """
        from Workflows.PrepareImages.HtmlInjector import HtmlInjector

        visual_id = produced_figure.get("perceptualImageHash") or ""
        composite_parts = produced_figure.get("compositeParts")

        if composite_parts:
            composite_markup = HtmlInjector.build_composite_figure_html(
                composite_parts,
                caption_text,
                VisualRefiner.REPLACEMENT_FIGURE_NUMBER,
                visual_id = visual_id,
            )
            if composite_markup:
                return composite_markup

        markup_html = produced_figure.get("markupHtml")

        if markup_html:
            return HtmlInjector.build_markup_figure_html(
                markup_html,
                caption_text,
                VisualRefiner.REPLACEMENT_FIGURE_NUMBER,
                visual_id = visual_id,
            )

        if produced_figure.get("imageBytes"):
            return HtmlInjector.build_figure_html(
                produced_figure["imageBytes"],
                caption_text,
                VisualRefiner.REPLACEMENT_FIGURE_NUMBER,
                visual_id = visual_id,
            )

        return ""

    @staticmethod
    def __resolve_model_identifier() -> str:
        from Globals.Classes.Automation.Pools.ModelPool import ModelPool

        model_string, _ = ModelPool.PAID_DECK_SYMBOLIC_VISUAL_MODEL
        return model_string


async def run() -> int:
    EnvironmentLoader.load()

    try:
        request_body = _read_request_body()
    except Exception as parse_error:
        _emit({"error": f"Bad request body: {parse_error}"})
        return 1

    action = str(request_body.get("action") or "").strip().upper()
    if action not in VisualRefiner.ALLOWED_ACTIONS:
        _emit({"error": f"Unsupported action '{action}'."})
        return 1

    before_html = request_body.get("beforeHtml")
    if not isinstance(before_html, str) or not before_html.strip():
        _emit({"error": "beforeHtml is required and must be a non-empty string."})
        return 1

    from Globals.Classes.Generation.FigureLocator import FigureLocator

    figure_ordinal = request_body.get("figureOrdinal")
    figure, failure_reason = FigureLocator.locate(
        before_html,
        visual_id = str(request_body.get("visualId") or ""),
        ordinal = figure_ordinal if isinstance(figure_ordinal, int) else None,
        expected_caption_text = str(request_body.get("expectedCaptionText") or ""),
    )

    if figure is None:
        _emit({"error": f"Could not locate that figure: {failure_reason}."})
        return 1

    if action == VisualRefiner.ACTION_REMOVE:
        _log("Removing the located figure — no model call needed.")
        _emit(VisualRefiner.remove_figure(before_html, figure))
        return 0

    description = str(request_body.get("description") or "").strip()
    if not description:
        _emit({"error": "description is required when redrawing a figure."})
        return 1

    visual_kind = str(request_body.get("visualKind") or "").strip().upper()
    if not visual_kind:
        _emit({"error": "visualKind is required when redrawing a figure."})
        return 1

    topic_chain = request_body.get("topicChain") or []
    if not isinstance(topic_chain, list):
        topic_chain = []

    _log(f"{action} figure {figure['ordinal'] + 1} as {visual_kind}.")

    try:
        result = await VisualRefiner.redraw_figure(
            before_html,
            figure,
            description,
            visual_kind,
            str(request_body.get("captionText") or ""),
            str(request_body.get("subjectName") or "").strip() or "the subject",
            str(request_body.get("examName") or "").strip(),
            [str(entry) for entry in topic_chain],
        )
    except Exception as refinement_error:
        _emit({"error": f"{refinement_error}"})
        return 1

    _emit(result)
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding = "utf-8")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding = "utf-8")
        except Exception:
            pass

    sys.exit(asyncio.run(run()))
