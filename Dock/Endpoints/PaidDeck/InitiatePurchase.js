const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const Purchase = require("../../Globals/Model/Purchase");
const PendingOrderQueryEngine = require("../../Globals/Classes/Database/PendingOrderQueryEngine");
const { getUser } = require("../Helpers/GetUser");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { purchaseStatuses } = require("../../Globals/Enumerations/PurchaseStatuses");
const { grantAndSeedDeck, checkUserHasPaidDeckPassword } = require("./PaidDeckGrantHelpers");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const LicenseExpiryResolver = require("../../Globals/Classes/Pricing/LicenseExpiryResolver");
const GrantSources = require("../../Globals/Constants/GrantSources");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// Reasons that describe a deck the caller cannot / need not be granted — an
// already-owned deck (a live license exists) or one that no longer resolves to
// a paid-deck document. Both are skipped by the grant loop and are exempt from
// the explicit-duration requirement.
const NON_GRANTABLE_BREAKDOWN_REASONS = new Set([ErrorCodes.ALREADY_OWNED, ErrorCodes.DECK_NOT_FOUND]);

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
    // convertToDisplayCurrency = true: the order is created in the buyer's
    // display currency so the payment provider captures the same amount the
    // storefront showed (no display-vs-charge mismatch).
    const pricing = await PaidDeckPricingEngine.computeFinalPrice(session.getUserId(), deckIds, region, user, true);

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
        // deck resolves to a finite rental or an explicit perpetual flag. A deck
        // whose pricing declares neither is a misconfiguration — refuse the whole
        // grant rather than silently minting a forever license.
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
    // a finite or explicit-perpetual license BEFORE creating a payment order, so
    // a buyer is never charged for a deck we would then refuse to grant in
    // VerifyPurchase. Mirrors the free-path gate above.
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

    const provider = providerEnum !== undefined
        ? PaymentProviderFactory.getProvider(providerEnum)
        : PaymentProviderFactory.getDefaultProvider();

    if (!provider.isConfigured())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED });
        return;
    }

    const order = await provider.initiateOrder
    (
        pricing.totalMinor,
        pricing.currency,
        {
            receiptId: `mm_${session.getUserId().slice(0, 8)}_${Date.now()}`,
            notes:
            {
                userId: session.getUserId(),
                deckIds: deckIds.join(",")
            }
        }
    );

    // Bind the provider order to the buyer + the exact decks + the server-priced
    // amount. VerifyPurchase reads this back and grants licenses strictly from
    // it, so a buyer cannot swap in more expensive deckIds after paying. The
    // order notes above are advisory only — this row is the trusted record.
    await PendingOrderQueryEngine.createPendingOrder
    ({
        providerOrderId: order.providerOrderId,
        userId: session.getUserId(),
        deckIds: deckIds,
        amountMinor: pricing.totalMinor,
        currency: pricing.currency,
        region: region,
        paymentProvider: provider.getProviderEnumValue()
    });

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
