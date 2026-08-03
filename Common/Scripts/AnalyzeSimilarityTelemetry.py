"""
Turns SourceSimilarityScorer telemetry into a containment threshold.

    python Common/Scripts/AnalyzeSimilarityTelemetry.py <logfile> [<logfile> ...]

WHY THIS EXISTS
SourceSimilarityScorer ships with enforcement OFF and a DEFAULT_CONTAINMENT_
THRESHOLD its own comments describe as "a starting point for that calibration,
NOT a validated value". Turning enforcement on before that calibration has
happened is the failure this script exists to prevent: a threshold set too low
rejects correct generations and pressures the model to paraphrase formulae and
terms of art — trading accuracy for originality, which is never an acceptable
trade — while one set too high never fires and the control is theatre.

This reads the `[SIMILARITY]` and `[SEED_OVERLAP]` lines the workers already
emit, reports the real distribution, and recommends a threshold from it.

RECOMMENDATION RULE
The threshold is placed above the observed body of normal output, not at an
arbitrary round number: the 99th percentile of scored containment, rounded up,
with a floor. A generation is flagged when it is an outlier against this
codebase's own output, which is the only meaningful reference — absolute
containment values are not comparable across subjects, prompt versions or
source shapes.

Read the sample size before believing the number. A threshold derived from a
handful of generations is not calibration.
"""

import re
import sys
from collections import Counter


# Minimum scored generations before a recommendation means anything. Below this
# the percentile is noise, and the script says so rather than printing a number
# that would be acted on.
MINIMUM_SAMPLE_FOR_RECOMMENDATION = 200

# Never recommend below this, whatever the distribution says. Prose that shares
# under this much with its source is not meaningfully copied, and a lower bar
# would fire on ordinary shared phrasing.
MINIMUM_RECOMMENDED_THRESHOLD = 0.15

# Headroom above the observed 99th percentile, so normal output does not sit on
# the boundary and drift across it as prompts change.
THRESHOLD_HEADROOM = 0.05

CONTAINMENT_PATTERN = re.compile(r"\[SIMILARITY\]\s+(?P<label>.+?)\s+containment=(?P<containment>[0-9.]+)")
NOT_SCORED_PATTERN = re.compile(r"\[SIMILARITY\]\s+(?P<label>.+?)\s+not scored \((?P<reason>[^,)]+)")
SEED_OVERLAP_PATTERN = re.compile(r"\[SEED_OVERLAP\]\s+(?P<label>.+?)\s+longest_shared_run=(?P<run>\d+)")


def percentile(sorted_values, fraction):
    if not sorted_values:
        return 0.0
    position = min(len(sorted_values) - 1, max(0, int(round(fraction * (len(sorted_values) - 1)))))
    return sorted_values[position]


def summarise_kind(label):
    """Groups a label down to its generator so study material and flashcards are reported apart."""
    if label.startswith("study-material"):
        return "study-material"
    if label.startswith("flashcards"):
        return "flashcards"
    if label.startswith("mock-test"):
        return "mock-test"
    return "other"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    containment_by_kind = {}
    not_scored_reasons = Counter()
    seed_overlap_runs = []

    for log_path in sys.argv[1:]:
        try:
            with open(log_path, "r", encoding="utf-8", errors="replace") as log_file:
                for line in log_file:
                    containment_match = CONTAINMENT_PATTERN.search(line)
                    if containment_match:
                        kind = summarise_kind(containment_match.group("label"))
                        containment_by_kind.setdefault(kind, []).append(float(containment_match.group("containment")))
                        continue

                    not_scored_match = NOT_SCORED_PATTERN.search(line)
                    if not_scored_match:
                        not_scored_reasons[not_scored_match.group("reason").strip()] += 1
                        continue

                    seed_overlap_match = SEED_OVERLAP_PATTERN.search(line)
                    if seed_overlap_match:
                        seed_overlap_runs.append(int(seed_overlap_match.group("run")))
        except OSError as read_error:
            print(f"Could not read {log_path}: {read_error}", file=sys.stderr)

    all_containment = [value for values in containment_by_kind.values() for value in values]

    print("=" * 72)
    print("SourceSimilarityScorer telemetry")
    print("=" * 72)
    print(f"Scored generations   : {len(all_containment)}")
    print(f"Not scored           : {sum(not_scored_reasons.values())}")
    for reason, count in not_scored_reasons.most_common():
        print(f"    {reason}: {count}")
    print()

    if not all_containment:
        print("No scored generations found. Run generations with the scorer wired in, then re-run this.")
        return 1

    for kind in sorted(containment_by_kind):
        values = sorted(containment_by_kind[kind])
        print(f"{kind} (n={len(values)})")
        print(f"    median  {percentile(values, 0.50):.4f}")
        print(f"    p90     {percentile(values, 0.90):.4f}")
        print(f"    p99     {percentile(values, 0.99):.4f}")
        print(f"    max     {values[-1]:.4f}")
        print()

    sorted_all = sorted(all_containment)
    recommended = max(MINIMUM_RECOMMENDED_THRESHOLD, round(percentile(sorted_all, 0.99) + THRESHOLD_HEADROOM, 2))

    print("-" * 72)
    if len(sorted_all) < MINIMUM_SAMPLE_FOR_RECOMMENDATION:
        print(f"SAMPLE TOO SMALL — {len(sorted_all)} scored generation(s), need at least "
              f"{MINIMUM_SAMPLE_FOR_RECOMMENDATION}.")
        print("No threshold is recommended. Keep enforcement OFF and collect more.")
        print(f"(For reference only, p99 + headroom would be {recommended:.2f}.)")
        return 1

    print(f"Recommended SOURCE_SIMILARITY_CONTAINMENT_THRESHOLD = {recommended:.2f}")
    print(f"  (p99 = {percentile(sorted_all, 0.99):.4f}, + {THRESHOLD_HEADROOM} headroom)")
    print(f"  Generations that WOULD have been rejected at this threshold: "
          f"{sum(1 for value in sorted_all if value >= recommended)} of {len(sorted_all)}")
    print()
    print("Before enabling enforcement, read the sample of generations at or above the")
    print("threshold and confirm they are genuinely over-copied rather than short topics")
    print("with little room to vary. Then set both env vars:")
    print(f"    SOURCE_SIMILARITY_CONTAINMENT_THRESHOLD={recommended:.2f}")
    print( "    SOURCE_SIMILARITY_ENFORCEMENT_ENABLED=true")

    if seed_overlap_runs:
        sorted_runs = sorted(seed_overlap_runs)
        print()
        print(f"Seed overlap breaches logged: {len(sorted_runs)} "
              f"(median run {percentile(sorted_runs, 0.50):.0f}, max {sorted_runs[-1]})")
        print("Each is a generated exam question sharing a long word run with its verbatim")
        print("seed. These are reviewed individually, not thresholded.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
