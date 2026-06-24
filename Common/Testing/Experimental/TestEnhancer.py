"""
TestEnhancer.py -- quick CLI test for DiagramImageEnhancer (no GUI needed).

Usage:
    Agent/.venv/Scripts/python.exe Common/Testing/Experimental/TestEnhancer.py [image_path]

If no image_path is given, defaults to the p025 marketing diagram from the
most recent confirmed run.
"""

import asyncio
import os
import sys
import time

THIS_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
REPOSITORY_ROOT = os.path.abspath(os.path.join(THIS_DIRECTORY, "..", "..", ".."))
AGENT_DIRECTORY = os.path.join(REPOSITORY_ROOT, "Agent")
OUTPUT_ROOT_DIRECTORY = os.path.join(THIS_DIRECTORY, "Output")

if AGENT_DIRECTORY not in sys.path:
    sys.path.insert(0, AGENT_DIRECTORY)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(AGENT_DIRECTORY, ".env"))
except Exception as environment_error:
    print(f"[startup] Could not load Agent/.env: {environment_error}")

DEFAULT_IMAGE_PATH = os.path.join(
    OUTPUT_ROOT_DIRECTORY,
    "UNIT-III_CC_BD_CS62_March2025_20260621_121119",
    "02_llm_confirmed",
    "p025_fig00_ea65ade21230ecec.png",
)


async def run_test(image_path: str) -> None:
    from Workflows.EnhanceImages.DiagramImageEnhancer import DiagramImageEnhancer

    print(f"Image: {os.path.basename(image_path)}")
    print(f"Path:  {image_path}")
    print()

    with open(image_path, "rb") as image_file:
        image_bytes = image_file.read()
    print(f"Loaded {len(image_bytes):,} bytes.")

    enhancer = DiagramImageEnhancer()
    started = time.perf_counter()
    result = await enhancer.enhance(image_bytes)
    elapsed = time.perf_counter() - started

    print()
    print("=" * 60)
    print(f"kind:       {result.get('kind')}")
    print(f"complexity: {result.get('complexity', 'n/a')}")
    print(f"renderer:   {result.get('renderer', 'n/a')}")
    print(f"elapsed:    {elapsed:.1f}s")
    print("=" * 60)

    if result.get("kind") == "DIAGRAM_IMAGE_PNG":
        base_name = os.path.splitext(os.path.basename(image_path))[0]
        output_path = os.path.join(THIS_DIRECTORY, f"{base_name}__test_enhanced.png")
        with open(output_path, "wb") as png_file:
            png_file.write(result["image_bytes"])
        print(f"PNG written ({len(result['image_bytes']):,} bytes) -> {output_path}")
    else:
        print("DIAGRAM_FALLBACK_ORIGINAL -- no output produced.")


if __name__ == "__main__":
    target_image_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_IMAGE_PATH
    if not os.path.isfile(target_image_path):
        print(f"ERROR: file not found: {target_image_path}")
        sys.exit(1)
    asyncio.run(run_test(target_image_path))
