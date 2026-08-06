const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const PaymentProvider = require("../../Globals/Classes/Payments/PaymentProvider");
const CheckoutReceiptIdentifier = require("../../Globals/Classes/Payments/CheckoutReceiptIdentifier");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const PaidDeckAudienceResolver = require("../../Globals/Classes/PaidDeck/PaidDeckAudienceResolver");
const Purchase = require("../../Globals/Model/Purchase");
const PendingOrderQueryEngine = require("../../Globals/Classes/Database/PendingOrderQueryEngine");
const { getUser } = require("../Helpers/GetUser");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { purchaseStatuses } = require("../../Globals/Enumerations/PurchaseStatuses");
const { grantAndSeedDeck, checkUserHasPaidDeckPassword } = require("./PaidDeckGrantHelpers");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const LicenseExpiryResolver = require("../../Globals/Classes/Pricing/LicenseExpiryResolver");
const LicenseDurationConfigurationResolver = require("../../Globals/Classes/Pricing/LicenseDurationConfigurationResolver");
const GrantSources = require("../../Globals/Constants/GrantSources");
const PlanDeckPerkService = require("../../Globals/Classes/Plans/PlanDeckPerkService");
const PlanTierResolver = require("../../Globals/Classes/Plans/PlanTierResolver");
const { planTiers } = require("../../Globals/Enumerations/PlanTiers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const Logger = require("../../Globals/Classes/Logger");
const LogTitles = require("../../Globals/Classes/Logging/LogTitles");
const { logCategory } = require("../../Globals/Enumerations/LogCategory");

// Reasons that describe a deck the caller cannot / need not be granted — an
// already-owned deck (a live license exists) or one that no longer resolves to
// a paid-deck document. Both are skipped by the grant loop and are exempt from
// the explicit-duration requirement.
const NON_GRANTABLE_BREAKDOWN_REASONS = new Set([ErrorCodes.ALREADY_OWNED, ErrorCodes.DECK_NOT_FOUND]);

/**
 * Records the decks whose license term came from an implicit fallback rather
 * than from a configured duration. The acquisition still goes through — a buyer
 * is never blocked by an admin's blank field — but the misconfiguration is
 * logged so the catalogue can be corrected. Priced decks are the interesting
 * case; a free deck has no term to configure, so it is not worth reporting.
 *
 * @param {string} userId the acquiring user
 * @param {Array<object>} breakdownEntries the pricing breakdown entries being granted
 */
function reportImplicitLicenseDurations(userId, breakdownEntries)
{
    const implicitlyPricedDeckIds = breakdownEntries
        .filter(breakdownEntry => breakdownEntry.durationSource === LicenseDurationConfigurationResolver.SOURCE_LEGACY_IMPLICIT_PERPETUAL)
        .map(breakdownEntry => breakdownEntry.deckId);

    if (implicitlyPricedDeckIds.length === 0)
    {
        return;
    }

    Logger.warning(logCategory.PURCHASE, LogTitles.PURCHASE_DECK, "Granting perpetual access to a priced deck with no configured license duration",
    {
        accountId: userId,
        additionalData: { deckIds: implicitlyPricedDeckIds }
    });
}

async function initiatePurchase(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const deckIds = Array.isArray(body?.deckIds) ? body.deckIds : [];
    // Resolve to a Regions enum code (manual pick -> CF-IPCountry -> locale
    // hint -> default) — the same resolution the storefront display uses, so
    // the buyer is charged in exactly the currency they were shown.
    const region = RegionResolver.resolveRegion(request, (body?.region || "").toUpperCase() || null, (body?.localeRegionHint || "").toUpperCase() || null);
    const providerEnum = typeof body?.paymentProvider === "number"
        ? body.paymentProvider
        : paymentProviders[String(body?.paymentProvider || "").toUpperCase()];

    if (deckIds.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_IDS });
        return;
    }

    // Load the user once so the pricing engine can resolve org-perks
    // by email without redundant DB hits.
    const user = await getUser(request);

    // An organization's decks are provided to its members, never sold. Refused
    // here — BEFORE pricing, before any coupon is reserved and before any order
    // is created — so no payment path is reachable for one at all. The publish
    // service already forces their price to zero; this is the second,
    // independent guard, because "it costs nothing" and "it is not purchasable"
    // are different claims and only the second one keeps a deck out of the
    // checkout flow entirely.
    const audienceScopedDeckIds = await PaidDeckAudienceResolver.listOrganizationDeckIds(deckIds);
    if (audienceScopedDeckIds.length > 0)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.DECK_NOT_FOR_SALE, deckIds: audienceScopedDeckIds });
        return;
    }
    // convertToDisplayCurrency = true: the order is created in the buyer's
    // display currency so the payment provider captures the same amount the
    // storefront showed (no display-vs-charge mismatch).
    const pricing = await PaidDeckPricingEngine.computeFinalPrice(session.getUserId(), deckIds, region, user, true);

    // Pro Plus monthly free-deck perk. When the client explicitly claims it for
    // a single deck, atomically consume this month's claim and grant that deck
    // free. Gated by the claim (not by pricing) so it is spendable on at most
    // one deck per month; on grant failure the claim is released so the perk is
    // not lost. Re-authorized server-side against the stored plan tier.
    if (body?.useMonthlyFreeDeckClaim === true)
    {
        if (deckIds.length !== 1)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
            return;
        }

        const claimTier = user ? PlanTierResolver.getEffectiveTier(user) : planTiers.FREE;
        if (PlanDeckPerkService.getMonthlyClaimAllowance(claimTier) <= 0)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: ErrorCodes.FEATURE_NOT_IN_PLAN });
            return;
        }

        const claimDeckId = deckIds[0];
        const claimBreakdownEntry = (pricing.breakdown || []).find(entry => entry.deckId === claimDeckId);
        if (claimBreakdownEntry && NON_GRANTABLE_BREAKDOWN_REASONS.has(claimBreakdownEntry.reason))
        {
            // Already owned (live license) or no longer a paid deck — nothing to claim.
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: claimBreakdownEntry.reason });
            return;
        }
        if (!LicenseExpiryResolver.isGrantable(claimBreakdownEntry))
        {
            response.statusCode = httpStatus.UNPROCESSABLE_ENTITY;
            response.sendJson({ error: ErrorCodes.PRICING_DURATION_NOT_CONFIGURED, deckIds: [claimDeckId] });
            return;
        }

        const consumeResult = await PlanDeckPerkService.tryConsumeClaim(session.getUserId(), claimTier, claimDeckId);
        if (!consumeResult.consumed)
        {
            response.statusCode = httpStatus.CONFLICT;
            response.sendJson({ error: ErrorCodes.MONTHLY_DECK_CLAIM_USED });
            return;
        }

        const database = await DatabaseConnector.getDatabase();
        const expiryResolution = LicenseExpiryResolver.resolve(claimBreakdownEntry);
        const licenseJson = await grantAndSeedDeck(database, session.getUserId(), claimDeckId,
        {
            expiresAt: expiryResolution.expiresAt,
            grantSource: GrantSources.PLAN_PERK
        });

        if (!licenseJson)
        {
            // Grant failed after the claim was consumed — release it so the user
            // keeps this month's free deck.
            await PlanDeckPerkService.releaseClaim(session.getUserId(), consumeResult.periodKey);
            response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
            response.sendJson({ error: ErrorCodes.LICENSE_PERSIST_FAILED });
            return;
        }

        const planPerkOrderId = `planPerk:${consumeResult.periodKey}:${claimDeckId}`;
        const planPerkPurchase = new Purchase
        ({
            userId: session.getUserId(),
            deckId: claimDeckId,
            paymentProvider: paymentProviders.ORG_AUTO_ASSIGN,
            providerOrderId: planPerkOrderId,
            providerPaymentId: "",
            amountMinor: 0,
            currency: pricing.currency || "INR",
            region: region,
            purchaseDate: new Date(),
            refundedAt: new Date(0),
            status: purchaseStatuses.COMPLETED,
            additionalData: { grant: "PLAN_PERK", periodKey: consumeResult.periodKey }
        });
        await database
            .collection(DatabaseConstants.PURCHASES_COLLECTION)
            .updateOne
            (
                { userId: session.getUserId(), deckId: claimDeckId, providerOrderId: planPerkOrderId },
                { $set: planPerkPurchase.toJson() },
                { upsert: true }
            );

        const hasExistingPaidDeckPassword = await checkUserHasPaidDeckPassword(database, session.getUserId());
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            requiresPayment: false,
            pricing: pricing,
            licenses: [LicenseClientView.sanitize(licenseJson)],
            requiresPasswordSetup: !hasExistingPaidDeckPassword,
            monthlyFreeDeckClaimed: true
        });
        return;
    }

    if (pricing.totalMinor === 0)
    {
        // Free / fully-discounted: grant immediately — issue the license and
        // seed the buyer's encrypted content, exactly like a paid checkout
        // does in VerifyPurchase. Without this the client's "added to your
        // library" was a no-op (no license => nothing on the home page).
        const database = await DatabaseConnector.getDatabase();

        const breakdownByDeckId = new Map();
        for (const breakdownEntry of (pricing.breakdown || []))
        {
            breakdownByDeckId.set(breakdownEntry.deckId, breakdownEntry);
        }

        // Explicit-duration gate: a grant may only proceed when every grantable
        // deck resolves to a finite rental or perpetual access. The resolver
        // already supplies perpetual access for a free deck (nothing is being
        // sold, so there is no term to declare), so this can only fire when an
        // operator has opted into PAID_DECK_REQUIRE_EXPLICIT_LICENSE_DURATION for
        // a priced deck — a free acquisition is never refused for it.
        const misconfiguredDeckIds = deckIds.filter((deckId) =>
        {
            const breakdownEntry = breakdownByDeckId.get(deckId);
            if (breakdownEntry && NON_GRANTABLE_BREAKDOWN_REASONS.has(breakdownEntry.reason))
            {
                return false;
            }
            return !LicenseExpiryResolver.isGrantable(breakdownEntry);
        });

        if (misconfiguredDeckIds.length > 0)
        {
            response.statusCode = httpStatus.UNPROCESSABLE_ENTITY;
            response.sendJson({ error: ErrorCodes.PRICING_DURATION_NOT_CONFIGURED, deckIds: misconfiguredDeckIds });
            return;
        }

        reportImplicitLicenseDurations(session.getUserId(), pricing.breakdown || []);

        const issuedLicenses = [];
        for (const deckId of deckIds)
        {
            const breakdownEntry = breakdownByDeckId.get(deckId);
            if (breakdownEntry && NON_GRANTABLE_BREAKDOWN_REASONS.has(breakdownEntry.reason))
            {
                // Already owned (live license) or no longer a paid deck — nothing
                // to grant here.
                continue;
            }

            const orgPerkActive = breakdownEntry !== undefined && breakdownEntry.reason === "ORG_PERK";
            const expiryResolution = LicenseExpiryResolver.resolve(breakdownEntry);
            const licenseOptions =
            {
                expiresAt: expiryResolution.expiresAt,
                grantSource: orgPerkActive ? GrantSources.ORG_DISCOUNTED_PURCHASE : GrantSources.FREE_GRANT
            };

            const licenseJson = await grantAndSeedDeck(database, session.getUserId(), deckId, licenseOptions);
            if (licenseJson)
            {
                issuedLicenses.push(LicenseClientView.sanitize(licenseJson));

                // Record the free acquisition as a zero-amount Purchase so it
                // appears in purchase history / invoices just like a paid one.
                // A stable per-(user, deck) order id keeps a re-grant from
                // stacking duplicate rows.
                const freeGrantOrderId = `free:${deckId}`;
                const freeGrantPurchase = new Purchase
                ({
                    userId: session.getUserId(),
                    deckId: deckId,
                    paymentProvider: paymentProviders.ORG_AUTO_ASSIGN,
                    providerOrderId: freeGrantOrderId,
                    providerPaymentId: "",
                    amountMinor: 0,
                    currency: pricing.currency || "INR",
                    region: region,
                    purchaseDate: new Date(),
                    refundedAt: new Date(0),
                    status: purchaseStatuses.COMPLETED,
                    additionalData: orgPerkActive
                        ? { organizationId: breakdownEntry.organizationId, perkType: "ORG_PERK", durationDays: breakdownEntry.durationDays }
                        : { grant: "FREE" }
                });

                await database
                    .collection(DatabaseConstants.PURCHASES_COLLECTION)
                    .updateOne
                    (
                        { userId: session.getUserId(), deckId: deckId, providerOrderId: freeGrantOrderId },
                        { $set: freeGrantPurchase.toJson() },
                        { upsert: true }
                    );
            }
        }

        const hasExistingPaidDeckPassword = await checkUserHasPaidDeckPassword(database, session.getUserId());

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            requiresPayment: false,
            pricing: pricing,
            licenses: issuedLicenses,
            requiresPasswordSetup: !hasExistingPaidDeckPassword
        });
        return;
    }

    // Explicit-duration gate for the PAID path: validate every deck resolves to
    // a finite or perpetual license BEFORE creating a payment order, so a buyer
    // is never charged for a deck we would then refuse to grant in
    // VerifyPurchase. Mirrors the free-path gate above, and likewise only fires
    // under PAID_DECK_REQUIRE_EXPLICIT_LICENSE_DURATION.
    const paidBreakdownByDeckId = new Map();
    for (const breakdownEntry of (pricing.breakdown || []))
    {
        paidBreakdownByDeckId.set(breakdownEntry.deckId, breakdownEntry);
    }
    const paidMisconfiguredDeckIds = deckIds.filter((deckId) =>
    {
        const breakdownEntry = paidBreakdownByDeckId.get(deckId);
        if (breakdownEntry && NON_GRANTABLE_BREAKDOWN_REASONS.has(breakdownEntry.reason))
        {
            return false;
        }
        return !LicenseExpiryResolver.isGrantable(breakdownEntry);
    });

    if (paidMisconfiguredDeckIds.length > 0)
    {
        response.statusCode = httpStatus.UNPROCESSABLE_ENTITY;
        response.sendJson({ error: ErrorCodes.PRICING_DURATION_NOT_CONFIGURED, deckIds: paidMisconfiguredDeckIds });
        return;
    }

    reportImplicitLicenseDurations(session.getUserId(), pricing.breakdown || []);

    const provider = providerEnum !== undefined
        ? PaymentProviderFactory.getProvider(providerEnum)
        : PaymentProviderFactory.getDefaultProvider();

    if (!provider.isConfigured())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED });
        return;
    }

    // Bound the amount BEFORE it leaves our control. A basket that prices
    // outside the chargeable band means a pricing defect or a manipulation
    // attempt, and either way the provider would reject it remotely — after we
    // had already given up the ability to report the reason cleanly.
    if (!PaymentProvider.isChargeableAmount(pricing.totalMinor))
    {
        Logger.warning(logCategory.PURCHASE, LogTitles.PURCHASE_DECK, "Refused a paid-deck order outside the chargeable amount band",
        {
            accountId: session.getUserId(),
            additionalData: { totalMinor: pricing.totalMinor, currency: pricing.currency, deckIds: deckIds }
        });
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.AMOUNT_OUT_OF_RANGE });
        return;
    }

    // The receipt is derived from the buyer, the (sorted) decks, the amount and
    // the currency — never from the clock. Two clicks on the same basket at the
    // same price therefore produce the same receipt, which is what lets the
    // retry below find the order the first click already created.
    const receiptId = CheckoutReceiptIdentifier.forPaidDeckPurchase
    ({
        userId: session.getUserId(),
        deckIds: deckIds,
        amountMinor: pricing.totalMinor,
        currency: pricing.currency
    });

    // A retry of an unpaid checkout reuses the existing provider order instead
    // of minting a second one for a single purchase. Safe without re-pricing:
    // the amount and currency are inputs to the receipt, so a row found here is
    // provably for the same decks at the same price. If anything about the
    // price moved, the receipt moved with it and this misses.
    const reusableOrder = await PendingOrderQueryEngine.findReusableByReceipt(receiptId, session.getUserId());
    if (reusableOrder)
    {
        const reusedCheckoutContext = provider.buildCheckoutContext(reusableOrder);
        if (reusedCheckoutContext)
        {
            response.statusCode = httpStatus.OK;
            response.sendJson
            ({
                requiresPayment: true,
                provider: provider.getProviderEnumValue(),
                order:
                {
                    providerOrderId: reusableOrder.providerOrderId,
                    amountMinor: reusableOrder.amountMinor,
                    currency: reusableOrder.currency,
                    checkoutContext: reusedCheckoutContext
                },
                pricing: pricing,
                reusedExistingOrder: true
            });
            return;
        }
    }

    // A provider outage must surface as a controlled 502, not an exception
    // thrown out of the handler. Mirrors InitiateCreditPurchase's handling: the
    // provider's own error text is logged server-side and never returned to the
    // client, which would otherwise leak provider internals.
    // Written BEFORE the provider call — see the note in
    // InitiateCreditPurchase for why the previous ordering was wrong.
    await PendingOrderQueryEngine.createPendingOrder
    ({
        providerOrderId: receiptId,
        userId: session.getUserId(),
        deckIds: deckIds,
        amountMinor: pricing.totalMinor,
        currency: pricing.currency,
        region: region,
        paymentProvider: provider.getProviderEnumValue(),
        receiptId: receiptId
    });

    let order;
    try
    {
        order = await provider.initiateOrder
        (
            pricing.totalMinor,
            pricing.currency,
            {
                receiptId: receiptId,
                notes:
                {
                    userId: session.getUserId(),
                    deckIds: deckIds.join(",")
                }
            }
        );
    }
    catch (orderError)
    {
        await PendingOrderQueryEngine.deleteUnclaimedOrder(receiptId, session.getUserId());
        console.error(`[InitiatePurchase] Order creation failed for ${session.getUserId()}: ${orderError?.message || orderError}`);
        response.statusCode = httpStatus.BAD_GATEWAY;
        response.sendJson({ error: ErrorCodes.EXCEPTION });
        return;
    }

    // Attach the provider's order id to the row written above. VerifyPurchase
    // reads it back and grants licenses strictly from it, so a buyer cannot
    // swap in more expensive deckIds after paying.
    await PendingOrderQueryEngine.attachProviderOrderId(receiptId, session.getUserId(), order.providerOrderId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        requiresPayment: true,
        provider: provider.getProviderEnumValue(),
        order: order,
        pricing: pricing
    });
}

module.exports = { initiatePurchase };
