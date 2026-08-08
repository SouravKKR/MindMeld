"""
Verification harness for PaidDeckFieldGenerator's response post-processing.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyPaidDeckFieldPostProcess.py    (Windows)
    .venv/bin/python Verification/VerifyPaidDeckFieldPostProcess.py            (Linux)

Needs no network, no model and no services -- the module is loaded directly and
only the pure post-processing path is exercised.

What it protects. GoogleEnterpriseAiProvider defaults response_mime_type to
"application/json" unless some content carries response_as_text, and with no
response_schema supplied the model invents its own envelope. The admin
"AI generate field" buttons therefore filled the storefront Description box with
the literal text {"description": "..."} while the prompt was, all along, asking
for a bare value. The transport now asks for plain text as well, and this file
pins the second line of defence: a model that wraps the value anyway must still
yield the value, and text that merely LOOKS structured must survive untouched.

The ordering assertion is the subtle one. The pre-existing code-fence strip runs
`text.strip("`")`, which turns a fenced JSON payload into a fragment that no
longer parses -- so the envelope unwrap has to happen first or the fenced case
silently degrades to raw JSON in the field.
"""

import importlib.util
import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

WORKER_PATH = AGENT_DIRECTORY / "Workflows" / "GeneratePaidDeckField" / "GeneratePaidDeckField.py"


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


def load_post_process():
    """
    Loads the worker by path rather than by import. It is a spawned script, not
    a package module, so there is no import path that reaches it -- and loading
    it by path is also what keeps this harness free of the automation stack,
    which the worker only imports inside generate().
    """
    specification = importlib.util.spec_from_file_location("GeneratePaidDeckFieldWorker", WORKER_PATH)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)

    # Name-mangled because the method is private; reaching it directly keeps the
    # check on the pure function instead of standing up a model call.
    return module.PaidDeckFieldGenerator._PaidDeckFieldGenerator__post_process


def main() -> int:
    post_process = load_post_process()

    section("JSON envelopes are unwrapped")

    assert_that(
        post_process("description", '{"description": "Covers cloud computing basics."}')
            == "Covers cloud computing basics.",
        "A bare envelope keyed by the requested field yields the value",
    )
    assert_that(
        post_process("title", '{"title": "Cloud Computing"}') == "Cloud Computing",
        "Title envelope yields the value",
    )
    assert_that(
        post_process("category", '{"someUnexpectedKey": "Computer Science"}') == "Computer Science",
        "A single-valued envelope under an unanticipated key is still recovered",
    )

    section("Fenced envelopes are unwrapped before the fence strip")

    assert_that(
        post_process("description", '```json\n{"description": "Fenced envelope."}\n```')
            == "Fenced envelope.",
        "A json-tagged fenced envelope yields the value",
    )
    assert_that(
        post_process("description", '```\n{"description": "Untagged fence."}\n```')
            == "Untagged fence.",
        "An untagged fenced envelope yields the value",
    )

    section("List responses are joined")

    assert_that(
        post_process("tags", '{"tags": ["cloud", "virtualisation"]}') == "cloud, virtualisation",
        "A list under the field key is joined into the comma-separated form the input expects",
    )
    assert_that(
        post_process("tags", '["cloud", "iaas"]') == "cloud, iaas",
        "A bare JSON array is joined",
    )

    section("Plain text is left alone")

    assert_that(
        post_process("description", "Just plain text, no envelope.") == "Just plain text, no envelope.",
        "Plain prose passes through unchanged",
    )
    assert_that(
        post_process("description", "```\nFenced plain text.\n```") == "Fenced plain text.",
        "Fenced plain text still has its fence stripped",
    )
    assert_that(
        post_process("title", '"Quoted Title"') == "Quoted Title",
        "A quoted single value is still unquoted",
    )

    section("Ambiguity is surfaced, not guessed at")

    ambiguous_envelope = '{"first": "one", "second": "two"}'
    assert_that(
        post_process("description", ambiguous_envelope) == ambiguous_envelope,
        "A multi-valued envelope under unanticipated keys is returned raw rather than guessed at",
    )
    assert_that(
        post_process("description", "{ this is not json }") == "{ this is not json }",
        "Text that merely opens with a brace is not mangled by a failed parse",
    )

    section("Field caps still apply after unwrapping")

    long_description = "x" * 5000
    capped = post_process("description", '{"description": "' + long_description + '"}')
    assert_that(len(capped) == 4096, "An unwrapped value is still truncated to the field's maxlength")

    assert_that(
        post_process("title", '{"title": "Line one\\nLine two"}') == "Line one Line two",
        "An unwrapped single-line field still has its newlines collapsed",
    )

    print(f"\nPassed: {passed_count}   Failed: {failed_count}")
    return 1 if failed_count > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
