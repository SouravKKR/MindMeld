# Orchestrates the four deduction timings for the currently-running task.
# Lives in the Agent because the Agent subprocess is the only thing alive
# during a task run — it is therefore the only place that can charge ON_START,
# AT_INTERVALS, ON_SUCCESS and ON_ANY_COMPLETION with real token/time metrics.
#
# Cost metrics are keyed by CreditCostDimensions name:
#   INPUT_TOKENS / OUTPUT_TOKENS  ← CreditMeter snapshot
#   DURATION_SECONDS              ← wall-clock since the task started

import asyncio
import os
import time

from Globals.Enumerations.CreditDeductionTimings import CreditDeductionTimings
from Globals.Enumerations.CreditTransactionTypes import CreditTransactionTypes
from Globals.Classes.Credits.CreditLedger import CreditLedger
from Globals.Classes.Credits.CreditMeter import CreditMeter
from Globals.Classes.Credits.TaskUsageReporter import TaskUsageReporter


class TaskCreditCharger:

    def __init__(self, user_id: str, task_id: str, task_type: int, rule) -> None:
        self.__user_id = user_id
        self.__task_id = task_id
        self.__task_type = task_type
        self.__rule = rule
        self.__start_time = time.time()
        self.__charged_amount = 0.0
        self.__interval_task = None
        self.__interval_index = 0
        self.__stop_event = None

    def __build_metrics(self) -> dict:
        snapshot = CreditMeter.snapshot()
        return {
            "INPUT_TOKENS": snapshot["INPUT_TOKENS"],
            "OUTPUT_TOKENS": snapshot["OUTPUT_TOKENS"],
            "DURATION_SECONDS": max(0.0, time.time() - self.__start_time),
        }

    def __base_metadata(self) -> dict:
        # mainTaskId ties this child charge back to the generation it belongs
        # to, so the Activity page can show a per-task credit-spend breakdown
        # for the whole run. Absent for top-level / standalone tasks.
        metadata = {"taskId": self.__task_id, "taskType": self.__task_type}
        main_task_id = os.getenv("MAIN_TASK_ID")
        if main_task_id:
            metadata["mainTaskId"] = main_task_id
        return metadata

    def __usage_metadata(self, metrics: dict) -> dict:
        # The raw (un-normalized) usage that drove this charge, recorded on the
        # transaction so the user can see where their credits went: actual
        # tokens consumed and wall-clock seconds. Normalized billing tokens are
        # an internal detail and are intentionally not surfaced here.
        raw_tokens = CreditMeter.raw_snapshot()
        return {
            "inputTokens": int(raw_tokens.get("INPUT_TOKENS", 0)),
            "outputTokens": int(raw_tokens.get("OUTPUT_TOKENS", 0)),
            "durationSeconds": round(float(metrics.get("DURATION_SECONDS", 0.0)), 2),
        }

    async def charge_on_start(self) -> bool:
        """
        Charges the flat (start-time) portion when timing is ON_START.
        Returns False only when the charge was rejected by the balance floor
        — the caller should then fail the task without running the workflow.
        """
        if self.__rule.get_deduction_timing() != CreditDeductionTimings.ON_START:
            return True

        # Empty metrics → only flat terms contribute (tokens / time are 0).
        amount = self.__rule.evaluate({})
        metadata = self.__base_metadata()
        metadata["phase"] = "start"
        result = await CreditLedger.charge(
            self.__user_id,
            amount,
            CreditTransactionTypes.TASK_CHARGE,
            f"task:{self.__task_id}:start",
            metadata,
            self.__rule.get_minimum_balance_floor(),
        )

        if result.get("applied") or result.get("already_applied"):
            self.__charged_amount += result.get("amount", 0)

        return not result.get("rejected", False)

    def begin_interval_charging(self) -> None:
        """Starts the background interval loop when timing is AT_INTERVALS."""
        if self.__rule.get_deduction_timing() != CreditDeductionTimings.AT_INTERVALS:
            return
        self.__stop_event = asyncio.Event()
        self.__interval_task = asyncio.ensure_future(self.__interval_loop())

    async def __interval_loop(self) -> None:
        # The loop is stopped via __stop_event (set in settle), NOT via task
        # cancellation. Cancelling could interrupt an in-flight charge after
        # the balance was decremented but before __charged_amount advanced,
        # which would make the final settle re-charge that delta. Waiting on
        # the event for the interval means the loop only ever exits between
        # charges, keeping __charged_amount consistent.
        interval_seconds = self.__rule.get_interval_seconds()
        while True:
            try:
                await asyncio.wait_for(self.__stop_event.wait(), timeout=interval_seconds)
                # Event was set → stop without charging; settle does the final
                # increment.
                return
            except asyncio.TimeoutError:
                # Interval elapsed → charge the accrued delta, then loop.
                self.__interval_index += 1
                await self.__charge_increment(f"interval:{self.__interval_index}")

    async def __charge_increment(self, reference_suffix: str) -> None:
        """
        Charges the delta between the cumulative cost at this moment and the
        amount already charged this run. Used by the interval loop and by the
        final settle of an AT_INTERVALS rule.
        """
        metrics = self.__build_metrics()
        cumulative_cost = self.__rule.evaluate(metrics)
        delta = cumulative_cost - self.__charged_amount
        if delta <= 0:
            return

        metadata = self.__base_metadata()
        metadata["phase"] = reference_suffix
        metadata["usage"] = self.__usage_metadata(metrics)
        result = await CreditLedger.charge(
            self.__user_id,
            delta,
            CreditTransactionTypes.TASK_CHARGE,
            f"task:{self.__task_id}:{reference_suffix}",
            metadata,
            self.__rule.get_minimum_balance_floor(),
        )

        if result.get("applied") or result.get("already_applied"):
            self.__charged_amount += result.get("amount", 0)

    async def __charge_full(self, reference_suffix: str) -> None:
        metrics = self.__build_metrics()
        amount = self.__rule.evaluate(metrics)
        metadata = self.__base_metadata()
        metadata["phase"] = reference_suffix
        metadata["usage"] = self.__usage_metadata(metrics)
        result = await CreditLedger.charge(
            self.__user_id,
            amount,
            CreditTransactionTypes.TASK_CHARGE,
            f"task:{self.__task_id}:{reference_suffix}",
            metadata,
            self.__rule.get_minimum_balance_floor(),
        )
        if result.get("applied") or result.get("already_applied"):
            self.__charged_amount += result.get("amount", 0)

    async def settle(self, b_failed: bool) -> None:
        """
        Called from Main.py's finally block. Stops the interval loop
        gracefully (so no in-flight charge is interrupted), then applies the
        completion charge appropriate to the rule's timing.
        """
        if self.__interval_task is not None:
            if self.__stop_event is not None:
                self.__stop_event.set()
            try:
                # Wait for the loop to finish any in-progress charge and exit.
                await self.__interval_task
            except Exception as interval_error:
                print(f"[Credits] interval loop ended with error: {interval_error}")
            self.__interval_task = None

        timing = self.__rule.get_deduction_timing()

        if timing == CreditDeductionTimings.AT_INTERVALS:
            # Settle whatever accrued since the last interval tick, regardless
            # of success — the user consumed the tokens / time either way.
            await self.__charge_increment("complete")
        elif timing == CreditDeductionTimings.ON_SUCCESS:
            if not b_failed:
                await self.__charge_full("complete")
        elif timing == CreditDeductionTimings.ON_ANY_COMPLETION:
            await self.__charge_full("complete")
        # ON_START was already settled before the workflow ran.

        # Record this generation as a single AI request in the central log, with
        # the account, model usage and credits spent (requirement: every AI request
        # is logged with its metadata, credits spent and account id). Shared with
        # the free/exempt path in TaskRunner so both write the identical record.
        await TaskUsageReporter.report(
            user_id = self.__user_id,
            task_id = self.__task_id,
            task_type = self.__task_type,
            start_time = self.__start_time,
            credits_charged = self.__charged_amount,
            b_failed = b_failed,
        )
