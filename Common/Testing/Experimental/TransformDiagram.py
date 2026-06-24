"""
TransformDiagram.py
===================

Quick one-shot lab: send any image to OpenAI gpt-image-2 with a
simplification / redraw prompt and save the result as a PNG.

Usage:
    Agent/.venv/Scripts/python.exe Common/Testing/Experimental/TransformDiagram.py <image_path>

    e.g.
    Agent/.venv/Scripts/python.exe Common/Testing/Experimental/TransformDiagram.py "C:/Users/Sourav/Desktop/marketing.png"

Output is written next to the input file as  <basename>_gptimage.png

Requirements:
  - OPENAI_API_KEY must be set in Agent/.env  (it is)
  - openai>=2  and  pillow  must be installed in the Agent venv  (they are)
  - gpt-image-1 edit endpoint requires a PNG input; the script auto-converts
    any JPEG/WebP/etc. to PNG before uploading.
"""

import os
import sys
import base64
import io
import pathlib

THIS_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
REPOSITORY_ROOT = os.path.abspath(os.path.join(THIS_DIRECTORY, "..", "..", ".."))
AGENT_DIRECTORY = os.path.join(REPOSITORY_ROOT, "Agent")

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(AGENT_DIRECTORY, ".env"))
except Exception as environment_error:
    print(f"[startup] Could not load Agent/.env: {environment_error}")

from PIL import Image
from openai import OpenAI


TRANSFORM_PROMPT = (
    "Redraw this marketing lifecycle diagram in a clean, simplified educational style "
    "suitable for study notes or an exam. Keep every text label exactly as written. "
    "Use a white background with dark elements.\n\n"
    "LEFT SIDE (old school): two dark filled circles connected by two arcs. "
    "Large circle: 'acquisition'. Small circle: 'conversion'. "
    "Outer arc label: 'permission'. Inner arc label: 'conversion'. "
    "Small note near the small circle: 'permission capture'.\n\n"
    "RIGHT SIDE inside a dashed rectangular border titled 'new school marketing' "
    "(subtitle: 'The cross-channel lifecycle marketing approach'): "
    "two large dark filled circles, 'relationship' on the left and 'conversion' on the right. "
    "Between them, three concentric oval loops (outermost to innermost): "
    "loop 1 labelled 're-permission' and 'winback' at the top, "
    "loop 2 labelled 'stickiness', "
    "loop 3 labelled 'repurchase'. "
    "A horizontal dotted line between the two circles labelled 'segmented'. "
    "Bottom arcs labelled 'welcome' (lower left) and 'conversion' (lower outer). "
    "Small dots with labels around the loops on the right side: "
    "alerts, transactional, cross sell, reviews, friend to friend, replenishment, abandon, browse. "
    "Footer text at the bottom: 'email / mobile / social / display / web'.\n\n"
    "Make it clean, high-contrast, legible, and easy to reproduce by hand."
)


def load_as_png_bytes(image_path: pathlib.Path) -> bytes:
    with Image.open(image_path) as source_image:
        if source_image.mode not in ("RGB", "RGBA"):
            source_image = source_image.convert("RGBA")
        buffer = io.BytesIO()
        source_image.save(buffer, format="PNG")
        return buffer.getvalue()


def transform_image(image_path_string: str) -> None:
    input_path = pathlib.Path(image_path_string).resolve()
    if not input_path.exists():
        print(f"ERROR: file not found: {input_path}")
        sys.exit(1)

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("ERROR: OPENAI_API_KEY not found in Agent/.env")
        sys.exit(1)

    client = OpenAI(api_key=api_key)

    print(f"Converting {input_path.name} to PNG for upload ...")
    png_bytes = load_as_png_bytes(input_path)
    print(f"Image size: {len(png_bytes):,} bytes  ({len(png_bytes) / 1024 / 1024:.1f} MB)")

    print("Sending to gpt-image-2 (edit) -- this usually takes 15-30 seconds ...")
    response = client.images.edit(
        model="gpt-image-2",
        image=("input.png", io.BytesIO(png_bytes), "image/png"),
        prompt=TRANSFORM_PROMPT,
        size="1536x1024",
        n=1,
    )

    image_base64 = response.data[0].b64_json
    if not image_base64:
        print("ERROR: No base64 image data in response.")
        print(f"Response: {response}")
        sys.exit(1)

    output_path = input_path.parent / f"{input_path.stem}_gptimage.png"
    with open(output_path, "wb") as output_file:
        output_file.write(base64.b64decode(image_base64))

    print(f"Done. Saved to:\n  {output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        print("Usage: python TransformDiagram.py <image_path>")
        sys.exit(1)

    transform_image(sys.argv[1])
