const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const OrganizationDeckQueryEngine = require("./OrganizationDeckQueryEngine");
const CreditSpendCategoryNamer = require("./CreditSpendCategoryNamer");
const UserDailyActivityQueryEngine = require("../Database/UserDailyActivityQueryEngine");
const PaidDeckScopeResolver = require("../PaidDeck/PaidDeckScopeResolver");
const CreditLedger = require("../Credits/CreditLedger");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");
const { mockTestEvaluationStatuses } = require("../../Enumerations/MockTestEvaluationStatuses");

/**
 * OrganizationEngagementReportBuilder — what an organization's members actually
 * DID, as opposed to what it cost.
 *
 * The spend report answers "what did this cost". An institute's real question is
 * "is this student using the app, and what are they doing with it", and that is
 * a different join against different collections.
 *
 * TWO KEY SPACES, AND THE BOUNDARY BETWEEN THEM. Content lives in collections
 * keyed by SCOPE KEY — a personal library is keyed by the plain userId, an
 * organization view by "<userId>::org:<organizationId>". Credit transactions
 * are keyed by the PERSONAL account id. So:
 *
 *   - Engagement counts are org-scope AND filtered to the organization's own
 *     decks. They are genuinely "what this student did with your material".
 *   - AI usage counts are the member's whole account. A member asking Ask AI in
 *     their personal library spends the same balance and lands in the same
 *     ledger, and there is no honest way to attribute that to an institute.
 *
 * Both facts are carried on the report as disclaimers rather than left for the
 * reader to infer, for the same reason the spend report writes its own
 * disclaimer into the file rather than beside the download button.
 *
 * MEASURED VERSUS REPORTED. Mock tests, curated study and AI usage are dated
 * server-side and unbounded — those counts are observed. Cards studied and
 * study materials viewed are not: card review history keeps only the 20 most
 * recent points per card, and views are a bare counter with no timestamp. Those
 * two come from the device via UserDailyActivityQueryEngine, and every column
 * carries which kind it is so a reader can weigh them differently.
 */
class OrganizationEngagementReportBuilder
{
    /**
     * The window every heatmap covers. Fixed rather than "since the member
     * joined" so two students in the same report are drawn on the same axis —
     * a per-student window would make the grids incomparable, which is most of
     * the point of putting them in one document.
     */
    static HEATMAP_DAY_COUNT = 364;

    static MEASUREMENT_OBSERVED = "OBSERVED";
    static MEASUREMENT_DEVICE_REPORTED = "DEVICE_REPORTED";

    static SCOPE_DISCLAIMER =
        "Engagement counts cover this organization's decks only, studied inside this organization's view. "
        + "AI usage covers the member's whole account — a member using AI on their own material spends the "
        + "same balance and cannot be separated from it here.";

    static MEASUREMENT_DISCLAIMER =
        "Mock tests, curated study and AI usage are measured on the server. Cards studied and study materials "
        + "viewed are reported by the member's device, because neither is timestamped on the server: card "
        + "review history keeps only the 20 most recent reviews per card, and views are a plain counter.";

