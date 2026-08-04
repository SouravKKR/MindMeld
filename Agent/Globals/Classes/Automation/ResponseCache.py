import asyncio
import hashlib
import pickle
from datetime import datetime, timedelta, timezone

from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes


class ResponseCache:

    COLLECTION_NAME           = "llm_response_cache"
    TTL_DAYS                  = 90
    INDEX_INITIALIZED_KEY     = "__response_cache_index_initialized"
    SKIPPED_CONTENT_TYPES     = (AutomationContentTypes.IMAGE, AutomationContentTypes.AUDIO, AutomationContentTypes.VIDEO)

    __initialization_lock = asyncio.Lock()
    __initialized         = False

    @staticmethod
    def compute_key(request: AutomationRequest) -> str | None:
        # A request that names no model is not an LLM call at all. The local
        # providers (DocumentProcessingProvider and friends) do their work
        # in-process and never consult a model, so ProcessSyllabus builds their
        # requests with model=None — and AutomationRequest exposes no setter, so
        # that is permanent rather than a value filled in later.
        #
        # This cache stores LLM responses keyed on the model, precisely so one
        # model can never serve another's cached answer. A model-less request has
        # no meaningful key, so it is simply not cacheable. None is the
        # established "do not cache this" signal here — the skipped content types
        # below return it too, and every caller in AutomationCaller already
        # guards with `if cache_key is not None`.
        #
        # This must stay a None-check and never an unconditional dereference: a
        # cache lookup is an optimisation, and letting one raise takes down the
        # whole workflow it was only meant to make faster.
        model_name = request.get_model()

        if model_name is None:
            return None

        digest = hashlib.sha256()
        digest.update(b"model:")
        digest.update(model_name.encode("utf-8"))

        for content in request.get_inputs():
            content_type = content.get_content_type()

            if content_type in ResponseCache.SKIPPED_CONTENT_TYPES:
                return None

            data     = content.get_data()
            metadata = content.get_metadata() or {}

            digest.update(b"\x00type:")
            digest.update(str(int(content_type)).encode("utf-8"))
            digest.update(b"\x00data:")

            if isinstance(data, str):
                digest.update(data.encode("utf-8"))
            elif isinstance(data, (bytes, bytearray)):
                digest.update(bytes(data))
            else:
                digest.update(repr(data).encode("utf-8"))

            response_as_text = bool(metadata.get("response_as_text", False))
            digest.update(b"\x00response_as_text:")
            digest.update(b"1" if response_as_text else b"0")

        return digest.hexdigest()

    @staticmethod
    async def __ensure_initialized():
        if ResponseCache.__initialized:
            return

        async with ResponseCache.__initialization_lock:
            if ResponseCache.__initialized:
                return

            database = await DatabaseConnector.get_database()
            if database is None:
                return

            collection = database[ResponseCache.COLLECTION_NAME]

            await asyncio.to_thread(
                collection.create_index,
                "key",
                unique = True,
            )

            await asyncio.to_thread(
                collection.create_index,
                "expiresAt",
                expireAfterSeconds = 0,
            )

            ResponseCache.__initialized = True

    @staticmethod
    async def lookup(key: str) -> AutomationResponse | None:
        if key is None:
            return None

        await ResponseCache.__ensure_initialized()

        database = await DatabaseConnector.get_database()
        if database is None:
            return None

        collection = database[ResponseCache.COLLECTION_NAME]
        document   = await asyncio.to_thread(collection.find_one, {"key": key})

        if document is None:
            return None

        try:
            outputs = pickle.loads(document["payload"])
        except Exception as deserialization_error:
            print(f"[ResponseCache] Failed to deserialize cached payload for key {key}: {deserialization_error}")
            return None

        if not isinstance(outputs, list):
            return None

        rebuilt = []
        for serialized in outputs:
            rebuilt.append(AutomationContent(
                AutomationContentTypes(serialized["contentType"]),
                serialized["data"],
                serialized.get("metadata") or {},
            ))

        # The token usage the ORIGINAL live call reported, carried back out so a
        # cache hit can be metered and billed like the call it is standing in
        # for. Absent on entries written before usage was persisted; the caller
        # falls back to a chars/4 estimate for those rather than billing zero.
        return AutomationResponse(rebuilt, document.get("usageMetadata"))

    @staticmethod
    async def store(key: str, response: AutomationResponse) -> None:
        if key is None or response is None:
            return

        outputs = response.get_outputs()
        if not outputs:
            return

        for content in outputs:
            content_type = content.get_content_type()
            if content_type in ResponseCache.SKIPPED_CONTENT_TYPES:
                return

        await ResponseCache.__ensure_initialized()

        database = await DatabaseConnector.get_database()
        if database is None:
            return

        collection = database[ResponseCache.COLLECTION_NAME]

        serializable_outputs = []
        for content in outputs:
            serializable_outputs.append({
                "contentType": int(content.get_content_type()),
                "data":        content.get_data(),
                "metadata":    content.get_metadata() or {},
            })

        try:
            payload = pickle.dumps(serializable_outputs, protocol = pickle.HIGHEST_PROTOCOL)
        except Exception as serialization_error:
            print(f"[ResponseCache] Failed to serialize response for key {key}: {serialization_error}")
            return

        now        = datetime.now(timezone.utc)
        expires_at = now + timedelta(days = ResponseCache.TTL_DAYS)

        document = {
            "key":       key,
            "payload":   payload,
            "createdAt": now,
            "expiresAt": expires_at,
        }

        # The live call's token usage, stored so every later hit on this key can
        # be billed for what the work actually cost instead of nothing. Omitted
        # rather than written as zeroes when the provider reported none, so a
        # reader can tell "no usage recorded" (estimate it) apart from "this
        # genuinely consumed nothing" (bill nothing).
        usage_metadata = response.get_usage_metadata()
        if usage_metadata:
            document["usageMetadata"] = {
                "inputTokens":  int(usage_metadata.get("inputTokens", 0) or 0),
                "outputTokens": int(usage_metadata.get("outputTokens", 0) or 0),
            }

        await asyncio.to_thread(
            lambda: collection.update_one(
                {"key": key},
                {"$set": document},
                upsert = True,
            )
        )
