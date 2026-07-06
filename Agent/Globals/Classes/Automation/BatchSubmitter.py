from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes


class BatchSubmitter:
    """
    Request collector for a single model.

    The batch API path has been removed: the Agent authenticates to Google's
    enterprise backend with a single API key, which cannot reach that
    backend's GCS/BigQuery batch-prediction jobs. So this class no longer
    submits a batch — it is now a thin collector. Callers enqueue their
    (key, request) pairs here exactly as before, then hand the collector to
    AutomationCaller.call_batch, which executes every entry live and
    bounded-concurrently through the provider. The collector's public surface
    (get_model / is_empty / supports / enqueue / get_entries) and the return
    contract of call_batch are unchanged, so callers did not have to change.
    """

    # Share of an item's progress weight a worker may grant the moment its
    # requests are handed off for execution, with the remaining (1 - share)
    # granted as each result is written. Granting a slice at dispatch makes
    # the parent bar visibly move when work is handed off. Safe by
    # construction: dispatch-share + result-share = the item's full weight, so
    # the per-worker total is unchanged and cannot overshoot.
    SUBMIT_PROGRESS_SHARE    = 0.15

    # Content that cannot ride the collected/pooled execution path and must be
    # sent through a dedicated live call by the caller instead.
    SKIPPED_CONTENT_TYPES    = (AutomationContentTypes.IMAGE, AutomationContentTypes.AUDIO, AutomationContentTypes.VIDEO)

    def __init__(self, model_string: str, main_task = None, timeout_hours: float = None):
        # main_task / timeout_hours are accepted for call-site compatibility;
        # they were only meaningful for the removed batch-poll wait and are
        # unused now that execution is live.
        self.__model_string = model_string
        self.__entries      = []

    def get_model(self) -> str:
        return self.__model_string

    def is_empty(self) -> bool:
        return len(self.__entries) == 0

    def supports(self, request: AutomationRequest) -> bool:
        if request.get_model() != self.__model_string:
            return False

        for content in request.get_inputs():
            content_type = content.get_content_type()
            if content_type in BatchSubmitter.SKIPPED_CONTENT_TYPES:
                return False

            metadata = content.get_metadata() or {}
            if metadata.get("enable_search") or metadata.get("generate_image"):
                return False

        return True

    def enqueue(self, key: str, request: AutomationRequest) -> bool:
        if not self.supports(request):
            return False

        self.__entries.append({
            "key":     key,
            "request": request,
        })

        return True

    def get_entries(self) -> list:
        return list(self.__entries)
