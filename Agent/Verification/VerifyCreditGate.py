"""
Verification harness for the credit gate and the credit meter.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyCreditGate.py     (Windows)
    .venv/bin/python Verification/VerifyCreditGate.py             (Linux)

Needs no network and no model calls: TaskManager and CreditLedger are stubbed so
every case is a pure decision check against TaskRunner._evaluate_credit_gate and
CreditMeter. It does read the local credit configuration, so a reachable Mongo is
the one prerequisite; without it the run reports SKIPPED rather than failing.

What it protects. Three defects that all had the same symptom -- work happened
and nobody was billed correctly for it -- and none of which are visible from the
app:

  1. PAID-DECK RUNS WERE CHARGED. Paid-deck generation is admin-side authoring,
     not consumption, so it is never billed. Nothing used to check the flag, so
     the duration-metered stages billed the operator for producing catalogue
     content. The exemption must also beat the balance gate, or a paid-deck run
     is refused for a balance it should never have needed.

  2. CACHE HITS WERE BILLED AT ZERO. AutomationCaller returns a ResponseCache hit
     before ever reaching the provider, so nothing metered it. The cache key is a
     hash of model + prompt with NO account in it, which makes the cache global:
     billing a hit at zero meant the first user to generate a given syllabus paid
     and everyone after them got the same deck free, forever.

  3. THE METER WAS NEVER RESET. CreditMeter is process-global and its docstring
     assumed one task per process -- true for the one-shot Agent/Main.py, false
     for the long-lived Agent/Worker.py, which runs task after task in one
     interpreter. The second task inherited the first task's tokens.

The end-to-end proof that a real generation charges a real account lives in
Common/Testing/Main/run_credit_charging_tests.js; this file pins the decisions
that suite is too slow and too expensive to enumerate.
"""

import asyncio
import os
import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

# The Agent defaults to the PRODUCTION environment when nothing says otherwise,
# and this harness must never read production's database.
if not any(argument.startswith("--environment=") for argument in sys.argv):
    sys.argv.append("--environment=local")

from Globals.Utility.EnvironmentLoader import EnvironmentLoader

EnvironmentLoader.load()

from Globals.Classes.Credits.CreditConfigurationStore import CreditConfigurationStore
from Globals.Classes.Credits.CreditLedger import CreditLedger
from Globals.Classes.Credits.CreditMeter import CreditMeter
from Globals.Classes.Credits.TaskUsageReporter import TaskUsageReporter
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.Task.TaskRunner import TaskRunner
from Globals.Enumerations.TaskTypes import TaskTypes

MAIN_TASK_ID = "verify-credit-gate-main-task"
USER_ID = "verify-credit-gate-user"

# A task type that is token-metered, so a rule exists and "charge" is meaningful.
CHARGEABLE_TASK_TYPE = TaskTypes.FLASHCARD_GENERATION_WORKER

# An orchestrator that makes real model calls but carries no spend rule.
UNMETERED_TASK_TYPE = TaskTypes.GENERATE_FLASHCARDS

passed_count = 0
failed_count = 0


def assert_that(bCondition, description):
    global passed_count, failed_count

    if bCondition:
        passed_count += 1
        print(f"  PASS  {description}")
    else:
        failed_count += 1
        print(f"  FAIL  {description}")


def make_task(payload, task_type = CHARGEABLE_TASK_TYPE):
    return TaskDescriptor(user_id = USER_ID, type = task_type, payload = payload)


