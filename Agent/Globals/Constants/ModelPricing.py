# Per-model API pricing, used to cost-normalize metered tokens before they
# are billed. Tokens from an expensive model are scaled up relative to a
# reference model, so a single per-token credit rate set in the admin panel
# yields the same profit margin no matter which model served the call (a
# flashcard worker mixes three models across its cells).
#
# This is the source of truth for that normalization. Update it whenever
# Google changes published pricing; adding a new model is a one-line entry.


class ModelPricing:

    # USD per 1,000,000 tokens, as (input_price, output_price). Pro pricing is
    # the published rate for prompts up to 200K context (it doubles above
    # that); generation prompts stay well under that ceiling, so the base rate
    # is used.
    PRICING = {
        "gemini-2.5-flash-lite": (0.10, 0.40),
        "gemini-3.1-flash-lite": (0.25, 1.50),
        "gemini-3.1-pro-preview": (2.00, 12.00),
    }

    # Tokens of the reference model count 1:1; every other model's tokens are
    # scaled by their price ratio to this one. The cheapest model is chosen as
    # the reference so all weights are >= 1, and a single admin credit-rate
    # calibrated to it produces the target margin on every model.
    REFERENCE_MODEL = "gemini-2.5-flash-lite"

    # Margin-gradient compression. Billing weights are pulled toward 1.0 (flat)
    # from the true cost ratio so cheaper models keep a higher profit margin
    # than expensive ones, instead of every model landing on the same margin.
    #   1.0 = bill at the true cost ratio (every model the same margin)
    #   0.0 = flat (the cheapest model keeps full margin; expensive models lose
    #         it and can run at a loss)
    # 0.70 gives the intended gradient: at the recommended rate the reference
    # (cheapest) model earns ~60%, gemini-3.1-flash-lite ~53%, and
    # gemini-3.1-pro ~48% — cheaper models carry the higher margin.
    MARGIN_COMPRESSION = 0.70

    # Models absent from PRICING fall back to the reference model's pricing
    # (weight 1.0) so an unregistered model never silently inflates a charge.
    # A one-time warning is logged so the gap gets noticed and the model added.
    __warned_models = set()

    @staticmethod
    def __resolve_pricing(model: str) -> tuple:
        if model is None:
            return ModelPricing.PRICING[ModelPricing.REFERENCE_MODEL]

        pricing = ModelPricing.PRICING.get(model)
        if pricing is None:
            if model not in ModelPricing.__warned_models:
                ModelPricing.__warned_models.add(model)
                print(
                    f"[ModelPricing] No pricing registered for model '{model}' — "
                    f"normalizing as the reference model (weight 1.0). "
                    f"Add it to ModelPricing.PRICING."
                )
            return ModelPricing.PRICING[ModelPricing.REFERENCE_MODEL]

        return pricing

    @staticmethod
    def __compress(true_ratio: float) -> float:
        # Pulls a true cost ratio toward 1.0 by MARGIN_COMPRESSION so expensive
        # models are billed below their true relative cost, leaving cheaper
        # models with the higher margin.
        return 1.0 + ModelPricing.MARGIN_COMPRESSION * (true_ratio - 1.0)

    @staticmethod
    def input_weight(model: str) -> float:
        reference_input_price = ModelPricing.PRICING[ModelPricing.REFERENCE_MODEL][0]
        input_price = ModelPricing.__resolve_pricing(model)[0]
        return ModelPricing.__compress(input_price / reference_input_price)

    @staticmethod
    def output_weight(model: str) -> float:
        reference_output_price = ModelPricing.PRICING[ModelPricing.REFERENCE_MODEL][1]
        output_price = ModelPricing.__resolve_pricing(model)[1]
        return ModelPricing.__compress(output_price / reference_output_price)
