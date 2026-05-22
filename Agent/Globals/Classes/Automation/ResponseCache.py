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
        digest = hashlib.sha256()
        digest.update(b"model:")
        digest.update(request.get_model().encode("utf-8"))

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

        return AutomationResponse(rebuilt)

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

        await asyncio.to_thread(
            lambda: collection.update_one(
                {"key": key},
                {"$set": document},
                upsert = True,
            )
        )
