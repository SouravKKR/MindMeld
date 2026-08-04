# Process-global token accumulator for the CURRENTLY-RUNNING task. A
# module-level counter captures a task's total LLM token usage with no plumbing
# through the workflow call tree. GoogleEnterpriseAiProvider, AnthropicProvider
# and the cache-hit path record into it after every call; TaskCreditCharger
# reads the snapshot when it computes token-based costs.
#
# "Process-global" is NOT "one task per process". The one-shot Agent/Main.py
# launcher does run a single task, but Agent/Worker.py is a long-lived poller
# that runs task after task in the same interpreter. TaskRunner.run_task
# therefore calls reset() before every task — without it, a worker's second
# task inherits the first task's tokens and is billed for work it never did.
#
# Two parallel totals are kept:
#   - raw tokens        : the actual counts the provider reported (or, when
#                         the provider omits usage, an estimate). Surfaced for
#                         logging / audit only.
#   - normalized tokens : raw tokens scaled by the serving model's cost
#                         relative to the reference model (see ModelPricing).
#                         Billing reads these so a single per-token credit rate
#                         yields the same margin regardless of which model ran.

from Globals.Constants.ModelPricing import ModelPricing
from Globals.Classes.Generic.TokenSafeContent import TokenSafeContent


class CreditMeter:

    __raw_input_tokens = 0
    __raw_output_tokens = 0
    __normalized_input_tokens = 0.0
    __normalized_output_tokens = 0.0

    # Tracks whether this process has already announced that a provider
    # returned no usage_metadata (so we billed from estimates instead). Logged
    # once per subprocess to confirm whether real token reporting is landing,
    # without flooding the log with one line per batch entry.
    __fallback_notice_emitted = False

    @staticmethod
    def record(input_tokens: int = 0, output_tokens: int = 0, model: str = None) -> None:
        try:
            input_tokens = int(input_tokens or 0)
        except (TypeError, ValueError):
            input_tokens = 0
        try:
            output_tokens = int(output_tokens or 0)
        except (TypeError, ValueError):
            output_tokens = 0

        CreditMeter.__raw_input_tokens += input_tokens
        CreditMeter.__raw_output_tokens += output_tokens

        CreditMeter.__normalized_input_tokens += input_tokens * ModelPricing.input_weight(model)
        CreditMeter.__normalized_output_tokens += output_tokens * ModelPricing.output_weight(model)

    @staticmethod
    def record_from_response(response, model: str = None, fallback_input_text: str = None, fallback_output_text: str = None) -> dict:
        """
        Extracts usage_metadata from a Gemini response (or a streamed chunk),
        records it into the meter, and returns the raw token counts as a plain
        dict. Shared by the live, batch and image-generation paths so token
        accounting is identical everywhere.

        When the provider omits usage (some batch backends report no
        usage_metadata), each missing dimension falls back to a chars/4 token
        estimate of the supplied prompt / output text — the same estimator
        TokenSafeContent uses — so batch-served work is still billed. Returns
        None only when there is genuinely nothing to record (no usage and no
        usable fallback text).
        """
        usage = getattr(response, "usage_metadata", None)

        input_tokens = 0
        output_tokens = 0
        if usage is not None:
            input_tokens = getattr(usage, "prompt_token_count", 0) or 0
            output_tokens = getattr(usage, "candidates_token_count", 0) or 0
            # Thinking models (Gemini 3.x / pro) report reasoning tokens
            # separately as thoughts_token_count. Google bills them at the
            # output rate, but candidates_token_count excludes them — so add
            # them in or the meter under-counts billable output.
            output_tokens += getattr(usage, "thoughts_token_count", 0) or 0

        # Fallback: estimate any dimension the provider left at zero from the
        # length of the corresponding text (chars/4, matching TokenSafeContent).
        if input_tokens == 0 and fallback_input_text:
            input_tokens = TokenSafeContent.estimate_token_count(fallback_input_text)
        if output_tokens == 0 and fallback_output_text:
            output_tokens = TokenSafeContent.estimate_token_count(fallback_output_text)

        if usage is None and input_tokens == 0 and output_tokens == 0:
            return None

        if usage is None and (input_tokens > 0 or output_tokens > 0) and not CreditMeter.__fallback_notice_emitted:
            CreditMeter.__fallback_notice_emitted = True
            print(
                "[CreditMeter] Provider returned no usage_metadata — billing this "
                "task from chars/4 token estimates. (Logged once per process.)"
            )

        CreditMeter.record(input_tokens, output_tokens, model)

        return {"inputTokens": int(input_tokens), "outputTokens": int(output_tokens)}

    @staticmethod
    def record_from_anthropic_response(response, model: str = None, fallback_input_text: str = None, fallback_output_text: str = None) -> dict:
        """
        Anthropic-shaped sibling of record_from_response. The two providers
        report usage under different names, so the extraction differs, but both
        land in the same meter and return the same {inputTokens, outputTokens}
        dict — billing therefore stays provider-agnostic.

        Anthropic reports usage on `response.usage` as input_tokens /
        output_tokens, with cache_creation_input_tokens and
        cache_read_input_tokens broken out separately. Cached reads are BILLED
        (at a reduced rate) and cache writes at a premium, but the meter's job is
        to count tokens, not to price them — ModelPricing applies the per-model
        weight afterwards. Both cache dimensions are therefore folded into the
        input total so a cached call is never metered as free.

        Unlike Gemini, thinking tokens are already included in output_tokens, so
        there is no separate reasoning dimension to add.
        """
        usage = getattr(response, "usage", None)

        input_tokens = 0
        output_tokens = 0
        if usage is not None:
            input_tokens = getattr(usage, "input_tokens", 0) or 0
            input_tokens += getattr(usage, "cache_creation_input_tokens", 0) or 0
            input_tokens += getattr(usage, "cache_read_input_tokens", 0) or 0
            output_tokens = getattr(usage, "output_tokens", 0) or 0

        if input_tokens == 0 and fallback_input_text:
            input_tokens = TokenSafeContent.estimate_token_count(fallback_input_text)
        if output_tokens == 0 and fallback_output_text:
            output_tokens = TokenSafeContent.estimate_token_count(fallback_output_text)

        if usage is None and input_tokens == 0 and output_tokens == 0:
            return None

        if usage is None and (input_tokens > 0 or output_tokens > 0) and not CreditMeter.__fallback_notice_emitted:
            CreditMeter.__fallback_notice_emitted = True
            print(
                "[CreditMeter] Provider returned no usage — billing this task "
                "from chars/4 token estimates. (Logged once per process.)"
            )

        CreditMeter.record(input_tokens, output_tokens, model)

        return {"inputTokens": int(input_tokens), "outputTokens": int(output_tokens)}

    @staticmethod
    def record_cached_usage(usage_metadata: dict, model: str = None, fallback_input_text: str = None, fallback_output_text: str = None) -> dict:
        """
        Records the usage of an answer served from ResponseCache instead of the
        provider.

        A cache hit is billed exactly like a live call, and deliberately so. The
        cache is an infrastructure optimisation that saves the PROVIDER cost,
        not the user's price: the user asked for work and received the finished
        work, so they pay for it. The key matters more than it looks — it is a
        hash of model + prompt only, with no account in it, so the cache is
        shared across every user. Billing a hit at zero would mean the first
        person to generate a given syllabus pays and everyone after them
        generates the same deck for free, forever. The most popular content
        would be the least profitable.

        Entries written before usage was persisted carry none, so each missing
        dimension falls back to the same chars/4 estimate record_from_response
        uses. An approximate charge is right; a zero charge is not.
        """
        usage_metadata = usage_metadata or {}

        input_tokens = int(usage_metadata.get("inputTokens", 0) or 0)
        output_tokens = int(usage_metadata.get("outputTokens", 0) or 0)

        if input_tokens == 0 and fallback_input_text:
            input_tokens = TokenSafeContent.estimate_token_count(fallback_input_text)
        if output_tokens == 0 and fallback_output_text:
            output_tokens = TokenSafeContent.estimate_token_count(fallback_output_text)

        if input_tokens == 0 and output_tokens == 0:
            return None

        CreditMeter.record(input_tokens, output_tokens, model)

        return {"inputTokens": int(input_tokens), "outputTokens": int(output_tokens)}

    @staticmethod
    def snapshot() -> dict:
        # Keyed by CreditCostDimensions name so the values drop straight into a
        # rule's metrics object. These are the COST-NORMALIZED totals — the
        # values billing charges against.
        return {
            "INPUT_TOKENS": CreditMeter.__normalized_input_tokens,
            "OUTPUT_TOKENS": CreditMeter.__normalized_output_tokens,
        }

    @staticmethod
    def raw_snapshot() -> dict:
        # The actual, un-normalized token counts — for logging and audit, not
        # billing.
        return {
            "INPUT_TOKENS": CreditMeter.__raw_input_tokens,
            "OUTPUT_TOKENS": CreditMeter.__raw_output_tokens,
        }

    @staticmethod
    def reset() -> None:
        CreditMeter.__raw_input_tokens = 0
        CreditMeter.__raw_output_tokens = 0
        CreditMeter.__normalized_input_tokens = 0.0
        CreditMeter.__normalized_output_tokens = 0.0
