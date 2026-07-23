const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeckPricingEngine = require("../../Globals/Classes/Pricing/PaidDeckPricingEngine");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const PendingOrderQueryEngine = require("../../Globals/Classes/Database/PendingOrderQueryEngine");
const Purchase = require("../../Globals/Model/Purchase");
const { getUser } = require("../Helpers/GetUser");
const { purchaseStatuses } = require("../../Globals/Enumerations/PurchaseStatuses");
const { seedProtectedContentForLicense, checkUserHasPaidDeckPassword } = require("./PaidDeckGrantHelpers");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const LicenseExpiryResolver = require("../../Globals/Classes/Pricing/LicenseExpiryResolver");
const ZohoInvoiceService = require("../../Globals/Classes/Invoicing/ZohoInvoiceService");
const GrantSources = require("../../Globals/Constants/GrantSources");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const Logger = require("../../Globals/Classes/Logger");
const LogTitles = require("../../Globals/Classes/Logging/LogTitles");
const { logCategory } = require("../../Globals/Enumerations/LogCategory");
const NotificationDispatcher = require("../../Globals/Classes/Notifications/NotificationDispatcher");
const NotificationContent = require("../../Globals/Classes/Notifications/NotificationContent");
const { notificationChannels } = require("../../Globals/Enumerations/NotificationChannels");

