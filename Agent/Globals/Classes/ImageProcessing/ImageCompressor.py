import io

from PIL import Image


class ImageCompressor:
    """
    Shrinks image bytes to a small JPEG suitable for inline base64 embedding
    inside flashcard / study-material HTML.

    Why this exists: raw PDF-extracted figures and Gemini-regenerated
    renders are routinely 1-3 MB each. With base64 overhead (~4/3) and
    several figures per deck, the encoded HTML balloons past 20 MB per
    deck, which breaks sync. The user's quality bar is "text must remain
    readable, nothing more" so we re-encode aggressively to JPEG at a
    capped resolution.

    Invariant: this only runs at HTML-embedding time. Originals stay
    untouched in GCS (`figures/<phash>.png`) and in the Mongo `figures`
    collection.
    """

    # Display CSS already caps figures at HtmlInjector._ABSOLUTE_MAX_WIDTH_PIXELS
    # = 720px. We store at ~1.4x that so the figure still looks crisp on a
    # retina screen but no larger.
    MAX_WIDTH_PIXELS = 1024
    MAX_HEIGHT_PIXELS = 1024

    # 75 hits the readable-text knee on JPEG's quality curve; lower than
    # this and aliasing artefacts start eating thin diagram lines.
    JPEG_QUALITY = 75

    # JPEG can't carry an alpha channel; flatten transparency onto white
    # before saving so PNG-with-transparency inputs (Gemini's image
    # generation output, occasionally) don't crash the encoder.
    _ALPHA_FILL_COLOR = (255, 255, 255)

    @staticmethod
    def compress_for_embedding(image_bytes: bytes) -> bytes:
        if not isinstance(image_bytes, (bytes, bytearray)) or len(image_bytes) == 0:
            return image_bytes

        source_image = Image.open(io.BytesIO(image_bytes))

        # Force a load() so the underlying stream is read before we close it
        # via the with-style reassignments below.
        source_image.load()

        flattened_image = ImageCompressor.__flatten_alpha_to_rgb(source_image)

        if (
            flattened_image.width > ImageCompressor.MAX_WIDTH_PIXELS
            or flattened_image.height > ImageCompressor.MAX_HEIGHT_PIXELS
        ):
            flattened_image.thumbnail(
                (ImageCompressor.MAX_WIDTH_PIXELS, ImageCompressor.MAX_HEIGHT_PIXELS),
                Image.LANCZOS,
            )

        output_buffer = io.BytesIO()
        flattened_image.save(
            output_buffer,
            format = "JPEG",
            quality = ImageCompressor.JPEG_QUALITY,
            optimize = True,
            progressive = True,
        )
        return output_buffer.getvalue()

    @staticmethod
    def __flatten_alpha_to_rgb(source_image: Image.Image) -> Image.Image:
        if source_image.mode == "RGB":
            return source_image

        if source_image.mode in ("RGBA", "LA"):
            white_background = Image.new(
                "RGB",
                source_image.size,
                ImageCompressor._ALPHA_FILL_COLOR,
            )
            alpha_mask = source_image.split()[-1]
            white_background.paste(source_image.convert("RGBA"), mask = alpha_mask)
            return white_background

        if source_image.mode == "P":
            converted_to_rgba = source_image.convert("RGBA")
            return ImageCompressor.__flatten_alpha_to_rgb(converted_to_rgba)

        return source_image.convert("RGB")
