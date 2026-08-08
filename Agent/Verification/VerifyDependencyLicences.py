"""
Dependency licence gate for the Agent.

Run from the Agent directory, against the venv you are about to freeze:
    .venv/Scripts/python.exe Verification/VerifyDependencyLicences.py    (Windows)
    .venv/bin/python Verification/VerifyDependencyLicences.py            (Linux)

Why this exists
---------------
CogniumLearn is a closed-source hosted service. A network-copyleft dependency
(AGPL, SSPL, and the copyleft-by-default CC-BY-SA / OSL family) obliges us to
offer every user the Corresponding Source of the whole service, which is
incompatible with paid decks, the encryption scheme and the obfuscated frontend.

PyMuPDF sat in the worker for months under exactly that licence before anyone
noticed, because nothing in the pipeline ever looked. This gate is that look.
It reads the licence metadata of everything actually installed in the venv, so
it catches transitive pulls too — the usual way a copyleft package arrives.

Exit code 0 = clean, 1 = at least one blocked licence, 2 = could not inspect.

Add a package to ACKNOWLEDGED_EXCEPTIONS only with a written reason. An entry
there is a decision, not a snooze button.
"""

import re
import sys
from importlib import metadata


# Licence patterns that are incompatible with shipping a closed-source hosted
# service. Matched case-insensitively against the License / License-Expression
# field and the "License :: ..." trove classifiers.
BLOCKED_LICENCE_PATTERNS = [
    (re.compile(r"\bAGPL\b|affero", re.IGNORECASE),
     "AGPL — network-use triggers a source-disclosure obligation"),
    (re.compile(r"\bSSPL\b|server side public license", re.IGNORECASE),
     "SSPL — service-source disclosure obligation"),
    (re.compile(r"\bOSL\b|open software license", re.IGNORECASE),
     "OSL — network-use copyleft"),
    (re.compile(r"CC-BY-SA|creative commons attribution.share", re.IGNORECASE),
     "CC-BY-SA — share-alike copyleft, unsuitable for bundled code"),
]

# GPL without the "Lesser"/"Library" qualifier. LGPL is deliberately allowed:
# it carries no source-disclosure obligation for a hosted service, and svglib
# (the SVG rasterization path) relies on that distinction.
GPL_PATTERN = re.compile(r"(?<!L)GPL(?!.*lesser)|general public license", re.IGNORECASE)
LGPL_PATTERN = re.compile(r"\bLGPL\b|lesser general public|library general public", re.IGNORECASE)

# Packages allowed past the gate despite a matching licence string, each with a
# reason. Keep this list short and justified.
#
# Empty by design — the PDF-stack licence migration is closed. PyMuPDF became
# pypdfium2 and doclayout_yolo became ds4sd/docling-layout-heron loaded through
# transformers. An entry appearing here again is a decision someone has to
# justify in writing, not a default.
ACKNOWLEDGED_EXCEPTIONS = {}


# A `License` field longer than this is the package's full licence TEXT, not a
# licence name. Scanning that text is actively wrong: scipy ships a 46 KB
# License field that bundles a GPLv3 whose section 13 mentions the Affero GPL,
# which makes a naive substring search report BSD-licensed scipy as AGPL. Only
# short, name-shaped values are trusted.
MAXIMUM_LICENCE_NAME_LENGTH = 200


def collect_licence_text(distribution):
    """
    The authoritative licence declaration for a distribution.

    Preference order, strongest first:
      1. License-Expression — an SPDX expression; unambiguous when present.
      2. "License :: ..." trove classifiers — a controlled vocabulary.
      3. The free-text License field, but ONLY when it is short enough to be a
         licence NAME rather than a pasted licence file.
    """
    try:
        package_metadata = distribution.metadata
    except Exception:
        return ""

    licence_expression = package_metadata.get("License-Expression")
    if licence_expression and str(licence_expression).strip():
        return str(licence_expression).strip()

    try:
        classifiers = package_metadata.get_all("Classifier") or []
    except Exception:
        classifiers = []
    licence_classifiers = [
        classifier for classifier in classifiers if classifier.startswith("License ::")
    ]
    if licence_classifiers:
        return " | ".join(licence_classifiers)

    licence_field = package_metadata.get("License")
    if licence_field:
        licence_field = str(licence_field).strip()
        if 0 < len(licence_field) <= MAXIMUM_LICENCE_NAME_LENGTH:
            return licence_field

    return ""


def main():
    try:
        distributions = list(metadata.distributions())
    except Exception as inspect_error:
        print(f"Could not inspect the environment: {inspect_error}")
        return 2

    blocked_findings = []
    acknowledged_findings = []
    unknown_licence_packages = []
    inspected_count = 0

    for distribution in distributions:
        try:
            package_name = distribution.metadata["Name"]
        except Exception:
            continue
        if not package_name:
            continue

        inspected_count += 1
        normalised_name = package_name.lower().replace("_", "-")
        licence_text = collect_licence_text(distribution)

        if not licence_text.strip():
            unknown_licence_packages.append(package_name)
            continue

        matched_reason = None
        for pattern, reason in BLOCKED_LICENCE_PATTERNS:
            if pattern.search(licence_text):
                matched_reason = reason
                break

        if matched_reason is None and GPL_PATTERN.search(licence_text):
            if not LGPL_PATTERN.search(licence_text):
                matched_reason = "GPL — copyleft; obliges source release on distribution"

        if matched_reason is None:
            continue

        finding = (package_name, distribution.version, matched_reason, licence_text[:110])
        if normalised_name in ACKNOWLEDGED_EXCEPTIONS or package_name in ACKNOWLEDGED_EXCEPTIONS:
            acknowledged_findings.append(finding)
        else:
            blocked_findings.append(finding)

    print("=" * 78)
    print(f"Agent dependency licence gate — {inspected_count} package(s) inspected")
    print("=" * 78)

    if acknowledged_findings:
        print("\nACKNOWLEDGED (tracked debt, not a build failure):")
        for package_name, version, reason, licence_text in acknowledged_findings:
            normalised_name = package_name.lower().replace("_", "-")
            note = (
                ACKNOWLEDGED_EXCEPTIONS.get(normalised_name)
                or ACKNOWLEDGED_EXCEPTIONS.get(package_name, "")
            )
            print(f"  - {package_name}=={version}: {reason}")
            print(f"      {note}")

    if unknown_licence_packages:
        print(f"\nNO LICENCE METADATA ({len(unknown_licence_packages)} package(s)) — "
              f"verify by hand if any are new:")
        print(f"  {', '.join(sorted(unknown_licence_packages)[:18])}"
              f"{' ...' if len(unknown_licence_packages) > 18 else ''}")

    if blocked_findings:
        print("\nBLOCKED — these cannot ship in a closed-source hosted service:")
        for package_name, version, reason, licence_text in blocked_findings:
            print(f"  - {package_name}=={version}")
            print(f"      {reason}")
            print(f"      declared: {licence_text}")
        print("\nResolve by replacing the package, buying a commercial licence, or —")
        print("only with a written reason — adding it to ACKNOWLEDGED_EXCEPTIONS.")
        print("\nRESULT: FAIL")
        return 1

    print("\nRESULT: PASS — no unacknowledged copyleft dependency.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