async function verifyPurchase(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    // Only the payment-identifying fields are trusted from the client. The
    // decks being granted, their amounts, region and currency are NEVER taken
    // from the body — they come from the server-side pending-order row created
    // at InitiatePurchase. This closes the bypass where a buyer pays for a
    // cheap/free deck then claims licenses for arbitrary expensive decks.
    // paymentProvider is intentionally NOT read from the client — the verifier
    // is resolved from the trusted server-side pending-order row below.
    const { providerOrderId, providerPaymentId, signature } = body || {};

    if (!providerOrderId || !providerPaymentId || !signature)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    // Resolve the server's binding for this order and assert it belongs to the
    // authenticated buyer before doing anything else.
    const pendingOrder = await PendingOrderQueryEngine.getByOrderId(providerOrderId);
    if (!pendingOrder)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.ORDER_NOT_FOUND });
        return;
    }

    if (pendingOrder.userId !== session.getUserId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.ORDER_OWNER_MISMATCH });
        return;
    }

    // Resolve the provider that actually created this order from the trusted
    // pending row (falls back to the configured default for legacy rows).
    const storedProvider = pendingOrder.paymentProvider;
    const provider = storedProvider !== null && storedProvider !== undefined
        ? PaymentProviderFactory.getProvider(storedProvider)
        : PaymentProviderFactory.getDefaultProvider();
    const verification = await provider.verifyPayment({ providerOrderId, providerPaymentId, signature });

    if (!verification.verified)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PAYMENT_NOT_VERIFIED, reason: verification.reason });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const hasExistingPaidDeckPassword = await checkUserHasPaidDeckPassword(database, session.getUserId());

    // Replay guard: a verified payment grants exactly once. A duplicate /
    // replayed verify (provider retries, double-clicks) short-circuits to an
    // idempotent success rather than re-granting.
    if (pendingOrder.status === PendingOrderQueryEngine.STATUS_CONSUMED)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            alreadyProcessed: true,
            licenses: [],
            requiresPasswordSetup: !hasExistingPaidDeckPassword
        });
        return;
    }

    // The authoritative deck list is the server's record of what was ordered.
    const authoritativeDeckIds = Array.isArray(pendingOrder.deckIds) ? pendingOrder.deckIds : [];
    // Use the region captured at initiation (a Regions enum name) so recomputed
    // amounts match what the buyer was actually charged; fall back to a fresh
    // resolve only if the row somehow lacks it.
    const hasStoredRegion = pendingOrder.region !== null && pendingOrder.region !== undefined && pendingOrder.region !== "";
    const safeRegion = hasStoredRegion
        ? pendingOrder.region
        : RegionResolver.resolveRegion(request, null, null);

    // Re-evaluate pricing server-side over the authoritative decks. The engine's
    // per-deck breakdown drives both the recorded Purchase amounts and the perk
    // metadata (durationDays) that sets each license's expiresAt.
    const user = await getUser(request);
    const serverPricing = await PaidDeckPricingEngine.computeFinalPrice
    (
        session.getUserId(),
        authoritativeDeckIds,
        safeRegion,
        user,
        true
    );

    const breakdownByDeckId = new Map();
    for (const breakdownEntry of (serverPricing.breakdown || []))
    {
        breakdownByDeckId.set(breakdownEntry.deckId, breakdownEntry);
    }

    const issuedLicenses = [];

    for (const deckId of authoritativeDeckIds)
    {
        const perkBreakdown = breakdownByDeckId.get(deckId);
        const orgPerkActive = perkBreakdown !== undefined && perkBreakdown.reason === "ORG_PERK";

        // Explicit-duration gate (defence in depth). InitiatePurchase already
        // refused to create the order for a deck with no finite / perpetual
        // configuration, so this should never fire — but if pricing changed
        // between initiation and verification, skip the deck rather than mint a
        // forever license. The buyer keeps their paid decks; a misconfigured one
        // is simply not granted and is logged for follow-up.
        const expiryResolution = LicenseExpiryResolver.resolve(perkBreakdown);
        if (expiryResolution.status === LicenseExpiryResolver.STATUS_UNSPECIFIED)
        {
            Logger.warning(logCategory.PURCHASE, LogTitles.PURCHASE_DECK, "Skipped granting a deck with no explicit license duration",
            {
                accountId: session.getUserId(),
                additionalData: { deckId: deckId, providerOrderId: providerOrderId }
            });
            continue;
        }
        const purchaseAdditionalData = orgPerkActive
            ? { organizationId: perkBreakdown.organizationId, perkType: "ORG_PERK", durationDays: perkBreakdown.durationDays }
            : {};
        // Recorded amount comes from the server pricing breakdown, never the
        // client body.
        const recordedAmountMinor = perkBreakdown ? (Number(perkBreakdown.finalPriceMinor) || 0) : 0;

        const purchase = new Purchase
        ({
            userId: session.getUserId(),
            deckId: deckId,
            paymentProvider: provider.getProviderEnumValue(),
            providerOrderId: providerOrderId,
            providerPaymentId: providerPaymentId,
            amountMinor: recordedAmountMinor,
            currency: serverPricing.currency || pendingOrder.currency || "INR",
            region: safeRegion,
            purchaseDate: new Date(),
            refundedAt: new Date(0),
            status: purchaseStatuses.COMPLETED,
            additionalData: purchaseAdditionalData
        });

        await database
            .collection(DatabaseConstants.PURCHASES_COLLECTION)
            .updateOne
            (
                { userId: session.getUserId(), deckId: deckId, providerOrderId: providerOrderId },
                { $set: purchase.toJson() },
                { upsert: true }
            );

        Logger.info(logCategory.PURCHASE, LogTitles.PURCHASE_DECK, "Paid deck purchased",
        {
            accountId: session.getUserId(),
            additionalData:
            {
                deckId: deckId,
                amountMinor: recordedAmountMinor,
                currency: serverPricing.currency || pendingOrder.currency || "INR",
                paymentProvider: provider.getProviderEnumValue(),
                providerOrderId: providerOrderId,
                providerPaymentId: providerPaymentId
            }
        });

        // License expiry comes from the single resolver: a finite window when
        // durationDays > 0 (org-perk rental or a time-limited sale) or the
        // FOREVER sentinel only when the deck was explicitly sold as perpetual.
        const licenseOptions =
        {
            expiresAt: expiryResolution.expiresAt,
            grantSource: orgPerkActive ? GrantSources.ORG_DISCOUNTED_PURCHASE : GrantSources.PURCHASE
        };

        const licenseResult = await KeyManagementService.issueLicenseForDeck(session.getUserId(), deckId, licenseOptions);

        if (licenseResult.success)
        {
            const seedResult = await seedProtectedContentForLicense(database, session.getUserId(), deckId, licenseResult.license);
            if (seedResult.success)
            {
                issuedLicenses.push(LicenseClientView.sanitize(licenseResult.license.toJson()));
            }
            else
            {
                console.error(`[VerifyPurchase] Failed to seed protected content for user ${session.getUserId()} deck ${deckId}: ${seedResult.reason}`);
            }
        }
    }

    // Flip the order to CONSUMED only after grants complete, so a crash mid-grant
    // leaves it PENDING and the buyer can safely retry (all grant writes above
    // are idempotent upserts). The transition is atomic, so concurrent verifies
    // still grant exactly once.
    await PendingOrderQueryEngine.markConsumed(providerOrderId, session.getUserId());

    // Purchase settled (this line is only reached on the first-time grant — a
    // replay short-circuits earlier). Tell the buyer their deck(s) are ready,
    // in-app + push. Best-effort; never blocks the grant / response.
    if (issuedLicenses.length > 0)
    {
        try
        {
            await NotificationDispatcher.dispatch(session.getUserId(), NotificationContent.deckPurchaseComplete(issuedLicenses.length), notificationChannels.IN_APP | notificationChannels.PUSH);
        }
        catch (notifyError)
        {
            console.warn(`[VerifyPurchase] Failed to dispatch purchase-complete notification for order ${providerOrderId}: ${notifyError.message}`);
        }
    }

    // Invoice the paid acquisition (customer purchase) — best-effort, never
    // blocks the grant. Uses the server-recomputed total, not the client body.
    // Only reached on the first-time grant path; a replay short-circuits above.
    if (ZohoInvoiceService.isEnabled() && Number(serverPricing.totalMinor) > 0)
    {
        try
        {
            const buyerEmail = user ? (user.getAdditionalData()?.email || "") : "";
            const deckLabel = authoritativeDeckIds.length === 1 ? "CogniumLearn deck" : `CogniumLearn decks (${authoritativeDeckIds.length})`;
            await ZohoInvoiceService.createPaidInvoice
            ({
                email: buyerEmail,
                name: user && user.getDisplayName ? user.getDisplayName() : "",
                amountMinor: serverPricing.totalMinor,
                currency: serverPricing.currency || pendingOrder.currency || "INR",
                description: deckLabel,
                referenceNumber: providerPaymentId || providerOrderId
            });
        }
        catch (invoiceError)
        {
            console.warn(`[VerifyPurchase] Invoice step failed for order ${providerOrderId} (non-fatal): ${invoiceError?.message || invoiceError}`);
        }
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        licenses: issuedLicenses,
        requiresPasswordSetup: !hasExistingPaidDeckPassword
    });
}

module.exports = { verifyPurchase };
