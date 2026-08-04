# Writes the single AI_REQUEST log line that records what one task consumed:
# the account, the model usage and the credits it was charged.
#
# This used to live at the tail of TaskCreditCharger.settle, which meant only
# CHARGED tasks were ever reported. Tasks the credit gate lets through free —
# the generation orchestrators that have no spend rule (GENERATE_FLASHCARDS,
# GENERATE_MOCK_TESTS), and every task in an exempt paid-deck run — make real
# model calls and were therefore invisible: no charge, and no record that any
# tokens had been spent at all. Reporting is now separated from charging so
# both paths write the identical record and the free ones stop being blind
# spots. A free task simply reports credits = 0 with a note saying why.

import os
import time

from Globals.Enumerations.LogCategory import LogCategory
from Globals.Classes.Credits.CreditMeter import CreditMeter
from Globals.Classes.Logging.Logger import Logger
from Globals.Classes.Logging.LogTitles import LogTitles


class TaskUsageReporter:

    # Reasons a task ran without being charged, recorded on the log line so an
    # unbilled generation can be told apart from a billing failure at a glance.
    BILLING_NOTE_NO_RULE = "no spend rule configured for this task type"
    BILLING_NOTE_PAID_DECK = "paid-deck generation — admin-side, never charged"

    @staticmethod
    async def report(user_id: str, task_id: str, task_type: int, start_time: float, credits_charged: float, b_failed: bool, billing_note: str = "") -> None:
        """
        Emits the AI_REQUEST record for a finished task. Never raises — losing a
        log line must not turn a completed task into a failed one.

        @param start_time — the time.time() captured when the task began.
        @param credits_charged — 0 for unmetered or exempt tasks.
        @param billing_note — why the task was free, when it was; empty for
               charged tasks.
        """
        try:
            raw_usage = CreditMeter.raw_snapshot()

            request_additional_data = {
                "taskId": task_id,
                "taskType": task_type,
                "mainTaskId": os.getenv("MAIN_TASK_ID") or "",
                "inputTokens": int(raw_usage.get("INPUT_TOKENS", 0)),
                "outputTokens": int(raw_usage.get("OUTPUT_TOKENS", 0)),
                "durationSeconds": round(max(0.0, time.time() - start_time), 2),
                "credits": round(float(credits_charged), 4),
                "failed": bool(b_failed),
            }

            if billing_note:
                request_additional_data["billingNote"] = billing_note

            if b_failed:
                await Logger.warning(LogCategory.AI_REQUEST, LogTitles.AI_GENERATION, "AI generation task failed", account_id = user_id or "", additional_data = request_additional_data)
            else:
                await Logger.info(LogCategory.AI_REQUEST, LogTitles.AI_GENERATION, "AI generation task completed", account_id = user_id or "", additional_data = request_additional_data)
        except Exception as log_error:
            print(f"[Credits] failed to log AI request: {log_error}")
