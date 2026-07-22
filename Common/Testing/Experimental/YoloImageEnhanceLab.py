"""
YoloImageEnhanceLab.py
======================

A standalone, menu-driven experimentation harness for the two most
expensive halves of the CogniumLearn image pipeline:

  1. YOLO figure detection           (Agent/Workflows/PrepareImages/ImageExtractor.py)
  2. LLM "is this educational" gate   (mirrors PrepareImages._validate_figures_with_vision)
  3. Image enhancement                (Agent/Workflows/EnhanceImages/DiagramImageEnhancer.py -> Gemini describe -> GPT-Image)

It does NOT touch any production code. It imports the real Agent classes,
runs them against a PDF you pick from Explorer, and writes every
intermediate artifact to disk so you can see -- and optimise -- exactly
what each stage produced and what it cost.

Output, per run, under  Common/Testing/Experimental/Output/<pdf>_<timestamp>/:

    01_yolo_detected/    every crop YOLO (+ vector/embedded fallbacks) found
    02_llm_confirmed/    only the crops the LLM gate kept as educational
    03_enhanced/         the regenerated diagrams / extracted text
    report.txt           human-readable detection + cost summary
    report.json          the same data, machine-readable
    run.log              full transcript of the run

COST: real Gemini token usage is captured live (by wrapping CreditMeter.record
-- at runtime only, no files are modified) and converted to USD with the
editable PRICING table below. Because Gemini is not instant, the running cost
is printed after every call so you can stop early if it climbs.

How to run:
    Common/Testing/Experimental/RunYoloImageEnhanceLab.bat
  (or)  Agent/.venv/Scripts/python.exe Common/Testing/Experimental/YoloImageEnhanceLab.py

Requires the Agent's virtualenv (it has fitz, doclayout-yolo, google-genai,
imagehash, etc.). The .bat launcher points at Agent/.venv automatically.
"""

import os
import sys
import io
import json
import time
import queue
import threading
import traceback
from datetime import datetime


# ----------------------------------------------------------------------------
# Path + environment wiring. The Agent code imports `Globals.*` / `Workflows.*`
# relative to the Agent/ directory, so we put Agent/ on sys.path and load its
# .env (GEMINI_API_KEY etc.) before any project import happens.
# ----------------------------------------------------------------------------
THIS_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
REPOSITORY_ROOT = os.path.abspath(os.path.join(THIS_DIRECTORY, "..", "..", ".."))
AGENT_DIRECTORY = os.path.join(REPOSITORY_ROOT, "Agent")
OUTPUT_ROOT_DIRECTORY = os.path.join(THIS_DIRECTORY, "Output")

if AGENT_DIRECTORY not in sys.path:
    sys.path.insert(0, AGENT_DIRECTORY)

# Never let this harness fire a pro-tier shadow-evaluation call (it can't
# anyway -- image requests are excluded -- but make it explicit and free).
os.environ.setdefault("SHADOW_EVALUATOR_DISABLED", "1")

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(AGENT_DIRECTORY, ".env"))
except Exception as environment_load_error:
    print(f"[startup] Could not load Agent/.env: {environment_load_error}")

# Put the local portable Graphviz `dot` binary on PATH so the SVG enhancer's
# complex -> DOT -> Graphviz route works in local testing. Production gets `dot`
# from the Docker image's apt graphviz package instead, so this is dev-only.
import glob
for _graphviz_bin in glob.glob(os.path.join(AGENT_DIRECTORY, ".tools", "Graphviz*", "bin")):
    if os.path.isdir(_graphviz_bin) and _graphviz_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _graphviz_bin + os.pathsep + os.environ.get("PATH", "")


# ----------------------------------------------------------------------------
# EDITABLE PRICING TABLE  -- USD per 1,000,000 tokens, (input, output).
#
# Source: https://ai.google.dev/gemini-api/docs/pricing  (fetched 2026-06-20).
#   - The Gemini text models mirror Agent/Globals/Constants/ModelPricing.py, the
#     repo's own source of truth for billing normalisation. They cover the YOLO
#     LLM validation gate (Stage 2).
#   - claude-sonnet-4-6 serves Stage 3: the vision -> SVG enhancement. Published
#     rate $3.00 input / $15.00 output per 1M. Output tokens include the
#     extended-thinking tokens (max effort), so the per-figure cost is dominated
#     by the SVG + thinking output. The cost report below reads REAL returned
#     token counts.
#
# Tweak these freely while you experiment -- the cost report reads straight
# from this dict.
# ----------------------------------------------------------------------------
PRICING_USD_PER_MILLION_TOKENS = {
    "gemini-2.5-flash-lite": {"input": 0.10, "output": 0.40},
    "gemini-3.1-flash-lite": {"input": 0.25, "output": 1.50},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
}
# Any model not in the table is costed at the cheapest text model's rate, with a
# one-line warning in the report, so an unregistered model never silently reads
# as free.
PRICING_FALLBACK_MODEL_NAME = "gemini-2.5-flash-lite"

# GPT-Image-2 is billed per image (not per token). High quality 1024x1024 = $0.04.
GPT_IMAGE_2_COST_PER_IMAGE_USD = 0.04