    /**
     * Builds the report for one organization.
     *
     * @param {Organization} organization
     * @return {Promise<object>}
     */
    static async build(organization)
    {
        const database = await DatabaseConnector.getDatabase();
        const organizationId = organization.getId();

        const members = await OrganizationMemberQueryEngine.listMembers(organizationId);
        const organizationDecks = await OrganizationDeckQueryEngine.listDecksForOrganization(organizationId);
        // getId(), not .id — the query engine hands back PaidDeck models rather
        // than raw documents, and reading the field directly yields undefined
        // for every deck, which silently empties the whole report instead of
        // failing.
        const organizationDeckIds = organizationDecks.map(deck => deck.getId()).filter(Boolean);

        const userDocumentByEmail = await OrganizationEngagementReportBuilder.#loadUserDocumentsByEmail(database, members);

        const { fromDayUtc, toDayUtc } = OrganizationEngagementReportBuilder.#buildDayWindow();

        const dailyActivityRows = await UserDailyActivityQueryEngine.findForOrganizationWindow(organizationId, fromDayUtc, toDayUtc);
        const dailyActivityByScopeKey = OrganizationEngagementReportBuilder.#groupDailyActivityByScopeKey(dailyActivityRows);

        const rows = [];

        for (const member of members)
        {
            const userDocument = userDocumentByEmail.get(member.getEmail());
            const accountUserId = userDocument ? userDocument.id : "";

            const scopeKeys = accountUserId.length > 0
                ? await OrganizationEngagementReportBuilder.#resolveScopeKeysForMember(database, accountUserId, organizationDeckIds)
                : [];

            const engagement = accountUserId.length > 0
                ? await OrganizationEngagementReportBuilder.#buildEngagementForMember(database, scopeKeys, organizationDeckIds, dailyActivityByScopeKey)
                : OrganizationEngagementReportBuilder.#buildEmptyEngagement();

            const aiUsage = accountUserId.length > 0
                ? await OrganizationEngagementReportBuilder.#buildAiUsageForMember(database, accountUserId, fromDayUtc)
                : { totalsByCategory: {}, seriesByCategory: {}, totalCount: 0 };

            rows.push
            ({
                email: member.getEmail(),
                name: (userDocument && userDocument.displayName) || member.getAttributes()?.name || "",
                tags: member.getTags(),
                bHasAccount: userDocument !== undefined,
                bHoldsOrganizationDeck: scopeKeys.length > 0,
                engagement: engagement,
                aiUsage: aiUsage,
            });
        }

        const aiCategories = OrganizationEngagementReportBuilder.#collectAiCategories(rows);

        return {
            generatedAt: new Date().toISOString(),
            organizationName: organization.getName(),
            scopeDisclaimer: OrganizationEngagementReportBuilder.SCOPE_DISCLAIMER,
            measurementDisclaimer: OrganizationEngagementReportBuilder.MEASUREMENT_DISCLAIMER,
            windowFromDayUtc: fromDayUtc,
            windowToDayUtc: toDayUtc,
            // "" when the rollup has never recorded anything for this
            // organization. The renderer prints this rather than drawing an
            // empty grid, which would read as "nobody did anything" when the
            // truth is "nothing was recorded yet".
            deviceReportingStartedOn: await UserDailyActivityQueryEngine.findEarliestRecordedDay(organizationId),
            aiCategories: aiCategories,
            organizationDeckCount: organizationDeckIds.length,
            rows: rows,
        };
    }

    /**
     * The scope keys a member's copies of this organization's decks live under.
     *
     * Follows OrganizationDeckWithdrawalService's traversal exactly: licences
     * are keyed by the PERSONAL userId, and each one resolves to the scope key
     * its content was seeded into. A member with no licence has no scope keys
     * and no engagement — which is a real answer, not a gap.
     */
    static async #resolveScopeKeysForMember(database, accountUserId, organizationDeckIds)
    {
        if (organizationDeckIds.length === 0)
        {
            return [];
        }

        const licenseDocuments = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find(
                { userId: accountUserId, deckId: { $in: organizationDeckIds }, status: deckLicenseStatuses.ACTIVE },
                { projection: { _id: 0 } },
            )
            .toArray();

        const scopeKeys = new Set();

        for (const licenseDocument of licenseDocuments)
        {
            scopeKeys.add(PaidDeckScopeResolver.resolveForLicense(licenseDocument, accountUserId));
        }

        return Array.from(scopeKeys);
    }

    static async #buildEngagementForMember(database, scopeKeys, organizationDeckIds, dailyActivityByScopeKey)
    {
        if (scopeKeys.length === 0)
        {
            return OrganizationEngagementReportBuilder.#buildEmptyEngagement();
        }

        const organizationDeckFilter =
        {
            userId: { $in: scopeKeys },
            "data.additionalData.paidDeckId": { $in: organizationDeckIds },
        };

        const mockTests = await OrganizationEngagementReportBuilder.#countMockTestAttempts(database, organizationDeckFilter);
        const curatedStudy = await OrganizationEngagementReportBuilder.#countCuratedStudyIterations(database, organizationDeckFilter);
        const materialViews = await OrganizationEngagementReportBuilder.#sumStudyMaterialViews(database, organizationDeckFilter);

        const deviceReported = OrganizationEngagementReportBuilder.#sumDeviceReported(scopeKeys, dailyActivityByScopeKey);

        return {
            cardsStudied:
            {
                total: deviceReported.totals.cardsStudied,
                series: deviceReported.series.cardsStudied,
                measurement: OrganizationEngagementReportBuilder.MEASUREMENT_DEVICE_REPORTED,
            },
            studyMaterialsViewed:
            {
                // Two numbers, deliberately. The lifetime counter is the honest
                // "ever" figure and is all the server has; the windowed series
                // is what the device reported and is all a heatmap can draw.
                total: materialViews,
                windowedTotal: deviceReported.totals.studyMaterialsViewed,
                series: deviceReported.series.studyMaterialsViewed,
                measurement: OrganizationEngagementReportBuilder.MEASUREMENT_DEVICE_REPORTED,
            },
            mockTestsTaken:
            {
                total: mockTests.total,
                series: mockTests.series,
                measurement: OrganizationEngagementReportBuilder.MEASUREMENT_OBSERVED,
            },
            curatedStudyIterations:
            {
                total: curatedStudy.total,
                series: curatedStudy.series,
                measurement: OrganizationEngagementReportBuilder.MEASUREMENT_OBSERVED,
            },
        };
    }

