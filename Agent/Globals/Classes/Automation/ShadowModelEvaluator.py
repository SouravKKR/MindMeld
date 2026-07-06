import asyncio
import hashlib
import os
import pickle
import random
from datetime import datetime, timezone

from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes


class ShadowModelEvaluator:

    SAMPLE_RATE                  = 0.05
    PRO_TIER_MODELS              = {"gemini-3.1-pro-preview"}
    CANDIDATE_MODEL              = "gemini-3.1-flash-lite"
    COLLECTION_NAME              = "shadow_pairs"
    SKIPPED_CONTENT_TYPES        = (AutomationContentTypes.IMAGE, AutomationContentTypes.AUDIO, AutomationContentTypes.VIDEO)
    __initialization_lock        = asyncio.Lock()
    __initialized                = False

    @staticmethod
    def __is_disabled() -> bool:
        return os.getenv("SHADOW_EVALUATOR_DISABLED", "").lower() in ("1", "true", "yes")

    @staticmethod
    def __is_eligible_request(request: AutomationRequest) -> bool:
        if request.get_model() not in ShadowModelEvaluator.PRO_TIER_MODELS:
            return False

        for content in request.get_inputs():
            content_type = content.get_content_type()
            if content_type in ShadowModelEvaluator.SKIPPED_CONTENT_TYPES:
                return False

            metadata = content.get_metadata() or {}
            if metadata.get("enable_search") or metadata.get("generate_image"):
                return False

        return True

    @staticmethod
    def __compute_input_hash(request: AutomationRequest) -> str:
        digest = hashlib.sha256()
        digest.update(request.get_model().encode("utf-8"))

        for content in request.get_inputs():
            data = content.get_data()
            digest.update(str(int(content.get_content_type())).encode("utf-8"))
            digest.update(b"\x00")
            digest.update(data.encode("utf-8") if isinstance(data, str) else repr(data).encode("utf-8"))
            digest.update(b"\x00")

        return digest.hexdigest()

    @staticmethod
    async def __ensure_initialized():
        if ShadowModelEvaluator.__initialized:
            return

        async with ShadowModelEvaluator.__initialization_lock:
            if ShadowModelEvaluator.__initialized:
                return

            database = await DatabaseConnector.get_database()
            if database is None:
                return

            collection = database[ShadowModelEvaluator.COLLECTION_NAME]

            await asyncio.to_thread(collection.create_index, "inputHash")
            await asyncio.to_thread(collection.create_index, "cellKey")
            await asyncio.to_thread(collection.create_index, "judged")

            ShadowModelEvaluator.__initialized = True

    @staticmethod
    def __serialize_response(response: AutomationResponse) -> bytes:
        outputs = []
        for content in response.get_outputs():
            outputs.append({
                "contentType": int(content.get_content_type()),
                "data":        content.get_data(),
                "metadata":    content.get_metadata() or {},
            })
        return pickle.dumps(outputs, protocol = pickle.HIGHEST_PROTOCOL)

    @staticmethod
    def maybe_sample_and_shadow(request: AutomationRequest, pro_response: AutomationResponse, cell_key: str | None = None) -> None:
        """
        Fire-and-forget hook. Called after a successful pro-tier response.
        Decides whether to sample, and if so schedules an async shadow call.
        Returns immediately so the production path is never blocked.
        """
        if ShadowModelEvaluator.__is_disabled():
            return

        if pro_response is None:
            return

        if not ShadowModelEvaluator.__is_eligible_request(request):
            return

        if random.random() >= ShadowModelEvaluator.SAMPLE_RATE:
            return

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        loop.create_task(ShadowModelEvaluator.__run_shadow_call(request, pro_response, cell_key))

    @staticmethod
    async def __run_shadow_call(request: AutomationRequest, pro_response: AutomationResponse, cell_key: str | None) -> None:
        try:
            candidate_request = AutomationRequest(
                ShadowModelEvaluator.CANDIDATE_MODEL,
                request.get_inputs(),
            )

            candidate_provider = GoogleEnterpriseAiProvider()
            candidate_response = await candidate_provider.execute(candidate_request)

            await ShadowModelEvaluator.__persist_pair(
                request,
                pro_response,
                candidate_response,
                cell_key,
            )
        except Exception as shadow_error:
            print(f"[ShadowModelEvaluator] Shadow call failed: {shadow_error}")

    @staticmethod
    async def __persist_pair(
        original_request:   AutomationRequest,
        pro_response:       AutomationResponse,
        candidate_response: AutomationResponse,
        cell_key:           str | None,
    ) -> None:
        await ShadowModelEvaluator.__ensure_initialized()

        database = await DatabaseConnector.get_database()
        if database is None:
            return

        collection = database[ShadowModelEvaluator.COLLECTION_NAME]

        document = {
            "inputHash":         ShadowModelEvaluator.__compute_input_hash(original_request),
            "cellKey":           cell_key,
            "proModel":          original_request.get_model(),
            "candidateModel":    ShadowModelEvaluator.CANDIDATE_MODEL,
            "proResponse":       ShadowModelEvaluator.__serialize_response(pro_response),
            "candidateResponse": ShadowModelEvaluator.__serialize_response(candidate_response) if candidate_response is not None else None,
            "createdAt":         datetime.now(timezone.utc),
            "judged":            False,
            "judgement":         None,
        }

        await asyncio.to_thread(collection.insert_one, document)