async def main():
    configuration = await CreditConfigurationStore.load()
    if configuration is None:
        print("SKIPPED: no credit configuration is readable (is the local MongoDB running?).")
        sys.exit(0)

    if configuration.get_rule_for_task(int(CHARGEABLE_TASK_TYPE.value)) is None:
        print(f"SKIPPED: no spend rule configured for {CHARGEABLE_TASK_TYPE.name}, so 'charge' cannot be asserted.")
        sys.exit(0)

    main_task_holder = {"task": None}
    balance_holder = {"balance": 500.0}

    original_get_balance = CreditLedger.get_balance
    original_get_task = TaskManager.get_task

    async def fake_get_balance(user_id):
        return balance_holder["balance"]

    async def fake_get_task(task_id):
        return main_task_holder["task"]

    CreditLedger.get_balance = staticmethod(fake_get_balance)
    TaskManager.get_task = staticmethod(fake_get_task)
    os.environ["MAIN_TASK_ID"] = MAIN_TASK_ID

    try:
        print("\n=== Paid-deck exemption ===")

        main_task_holder["task"] = None
        gate = await TaskRunner._evaluate_credit_gate(make_task({"paidDeckMode": True}), CHARGEABLE_TASK_TYPE)
        assert_that(gate["action"] == "exempt", "paidDeckMode on the task's OWN payload exempts it")

        main_task_holder["task"] = make_task({"paidDeckMode": True}, TaskTypes.PREPARE_FOR_GENERATION)
        gate = await TaskRunner._evaluate_credit_gate(make_task({}), CHARGEABLE_TASK_TYPE)
        assert_that(gate["action"] == "exempt", "a child task inherits the exemption from the MAIN task")
        assert_that(
            gate.get("reason") == TaskUsageReporter.BILLING_NOTE_PAID_DECK,
            "the exemption records WHY it was free, so it can be told from a billing failure",
        )

        balance_holder["balance"] = 0.0
        gate = await TaskRunner._evaluate_credit_gate(make_task({}), CHARGEABLE_TASK_TYPE)
        assert_that(
            gate["action"] == "exempt",
            "the exemption beats the balance gate -- a paid-deck run is never refused for credits it does not need",
        )

        print("\n=== Everything else is still charged ===")

        balance_holder["balance"] = 500.0
        main_task_holder["task"] = make_task({"paidDeckMode": False}, TaskTypes.PREPARE_FOR_GENERATION)
        gate = await TaskRunner._evaluate_credit_gate(make_task({}), CHARGEABLE_TASK_TYPE)
        assert_that(gate["action"] == "charge", "a normal generation is charged")

        main_task_holder["task"] = None
        gate = await TaskRunner._evaluate_credit_gate(make_task({}), CHARGEABLE_TASK_TYPE)
        assert_that(gate["action"] == "charge", "a normal generation is charged even when the main task is gone")

        balance_holder["balance"] = 0.0
        gate = await TaskRunner._evaluate_credit_gate(make_task({}), CHARGEABLE_TASK_TYPE)
        assert_that(gate["action"] == "deny", "a normal run with no balance is still denied")

        balance_holder["balance"] = 500.0
        gate = await TaskRunner._evaluate_credit_gate(make_task({}, UNMETERED_TASK_TYPE), UNMETERED_TASK_TYPE)
        assert_that(
            gate["action"] == "allow_free",
            f"{UNMETERED_TASK_TYPE.name} has no rule, so it is allow_free -- distinct from an exemption",
        )

        print("\n=== The meter ===")

        CreditMeter.reset()
        CreditMeter.record(120, 60, "gemini-2.5-flash-lite")
        assert_that(
            CreditMeter.raw_snapshot() == {"INPUT_TOKENS": 120, "OUTPUT_TOKENS": 60},
            "record() accumulates raw tokens",
        )

        CreditMeter.reset()
        assert_that(
            CreditMeter.raw_snapshot() == {"INPUT_TOKENS": 0, "OUTPUT_TOKENS": 0}
            and CreditMeter.snapshot() == {"INPUT_TOKENS": 0.0, "OUTPUT_TOKENS": 0.0},
            "reset() clears BOTH the raw and the cost-normalized totals",
        )

        # The long-lived worker runs many tasks per process; without a reset
        # between them the second task is billed for the first task's tokens.
        CreditMeter.record(100, 50, "gemini-2.5-flash-lite")
        CreditMeter.reset()
        CreditMeter.record(10, 5, "gemini-2.5-flash-lite")
        assert_that(
            CreditMeter.raw_snapshot() == {"INPUT_TOKENS": 10, "OUTPUT_TOKENS": 5},
            "a reset between two tasks stops the second inheriting the first's tokens",
        )

        print("\n=== Cache-hit billing ===")

        CreditMeter.reset()
        recorded = CreditMeter.record_cached_usage({"inputTokens": 800, "outputTokens": 400}, model = "gemini-2.5-flash-lite")
        assert_that(
            recorded == {"inputTokens": 800, "outputTokens": 400}
            and CreditMeter.raw_snapshot() == {"INPUT_TOKENS": 800, "OUTPUT_TOKENS": 400},
            "a cache hit with stored usage is metered exactly like the live call it replaces",
        )

        # An expensive model's cached answer must not be billed at the cheap
        # reference rate just because it came from the cache.
        CreditMeter.reset()
        CreditMeter.record_cached_usage({"inputTokens": 1000, "outputTokens": 0}, model = "gemini-3.1-pro-preview")
        expensive_normalized = CreditMeter.snapshot()["INPUT_TOKENS"]
        CreditMeter.reset()
        CreditMeter.record_cached_usage({"inputTokens": 1000, "outputTokens": 0}, model = "gemini-2.5-flash-lite")
        reference_normalized = CreditMeter.snapshot()["INPUT_TOKENS"]
        assert_that(
            expensive_normalized > reference_normalized,
            "a cached answer is normalized by ITS OWN model's cost, not the reference model's",
        )

        # Entries written before usage was persisted must not bill zero.
        CreditMeter.reset()
        CreditMeter.record_cached_usage(None, model = "gemini-2.5-flash-lite",
                                        fallback_input_text = "x" * 4000, fallback_output_text = "y" * 800)
        legacy_usage = CreditMeter.raw_snapshot()
        assert_that(
            legacy_usage["INPUT_TOKENS"] > 0 and legacy_usage["OUTPUT_TOKENS"] > 0,
            "a legacy cache entry with no stored usage is billed from a chars/4 estimate, not at zero",
        )

        CreditMeter.reset()
        assert_that(
            CreditMeter.record_cached_usage(None, model = "gemini-2.5-flash-lite") is None
            and CreditMeter.raw_snapshot() == {"INPUT_TOKENS": 0, "OUTPUT_TOKENS": 0},
            "with neither stored usage nor fallback text there is genuinely nothing to record",
        )

    finally:
        TaskManager.get_task = original_get_task
        CreditLedger.get_balance = original_get_balance

    print("\n=== Summary ===")
    print(f"  passed:  {passed_count}")
    print(f"  failed:  {failed_count}")

    sys.exit(1 if failed_count else 0)


asyncio.run(main())
