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
const GrantSources = require("../../Globals/Constants/GrantSources");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

const MILLISECONDS_PER_DAY = 86_400_000;

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

        const perkLookupByDeckId = new Map();
        for (const breakdownEntry of (pricing.breakdown || []))
        {
            if (breakdownEntry.reason === "ORG_PERK")
            {
                perkLookupByDeckId.set(breakdownEntry.deckId, breakdownEntry);
            }
        }

        const issuedLicenses = [];
        for (const deckId of deckIds)
        {
            const perkBreakdown = perkLookupByDeckId.get(deckId);
            const orgPerkActive = perkBreakdown !== undefined;
            const licenseOptions = orgPerkActive && Number.isInteger(perkBreakdown.durationDays) && perkBreakdown.durationDays > 0
                ? { expiresAt: new Date(Date.now() + perkBreakdown.durationDays * MILLISECONDS_PER_DAY), grantSource: GrantSources.ORG_DISCOUNTED_PURCHASE }
                : { expiresAt: new Date(0), grantSource: orgPerkActive ? GrantSources.ORG_DISCOUNTED_PURCHASE : GrantSources.FREE_GRANT };

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
                        ? { organizationId: perkBreakdown.organizationId, perkType: "ORG_PERK", durationDays: perkBreakdown.durationDays }
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
