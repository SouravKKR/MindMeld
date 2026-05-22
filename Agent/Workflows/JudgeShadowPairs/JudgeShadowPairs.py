import asyncio
import json
import pickle
from datetime import datetime, timezone

from Workflows.Workflow import Workflow
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.ShadowModelEvaluator import ShadowModelEvaluator
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Utility.StripJsonMarkdown import strip_json_markdown


class JudgeShadowPairs(Workflow):

    BATCH_SIZE                 = 50
    JUDGE_MODEL_STRING, _      = ModelPool.SYLLABUS_PROCESSING_MODEL  # gemini-3.1-pro-preview
    JUDGE_SYSTEM_PROMPT        = (
        "You are an impartial expert judging two responses (A and B) generated for the same task. "
        "Evaluate them on factual accuracy, instruction-following, depth, and adherence to the requested "
        "output schema. Return a single compact JSON object with keys: "
        '{"winner": "A" | "B" | "tie", "rationale": "<one-sentence reason>", "scoreA": <0-10>, "scoreB": <0-10>}. '
        "No prose outside the JSON."
    )

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__batch_size = int(payload.get("batchSize", JudgeShadowPairs.BATCH_SIZE))

    async def run(self, args = {}):
        database = await DatabaseConnector.get_database()
        if database is None:
            print("[JudgeShadowPairs] No database connection — exiting.")
            return

        collection = database[ShadowModelEvaluator.COLLECTION_NAME]

        def find_unjudged():
            return list(collection.find(
                {"judged": False, "candidateResponse": {"$ne": None}},
                limit = self.__batch_size,
            ))

        documents = await asyncio.to_thread(find_unjudged)

        if not documents:
            print("[JudgeShadowPairs] No unjudged pairs found.")
            return

        print(f"[JudgeShadowPairs] Judging {len(documents)} pair(s).")

        provider = GeminiProvider()
        caller   = AutomationCaller(provider)

        for document in documents:
            judgement = await self.__judge_one(document, caller)

            update_fields = {
                "judged":      True,
                "judgement":   judgement,
                "judgedAt":    datetime.now(timezone.utc),
                "judgeModel":  JudgeShadowPairs.JUDGE_MODEL_STRING,
            }

            await asyncio.to_thread(
                lambda: collection.update_one(
                    {"_id": document["_id"]},
                    {"$set": update_fields},
                )
            )

        print(f"[JudgeShadowPairs] Done.")

    async def __judge_one(self, document: dict, caller: AutomationCaller) -> dict | None:
        try:
            pro_outputs       = pickle.loads(document["proResponse"])
            candidate_outputs = pickle.loads(document["candidateResponse"])
        except Exception as deserialization_error:
            print(f"[JudgeShadowPairs] Could not deserialize pair {document['_id']}: {deserialization_error}")
            return None

        pro_text       = self.__extract_text(pro_outputs)
        candidate_text = self.__extract_text(candidate_outputs)

        if pro_text is None or candidate_text is None:
            return None

        user_prompt = (
            f"Response A (model {document.get('proModel', 'unknown')}):\n"
            f"-----\n{pro_text}\n-----\n\n"
            f"Response B (model {document.get('candidateModel', 'unknown')}):\n"
            f"-----\n{candidate_text}\n-----\n\n"
            "Compare A and B and return the JSON verdict."
        )

        request = AutomationRequest(
            JudgeShadowPairs.JUDGE_MODEL_STRING,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, JudgeShadowPairs.JUDGE_SYSTEM_PROMPT),
                AutomationContent(AutomationContentTypes.TEXT,   user_prompt),
            ]
        )

        response = await caller.call(request, None, retries = 2)

        if response is None:
            return None

        try:
            data   = response.get_output().get_data()
            parsed = strip_json_markdown(data) if isinstance(data, str) else data
            if not isinstance(parsed, dict):
                return None
            return parsed
        except Exception as parse_error:
            print(f"[JudgeShadowPairs] Failed to parse judgement: {parse_error}")
            return None

    @staticmethod
    def __extract_text(outputs: list) -> str | None:
        for serialized in outputs:
            if serialized.get("contentType") == int(AutomationContentTypes.TEXT):
                data = serialized.get("data")
                if isinstance(data, str):
                    return data
                try:
                    return json.dumps(data, ensure_ascii = False)
                except Exception:
                    return repr(data)
        return None
