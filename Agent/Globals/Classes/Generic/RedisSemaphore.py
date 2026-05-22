"""
RedisSemaphore

Distributed counting semaphore backed by Redis. Coordinates concurrency
across every process / cluster thread that shares the same Redis
instance — exactly what you want when many workers must collectively
respect an external rate limit (LLM API, third-party HTTP, etc.).

This is intentionally GENERIC: it has no knowledge of Gemini, tokens,
or any specific API. The caller picks a bucket name (typically the
external resource identifier — e.g. a model name) and a maximum
concurrent holder count, and the semaphore blocks until a slot is
available.

Design:
- Slots are members of a Redis sorted set keyed by the bucket. The
  member is a per-holder token (random UUID); the score is the slot's
  expiry timestamp in milliseconds.
- On acquire, expired slots are pruned before counting holders. That
  is the crash-safety net: if a process dies between acquire and
  release, its slot times out after hold_timeout_seconds and frees up
  for the next caller. Without this, a single process crash could
  permanently leak slots and stall the whole pool.
- Release is just a ZREM of the token; idempotent and cheap.
- The acquire path is not strictly atomic (ZCARD then ZADD without a
  Lua script), which means in a burst two callers can both see
  "count < max" and both ADD, briefly overshooting. Acceptable: the
  external API already enforces the hard limit and our retry-on-429
  policy absorbs the rare overshoot. If stricter atomicity is needed,
  promote __acquire to a Lua script.

Usage (context manager — the only correct way; guarantees release):

    async with RedisSemaphore.slot(
        bucket = "gemini:flash-lite",
        max_concurrent = 8,
        hold_timeout_seconds = 180,
    ):
        # ... do the work that occupies one slot ...

The context manager is safe even when Redis is unreachable: it falls
through (no-op acquire / release) so the system degrades to "no
cross-process limit" rather than blocking forever on infrastructure
that does not exist.
"""

import asyncio
import time
import uuid
from contextlib import asynccontextmanager

from Globals.Classes.Task.TaskManager import TaskManager


class RedisSemaphore:
    KEY_PREFIX = "Semaphore:"
    LOG_EVERY_N_POLLS = 5

    @staticmethod
    @asynccontextmanager
    async def slot(
        bucket: str,
        max_concurrent: int,
        hold_timeout_seconds: int,
        poll_interval_seconds: float = 1.0,
    ):
        holder_token = await RedisSemaphore.__acquire(
            bucket = bucket,
            max_concurrent = max_concurrent,
            hold_timeout_seconds = hold_timeout_seconds,
            poll_interval_seconds = poll_interval_seconds,
        )
        try:
            yield holder_token
        finally:
            await RedisSemaphore.__release(bucket = bucket, holder_token = holder_token)

    @staticmethod
    async def __acquire(
        bucket: str,
        max_concurrent: int,
        hold_timeout_seconds: int,
        poll_interval_seconds: float,
    ) -> str | None:
        redis_client = TaskManager.get_redis_client()
        if redis_client is None:
            # Graceful degradation: no Redis -> no cross-process limit.
            # Better than blocking forever waiting on infrastructure that
            # the local-dev or test harness may not have stood up.
            return None

        key = RedisSemaphore.KEY_PREFIX + bucket
        holder_token = uuid.uuid4().hex
        key_ttl_seconds = max(hold_timeout_seconds * 3, hold_timeout_seconds + 30)

        poll_index = 0
        while True:
            now_milliseconds = int(time.time() * 1000)
            slot_expiry_milliseconds = now_milliseconds + hold_timeout_seconds * 1000

            await redis_client.zremrangebyscore(key, 0, now_milliseconds)
            active_holder_count = await redis_client.zcard(key)

            if active_holder_count < max_concurrent:
                await redis_client.zadd(key, {holder_token: slot_expiry_milliseconds})
                await redis_client.expire(key, key_ttl_seconds)
                return holder_token

            if poll_index % RedisSemaphore.LOG_EVERY_N_POLLS == 0:
                print(
                    f"[RedisSemaphore] '{bucket}' is at capacity ({active_holder_count}/"
                    f"{max_concurrent}); waiting for a slot (poll #{poll_index + 1})."
                )

            poll_index += 1
            await asyncio.sleep(poll_interval_seconds)

    @staticmethod
    async def __release(bucket: str, holder_token: str | None) -> None:
        if holder_token is None:
            return

        redis_client = TaskManager.get_redis_client()
        if redis_client is None:
            return

        key = RedisSemaphore.KEY_PREFIX + bucket
        try:
            await redis_client.zrem(key, holder_token)
        except Exception as release_error:
            # Release failure is non-fatal — the slot will auto-expire
            # via its score TTL. Log + move on rather than poisoning the
            # caller's success path.
            print(f"[RedisSemaphore] Release failed for bucket '{bucket}': {release_error}")
