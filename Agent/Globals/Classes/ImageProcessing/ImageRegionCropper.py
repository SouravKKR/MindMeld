import io

from PIL import Image


class ImageRegionCropper:
    """
    Crops source image bytes to a percentage-based bounding rectangle.

    Used by AssetEnhancer to tighten the reference image fed into Stage 2
    image regeneration so the model only sees the diagram subject, not
    the ambient body text / page noise that YOLO sometimes drags in when
    its figure crop is loose (or, in the worst case, when the entire
    textbook page was selected as one figure).

    Strictly fail-soft: every failure mode (missing region, malformed
    bounds, sub-threshold region, PIL decode/crop error) returns the
    ORIGINAL bytes unchanged and logs one warning line so the pipeline
    keeps moving. Worst case after this utility runs is "same behaviour
    as before the crop signal existed".
    """

    # A region covering less than this fraction of the source image is
    # almost certainly a Stage-1 hallucination on a noise speck (e.g. a
    # page-number watermark) -- fall back to the full image rather than
    # crop down to that.
    MIN_REGION_AREA_PERCENT = 5.0

    # Below this, the cropped reference loses enough resolution that
    # Stage 2 can't reconstruct shape geometry reliably -- fall back to
    # the full image instead.
    MIN_CROPPED_DIMENSION_PIXELS = 64

    @staticmethod
    def crop_to_subject_region(
        source_image_bytes: bytes,
        diagram_subject_region,
    ) -> bytes:
        if diagram_subject_region is None:
            return source_image_bytes

        top_percent    = getattr(diagram_subject_region, "top_percent", None)
        left_percent   = getattr(diagram_subject_region, "left_percent", None)
        bottom_percent = getattr(diagram_subject_region, "bottom_percent", None)
        right_percent  = getattr(diagram_subject_region, "right_percent", None)

        if None in (top_percent, left_percent, bottom_percent, right_percent):
            print(
                "[ImageRegionCropper] Subject region missing one or more edge "
                "percentages -- falling back to full source image."
            )
            return source_image_bytes

        if not ImageRegionCropper.__are_bounds_valid(
            top_percent, left_percent, bottom_percent, right_percent
        ):
            print(
                f"[ImageRegionCropper] Subject region bounds out of range or "
                f"inverted (top={top_percent}, left={left_percent}, "
                f"bottom={bottom_percent}, right={right_percent}) -- falling "
                f"back to full source image."
            )
            return source_image_bytes

        region_area_percent = (
            (bottom_percent - top_percent) * (right_percent - left_percent) / 100.0
        )
        if region_area_percent < ImageRegionCropper.MIN_REGION_AREA_PERCENT:
            print(
                f"[ImageRegionCropper] Subject region covers only "
                f"{region_area_percent:.2f}% of source (below "
                f"{ImageRegionCropper.MIN_REGION_AREA_PERCENT}% threshold) -- "
                f"likely a hallucination, falling back to full source image."
            )
            return source_image_bytes

        try:
            source_image = Image.open(io.BytesIO(source_image_bytes))
            source_image.load()

            source_width  = source_image.width
            source_height = source_image.height

            left_pixels   = int(round(source_width  * (left_percent   / 100.0)))
            top_pixels    = int(round(source_height * (top_percent    / 100.0)))
            right_pixels  = int(round(source_width  * (right_percent  / 100.0)))
            bottom_pixels = int(round(source_height * (bottom_percent / 100.0)))

            # Clamp to image bounds in case the model returned 100.0001 etc.
            left_pixels   = max(0, min(source_width,  left_pixels))
            top_pixels    = max(0, min(source_height, top_pixels))
            right_pixels  = max(0, min(source_width,  right_pixels))
            bottom_pixels = max(0, min(source_height, bottom_pixels))

            cropped_width  = right_pixels  - left_pixels
            cropped_height = bottom_pixels - top_pixels

            if (
                cropped_width  < ImageRegionCropper.MIN_CROPPED_DIMENSION_PIXELS
                or cropped_height < ImageRegionCropper.MIN_CROPPED_DIMENSION_PIXELS
            ):
                print(
                    f"[ImageRegionCropper] Cropped region too small "
                    f"({cropped_width}x{cropped_height}, minimum is "
                    f"{ImageRegionCropper.MIN_CROPPED_DIMENSION_PIXELS}px) -- "
                    f"falling back to full source image."
                )
                return source_image_bytes

            cropped_image = source_image.crop(
                (left_pixels, top_pixels, right_pixels, bottom_pixels)
            )

            output_buffer = io.BytesIO()
            cropped_image.save(output_buffer, format = "PNG", optimize = True)
            return output_buffer.getvalue()

        except Exception as crop_failure:
            print(
                f"[ImageRegionCropper] PIL crop failed ({crop_failure}) -- "
                f"falling back to full source image."
            )
            return source_image_bytes

    @staticmethod
    def __are_bounds_valid(
        top_percent: float,
        left_percent: float,
        bottom_percent: float,
        right_percent: float,
    ) -> bool:
        for edge_percent in (top_percent, left_percent, bottom_percent, right_percent):
            if not isinstance(edge_percent, (int, float)):
                return False
            if edge_percent < 0.0 or edge_percent > 100.0:
                return False
        if top_percent >= bottom_percent:
            return False
        if left_percent >= right_percent:
            return False
        return True
