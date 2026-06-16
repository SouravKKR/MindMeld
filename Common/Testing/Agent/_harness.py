# Tiny dependency-free test harness shared by the Agent Python suites. It
# collects cases, tags each with the catalogued function it exercises (for
# structural coverage), and writes the uniform per-suite JSON that
# .claude/skills/run-tests/run_tests.py aggregates. Exit code stays 0 even on
# failures so the orchestrator can read the JSON and continue.

import json
import os
import sys
import time
import traceback


class Harness:
    def __init__(self, service, category, catalogued_targets):
        self.service = service
        self.category = category
        self.catalogued_targets = list(catalogued_targets)
        self._cases = []

    def test(self, name, target):
        """Decorator: register a test function. `target` is the catalogued
        function name this case exercises (drives structural coverage)."""
        def decorator(function):
            self._cases.append({"name": name, "target": target, "function": function})
            return function
        return decorator

    def run_and_write(self, result_file):
        results = []
        for case in self._cases:
            started = time.time()
            entry = {"name": case["name"], "target": case["target"]}
            try:
                case["function"]()
                entry["status"] = "PASS"
                entry["detail"] = ""
            except AssertionError as error:
                entry["status"] = "FAIL"
                entry["detail"] = str(error) or "assertion failed"
            except Exception as error:  # noqa: BLE001 - report any error as a failure
                entry["status"] = "FAIL"
                entry["detail"] = f"{type(error).__name__}: {error}"
                entry["trace"] = traceback.format_exc().splitlines()[-3:]
            entry["durationSeconds"] = round(time.time() - started, 4)
            results.append(entry)

        passed = sum(1 for entry in results if entry["status"] == "PASS")
        failed = sum(1 for entry in results if entry["status"] == "FAIL")
        covered = sorted({entry["target"] for entry in results
                          if entry["status"] == "PASS" and entry["target"] in self.catalogued_targets})
        total_targets = len(self.catalogued_targets) or 1
        percent = round(100.0 * len(covered) / total_targets, 1)

        payload = {
            "service": self.service,
            "category": self.category,
            "status": "PASS" if failed == 0 else "FAIL",
            "passed": passed,
            "failed": failed,
            "skipped": 0,
            "total": len(results),
            "coverage": {
                "kind": "structural",
                "label": "Functions",
                "percent": percent,
                "covered": len(covered),
                "total": len(self.catalogued_targets),
                "detail": f"{len(covered)}/{len(self.catalogued_targets)} catalogued functions have a passing test",
            },
            "cases": results,
        }

        target = result_file or os.environ.get("RESULT_FILE")
        if target:
            os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)

        print(f"{self.service} {self.category}: {passed} passed, {failed} failed, "
              f"coverage {percent}%")
        if failed:
            for entry in results:
                if entry["status"] == "FAIL":
                    print(f"  FAIL {entry['name']}: {entry['detail']}", file=sys.stderr)
        return payload