# Mirrors PrepareImages._VISION_BATCH_SIZE -- how many images go to the LLM
# validation gate per request.
VISION_VALIDATION_BATCH_SIZE = 10

# The repo's current YOLO confidence floor, shown as the default in the UI. The
# real value lives on ImageExtractor._YOLO_CONFIDENCE_THRESHOLD; the harness
# overrides that class attribute at runtime (no file edit) with whatever you type.
DEFAULT_YOLO_CONFIDENCE_THRESHOLD = 0.15


def sanitize_for_filename(raw_text: str) -> str:
    keep_characters = []
    for character in (raw_text or ""):
        if character.isalnum() or character in ("-", "_", "."):
            keep_characters.append(character)
        else:
            keep_characters.append("_")
    cleaned = "".join(keep_characters).strip("._")
    return cleaned or "unnamed"


def measure_aspect_ratio(image_bytes: bytes) -> float | None:
    """Width / height of a PNG/JPEG given as bytes, or None if unreadable."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(image_bytes)) as image:
            width, height = image.size
        if height <= 0:
            return None
        return width / height
    except Exception:
        return None


def measure_svg_aspect_ratio(svg_markup: str) -> float | None:
    """Width / height of an SVG from its viewBox (preferred) or width/height attributes."""
    import re
    try:
        viewbox_match = re.search(r'viewBox\s*=\s*["\']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)', svg_markup, re.IGNORECASE)
        if viewbox_match:
            width = float(viewbox_match.group(1))
            height = float(viewbox_match.group(2))
            return width / height if height > 0 else None
        width_match = re.search(r'\bwidth\s*=\s*["\']([\d.]+)', svg_markup, re.IGNORECASE)
        height_match = re.search(r'\bheight\s*=\s*["\']([\d.]+)', svg_markup, re.IGNORECASE)
        if width_match and height_match:
            height_value = float(height_match.group(1))
            return float(width_match.group(1)) / height_value if height_value > 0 else None
    except Exception:
        return None
    return None


def parse_page_range_text(page_range_text: str) -> set | None:
    """
    Turns "3", "3-5", "3-5,8,10-12" into a set of 1-indexed page numbers.
    Blank / None means the whole document -> returns None (no page filter).
    """
    if not page_range_text or not page_range_text.strip():
        return None

    selected_pages: set[int] = set()
    for raw_segment in page_range_text.split(","):
        segment = raw_segment.strip()
        if not segment:
            continue
        if "-" in segment:
            start_text, _, end_text = segment.partition("-")
            start_page = int(start_text.strip())
            end_page = int(end_text.strip())
            if start_page > end_page:
                start_page, end_page = end_page, start_page
            for page_number in range(start_page, end_page + 1):
                selected_pages.add(page_number)
        else:
            selected_pages.add(int(segment))

    return selected_pages or None


def cost_usd_for_ledger_entries(ledger_entries: list, unknown_models_seen: set) -> dict:
    """
    Sums USD cost over a slice of the token ledger, grouped by model. Each ledger
    entry is {"model": str, "input": int, "output": int}.
    """
    total_input_tokens = 0
    total_output_tokens = 0
    total_input_usd = 0.0
    total_output_usd = 0.0
    by_model: dict = {}

    for entry in ledger_entries:
        model_name = entry["model"] or PRICING_FALLBACK_MODEL_NAME
        pricing = PRICING_USD_PER_MILLION_TOKENS.get(model_name)
        if pricing is None:
            unknown_models_seen.add(model_name)
            pricing = PRICING_USD_PER_MILLION_TOKENS[PRICING_FALLBACK_MODEL_NAME]

        input_usd = entry["input"] / 1_000_000.0 * pricing["input"]
        output_usd = entry["output"] / 1_000_000.0 * pricing["output"]

        total_input_tokens += entry["input"]
        total_output_tokens += entry["output"]
        total_input_usd += input_usd
        total_output_usd += output_usd

        model_summary = by_model.setdefault(
            model_name,
            {"calls": 0, "inputTokens": 0, "outputTokens": 0, "usd": 0.0},
        )
        model_summary["calls"] += 1
        model_summary["inputTokens"] += entry["input"]
        model_summary["outputTokens"] += entry["output"]
        model_summary["usd"] += input_usd + output_usd

    return {
        "inputTokens": total_input_tokens,
        "outputTokens": total_output_tokens,
        "inputUsd": total_input_usd,
        "outputUsd": total_output_usd,
        "totalUsd": total_input_usd + total_output_usd,
        "byModel": by_model,
    }


# ----------------------------------------------------------------------------
# The pipeline. Runs in a worker thread under asyncio.run(); every line goes to
# `log` (GUI + run.log). It returns a report dict.
# ----------------------------------------------------------------------------
async def run_pipeline(
    pdf_path: str,
    allowed_pages: set | None,
    enhance_enabled: bool,
    maximum_images_to_enhance: int | None,
    yolo_confidence_threshold: float,
    run_directory: str,
    log,
    stop_event: threading.Event | None = None,
) -> dict:
    # Lazy imports so the GUI opens instantly and any import failure is logged
    # rather than crashing startup.
    from Workflows.PrepareImages.ImageExtractor import ImageExtractor
    from Workflows.EnhanceImages.DiagramImageEnhancer import DiagramImageEnhancer
    from Globals.Classes.Automation.Pools.ModelPool import ModelPool
    from Globals.Classes.Automation.AutomationCaller import AutomationCaller
    from Globals.Classes.Automation.AutomationRequest import AutomationRequest
    from Globals.Classes.Automation.AutomationContent import AutomationContent
    from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
    from Globals.Utility.StripJsonMarkdown import strip_json_markdown
    from Globals.Classes.Credits.CreditMeter import CreditMeter

    # --- token ledger: wrap CreditMeter.record so every Gemini call (text AND
    # image, validation AND enhance) is captured with its model + token counts.
    # This is runtime composition in the harness only; no project file changes.
    token_ledger: list = []
    original_record_function = CreditMeter.record

    def recording_shim(input_tokens=0, output_tokens=0, model=None):
        try:
            recorded_input = int(input_tokens or 0)
        except (TypeError, ValueError):
            recorded_input = 0
        try:
            recorded_output = int(output_tokens or 0)
        except (TypeError, ValueError):
            recorded_output = 0
        token_ledger.append({"model": model, "input": recorded_input, "output": recorded_output})
        return original_record_function(input_tokens, output_tokens, model)

    CreditMeter.record = staticmethod(recording_shim)

    unknown_models_seen: set = set()

    yolo_detected_directory = os.path.join(run_directory, "01_yolo_detected")
    llm_confirmed_directory = os.path.join(run_directory, "02_llm_confirmed")
    enhanced_directory = os.path.join(run_directory, "03_enhanced")
    for directory in (yolo_detected_directory, llm_confirmed_directory, enhanced_directory):
        os.makedirs(directory, exist_ok=True)

    report: dict = {
        "pdf": pdf_path,
        "pageFilter": sorted(allowed_pages) if allowed_pages else "ALL PAGES",
        "yoloConfidenceThreshold": yolo_confidence_threshold,
        "enhanceEnabled": enhance_enabled,
        "startedAt": datetime.now().isoformat(timespec="seconds"),
    }

    try:
        # ----------------------------------------------------------------
        # STAGE 1 -- YOLO detection
        # ----------------------------------------------------------------
        log("=" * 70)
        log("STAGE 1 / YOLO DETECTION")
        log("=" * 70)
        log(f"Overriding ImageExtractor confidence floor -> {yolo_confidence_threshold} "
            f"(repo default {DEFAULT_YOLO_CONFIDENCE_THRESHOLD}).")

        # Runtime override of the class constant -- the optimisation knob.
        ImageExtractor._YOLO_CONFIDENCE_THRESHOLD = yolo_confidence_threshold

        with open(pdf_path, "rb") as pdf_file:
            pdf_bytes = pdf_file.read()
        log(f"Loaded PDF ({len(pdf_bytes):,} bytes).")
        log("Running YOLO detection... first run downloads the DocLayout-YOLO "
            "weights from Hugging Face and can take a minute. Please wait.")

        import asyncio
        detection_started = time.perf_counter()
        extractor = ImageExtractor()
        extracted_figures = await asyncio.to_thread(
            extractor.extract_figures, pdf_bytes, allowed_pages
        )
        detection_seconds = time.perf_counter() - detection_started

        log(f"YOLO detection finished in {detection_seconds:.1f}s -- "
            f"{len(extracted_figures)} figure(s) detected.")

        pages_with_counts: dict = {}
        detection_manifest = []
        for figure_index, figure in enumerate(extracted_figures):
            one_indexed_page = figure["pageNumber"] + 1
            pages_with_counts[one_indexed_page] = pages_with_counts.get(one_indexed_page, 0) + 1
            file_name = (
                f"p{one_indexed_page:03d}_fig{figure_index:02d}_"
                f"{sanitize_for_filename(figure['perceptualImageHash'])}.png"
            )
            with open(os.path.join(yolo_detected_directory, file_name), "wb") as image_file:
                image_file.write(figure["imageBytes"])
            figure["_savedFileName"] = file_name
            detection_manifest.append({
                "index": figure_index,
                "savedFileName": file_name,
                "pageNumber": one_indexed_page,
                "boundingBoxCoordinates": figure["boundingBoxCoordinates"],
                "captionText": figure["captionText"],
                "figureRef": figure["figureRef"],
                "perceptualImageHash": figure["perceptualImageHash"],
            })

        for page_number in sorted(pages_with_counts):
            log(f"   page {page_number}: {pages_with_counts[page_number]} figure(s)")

        with open(os.path.join(yolo_detected_directory, "yolo_detections.json"), "w", encoding="utf-8") as manifest_file:
            json.dump(detection_manifest, manifest_file, indent=2, ensure_ascii=False)

        report["yolo"] = {
            "seconds": round(detection_seconds, 1),
            "detectedCount": len(extracted_figures),
            "perPage": pages_with_counts,
        }

        # ----------------------------------------------------------------
        # STAGE 2 -- LLM educational-content gate
        # (mirrors PrepareImages._validate_figures_with_vision; persistence and
        #  the Tier-2/Tier-3 text-pair matching are intentionally skipped --
        #  those need surrounding card/study text that does not exist in this
        #  isolated experiment.)
        # ----------------------------------------------------------------
        log("")
        log("=" * 70)
        log("STAGE 2 / LLM EDUCATIONAL-CONTENT GATE")
        log("=" * 70)

        confirmed_figures = []
        validation_results_manifest = []
        validation_ledger_start = len(token_ledger)
        validation_started = time.perf_counter()

        if not extracted_figures:
            log("No figures to validate -- skipping.")
        else:
            validation_model_name, validation_provider_class = ModelPool.IMAGE_VALIDATION_MODEL
            log(f"Validating {len(extracted_figures)} figure(s) with "
                f"{validation_model_name}, batched {VISION_VALIDATION_BATCH_SIZE} per call.")
            validation_caller = AutomationCaller(validation_provider_class())

            for batch_start in range(0, len(extracted_figures), VISION_VALIDATION_BATCH_SIZE):
                batch = extracted_figures[batch_start: batch_start + VISION_VALIDATION_BATCH_SIZE]
                batch_size = len(batch)
                log(f"   batch {batch_start // VISION_VALIDATION_BATCH_SIZE + 1}: {batch_size} image(s)...")

                inputs = [
                    AutomationContent(
                        AutomationContentTypes.SYSTEM,
                        "You are an expert educational content validator evaluating images extracted from textbooks and lecture slide decks. You will receive multiple images. Evaluate each one."
                    ),
                    AutomationContent(
                        AutomationContentTypes.TEXT,
                        (
                            f"Look at these {batch_size} images. For each one, decide whether it should appear in a study deck. "
                            f"Include the image if it contains technical detail, illustrates something that could be discussed "
                            f"in the surrounding text, or looks like the kind of figure that could be asked about in an exam. "
                            f"Exclude headers, footers, page numbers, watermarks, logos, decorative borders, and any other "
                            f"ambient junk. "
                            f"Reply strictly with a JSON array containing exactly {batch_size} objects. "
                            f"Each object must have imageCategory (string), isEducationalContent (boolean), and "
                            f"visionModelGeneratedDescription (string). "
                            f"If false, leave the description empty. "
                            f"If true, write a dense 2-sentence description of the visual concept."
                        ),
                    ),
                ]
                for figure in batch:
                    inputs.append(AutomationContent(AutomationContentTypes.IMAGE, figure["imageBytes"]))

                request = AutomationRequest(model=validation_model_name, inputs=inputs)

                try:
                    response = await validation_caller.call(request, validator=None)
                except Exception as call_error:
                    log(f"   batch raised {call_error} -- skipping batch.")
                    continue

                if response is None:
                    log("   batch returned no response -- skipping.")
                    continue

                parsed = strip_json_markdown(response.get_output(0).get_data())
                if not isinstance(parsed, list) or len(parsed) != batch_size:
                    log("   batch returned an unexpected format -- skipping.")
                    continue

                for item_index, result in enumerate(parsed):
                    figure = batch[item_index]
                    is_educational = bool(isinstance(result, dict) and result.get("isEducationalContent"))
                    category = result.get("imageCategory", "") if isinstance(result, dict) else ""
                    description = result.get("visionModelGeneratedDescription", "") if isinstance(result, dict) else ""

                    validation_results_manifest.append({
                        "savedFileName": figure["_savedFileName"],
                        "pageNumber": figure["pageNumber"] + 1,
                        "isEducationalContent": is_educational,
                        "imageCategory": category,
                        "visionModelGeneratedDescription": description,
                    })

                    if is_educational:
                        figure["_imageCategory"] = category
                        figure["_visionDescription"] = description
                        confirmed_figures.append(figure)
                        with open(os.path.join(llm_confirmed_directory, figure["_savedFileName"]), "wb") as confirmed_file:
                            confirmed_file.write(figure["imageBytes"])
                        log(f"      KEEP  {figure['_savedFileName']}  [{category}]")
                    else:
                        log(f"      drop  {figure['_savedFileName']}  [{category or 'junk'}]")

        validation_seconds = time.perf_counter() - validation_started
        validation_cost = cost_usd_for_ledger_entries(
            token_ledger[validation_ledger_start:], unknown_models_seen
        )

        with open(os.path.join(llm_confirmed_directory, "llm_confirmations.json"), "w", encoding="utf-8") as manifest_file:
            json.dump(validation_results_manifest, manifest_file, indent=2, ensure_ascii=False)

        log(f"Validation finished in {validation_seconds:.1f}s -- "
            f"{len(confirmed_figures)}/{len(extracted_figures)} kept as educational. "
            f"Cost so far: ${validation_cost['totalUsd']:.4f}")

        report["validation"] = {
            "seconds": round(validation_seconds, 1),
            "confirmedCount": len(confirmed_figures),
            "rejectedCount": len(extracted_figures) - len(confirmed_figures),
            "cost": validation_cost,
        }

        # ----------------------------------------------------------------
        # STAGE 3 -- enhancement
        # ----------------------------------------------------------------
        enhancement_records = []
        enhancement_cost_total_usd = 0.0
        enhancement_seconds = 0.0

        if not enhance_enabled:
            log("")
            log("Enhancement disabled -- stopping after the LLM gate.")
        elif not confirmed_figures:
            log("")
            log("No confirmed figures to enhance -- stopping.")
        else:
            log("")
            log("=" * 70)
            log("STAGE 3 / IMAGE ENHANCEMENT")
            log("=" * 70)

            figures_to_enhance = confirmed_figures
            if maximum_images_to_enhance is not None:
                figures_to_enhance = confirmed_figures[:maximum_images_to_enhance]
                if len(confirmed_figures) > len(figures_to_enhance):
                    log(f"Capping enhancement to the first {len(figures_to_enhance)} of "
                        f"{len(confirmed_figures)} confirmed figure(s) (your limit).")

            log(f"Enhancing {len(figures_to_enhance)} figure(s). "
                f"Each figure: Gemini describe -> GPT-Image generate. "
                f"Running cost printed after each.")

            asset_enhancer = DiagramImageEnhancer()

            for enhance_index, figure in enumerate(figures_to_enhance):
                if stop_event is not None and stop_event.is_set():
                    log(f"   Stopped by user after {enhance_index} image(s).")
                    break

                base_name = os.path.splitext(figure["_savedFileName"])[0]
                log(f"   [{enhance_index + 1}/{len(figures_to_enhance)}] {figure['_savedFileName']} ...")

                per_image_ledger_start = len(token_ledger)
                per_image_started = time.perf_counter()
                enhancement_kind = None
                output_file_name = None
                error_text = None
                original_aspect = None
                enhanced_aspect = None
                enhancement_complexity = None
                enhancement_renderer = None
                per_image_flat_cost_usd = 0.0

                try:
                    enhancement_result = await asset_enhancer.enhance(figure["imageBytes"])
                    enhancement_kind = enhancement_result["kind"]
                    enhancement_complexity = enhancement_result.get("complexity")
                    enhancement_renderer = enhancement_result.get("renderer")

                    # Always drop the original alongside for easy A/B comparison.
                    with open(os.path.join(enhanced_directory, f"{base_name}__ORIGINAL.png"), "wb") as original_file:
                        original_file.write(figure["imageBytes"])

                    if enhancement_kind == "DIAGRAM_SVG":
                        output_file_name = f"{base_name}__ENHANCED.svg"
                        with open(os.path.join(enhanced_directory, output_file_name), "w", encoding="utf-8") as svg_file:
                            svg_file.write(enhancement_result["svg"])
                        original_aspect = measure_aspect_ratio(figure["imageBytes"])
                        enhanced_aspect = measure_svg_aspect_ratio(enhancement_result["svg"])

                    elif enhancement_kind == "DIAGRAM_IMAGE_PNG":
                        # GPT-Image-2 generated a fresh PNG. Flat per-image billing.
                        output_file_name = f"{base_name}__ENHANCED.png"
                        with open(os.path.join(enhanced_directory, output_file_name), "wb") as png_file:
                            png_file.write(enhancement_result["image_bytes"])
                        original_aspect = measure_aspect_ratio(figure["imageBytes"])
                        enhanced_aspect = measure_aspect_ratio(enhancement_result["image_bytes"])
                        per_image_flat_cost_usd = GPT_IMAGE_2_COST_PER_IMAGE_USD

                    elif enhancement_kind == "TEXT_DATA":
                        output_file_name = f"{base_name}__TEXT_DATA.md"
                        with open(os.path.join(enhanced_directory, output_file_name), "w", encoding="utf-8") as markdown_file:
                            markdown_file.write(enhancement_result.get("markdown", ""))

                    else:
                        # DIAGRAM_FALLBACK_ORIGINAL: both paths failed; production
                        # keeps the original image here.
                        log("      enhancement fell back to the original figure")

                except Exception as enhance_error:
                    error_text = str(enhance_error)
                    enhancement_kind = "ERROR"
                    log(f"      enhancement failed: {error_text}")

                per_image_seconds = time.perf_counter() - per_image_started
                per_image_cost = cost_usd_for_ledger_entries(
                    token_ledger[per_image_ledger_start:], unknown_models_seen
                )
                per_image_total_usd = per_image_cost["totalUsd"] + per_image_flat_cost_usd
                enhancement_cost_total_usd += per_image_total_usd
                enhancement_seconds += per_image_seconds

                framing_note = ""
                framing_drift = None
                framing_flag = None
                if original_aspect and enhanced_aspect:
                    framing_drift = abs(original_aspect - enhanced_aspect) / original_aspect
                    framing_flag = "POSSIBLE CLIP" if framing_drift > 0.12 else "framing OK"
                    framing_note = (
                        f"  aspect {original_aspect:.3f}->{enhanced_aspect:.3f} "
                        f"({framing_drift * 100:.0f}% drift, {framing_flag})"
                    )

                enhancement_records.append({
                    "savedFileName": figure["_savedFileName"],
                    "kind": enhancement_kind,
                    "complexity": enhancement_complexity,
                    "renderer": enhancement_renderer,
                    "outputFileName": output_file_name,
                    "error": error_text,
                    "seconds": round(per_image_seconds, 1),
                    "originalAspect": round(original_aspect, 3) if original_aspect else None,
                    "enhancedAspect": round(enhanced_aspect, 3) if enhanced_aspect else None,
                    "aspectDriftFraction": round(framing_drift, 3) if framing_drift is not None else None,
                    "framingFlag": framing_flag,
                    "tokenCost": per_image_cost,
                    "flatCostUsd": per_image_flat_cost_usd,
                    "totalCostUsd": per_image_total_usd,
                })

                thinking_label = "thinking OFF" if enhancement_complexity == "simple" else "thinking ON"
                route_label = f", {enhancement_renderer}" if enhancement_renderer else ""
                complexity_note = f"  [{enhancement_complexity} -> {thinking_label}{route_label}]" if enhancement_complexity else ""
                flat_cost_note = f" + ${per_image_flat_cost_usd:.4f} GPT-img" if per_image_flat_cost_usd else ""
                log(f"      kind={enhancement_kind}{complexity_note}  {per_image_seconds:.1f}s  "
                    f"${per_image_cost['totalUsd']:.4f}{flat_cost_note}  "
                    f"(running enhance total ${enhancement_cost_total_usd:.4f}){framing_note}")

            report["enhancement"] = {
                "enhancedCount": len(figures_to_enhance),
                "seconds": round(enhancement_seconds, 1),
                "totalUsd": enhancement_cost_total_usd,
                "perImage": enhancement_records,
            }

        # ----------------------------------------------------------------
        # FINAL REPORT
        # ----------------------------------------------------------------
        grand_total_usd = validation_cost["totalUsd"] + enhancement_cost_total_usd
        report["grandTotalUsd"] = grand_total_usd
        report["unknownModelsCostedAtFallback"] = sorted(unknown_models_seen)
        report["finishedAt"] = datetime.now().isoformat(timespec="seconds")

        log("")
        log("#" * 70)
        log("SUMMARY")
        log("#" * 70)
        log(f"PDF:                 {os.path.basename(pdf_path)}")
        log(f"Pages:               {report['pageFilter']}")
        log(f"YOLO confidence:     {yolo_confidence_threshold}")
        log(f"Detected (YOLO):     {len(extracted_figures)}")
        log(f"Confirmed (LLM):     {len(confirmed_figures)}")
        if enhance_enabled:
            log(f"Enhanced:            {report.get('enhancement', {}).get('enhancedCount', 0)}")
        log("")
        log(f"Validation cost:     ${validation_cost['totalUsd']:.4f}  "
            f"({validation_cost['inputTokens']:,} in / {validation_cost['outputTokens']:,} out tokens)")
        if enhance_enabled:
            log(f"Enhancement cost:    ${enhancement_cost_total_usd:.4f}")
            confirmed_count = max(1, len(confirmed_figures))
            enhanced_count = report.get("enhancement", {}).get("enhancedCount", 0)
            if enhanced_count > 0:
                per_image_average = enhancement_cost_total_usd / enhanced_count
                log(f"Avg per enhanced img: ${per_image_average:.4f}")
                log(f"Projected if all {len(confirmed_figures)} confirmed were enhanced: "
                    f"${per_image_average * len(confirmed_figures):.4f}")
        log("")
        log(f"GRAND TOTAL:         ${grand_total_usd:.4f}")
        if unknown_models_seen:
            log(f"NOTE: models costed at fallback rate (add to PRICING table): "
                f"{', '.join(sorted(unknown_models_seen))}")
        log("")
        log(f"Artifacts written to: {run_directory}")

        with open(os.path.join(run_directory, "report.json"), "w", encoding="utf-8") as report_file:
            json.dump(report, report_file, indent=2, ensure_ascii=False)

        with open(os.path.join(run_directory, "report.txt"), "w", encoding="utf-8") as report_text_file:
            report_text_file.write(build_text_report(report))

        return report

    finally:
        # Always restore the real CreditMeter.record, even on failure.
        CreditMeter.record = staticmethod(original_record_function)


def build_text_report(report: dict) -> str:
    lines = []
    lines.append("CogniumLearn YOLO + Image-Enhance Lab -- run report")
    lines.append("=" * 60)
    lines.append(f"PDF:               {report.get('pdf')}")
    lines.append(f"Pages:             {report.get('pageFilter')}")
    lines.append(f"YOLO confidence:   {report.get('yoloConfidenceThreshold')}")
    lines.append(f"Started:           {report.get('startedAt')}")
    lines.append(f"Finished:          {report.get('finishedAt')}")
    lines.append("")

    yolo = report.get("yolo", {})
    lines.append(f"[1] YOLO detection: {yolo.get('detectedCount', 0)} figure(s) "
                 f"in {yolo.get('seconds', 0)}s")
    for page_number, count in sorted((yolo.get("perPage") or {}).items()):
        lines.append(f"      page {page_number}: {count}")
    lines.append("")

    validation = report.get("validation", {})
    validation_cost = validation.get("cost", {})
    lines.append(f"[2] LLM gate: {validation.get('confirmedCount', 0)} kept, "
                 f"{validation.get('rejectedCount', 0)} dropped, in {validation.get('seconds', 0)}s")
    lines.append(f"      cost ${validation_cost.get('totalUsd', 0):.4f}  "
                 f"({validation_cost.get('inputTokens', 0):,} in / "
                 f"{validation_cost.get('outputTokens', 0):,} out tokens)")
    lines.append("")

    enhancement = report.get("enhancement")
    if enhancement:
        lines.append(f"[3] Enhancement: {enhancement.get('enhancedCount', 0)} image(s) "
                     f"in {enhancement.get('seconds', 0)}s, cost ${enhancement.get('totalUsd', 0):.4f}")
        for record in enhancement.get("perImage", []):
            framing_text = ""
            if record.get("framingFlag"):
                framing_text = (f"  aspect {record.get('originalAspect')}->{record.get('enhancedAspect')} "
                                f"[{record['framingFlag']}]")
            lines.append(f"      {record['savedFileName']}: kind={record['kind']} "
                         f"{record['seconds']}s ${record.get('totalCostUsd', record.get('tokenCost', {}).get('totalUsd', 0)):.4f}{framing_text}")
        lines.append("")

    lines.append(f"GRAND TOTAL: ${report.get('grandTotalUsd', 0):.4f}")
    if report.get("unknownModelsCostedAtFallback"):
        lines.append("Models costed at fallback rate (add to PRICING table): "
                     + ", ".join(report["unknownModelsCostedAtFallback"]))
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------------------
# Tkinter GUI -- pick a PDF from Explorer, set the knobs, watch the live log.
# ----------------------------------------------------------------------------
def launch_gui():
    import tkinter as tkinter_module
    from tkinter import filedialog, scrolledtext, messagebox

    log_message_queue: "queue.Queue[str]" = queue.Queue()
    worker_state = {"running": False, "lastRunDirectory": None, "logFilePath": None, "stopEvent": None}

    root = tkinter_module.Tk()
    root.title("CogniumLearn -- YOLO + Image Enhance Lab")
    root.geometry("960x680")

    selected_pdf_path_variable = tkinter_module.StringVar(value="")
    page_range_variable = tkinter_module.StringVar(value="")
    yolo_confidence_variable = tkinter_module.StringVar(value=str(DEFAULT_YOLO_CONFIDENCE_THRESHOLD))
    enhance_enabled_variable = tkinter_module.BooleanVar(value=True)
    maximum_enhance_variable = tkinter_module.StringVar(value="")

    controls_frame = tkinter_module.Frame(root, padx=10, pady=10)
    controls_frame.pack(fill="x")

    # Row 0 -- PDF picker
    tkinter_module.Label(controls_frame, text="PDF file:").grid(row=0, column=0, sticky="w")
    pdf_path_entry = tkinter_module.Entry(controls_frame, textvariable=selected_pdf_path_variable, width=80)
    pdf_path_entry.grid(row=0, column=1, sticky="we", padx=5)

    def browse_for_pdf():
        chosen_path = filedialog.askopenfilename(
            title="Select a PDF to run through the pipeline",
            filetypes=[("PDF files", "*.pdf"), ("All files", "*.*")],
        )
        if chosen_path:
            selected_pdf_path_variable.set(chosen_path)

    tkinter_module.Button(controls_frame, text="Browse...", command=browse_for_pdf).grid(row=0, column=2, padx=5)

    # Row 1 -- page range
    tkinter_module.Label(controls_frame, text="Page range (blank = whole PDF):").grid(row=1, column=0, sticky="w", pady=(8, 0))
    tkinter_module.Entry(controls_frame, textvariable=page_range_variable, width=30).grid(row=1, column=1, sticky="w", padx=5, pady=(8, 0))
    tkinter_module.Label(controls_frame, text="e.g.  3-5,8,10-12").grid(row=1, column=1, sticky="e", pady=(8, 0))

    # Row 2 -- YOLO confidence
    tkinter_module.Label(controls_frame, text="YOLO confidence floor:").grid(row=2, column=0, sticky="w", pady=(8, 0))
    tkinter_module.Entry(controls_frame, textvariable=yolo_confidence_variable, width=30).grid(row=2, column=1, sticky="w", padx=5, pady=(8, 0))
    tkinter_module.Label(controls_frame, text=f"repo default {DEFAULT_YOLO_CONFIDENCE_THRESHOLD} -- raise to detect fewer / cleaner figures").grid(row=2, column=1, sticky="e", pady=(8, 0))

    # Row 3 -- enhance toggle + cap
    tkinter_module.Checkbutton(controls_frame, text="Enhance confirmed images (the expensive 2-call stage)", variable=enhance_enabled_variable).grid(row=3, column=0, columnspan=2, sticky="w", pady=(8, 0))
    cap_frame = tkinter_module.Frame(controls_frame)
    cap_frame.grid(row=4, column=0, columnspan=2, sticky="w", pady=(4, 0))
    tkinter_module.Label(cap_frame, text="Max images to enhance (blank = all):").pack(side="left")
    tkinter_module.Entry(cap_frame, textvariable=maximum_enhance_variable, width=8).pack(side="left", padx=5)

    controls_frame.columnconfigure(1, weight=1)

    # Buttons
    button_frame = tkinter_module.Frame(root, padx=10)
    button_frame.pack(fill="x")
    run_button = tkinter_module.Button(button_frame, text="Run pipeline", width=18)
    run_button.pack(side="left", pady=6)
    stop_button = tkinter_module.Button(button_frame, text="Stop after current", width=20, state="disabled")
    stop_button.pack(side="left", padx=8, pady=6)
    open_output_button = tkinter_module.Button(button_frame, text="Open output folder", width=18)
    open_output_button.pack(side="left", padx=8)

    # Log view
    log_view = scrolledtext.ScrolledText(root, wrap="word", state="disabled", height=28)
    log_view.pack(fill="both", expand=True, padx=10, pady=(4, 10))

    def append_to_log_view(message: str):
        log_view.configure(state="normal")
        log_view.insert("end", message + "\n")
        log_view.see("end")
        log_view.configure(state="disabled")

    def drain_log_queue():
        try:
            while True:
                message = log_message_queue.get_nowait()
                if message == "__DONE__":
                    worker_state["running"] = False
                    run_button.configure(state="normal", text="Run pipeline")
                    stop_button.configure(state="disabled")
                else:
                    append_to_log_view(message)
        except queue.Empty:
            pass
        root.after(120, drain_log_queue)

    def open_output_folder():
        target = worker_state["lastRunDirectory"] or OUTPUT_ROOT_DIRECTORY
        if os.path.isdir(target):
            os.startfile(target)
        else:
            messagebox.showinfo("No output yet", "Run the pipeline first.")

    open_output_button.configure(command=open_output_folder)

    def worker_main(pdf_path, allowed_pages, enhance_enabled, maximum_images, yolo_confidence, run_directory, stop_event):
        import asyncio

        log_file_path = os.path.join(run_directory, "run.log")
        worker_state["logFilePath"] = log_file_path

        def log(message: str):
            log_message_queue.put(message)
            try:
                with open(log_file_path, "a", encoding="utf-8") as log_file:
                    log_file.write(message + "\n")
            except Exception:
                pass

        try:
            asyncio.run(run_pipeline(
                pdf_path=pdf_path,
                allowed_pages=allowed_pages,
                enhance_enabled=enhance_enabled,
                maximum_images_to_enhance=maximum_images,
                yolo_confidence_threshold=yolo_confidence,
                run_directory=run_directory,
                log=log,
                stop_event=stop_event,
            ))
        except Exception:
            log("PIPELINE CRASHED:")
            log(traceback.format_exc())
        finally:
            log_message_queue.put("__DONE__")

    def start_run():
        if worker_state["running"]:
            return

        pdf_path = selected_pdf_path_variable.get().strip()
        if not pdf_path or not os.path.isfile(pdf_path):
            messagebox.showerror("Pick a PDF", "Choose a valid PDF file first.")
            return

        try:
            allowed_pages = parse_page_range_text(page_range_variable.get())
        except ValueError:
            messagebox.showerror("Bad page range", "Use formats like  3-5,8,10-12  (or leave blank).")
            return

        try:
            yolo_confidence = float(yolo_confidence_variable.get().strip())
            if not (0.0 < yolo_confidence < 1.0):
                raise ValueError()
        except ValueError:
            messagebox.showerror("Bad confidence", "YOLO confidence must be a number between 0 and 1.")
            return

        maximum_enhance_text = maximum_enhance_variable.get().strip()
        maximum_images = None
        if maximum_enhance_text:
            try:
                maximum_images = int(maximum_enhance_text)
                if maximum_images <= 0:
                    raise ValueError()
            except ValueError:
                messagebox.showerror("Bad limit", "Max images to enhance must be a positive whole number (or blank).")
                return

        if not os.getenv("GEMINI_API_KEY"):
            messagebox.showerror("No API key", "GEMINI_API_KEY was not loaded from Agent/.env.")
            return

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        run_directory = os.path.join(
            OUTPUT_ROOT_DIRECTORY,
            f"{sanitize_for_filename(os.path.splitext(os.path.basename(pdf_path))[0])}_{timestamp}",
        )
        os.makedirs(run_directory, exist_ok=True)
        worker_state["lastRunDirectory"] = run_directory

        # Clear the log view for the new run.
        log_view.configure(state="normal")
        log_view.delete("1.0", "end")
        log_view.configure(state="disabled")

        stop_event = threading.Event()
        worker_state["stopEvent"] = stop_event
        worker_state["running"] = True
        run_button.configure(state="disabled", text="Running...")
        stop_button.configure(state="normal")

        def request_stop():
            if worker_state["stopEvent"]:
                worker_state["stopEvent"].set()
            stop_button.configure(state="disabled", text="Stopping...")

        stop_button.configure(command=request_stop, text="Stop after current")

        worker_thread = threading.Thread(
            target=worker_main,
            args=(pdf_path, allowed_pages, enhance_enabled_variable.get(),
                  maximum_images, yolo_confidence, run_directory, stop_event),
            daemon=True,
        )
        worker_thread.start()

    run_button.configure(command=start_run)

    append_to_log_view("Ready. Pick a PDF, set your knobs, and click Run pipeline.")
    append_to_log_view(f"Output goes to: {OUTPUT_ROOT_DIRECTORY}")
    append_to_log_view(f"GEMINI_API_KEY loaded: {'yes' if os.getenv('GEMINI_API_KEY') else 'NO -- check Agent/.env'}")
    root.after(120, drain_log_queue)
    root.mainloop()


if __name__ == "__main__":
    os.makedirs(OUTPUT_ROOT_DIRECTORY, exist_ok=True)
    launch_gui()