    static #buildEmptyEngagement()
    {
        const buildEmptyFeature = (measurement) => ({ total: 0, series: {}, measurement: measurement });

        return {
            cardsStudied: buildEmptyFeature(OrganizationEngagementReportBuilder.MEASUREMENT_DEVICE_REPORTED),
            studyMaterialsViewed: Object.assign(buildEmptyFeature(OrganizationEngagementReportBuilder.MEASUREMENT_DEVICE_REPORTED), { windowedTotal: 0 }),
            mockTestsTaken: buildEmptyFeature(OrganizationEngagementReportBuilder.MEASUREMENT_OBSERVED),
            curatedStudyIterations: buildEmptyFeature(OrganizationEngagementReportBuilder.MEASUREMENT_OBSERVED),
        };
    }

    /**
     * Completed mock-test attempts, by the day they were taken.
     *
     * Only COMPLETED attempts count, matching MetricBadgeManager — an abandoned
     * or still-evaluating attempt is not a test taken.
     */
    static async #countMockTestAttempts(database, organizationDeckFilter)
    {
        const mockTestDocuments = await database
            .collection(DatabaseConstants.MOCK_TESTS_COLLECTION)
            .find(organizationDeckFilter, { projection: { _id: 0, "data.history": 1 } })
            .toArray();

        const series = {};
        let total = 0;

        for (const mockTestDocument of mockTestDocuments)
        {
            const history = mockTestDocument.data && Array.isArray(mockTestDocument.data.history) ? mockTestDocument.data.history : [];

            for (const attempt of history)
            {
                if (attempt.evaluationStatus !== mockTestEvaluationStatuses.COMPLETED)
                {
                    continue;
                }

                const dayUtc = UserDailyActivityQueryEngine.toDayUtc(attempt.attemptDate);

                if (dayUtc.length === 0)
                {
                    continue;
                }

                series[dayUtc] = (series[dayUtc] || 0) + 1;
                total += 1;
            }
        }

        return { total: total, series: series };
    }

    /**
     * Curated study iterations, counted as DISTINCT BATCHES rather than
     * materials.
     *
     * One analysis produces several materials sharing a batch tag. Counting
     * materials would report a single sitting as five iterations and make a
     * student who studied once look five times as engaged as one who did.
     */
    static async #countCuratedStudyIterations(database, organizationDeckFilter)
    {
        const curatedFilter = Object.assign({}, organizationDeckFilter, { "data.additionalData.bCurated": true });

        const studyMaterialDocuments = await database
            .collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION)
            .find(curatedFilter, { projection: { _id: 0, "data.additionalData": 1 } })
            .toArray();

        const batchTagsByDay = new Map();

        for (const studyMaterialDocument of studyMaterialDocuments)
        {
            const additionalData = studyMaterialDocument.data ? studyMaterialDocument.data.additionalData : null;

            if (!additionalData)
            {
                continue;
            }

            // readAt when the student actually worked through it, falling back
            // to the generation tag. A batch generated and never opened is
            // still an iteration the platform performed, so it is not dropped —
            // it is simply dated by when it was made.
            const dayUtc = UserDailyActivityQueryEngine.toDayUtc(additionalData.readAt || additionalData.generatedForAnalysisAt);
            const batchTag = additionalData.generatedForAnalysisAt;

            if (dayUtc.length === 0 || !batchTag)
            {
                continue;
            }

            if (!batchTagsByDay.has(dayUtc))
            {
                batchTagsByDay.set(dayUtc, new Set());
            }

            batchTagsByDay.get(dayUtc).add(batchTag);
        }

        const series = {};
        let total = 0;

        for (const [dayUtc, batchTags] of batchTagsByDay)
        {
            series[dayUtc] = batchTags.size;
            total += batchTags.size;
        }

