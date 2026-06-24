import os

from Globals.Classes.Task.TaskManager import TaskManager


class ProviderHealthSignal:
    """
    Publishes a short-lived "the AI provider is busy" signal so the generation
    progress UI can tell the user that a 5xx / 429 slowdown is provider-side and
    the task has NOT halted.

    The signal is a single Redis key per generation root task with a short TTL:
    every transient provider error refreshes the key, and it clears itself once
    the errors stop. No explicit teardown is needed — when the provider recovers
    and no further error refreshes the key, it simply expires.
    """

    KEY_PREFIX = "ProviderSlowdown/"
    SIGNAL_TTL_SECONDS = 90

    @staticmethod
    def __resolve_root_task_id(root_task_id: str = None) -> str:
        """
        Resolves the generation root task id the signal is keyed by. Prefers an
        explicitly supplied id, otherwise falls back to the ambient MAIN_TASK_ID
        (the generation root every worker subprocess inherits), then TASK_ID.
        """
        if root_task_id:
            return root_task_id

        return os.getenv("MAIN_TASK_ID") or os.getenv("TASK_ID") or ""

    @staticmethod
    async def mark_slowdown(reason: str, root_task_id: str = None):
        """
        Refreshes the provider-slowdown signal for the current generation root.

        Best-effort by design: a telemetry write must never disrupt generation,
        so every failure here is swallowed.
        """
        try:
            resolved_root_task_id = ProviderHealthSignal.__resolve_root_task_id(root_task_id)
            if not resolved_root_task_id:
                return

            redis_client = TaskManager.get_redis_client()
            if redis_client is None:
                return

            signal_key = ProviderHealthSignal.KEY_PREFIX + resolved_root_task_id
            await redis_client.set(signal_key, reason, ex=ProviderHealthSignal.SIGNAL_TTL_SECONDS)
        except Exception:
            # Telemetry must never break the generation pipeline.
            pass
