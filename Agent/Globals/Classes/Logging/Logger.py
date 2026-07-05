# The Agent's structured logging entry point. Mirrors Dock's Logger: every call
# builds a canonical log entry (with the timestamp stamped INTERNALLY, never a
# caller parameter) and writes it DIRECTLY to the shared logEvents collection —
# the same trust model as CreditLedger, which already writes money this way. This
# is what makes Agent (and burst-virtual-machine) work visible in the central log
# in production, where the old print shim was a no-operation.
#
# Writes are direct rather than buffered so an entry cannot be lost if a
# short-lived worker exits right after logging. If the database write fails, the
# formatted line is emitted to the real standard output (bypassing any print shim)
# so the entry still survives in the worker's captured output.

import os
import sys
import uuid
from datetime import datetime, timezone

from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Enumerations.LogLevel import LogLevel
from Globals.Enumerations.LogServiceOrigin import LogServiceOrigin
from Globals.Classes.Logging.LogFormatter import LogFormatter


class Logger:

    __sequence_counter = 0

    @staticmethod
    def __next_sequence() -> int:
        Logger.__sequence_counter = (Logger.__sequence_counter + 1) % (2 ** 53)
        return Logger.__sequence_counter

    @staticmethod
    def __resolve_environment() -> str:
        environment = os.getenv("MINDMELD_ENVIRONMENT")
        if environment:
            return environment
        return "local" if "--debug" in sys.argv else "production"

    @staticmethod
    def __build_document(level, category, title, message, account_id, error_code, error_reason, additional_data) -> dict:
        now = datetime.now(timezone.utc)
        return {
            "id": str(uuid.uuid4()),
            "level": int(level),
            "category": int(category),
            "title": str(title),
            "message": "" if message is None else str(message),
            "service": int(LogServiceOrigin.AGENT),
            "accountId": str(account_id) if account_id else "",
            "errorCode": str(error_code) if error_code else "",
            "errorReason": str(error_reason) if error_reason else "",
            "additionalData": additional_data if isinstance(additional_data, dict) else {},
            "timestamp": now,
            "timestampIsoString": now.isoformat(),
            "sequence": Logger.__next_sequence(),
            "environment": Logger.__resolve_environment(),
        }

    @staticmethod
    async def __record(level, category, title, message, account_id="", error_code="", error_reason="", additional_data=None) -> None:
        document = Logger.__build_document(level, category, title, message, account_id, error_code, error_reason, additional_data)

        try:
            database = await DatabaseConnector.get_database()
            if database is not None:
                database[DatabaseConstants.LOG_EVENTS_COLLECTION].insert_one(document)
                return
        except Exception:
            pass

        # Fallback: write the formatted line to the real standard output (not the
        # possibly-shimmed print) so the entry is captured rather than lost.
        try:
            sys.__stdout__.write(LogFormatter.format_line(document) + "\n")
            sys.__stdout__.flush()
        except Exception:
            pass

    @staticmethod
    async def debug(category, title, message, account_id="", error_code="", error_reason="", additional_data=None) -> None:
        await Logger.__record(LogLevel.DEBUG, category, title, message, account_id, error_code, error_reason, additional_data)

    @staticmethod
    async def info(category, title, message, account_id="", error_code="", error_reason="", additional_data=None) -> None:
        await Logger.__record(LogLevel.INFO, category, title, message, account_id, error_code, error_reason, additional_data)

    @staticmethod
    async def warning(category, title, message, account_id="", error_code="", error_reason="", additional_data=None) -> None:
        await Logger.__record(LogLevel.WARNING, category, title, message, account_id, error_code, error_reason, additional_data)

    @staticmethod
    async def error(category, title, message, account_id="", error_code="", error_reason="", additional_data=None) -> None:
        await Logger.__record(LogLevel.ERROR, category, title, message, account_id, error_code, error_reason, additional_data)
