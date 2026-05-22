const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const { purchaseStatuses } = require("../../Globals/Enumerations/PurchaseStatuses");

async function getRevenueStats(request, response)
{
    const queryParams = await request.getQueryParams();
    const fromDate = queryParams.from ? new Date(queryParams.from) : new Date(0);
    const toDate = queryParams.to ? new Date(queryParams.to) : new Date();
    const groupBy = queryParams.groupBy || "deck";

    const database = await DatabaseConnector.getDatabase();
    const groupKey = groupBy === "region"
        ? "$region"
        : groupBy === "currency"
            ? "$currency"
            : "$deckId";

    const pipeline =
    [
        {
            $match:
            {
                status: purchaseStatuses.COMPLETED,
                purchaseDate: { $gte: fromDate, $lte: toDate }
            }
        },
        {
            $group:
            {
                _id: groupKey,
                purchaseCount: { $sum: 1 },
                totalMinor: { $sum: "$amountMinor" }
            }
        },
        { $sort: { totalMinor: -1 } }
    ];

    const aggregated = await database
        .collection(DatabaseConstants.PURCHASES_COLLECTION)
        .aggregate(pipeline)
        .toArray();

    response.statusCode = 200;
    response.sendJson
    ({
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        groupBy: groupBy,
        results: aggregated
    });
}

// Provision for the future PricingOptimizer (Python module). The optimizer
// will read this same aggregation (or its raw documents) plus regional cost
// data and write back to PAID_DECK_PRICINGS_COLLECTION. Keep this endpoint
// shape stable so the Python module can simply call /Admin/Stats/Revenue.

module.exports = { getRevenueStats };
