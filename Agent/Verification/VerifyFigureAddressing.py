"""
Verification harness for per-figure addressing and figure-preserving refinement.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyFigureAddressing.py    (Windows)
    .venv/bin/python Verification/VerifyFigureAddressing.py            (Linux)

Pure: no network, no model, no services.

What it protects. Refinement lets a reviewer act on ONE diagram in a lesson that
may hold several, and on prose that has diagrams embedded in it. Three separate
ways that goes wrong silently, each pinned here:

  * FigureLocator resolving the WRONG figure. Content generated before
    data-visual-id existed can only be addressed by position, and position moves.
    Redrawing the diagram next to the one the reviewer meant is not something a
    before/after comparison of a long lesson reliably surfaces.

  * FigurePlaceholderCodec LOSING a figure. A text refinement never shows the
    model the figures at all; if a placeholder comes back missing, the diagram
    must reappear somewhere and the reviewer must be told, not have it quietly
    dropped from a lesson that still reads correctly.

  * HtmlInjector emitting markup the addressing cannot then find. The stamp and
    the reader have to agree, so the injector's real output is parsed back here
    rather than a hand-written approximation of it.
"""

import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Classes.Generation.FigureLocator import FigureLocator
from Globals.Classes.Generation.FigurePlaceholderCodec import FigurePlaceholderCodec

from Workflows.PrepareImages.HtmlInjector import HtmlInjector


passed_count = 0
failed_count = 0


