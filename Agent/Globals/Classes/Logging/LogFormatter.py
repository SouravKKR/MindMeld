# Mirror of Dock/Globals/Classes/Logging/LogFormatter.js (the JavaScript side owns
# the HTML rendering used by the download endpoint; the Agent only needs the plain
# canonical line for its fallback output). Producing the identical single-line
# format here keeps "what you see equals what you download" true across services.

import json

from Globals.Enumerations.LogLevel import LogLevel


class LogFormatter:

    @staticmethod
    def severity_name(level) -> str:
        try:
            return LogLevel(int(level)).name
        except Exception:
            return "INFO"

    @staticmethod
    def __resolve_iso_string(log_entry_document: dict) -> str:
        iso_string = log_entry_document.get("timestampIsoString")
        if isinstance(iso_string, str) and len(iso_string) > 0:
            return iso_string

        timestamp = log_entry_document.get("timestamp")
        try:
            return timestamp.isoformat()
        except Exception:
            return ""

    @staticmethod
    def format_line(log_entry_document: dict) -> str:
        severity = LogFormatter.severity_name(log_entry_document.get("level"))
        iso_string = LogFormatter.__resolve_iso_string(log_entry_document)
        title = log_entry_document.get("title") or ""
        message = log_entry_document.get("message") or ""

        line = f"{severity}:[{iso_string}]:{title}: {message}"

        extras = {}
        if log_entry_document.get("accountId"):
            extras["accountId"] = log_entry_document.get("accountId")
        if log_entry_document.get("errorCode"):
            extras["errorCode"] = log_entry_document.get("errorCode")
        if log_entry_document.get("errorReason"):
            extras["errorReason"] = log_entry_document.get("errorReason")

        additional_data = log_entry_document.get("additionalData")
        if isinstance(additional_data, dict) and len(additional_data) > 0:
            extras["additionalData"] = additional_data

        if len(extras) > 0:
            line += " " + json.dumps(extras, default=str)

        return line
