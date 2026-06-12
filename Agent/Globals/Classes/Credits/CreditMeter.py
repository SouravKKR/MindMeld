# Process-global token accumulator. Each Agent subprocess runs exactly one
# task, so a module-level counter cleanly captures that task's total LLM
# token usage with no plumbing through the workflow call tree. GeminiProvider
# records into it after every generate_content call; TaskCreditCharger reads
# the snapshot when it computes token-based costs.


class CreditMeter:

    __input_tokens = 0
    __output_tokens = 0

    @staticmethod
    def record(input_tokens: int = 0, output_tokens: int = 0) -> None:
        try:
            CreditMeter.__input_tokens += int(input_tokens or 0)
        except (TypeError, ValueError):
            pass
        try:
            CreditMeter.__output_tokens += int(output_tokens or 0)
        except (TypeError, ValueError):
            pass

    @staticmethod
    def record_from_response(response) -> dict:
        """
        Extracts usage_metadata from a Gemini response (or a streamed chunk),
        records it into the meter, and returns it as a plain dict — or None
        when the object carries no usage block. Shared by the live, batch and
        image-generation paths so token accounting is identical everywhere.
        """
        usage = getattr(response, "usage_metadata", None)
        if usage is None:
            return None

        input_tokens = getattr(usage, "prompt_token_count", 0) or 0
        output_tokens = getattr(usage, "candidates_token_count", 0) or 0

        CreditMeter.record(input_tokens, output_tokens)

        return {"inputTokens": int(input_tokens), "outputTokens": int(output_tokens)}

    @staticmethod
    def snapshot() -> dict:
        # Keyed by CreditCostDimensions name so the values drop straight into
        # a rule's metrics object.
        return {
            "INPUT_TOKENS": CreditMeter.__input_tokens,
            "OUTPUT_TOKENS": CreditMeter.__output_tokens,
        }

    @staticmethod
    def reset() -> None:
        CreditMeter.__input_tokens = 0
        CreditMeter.__output_tokens = 0