def assert_that(condition: bool, description: str) -> None:
    global passed_count, failed_count
    if condition:
        passed_count += 1
        print(f"  PASS  {description}")
    else:
        failed_count += 1
        print(f"  FAIL  {description}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


PASSAGE_WITH_THREE_FIGURES = (
    "<h2>Refraction</h2><p>Light bends.</p>"
    '<figure class="generated-figure" data-visual-id="aaa111" style="margin: 1em 0;">'
    "<svg>ray</svg><figcaption>Ray diagram</figcaption></figure>"
    "<p>More prose.</p>"
    '<figure class="generated-figure" style="margin: 1em 0;">'
    '<pre class="mermaid">graph TD;</pre><figcaption>Process flow</figcaption></figure>'
    "<p>Closing prose.</p>"
    '<figure class="extracted-figure" style="margin: 1em 0;">'
    '<img src="data:image/jpeg;base64,AAAA"><figcaption>Apparatus</figcaption></figure>'
)


def main() -> int:
    section("FigureLocator enumerates what is there")

    figures = FigureLocator.list_figures(PASSAGE_WITH_THREE_FIGURES)
    assert_that(len(figures) == 3, "All three figures are found")
    assert_that([figure["ordinal"] for figure in figures] == [0, 1, 2], "Ordinals follow document order")
    assert_that(figures[0]["visualId"] == "aaa111", "A stamped visual id is read back")
    assert_that(figures[1]["visualId"] == "", "An unstamped figure reports no id rather than guessing one")
    assert_that(
        [figure["captionText"] for figure in figures] == ["Ray diagram", "Process flow", "Apparatus"],
        "Caption text is extracted for each figure",
    )
    assert_that(
        FigureLocator.list_figures("<p>No figures here.</p>") == [],
        "A passage with no figures yields an empty list",
    )

    section("Addressing by stable id")

    located, reason = FigureLocator.locate(PASSAGE_WITH_THREE_FIGURES, visual_id = "aaa111")
    assert_that(located is not None and located["ordinal"] == 0, "A known id resolves to its figure")

    located, reason = FigureLocator.locate(PASSAGE_WITH_THREE_FIGURES, visual_id = "gone999", ordinal = 1)
    assert_that(
        located is None and "no longer in the passage" in reason,
        "A stale id refuses rather than falling back to the ordinal and redrawing a different figure",
    )

    section("Addressing by position, guarded by the caption")

    located, reason = FigureLocator.locate(
        PASSAGE_WITH_THREE_FIGURES, ordinal = 1, expected_caption_text = "Process flow"
    )
    assert_that(located is not None and located["ordinal"] == 1, "An ordinal with a matching caption resolves")

    located, reason = FigureLocator.locate(
        PASSAGE_WITH_THREE_FIGURES, ordinal = 1, expected_caption_text = "Ray diagram"
    )
    assert_that(
        located is None and "changed since" in reason,
        "An ordinal whose caption no longer matches refuses — the passage moved underneath the reviewer",
    )

    located, reason = FigureLocator.locate(PASSAGE_WITH_THREE_FIGURES, ordinal = 7)
    assert_that(located is None and "there is no figure 8" in reason, "An out-of-range ordinal refuses")

    located, reason = FigureLocator.locate("<p>Nothing here.</p>", ordinal = 0)
    assert_that(located is None and "no figures" in reason, "Locating in a figureless passage refuses")

    section("Replacing and removing touch only the addressed figure")

    target, _ = FigureLocator.locate(PASSAGE_WITH_THREE_FIGURES, ordinal = 1, expected_caption_text = "Process flow")

    replaced = FigureLocator.replace(PASSAGE_WITH_THREE_FIGURES, target, "<figure>NEW</figure>")
    assert_that("NEW" in replaced, "The replacement markup is present")
    assert_that("mermaid" not in replaced, "The replaced figure is gone")
    assert_that('data-visual-id="aaa111"' in replaced, "The figure above is untouched")
    assert_that("Apparatus" in replaced, "The figure below is untouched")
    assert_that("Closing prose." in replaced, "The surrounding prose is untouched")

    removed = FigureLocator.remove(PASSAGE_WITH_THREE_FIGURES, target)
    assert_that(len(FigureLocator.list_figures(removed)) == 2, "Removal leaves exactly the other two figures")
    assert_that("More prose." in removed and "Closing prose." in removed, "Removal leaves the prose intact")

    section("FigurePlaceholderCodec holds figures back from the model")

    stripped, original_figures = FigurePlaceholderCodec.extract(PASSAGE_WITH_THREE_FIGURES)
    assert_that(len(original_figures) == 3, "All three figures are held back")
    assert_that("base64" not in stripped, "The base64 image payload never reaches the model")
    assert_that("<svg>" not in stripped and "mermaid" not in stripped, "Diagram markup never reaches the model")
    assert_that("Light bends." in stripped, "The prose the model has to work on survives")
    assert_that(len(stripped) < len(PASSAGE_WITH_THREE_FIGURES), "The stripped passage is smaller")

    restored, dropped_count = FigurePlaceholderCodec.restore(stripped, original_figures)
    assert_that(dropped_count == 0, "An untouched round trip drops nothing")
    assert_that(restored == PASSAGE_WITH_THREE_FIGURES, "An untouched round trip is byte-identical")

    section("A model that edits prose keeps its figures exactly")

    edited = stripped.replace("Light bends.", "Light bends when it changes medium.")
    restored, dropped_count = FigurePlaceholderCodec.restore(edited, original_figures)
    assert_that(dropped_count == 0, "Editing prose around the placeholders drops nothing")
    assert_that("Light bends when it changes medium." in restored, "The prose edit survives")
    assert_that(
        len(FigureLocator.list_figures(restored)) == 3,
        "All three figures come back",
    )
    assert_that(
        'data-visual-id="aaa111"' in restored and "base64,AAAA" in restored,
        "Figures come back byte-identical, ids and payloads intact",
    )

    section("A model that drops a placeholder is caught, not obeyed")

    mangled = stripped.replace('<figure data-refine-figure="1"></figure>', "")
    restored, dropped_count = FigurePlaceholderCodec.restore(mangled, original_figures)
    assert_that(dropped_count == 1, "The dropped figure is counted so the reviewer can be told")
    assert_that(len(FigureLocator.list_figures(restored)) == 3, "The dropped figure is re-appended, never lost")

    section("HtmlInjector output is addressable by what it stamps")

    injected_markup = HtmlInjector.build_markup_figure_html(
        "<svg>circuit</svg>", "A series circuit", 4, visual_id = "hash1234",
    )
    injected_figures = FigureLocator.list_figures(injected_markup)
    assert_that(len(injected_figures) == 1, "The injector emits one parseable figure")
    assert_that(injected_figures[0]["visualId"] == "hash1234", "The stamped id is the one the locator reads back")
    assert_that(injected_figures[0]["captionText"] == "A series circuit", "The caption round-trips")

    unstamped_markup = HtmlInjector.build_markup_figure_html("<svg>circuit</svg>", "No id", 4)
    assert_that(
        "data-visual-id" not in unstamped_markup,
        "No id supplied means no empty attribute emitted",
    )

    composite_markup = HtmlInjector.build_composite_figure_html(
        [{"markup": "<svg>a</svg>", "caption": "Panel A"}, {"markup": "<svg>b</svg>", "caption": "Panel B"}],
        "Comparison plate",
        5,
        visual_id = "composite77",
    )
    composite_figures = FigureLocator.list_figures(composite_markup)
    assert_that(len(composite_figures) == 1, "A composite plate is ONE figure, not one per panel")
    assert_that(composite_figures[0]["visualId"] == "composite77", "The composite carries the stamped id")
    assert_that(
        composite_figures[0]["captionText"] == "Comparison plate",
        "The plate's own caption is read, not the last panel's",
    )

    print(f"\nPassed: {passed_count}   Failed: {failed_count}")
    return 1 if failed_count > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
