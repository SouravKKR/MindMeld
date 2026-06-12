import asyncio
import os
import re
import time

from google import genai
from google.genai import types
from google.genai import errors as genai_errors

from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Generic.RedisSemaphore import RedisSemaphore
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Credits.CreditMeter import CreditMeter
from Globals.Constants.ApiConcurrencyLimits import ApiConcurrencyLimits
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes


class BatchSubmitter:

    POLL_INTERVAL_SECONDS    = 60
    DEFAULT_TIMEOUT_HOURS    = 2
    SUCCESS_STATE_FRAGMENT   = "SUCCEEDED"
    FAILURE_STATE_FRAGMENTS  = ("FAILED", "CANCELLED", "CANCELED", "EXPIRED")
    SKIPPED_CONTENT_TYPES    = (AutomationContentTypes.IMAGE, AutomationContentTypes.AUDIO, AutomationContentTypes.VIDEO)
    # Above this threshold we emit a heads-up log so a spike in batch size
    # shows up plainly when investigating a quota / latency regression. The
    # batch API itself accepts much larger payloads — this is a watch
    # marker, not a hard cap. The hard cap lives in the calling worker
    # (e.g. MockTestGenerationWorker.MAX_CELLS_PER_TASK) where it can
    # reason about the user's settings before enqueueing.
    LARGE_BATCH_WARNING_THRESHOLD = 50
    # Mirrors the ratio TokenSafeContent uses — Gemini's tokenizer lands
    # close to len/4 for the mixed English + math content that flows
    # through these prompts. The estimate is informational only (telemetry,
    # not control flow) so the rough approximation is fine.
    CHARS_PER_TOKEN_ESTIMATE = 4
    # Retry-on-429 for batch creation, mirroring GeminiProvider's policy
    # for live calls. The batch-create call itself is small (metadata),
    # but it can still hit the batch enqueue token quota when many workers
    # try to register batches in the same minute. Sleeping a few seconds
    # gives the bucket a chance to drain.
    MAX_RATE_LIMIT_RETRIES = 8
    DEFAULT_RETRY_SLEEP_SECONDS = 8.0
    MAX_RETRY_SLEEP_SECONDS = 60.0

    def __init__(self, model_string: str, main_task: TaskDescriptor = None, timeout_hours: float = None):
        self.__model_string  = model_string
        self.__main_task     = main_task
        self.__timeout_hours = timeout_hours if timeout_hours is not None else BatchSubmitter.DEFAULT_TIMEOUT_HOURS
        self.__client        = genai.Client(api_key = os.getenv("GEMINI_API_KEY"))
        self.__entries       = []
        self.__b_submitted   = False
        self.__batch_name    = None

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
        if self.__b_submitted:
            raise RuntimeError("Cannot enqueue after batch submission")

        if not self.supports(request):
            return False

        self.__entries.append({
            "key":     key,
            "request": request,
        })

        return True

    @staticmethod
    def __build_request_dict(request: AutomationRequest) -> dict:
        system_prompts   = []
        user_parts       = []
        response_as_text = False

        for content in request.get_inputs():
            metadata = content.get_metadata() or {}
            data     = content.get_data()
            ctype    = content.get_content_type()

            if metadata.get("response_as_text", False):
                response_as_text = True

            match ctype:
                case AutomationContentTypes.SYSTEM:
                    system_prompts.append(data)
                case AutomationContentTypes.TEXT:
                    user_parts.append({"text": data})

        config_dict = {
            "response_mime_type": "text/plain" if response_as_text else "application/json",
        }

        if system_prompts:
            config_dict["system_instruction"] = "\n".join(system_prompts)

        request_dict = {
            "contents": [
                {
                    "role":  "user",
                    "parts": user_parts,
                }
            ],
            "config": config_dict,
        }

        return request_dict

    async def submit(self) -> str:
        if self.__b_submitted:
            return self.__batch_name

        if not self.__entries:
            self.__b_submitted = True
            return None

        if len(self.__entries) > BatchSubmitter.LARGE_BATCH_WARNING_THRESHOLD:
            print(
                f"[BatchSubmitter] Large batch on model {self.__model_string}: "
                f"{len(self.__entries)} request(s) (threshold {BatchSubmitter.LARGE_BATCH_WARNING_THRESHOLD}). "
                f"If this triggers RESOURCE_EXHAUSTED, the caller should split the work or reduce inputs."
            )

        inline_requests = [
            BatchSubmitter.__build_request_dict(entry["request"])
            for entry in self.__entries
        ]

        # Pre-submit telemetry: log the prompt size we are about to enqueue.
        # This is the single most useful signal when investigating a
        # RESOURCE_EXHAUSTED on the batch token bucket — it pins down whether
        # the spike came from cell count, per-cell size, or both.
        per_entry_character_counts = [
            BatchSubmitter.__estimate_request_characters(request_dict)
            for request_dict in inline_requests
        ]
        total_character_count = sum(per_entry_character_counts)
        estimated_token_count = total_character_count // BatchSubmitter.CHARS_PER_TOKEN_ESTIMATE
        max_entry_characters = max(per_entry_character_counts) if per_entry_character_counts else 0
        print(
            f"[BatchSubmitter] About to enqueue {len(self.__entries)} request(s) "
            f"on model {self.__model_string}: total ~{total_character_count} chars "
            f"(~{estimated_token_count} tokens), largest single request ~{max_entry_characters} chars."
        )

        def create_batch_sync():
            return self.__client.batches.create(
                model = self.__model_string,
                src   = inline_requests,
                config = {
                    "display_name": f"mindmeld-worker-{os.getenv('TASK_ID', 'unknown')}",
                },
            )

        # Holding a Redis-backed slot during the batch *create* call
        # alone is enough — once the batch is enqueued on Gemini's side
        # the cost is paid against the batch token bucket, not against
        # the per-minute request bucket. Holding through wait_for_completion
        # would block other workers needlessly for what is effectively
        # an out-of-process job. The slot is keyed by model so a busy
        # Flash Lite quota doesn't block Pro batches and vice versa.
        attempt_index = 0
        while True:
            sleep_seconds = None
            async with RedisSemaphore.slot(
                bucket = f"batch-create:{self.__model_string}",
                max_concurrent = ApiConcurrencyLimits.MAX_CONCURRENT_BY_BUCKET.get(
                    self.__model_string,
                    ApiConcurrencyLimits.DEFAULT_MAX_CONCURRENT,
                ),
                hold_timeout_seconds = ApiConcurrencyLimits.SLOT_HOLD_TIMEOUT_SECONDS,
                poll_interval_seconds = ApiConcurrencyLimits.ACQUIRE_POLL_INTERVAL_SECONDS,
            ):
                try:
                    batch_job = await asyncio.to_thread(create_batch_sync)
                    break
                except genai_errors.ClientError as client_error:
                    if not BatchSubmitter.__is_rate_limit_error(client_error):
                        print(
                            f"[BatchSubmitter] Batch create FAILED on model {self.__model_string} "
                            f"({len(self.__entries)} request(s), ~{estimated_token_count} tokens): {client_error}"
                        )
                        raise

                    if attempt_index >= BatchSubmitter.MAX_RATE_LIMIT_RETRIES:
                        print(
                            f"[BatchSubmitter] 429 RESOURCE_EXHAUSTED creating batch on "
                            f"model {self.__model_string} after {attempt_index} retries — giving up."
                        )
                        raise

                    sleep_seconds = BatchSubmitter.__resolve_retry_delay_seconds(client_error, attempt_index)
                    print(
                        f"[BatchSubmitter] 429 RESOURCE_EXHAUSTED creating batch on "
                        f"model {self.__model_string} (attempt {attempt_index + 1}/"
                        f"{BatchSubmitter.MAX_RATE_LIMIT_RETRIES}). Sleeping {sleep_seconds:.1f}s then retrying."
                    )
                except Exception as batch_create_error:
                    print(
                        f"[BatchSubmitter] Batch create FAILED on model {self.__model_string} "
                        f"({len(self.__entries)} request(s), ~{estimated_token_count} tokens): {batch_create_error}"
                    )
                    raise

            # Sleep is OUTSIDE the semaphore — we have released our slot
            # back to the pool while we back off.
            if sleep_seconds is not None:
                await asyncio.sleep(sleep_seconds)
            attempt_index += 1

        self.__batch_name  = batch_job.name
        self.__b_submitted = True

        print(f"[BatchSubmitter] Submitted batch {self.__batch_name} with {len(self.__entries)} request(s) on model {self.__model_string}")

        return self.__batch_name

    @staticmethod
    def __is_rate_limit_error(client_error) -> bool:
        status_code = getattr(client_error, "code", None)
        if status_code == 429:
            return True
        return "RESOURCE_EXHAUSTED" in str(client_error)

    @staticmethod
    def __resolve_retry_delay_seconds(client_error, attempt_index: int) -> float:
        seconds = BatchSubmitter.__extract_retry_delay_from_error(client_error)
        if seconds is None:
            seconds = BatchSubmitter.DEFAULT_RETRY_SLEEP_SECONDS * (2 ** attempt_index)
        return min(max(seconds, 1.0), BatchSubmitter.MAX_RETRY_SLEEP_SECONDS)

    @staticmethod
    def __extract_retry_delay_from_error(client_error) -> float | None:
        for attribute_name in ("details", "response_json"):
            attribute_value = getattr(client_error, attribute_name, None)
            if isinstance(attribute_value, dict):
                error_block = attribute_value.get("error", attribute_value)
                for detail_entry in error_block.get("details", []) or []:
                    if detail_entry.get("@type", "").endswith("RetryInfo"):
                        delay_string = detail_entry.get("retryDelay", "")
                        match = re.match(r"^([0-9.]+)s$", delay_string.strip()) if isinstance(delay_string, str) else None
                        if match:
                            try:
                                return float(match.group(1))
                            except ValueError:
                                continue

        regex_match = re.search(r"retryDelay['\"]?\s*:\s*['\"]?([0-9.]+)s", str(client_error))
        if regex_match:
            try:
                return float(regex_match.group(1))
            except ValueError:
                return None
        return None

    @staticmethod
    def __estimate_request_characters(request_dict: dict) -> int:
        character_count = 0
        config_dict = request_dict.get("config") or {}
        system_instruction = config_dict.get("system_instruction")
        if isinstance(system_instruction, str):
            character_count += len(system_instruction)

        for content_entry in request_dict.get("contents", []) or []:
            for part in content_entry.get("parts", []) or []:
                text_value = part.get("text") if isinstance(part, dict) else None
                if isinstance(text_value, str):
                    character_count += len(text_value)

        return character_count

    async def __refresh_task_ttl(self):
        if self.__main_task is None:
            return

        try:
            await TaskManager.set_task(self.__main_task, atomic = True)
        except Exception as refresh_error:
            print(f"[BatchSubmitter] TTL refresh failed: {refresh_error}")

    async def wait_for_completion(self) -> bool:
        if not self.__b_submitted:
            raise RuntimeError("submit() must be called before wait_for_completion()")

        if self.__batch_name is None:
            return True

        deadline = time.time() + self.__timeout_hours * 3600

        while True:
            def get_batch_sync():
                return self.__client.batches.get(name = self.__batch_name)

            try:
                batch_job = await asyncio.to_thread(get_batch_sync)
            except Exception as poll_error:
                print(f"[BatchSubmitter] Poll error on {self.__batch_name}: {poll_error}")
                if time.time() >= deadline:
                    return False
                await asyncio.sleep(BatchSubmitter.POLL_INTERVAL_SECONDS)
                continue

            state_name = batch_job.state.name if hasattr(batch_job.state, "name") else str(batch_job.state)
            state_upper = state_name.upper()

            if BatchSubmitter.SUCCESS_STATE_FRAGMENT in state_upper:
                print(f"[BatchSubmitter] Batch {self.__batch_name} succeeded (state={state_name})")
                return True

            if any(failure_fragment in state_upper for failure_fragment in BatchSubmitter.FAILURE_STATE_FRAGMENTS):
                print(f"[BatchSubmitter] Batch {self.__batch_name} ended in terminal failure state: {state_name}")
                return False

            await self.__refresh_task_ttl()

            if time.time() >= deadline:
                print(f"[BatchSubmitter] Batch {self.__batch_name} exceeded {self.__timeout_hours}h timeout (state={state_name})")
                return False

            await asyncio.sleep(BatchSubmitter.POLL_INTERVAL_SECONDS)

    async def collect_results(self) -> dict:
        results = {}

        if not self.__b_submitted or self.__batch_name is None:
            return results

        def get_batch_sync():
            return self.__client.batches.get(name = self.__batch_name)

        try:
            batch_job = await asyncio.to_thread(get_batch_sync)
        except Exception as fetch_error:
            print(f"[BatchSubmitter] collect_results fetch error: {fetch_error}")
            for entry in self.__entries:
                results[entry["key"]] = None
            return results

        inlined_responses = None
        dest              = getattr(batch_job, "dest", None)

        if dest is not None:
            inlined_responses = getattr(dest, "inlined_responses", None)

        if inlined_responses is None:
            print(f"[BatchSubmitter] No inlined_responses on batch {self.__batch_name}")
            for entry in self.__entries:
                results[entry["key"]] = None
            return results

        for entry, inlined in zip(self.__entries, inlined_responses):
            key = entry["key"]

            if getattr(inlined, "error", None) is not None:
                print(f"[BatchSubmitter] Batch entry {key} returned error: {inlined.error}")
                results[key] = None
                continue

            response = getattr(inlined, "response", None)
            if response is None:
                results[key] = None
                continue

            text_data = None
            try:
                text_data = response.text
            except Exception:
                text_data = None

            if text_data is None:
                candidates = getattr(response, "candidates", None) or []
                for candidate in candidates:
                    content = getattr(candidate, "content", None)
                    if content is None:
                        continue
                    for part in getattr(content, "parts", []) or []:
                        part_text = getattr(part, "text", None)
                        if part_text:
                            text_data = part_text
                            break
                    if text_data:
                        break

            if text_data is None:
                results[key] = None
                continue

            # Record any per-response token usage the batch surfaced so
            # per-token spend rules apply to batch-served tasks too. Many
            # batch backends omit it; record_from_response returns None then.
            usage_metadata = CreditMeter.record_from_response(response)

            outputs = [AutomationContent(AutomationContentTypes.TEXT, text_data)]
            results[key] = AutomationResponse(outputs, usage_metadata)

        if len(results) < len(self.__entries):
            for entry in self.__entries:
                results.setdefault(entry["key"], None)

        return results

    def get_entries(self) -> list:
        return list(self.__entries)