        return { total: total, series: series };
    }

    static async #sumStudyMaterialViews(database, organizationDeckFilter)
    {
        const studyMaterialDocuments = await database
            .collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION)
            .find(organizationDeckFilter, { projection: { _id: 0, "data.lifecycle.views": 1 } })
            .toArray();

        let total = 0;

        for (const studyMaterialDocument of studyMaterialDocuments)
        {
            const views = studyMaterialDocument.data?.lifecycle?.views;
            total += Number.isFinite(views) ? views : 0;
        }

        return total;
    }

    /**
     * AI usage COUNTS from the ledger — how many times, not how much.
     *
     * Storage is excluded: it is a real charge but a periodic one, so counting
     * it would report billing ticks as though they were things the student did.
     */
    static async #buildAiUsageForMember(database, accountUserId, fromDayUtc)
    {
        const transactions = await database
            .collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION)
            .find(
                {
                    userId: accountUserId,
                    status: CreditLedger.TRANSACTION_STATUS_APPLIED,
                    amount: { $lt: 0 },
                    createdAt: { $gte: new Date(`${fromDayUtc}T00:00:00.000Z`) },
                },
                { projection: { _id: 0, type: 1, metadata: 1, createdAt: 1 } },
            )
            .toArray();

        const totalsByCategory = {};
        const seriesByCategory = {};
        let totalCount = 0;

        for (const transaction of transactions)
        {
            const categoryName = CreditSpendCategoryNamer.describe(transaction);

            if (!CreditSpendCategoryNamer.isInvokedAiFeature(categoryName))
            {
                continue;
            }

            const dayUtc = UserDailyActivityQueryEngine.toDayUtc(transaction.createdAt);

            if (dayUtc.length === 0)
            {
                continue;
            }

            totalsByCategory[categoryName] = (totalsByCategory[categoryName] || 0) + 1;
            seriesByCategory[categoryName] = seriesByCategory[categoryName] || {};
            seriesByCategory[categoryName][dayUtc] = (seriesByCategory[categoryName][dayUtc] || 0) + 1;
            totalCount += 1;
        }

        return { totalsByCategory: totalsByCategory, seriesByCategory: seriesByCategory, totalCount: totalCount };
    }

    static async #loadUserDocumentsByEmail(database, members)
    {
        const memberEmails = members.map(member => member.getEmail()).filter(email => email.length > 0);

        if (memberEmails.length === 0)
        {
            return new Map();
        }

        const userDocuments = await database
            .collection(DatabaseConstants.USERS_COLLECTION)
            .aggregate
            ([
                { $addFields: { normalisedEmail: { $toLower: { $ifNull: ["$additionalData.email", ""] } } } },
                { $match: { normalisedEmail: { $in: memberEmails } } },
                { $project: { _id: 0, id: 1, displayName: 1, normalisedEmail: 1 } },
            ])
            .toArray();

        return new Map(userDocuments.map(userDocument => [userDocument.normalisedEmail, userDocument]));
    }

    static #groupDailyActivityByScopeKey(dailyActivityRows)
    {
        const grouped = new Map();

        for (const activityRow of dailyActivityRows)
        {
            if (!grouped.has(activityRow.scopeKey))
            {
                grouped.set(activityRow.scopeKey, []);
            }

            grouped.get(activityRow.scopeKey).push(activityRow);
        }

        return grouped;
    }

    static #sumDeviceReported(scopeKeys, dailyActivityByScopeKey)
    {
        const totals = { cardsStudied: 0, studyMaterialsViewed: 0 };
        const series = { cardsStudied: {}, studyMaterialsViewed: {} };

        for (const scopeKey of scopeKeys)
        {
            for (const activityRow of (dailyActivityByScopeKey.get(scopeKey) || []))
            {
                for (const counterName of UserDailyActivityQueryEngine.COUNTER_NAMES)
                {
                    const counterValue = activityRow.counters ? Number(activityRow.counters[counterName]) : 0;

                    if (!Number.isFinite(counterValue) || counterValue <= 0)
                    {
                        continue;
                    }

                    totals[counterName] += counterValue;
                    series[counterName][activityRow.dayUtc] = (series[counterName][activityRow.dayUtc] || 0) + counterValue;
                }
            }
        }

        return { totals: totals, series: series };
    }

    /**
     * Every AI category anyone in the organization used, sorted.
     *
     * Discovered rather than fixed, so a feature added later appears without a
     * code change — and a feature nobody used does not occupy a column of
     * zeroes.
     */
    static #collectAiCategories(rows)
    {
        const categoryNames = new Set();

        for (const row of rows)
        {
            for (const categoryName of Object.keys(row.aiUsage.totalsByCategory))
            {
                categoryNames.add(categoryName);
            }
        }

        return Array.from(categoryNames).sort();
    }

    static #buildDayWindow()
    {
        const todayMilliseconds = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
        const dayLengthMilliseconds = 24 * 60 * 60 * 1000;
        const fromMilliseconds = todayMilliseconds - (OrganizationEngagementReportBuilder.HEATMAP_DAY_COUNT * dayLengthMilliseconds);

        return {
            fromDayUtc: new Date(fromMilliseconds).toISOString().slice(0, 10),
            toDayUtc: new Date(todayMilliseconds).toISOString().slice(0, 10),
        };
    }
}

module.exports = OrganizationEngagementReportBuilder;
