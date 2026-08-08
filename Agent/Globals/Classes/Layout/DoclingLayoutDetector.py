import threading

from Globals.Classes.Layout.LayoutDetection import LayoutDetection
from Globals.Classes.Layout.LayoutDetector import LayoutDetector
from Globals.Enumerations.LayoutRegionRoles import LayoutRegionRoles


class DoclingLayoutDetector(LayoutDetector):
    """
    Layout detection with IBM's Docling Heron model (RT-DETRv2), loaded straight
    from `transformers`.

    It replaces DocLayout-YOLO, which was AGPL-3.0 in both code and weights and —
    unlike PyMuPDF before it — had no commercial licence available, because it is
    a fork of YOLOv10/Ultralytics that its authors cannot relicense. Heron's
    weights are Apache-2.0 and the runtime is `transformers`, which the worker
    already installs, so this swap adds no dependency at all.

    Three things about RT-DETR differ from YOLO and are load-bearing here:

      * There is NO non-maximum suppression. post_process_object_detection is a
        plain top-k filter over a fixed set of queries, so the SAME predicted box
        can come back under two different labels (a header region as both
        `section_header` and `page_header` is routine). YOLO's NMS hid this for
        free; here it has to be suppressed explicitly or the pipeline crops the
        same figure twice and pays the vision model twice to look at it.
      * Because post-processing is a pure filter, one inference pass supports any
        confidence threshold. The thresholds below are therefore tuning
        constants, not things worth re-running the model to explore.
      * The checkpoint sets `do_normalize: false`, which differs from the
        processor class default. The processor MUST come from
        AutoImageProcessor.from_pretrained so the checkpoint's own preprocessing
        settings are honoured — constructing RTDetrImageProcessor() directly
        preprocesses wrongly and silently returns worse detections.
    """

    MODEL_REPOSITORY_ID = "ds4sd/docling-layout-heron"

    # Heron was trained at 640x640 and its preprocessor config pins that size.
    # Raising it costs quadratic compute for off-distribution inference.
    PROCESSOR_IMAGE_SIZE = 640

    # Per-role confidence floors, tuned against the DocLayout-YOLO baseline over
    # the whole 13-document / ~1,150-page corpus.
    #
    # These are far above the 0.15 the old YOLO model used, and that is not a
    # transcription error: RT-DETR scores are per-query sigmoids with no NMS, so
    # they concentrate near the extremes and are not comparable to YOLO's
    # objectness-times-class product.
    #
    # 0.55 is where the measured recall curve plateaus. Every baseline figure lost
    # between 0.40 and 0.55 was already lost at 0.40 — the flagged set is
    # identical at both — so the extra headroom is free, and it cuts the figures
    # reaching the vision model from 861 to 830 against a baseline of 820.
    #
    # All 23 baseline figures this configuration declines to reproduce were
    # inspected by eye: 7 institutional letterhead logos, 1 slide-decoration
    # shape, and 15 "KEY CONCEPTS" chapter-opener text sidebars. No diagram, chart
    # or illustration is lost, and each of those 23 previously cost a vision call.
    #
    # A false caption is the most expensive error of the three, which is why its
    # floor is not the lowest: captions are UNIONED into the figure box, so one
    # bad caption corrupts the crop of a figure that was detected perfectly.
    PICTURE_CONFIDENCE_THRESHOLD = 0.55
    TABLE_CONFIDENCE_THRESHOLD = 0.55
    CAPTION_CONFIDENCE_THRESHOLD = 0.50

    # Two detections overlapping by at least this much are the same region seen
    # under two labels; the higher-scoring one wins. See the no-NMS note above.
    DUPLICATE_BOX_IOU_THRESHOLD = 0.90

    # Heron routinely reports a composite figure AND each of its parts — a plate
    # of three panels comes back as four `picture` regions. Intersection-over-union
    # does not catch that (a panel inside a plate scores far below 0.90 because the
    # union is the whole plate), so containment is tested separately: a region this
    # far inside a higher-scoring region of the SAME role is a part of it, and only
    # the winner is kept.
    #
    # Measured on the reference chapter, 143 picture regions contained 136 such
    # nested pairs of which IoU-based dedup caught 2. Without this the pipeline
    # sends every panel to the vision model separately, several times over.
    #
    # Same-role only, deliberately: a CAPTION sits inside or against its FIGURE by
    # definition, and suppressing it would throw away the caption text.
    CONTAINED_BOX_SUPPRESSION_THRESHOLD = 0.80

    # A region must be at least this many pixels on both sides before it is worth
    # considering. Heron reliably tags small footer ornaments and logos as
    # `picture`; at the production 5% padding those grow past the extractor's own
    # 80px floor, so they have to be dropped here, at their true size, instead.
    MINIMUM_REGION_DIMENSION_PIXELS = 40

    PICTURE_LABEL = "picture"
    TABLE_LABEL = "table"
    CAPTION_LABEL = "caption"

    __cached_model = None
    __cached_processor = None
    __model_load_lock = threading.Lock()

    def __init__(
        self,
        picture_confidence_threshold = None,
        table_confidence_threshold = None,
        caption_confidence_threshold = None,
    ):
        self.__picture_confidence_threshold = (
            picture_confidence_threshold
            if picture_confidence_threshold is not None
            else DoclingLayoutDetector.PICTURE_CONFIDENCE_THRESHOLD
        )
        self.__table_confidence_threshold = (
            table_confidence_threshold
            if table_confidence_threshold is not None
            else DoclingLayoutDetector.TABLE_CONFIDENCE_THRESHOLD
        )
        self.__caption_confidence_threshold = (
            caption_confidence_threshold
            if caption_confidence_threshold is not None
            else DoclingLayoutDetector.CAPTION_CONFIDENCE_THRESHOLD
        )

    # ── Model loading ────────────────────────────────────────────────────────

    @classmethod
    def __load_model_and_processor(cls):
        if cls.__cached_model is not None:
            return cls.__cached_model, cls.__cached_processor

        with cls.__model_load_lock:
            if cls.__cached_model is None:
                from transformers import AutoImageProcessor, RTDetrV2ForObjectDetection

                # use_fast is pinned rather than left to the library default,
                # which has already changed once and warns that it "may produce
                # slightly different outputs" — the thresholds below were tuned
                # against the fast processor.
                processor = AutoImageProcessor.from_pretrained(
                    cls.MODEL_REPOSITORY_ID, use_fast = True
                )
                model = RTDetrV2ForObjectDetection.from_pretrained(cls.MODEL_REPOSITORY_ID)
                model.eval()

                cls.__cached_processor = processor
                cls.__cached_model = model

        return cls.__cached_model, cls.__cached_processor

    # ── Detection ────────────────────────────────────────────────────────────

    def detect(self, page_image, render_dpi):
        import torch

        model, processor = DoclingLayoutDetector.__load_model_and_processor()

        page_width, page_height = page_image.size
        model_inputs = processor(images = page_image, return_tensors = "pt")

        with torch.inference_mode():
            model_outputs = model(**model_inputs)

        lowest_threshold = min(
            self.__picture_confidence_threshold,
            self.__table_confidence_threshold,
            self.__caption_confidence_threshold,
        )

        # target_sizes is (height, width) — reversing it yields transposed boxes
        # that look plausible on square pages and are wrong on every other one.
        post_processed = processor.post_process_object_detection(
            model_outputs,
            threshold = lowest_threshold,
            target_sizes = [(page_height, page_width)],
        )[0]

        detections = []
        for score_tensor, label_tensor, box_tensor in zip(
            post_processed["scores"], post_processed["labels"], post_processed["boxes"]
        ):
            confidence_score = float(score_tensor)
            label = model.config.id2label[int(label_tensor)]

            region_role = self.__region_role_for(label)
            if region_role is LayoutRegionRoles.IGNORED:
                continue
            if confidence_score < self.__threshold_for(region_role):
                continue

            pixel_box = DoclingLayoutDetector.__clamp_box_to_page(
                box_tensor, page_width, page_height
            )
            if pixel_box is None:
                continue

            detections.append(
                LayoutDetection(region_role, label, confidence_score, pixel_box)
            )

        detections.sort(key = lambda detection: detection.get_confidence_score(), reverse = True)
        return DoclingLayoutDetector.__suppress_duplicate_boxes(detections)

    # ── Label and threshold mapping ──────────────────────────────────────────

    def __region_role_for(self, label):
        if label == DoclingLayoutDetector.PICTURE_LABEL:
            return LayoutRegionRoles.FIGURE
        if label == DoclingLayoutDetector.TABLE_LABEL:
            return LayoutRegionRoles.TABLE
        if label == DoclingLayoutDetector.CAPTION_LABEL:
            return LayoutRegionRoles.CAPTION
        return LayoutRegionRoles.IGNORED

    def __threshold_for(self, region_role):
        if region_role is LayoutRegionRoles.FIGURE:
            return self.__picture_confidence_threshold
        if region_role is LayoutRegionRoles.TABLE:
            return self.__table_confidence_threshold
        return self.__caption_confidence_threshold

    # ── Geometry ─────────────────────────────────────────────────────────────

    @staticmethod
    def __clamp_box_to_page(box_tensor, page_width, page_height):
        """
        RT-DETR predicts normalised centre-width-height boxes, so a converted box
        can run past the page edge or come back inverted. Returns None for
        anything left too small to be a figure.
        """
        raw_coordinates = [float(coordinate) for coordinate in box_tensor]
        left = max(0, min(raw_coordinates[0], raw_coordinates[2]))
        top = max(0, min(raw_coordinates[1], raw_coordinates[3]))
        right = min(page_width, max(raw_coordinates[0], raw_coordinates[2]))
        bottom = min(page_height, max(raw_coordinates[1], raw_coordinates[3]))

        pixel_box = (int(left), int(top), int(right), int(bottom))
        if (pixel_box[2] - pixel_box[0]) < DoclingLayoutDetector.MINIMUM_REGION_DIMENSION_PIXELS:
            return None
        if (pixel_box[3] - pixel_box[1]) < DoclingLayoutDetector.MINIMUM_REGION_DIMENSION_PIXELS:
            return None
        return pixel_box

    @staticmethod
    def __suppress_duplicate_boxes(detections):
        """
        Keeps the highest-scoring detection out of any group describing the same
        region — whether the group is near-identical boxes under different labels
        or a composite region and its parts. Detections must already be sorted
        most-confident first, so the first one seen for a region is the winner.
        """
        kept_detections = []
        for detection in detections:
            b_redundant = False
            for kept_detection in kept_detections:
                if DoclingLayoutDetector.__intersection_over_union(
                    detection.get_pixel_box(), kept_detection.get_pixel_box()
                ) >= DoclingLayoutDetector.DUPLICATE_BOX_IOU_THRESHOLD:
                    b_redundant = True
                    break

                if detection.get_region_role() is not kept_detection.get_region_role():
                    continue
                if DoclingLayoutDetector.__containment_fraction(
                    detection.get_pixel_box(), kept_detection.get_pixel_box()
                ) >= DoclingLayoutDetector.CONTAINED_BOX_SUPPRESSION_THRESHOLD:
                    b_redundant = True
                    break

            if not b_redundant:
                kept_detections.append(detection)
        return kept_detections

    @staticmethod
    def __containment_fraction(inner_box, outer_box):
        """How much of inner_box lies inside outer_box, 0..1."""
        intersection_left = max(inner_box[0], outer_box[0])
        intersection_top = max(inner_box[1], outer_box[1])
        intersection_right = min(inner_box[2], outer_box[2])
        intersection_bottom = min(inner_box[3], outer_box[3])

        if intersection_right <= intersection_left or intersection_bottom <= intersection_top:
            return 0.0

        intersection_area = (
            (intersection_right - intersection_left) * (intersection_bottom - intersection_top)
        )
        inner_area = (inner_box[2] - inner_box[0]) * (inner_box[3] - inner_box[1])
        if inner_area <= 0:
            return 0.0
        return intersection_area / inner_area

    @staticmethod
    def __intersection_over_union(first_box, second_box):
        intersection_left = max(first_box[0], second_box[0])
        intersection_top = max(first_box[1], second_box[1])
        intersection_right = min(first_box[2], second_box[2])
        intersection_bottom = min(first_box[3], second_box[3])

        if intersection_right <= intersection_left or intersection_bottom <= intersection_top:
            return 0.0

        intersection_area = (
            (intersection_right - intersection_left) * (intersection_bottom - intersection_top)
        )
        first_area = (first_box[2] - first_box[0]) * (first_box[3] - first_box[1])
        second_area = (second_box[2] - second_box[0]) * (second_box[3] - second_box[1])
        union_area = first_area + second_area - intersection_area

        if union_area <= 0:
            return 0.0
        return intersection_area / union_area
