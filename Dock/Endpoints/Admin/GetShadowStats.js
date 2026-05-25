const { getUser } = require("../Helpers/GetUser");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");

const SHADOW_COLLECTION_NAME = "shadow_pairs";


function buildEmptyCellStats()
{
    return {
        totalPairs:        0,
        judgedPairs:       0,
        candidateWins:     0,
        proWins:           0,
        ties:              0,
        unjudgedPairs:     0,
        candidateWinRate:  0,
    };
}


function aggregateByCell(pairs)
{
    const cellStatsByKey = {};

    for (const pair of pairs)
    {
        const cellKey = pair.cellKey || "__unkeyed__";

        if (!cellStatsByKey[cellKey])
        {
            cellStatsByKey[cellKey] = buildEmptyCellStats();
        }

        const stats = cellStatsByKey[cellKey];
        stats.totalPairs++;

        if (pair.judged && pair.judgement)
        {
            stats.judgedPairs++;

            const winner = pair.judgement.winner;

            if (winner === "B")
            {
                stats.candidateWins++;
            }
            else if (winner === "A")
            {
                stats.proWins++;
            }
            else if (winner === "tie")
            {
                stats.ties++;
            }
        }
        else
        {
            stats.unjudgedPairs++;
        }
    }

    for (const cellKey of Object.keys(cellStatsByKey))
    {
        const stats = cellStatsByKey[cellKey];

        if (stats.judgedPairs > 0)
        {
            stats.candidateWinRate = (stats.candidateWins + stats.ties / 2) / stats.judgedPairs;
        }
    }

    return cellStatsByKey;
}


async function handleGetShadowStats(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(401);
        return;
    }

    const database = await DatabaseConnector.getDatabase();

    if (!database)
    {
        response.sendStatusCode(503);
        return;
    }

    const collection = database.collection(SHADOW_COLLECTION_NAME);

    const projection = {
        cellKey:        1,
        proModel:       1,
        candidateModel: 1,
        judged:         1,
        "judgement.winner": 1,
        createdAt:      1,
    };

    const pairs = await collection.find({}, { projection }).limit(50000).toArray();

    const cellStats = aggregateByCell(pairs);

    const totals = buildEmptyCellStats();
    for (const cellKey of Object.keys(cellStats)) {
        const stats = cellStats[cellKey];
        totals.totalPairs    += stats.totalPairs;
        totals.judgedPairs   += stats.judgedPairs;
        totals.candidateWins += stats.candidateWins;
        totals.proWins       += stats.proWins;
        totals.ties          += stats.ties;
        totals.unjudgedPairs += stats.unjudgedPairs;
    }
    if (totals.judgedPairs > 0)
    {
        totals.candidateWinRate = (totals.candidateWins + totals.ties / 2) / totals.judgedPairs;
    }

    response.sendJson({
        totals,
        byCell: cellStats,
    });
}


module.exports = { handleGetShadowStats };
