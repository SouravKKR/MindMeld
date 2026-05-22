"""
TokenSafeContent

Guard against handing the LLM a prompt body so large the provider rejects
the request with a context-window error. Gemini's hard ceiling is
1 048 576 input tokens; well-formed prompts should stay well below that
even after the system block, examples, and instructions are added on top
of the content body.

The cap is intentionally conservative — 200 000 tokens — so a single
oversized OCR'd PDF cannot push a request near the ceiling once the
surrounding scaffolding is included. Truncation preserves the head of
the content (which usually carries the topic intro, definitions, and
high-density concepts) and drops the tail. We log the drop so it shows
up in the Agent log when investigating quality regressions.

Token count is approximated by character length / 4, which is the
ratio Gemini's tokenizer empirically lands on for mixed English + math
text. The estimate is intentionally cheap (no tokenizer roundtrip);
the cap leaves enough headroom that the approximation's slop is safe.
"""


class TokenSafeContent:
    # 30K tokens (~120K characters) is enough textbook context to write
    # 5-15 cards / questions on any one topic. The previous 200K default
    # was tuned to "fit comfortably under the 1M ceiling per request",
    # but real-world LLM quota is bounded by the per-minute TPM
    # bucket — 4M / model / minute on Tier-1 paid. A 12-request batch at
    # 200K each = 2.4M, leaving almost nothing for the live-fallback
    # retry that the same minute will need. 30K × 12 = 360K leaves room
    # for retries plus parallel workers without tripping the bucket.
    DEFAULT_MAX_TOKENS = 30_000
    CHARS_PER_TOKEN_ESTIMATE = 4

    @staticmethod
    def estimate_token_count(content: str) -> int:
        if not content:
            return 0
        return len(content) // TokenSafeContent.CHARS_PER_TOKEN_ESTIMATE

    @staticmethod
    def cap_content_for_prompt(content: str, max_tokens: int = DEFAULT_MAX_TOKENS, label: str = "content") -> str:
        if not content:
            return content

        estimated_tokens = TokenSafeContent.estimate_token_count(content)
        if estimated_tokens <= max_tokens:
            return content

        max_character_count = max_tokens * TokenSafeContent.CHARS_PER_TOKEN_ESTIMATE
        truncated_content = content[:max_character_count]
        dropped_tokens_estimate = estimated_tokens - max_tokens

        print(
            f"[TokenSafeContent] Truncated {label} from ~{estimated_tokens} to ~{max_tokens} tokens "
            f"(dropped ~{dropped_tokens_estimate} tokens from tail). Cap is conservative to keep "
            f"room for system prompt + instructions + LLM response budget."
        )

        return truncated_content
