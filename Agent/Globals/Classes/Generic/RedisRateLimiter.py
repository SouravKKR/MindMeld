"""
RedisRateLimiter

Cross-process rate limiter backed by Redis. Use this to bound any call —
LLM, HTTP, database — when the request rate is enforced by an external
service (or your own infrastructure) and you want all callers across the
Agent process pool to coordinate.

This is intentionally GENERIC: it knows nothing about Gemini, tokens,
or any specific API. The caller picks a bucket name, a max hit count
per window, and a window length in seconds. The limiter holds the call
until adding one more hit would not exceed the budget within the
rolling window, then records the hit and returns.

Usage (single hit, blocking until permitted):

    await RedisRateLimiter.acquire(bucket = "gemini:flash-lite", max_hits = 60, window_seconds = 60)
    # ... do the work that costs one slot ...

Implementation notes:
- Sliding-window via Redis sorted sets (one member per hit, scored by
  millisecond timestamp). Stale entries are pruned on every acquire so
  the set stays bounded.
- Polling cadence is intentionally coarse (one second) — the limiter is
  protecting against a per-minute quota, so sub-second precision adds no
  value and would burn Redis CPU.
- Not strictly atomic at the check-then-add boundary, which means in a
  burst two processes can each see "count < max" and both succeed
  pushing the count slightly over. That is acceptable: callers should
  set max_hits conservatively (below the hard external limit) and rely
  on retry-on-429 to absorb the rare overshoot. If you need true
  atomicity, push the check + zadd into a Lua script.
- TTL on the sorted-set key is window_seconds * 3 — enough to outlive a
  full window of stale entries even with clock drift, while not so long
  that an abandoned bucket sits in Redis forever.
"""

import asyncio
import time
import uuid

from Globals.Classes.Task.TaskManager import TaskManager


class RedisRateLimiter:
    KEY_PREFIX = "RateLimit:"
    DEFAULT_POLL_INTERVAL_SECONDS = 1.0
    KEY_TTL_MULTIPLIER = 3

    @staticmethod
    async def acquire(
        bucket: str,
        max_hits: int,
        window_seconds: int,
        poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> None:
        redis_client = TaskManager.get_redis_client()
        if redis_client is None:
            # Rate limiter is best-effort: if Redis isn't initialised yet
            # (early process startup, or a test harness with no Redis),
            # just let the call through. Better to risk a 429 than to
            # block forever waiting on infrastructure that does not
            # exist.
            return

        key = RedisRateLimiter.KEY_PREFIX + bucket
        ttl_seconds = max(window_seconds * RedisRateLimiter.KEY_TTL_MULTIPLIER, window_seconds + 5)
        log_every_n_polls = 5
        poll_index = 0

        while True:
            now_milliseconds = int(time.time() * 1000)
            window_cutoff_milliseconds = now_milliseconds - window_seconds * 1000

            await redis_client.zremrangebyscore(key, 0, window_cutoff_milliseconds)
            current_hit_count = await redis_client.zcard(key)

            if current_hit_count < max_hits:
                hit_member = f"{now_milliseconds}-{uuid.uuid4().hex}"
                await redis_client.zadd(key, {hit_member: now_milliseconds})
                await redis_client.expire(key, ttl_seconds)
                return

            if poll_index % log_every_n_polls == 0:
                print(
                    f"[RedisRateLimiter] '{bucket}' is at {current_hit_count}/{max_hits} hits in the "
                    f"last {window_seconds}s — waiting (poll #{poll_index + 1})."
                )

            poll_index += 1
            await asyncio.sleep(poll_interval_seconds)
