const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * UserDailyActivityQueryEngine — a per-user, per-day rollup of the study
 * actions the server cannot otherwise date.
 *
 * WHY THIS EXISTS. Most engagement in this product is already dated and
 * unbounded server-side: a mock-test attempt carries attemptDate, a curated
 * batch carries its generation tag, every AI charge carries createdAt. Two
 * things are not:
 *
 *   - Card reviews are dated, but Progress keeps only the 20 most recent
 *     points per card and shifts the rest off permanently. A student who
 *     drilled one card fifty times has forty of those days erased.
 *   - Study-material views are a bare counter with no timestamp at all.
 *
 * Both happen entirely in the browser. The server never observes them except
 * as a synced side effect, so a rollup written from the client is what makes
 * "usage over time" answerable for them at all.
 *
 * THE HONESTY CONSTRAINT. Because these counts are reported by the device
 * rather than measured by the server, every surface that displays them must
 * say so — the source field is carried on the document for exactly that reason
 * rather than being assumed by the reader. An institute deciding something
 * about a student needs to know which of its numbers were observed and which
 * were asserted.
 *
 * Rows are upserted per (scopeKey, dayUtc) with $inc, and clamped at the
 * endpoint so a replayed or crafted report cannot inflate a day without bound.
 */
class UserDailyActivityQueryEngine
{
    /**
     * Recorded on every row so a reader of the raw collection can tell measured
     * data from asserted data without consulting this file.
     */
    static SOURCE_CLIENT_REPORTED = "CLIENT_REPORTED";

    /**
     * The counters a client may report. Anything else in the payload is
     * dropped: a rollup is a fixed shape, and letting callers invent counter
     * names would make the report's columns depend on client versions.
     */
    static COUNTER_NAMES = ["cardsStudied", "studyMaterialsViewed"];

    /**
     * Adds a day's counts for one scope.
     *
     * @param {object} recordRequest
     *   scopeKey       — the key the content collections use; personal is the
     *                    plain userId, an organization view is
     *                    "<userId>::org:<organizationId>"
     *   accountUserId  — always the PERSONAL account id. Carried so a report
     *                    can join study activity to credit activity, which live
     *                    in different key spaces.
     *   organizationId — "" for personal scope
     *   dayUtc         — "YYYY-MM-DD"
     *   counters       — { cardsStudied, studyMaterialsViewed }
     * @return {Promise<boolean>} true when a row was written
     */
    static async recordDailyUsage(recordRequest)
    {
        const scopeKey = typeof recordRequest.scopeKey === "string" ? recordRequest.scopeKey : "";
        const dayUtc = typeof recordRequest.dayUtc === "string" ? recordRequest.dayUtc : "";

        if (scopeKey.length === 0 || !UserDailyActivityQueryEngine.isValidDayUtc(dayUtc))
        {
            return false;
        }

        const increments = {};

        for (const counterName of UserDailyActivityQueryEngine.COUNTER_NAMES)
        {
            const counterValue = Number(recordRequest.counters ? recordRequest.counters[counterName] : 0);

            if (Number.isFinite(counterValue) && counterValue > 0)
            {
                increments[`counters.${counterName}`] = Math.floor(counterValue);
            }
        }

        if (Object.keys(increments).length === 0)
        {
            // Nothing to add. Writing a zero row would make "this student did
            // nothing that day" indistinguishable from "this student's device
            // reported nothing", and the report draws those differently.
            return false;
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.USER_DAILY_ACTIVITY_COLLECTION);

        await collection.updateOne(
            { scopeKey: scopeKey, dayUtc: dayUtc },
            {
                $inc: increments,
                $set:
                {
                    accountUserId: recordRequest.accountUserId || "",
                    organizationId: recordRequest.organizationId || "",
                    source: UserDailyActivityQueryEngine.SOURCE_CLIENT_REPORTED,
                    updatedAt: new Date(),
                },
                $setOnInsert: { firstRecordedAt: new Date() },
            },
            { upsert: true },
        );

        return true;
    }

    /**
     * Every row for one organization inside a day window, for the report.
     *
     * @return {Promise<object[]>}
     */
    static async findForOrganizationWindow(organizationId, fromDayUtc, toDayUtc)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return [];
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.USER_DAILY_ACTIVITY_COLLECTION);

        return await collection
            .find(
                { organizationId: organizationId, dayUtc: { $gte: fromDayUtc, $lte: toDayUtc } },
                { projection: { _id: 0 } },
            )
            .sort({ dayUtc: 1 })
            .toArray();
    }

    /**
     * The earliest day this organization has any row for, or "" when it has
     * none.
     *
     * The report prints this rather than drawing an empty grid for the period
     * before the collection existed. A blank heatmap reads as "this student did
     * nothing", which would be a true-looking chart making a false claim.
     */
    static async findEarliestRecordedDay(organizationId)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return "";
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.USER_DAILY_ACTIVITY_COLLECTION);

        const earliestDocument = await collection
            .find({ organizationId: organizationId }, { projection: { _id: 0, dayUtc: 1 } })
            .sort({ dayUtc: 1 })
            .limit(1)
            .next();

        return earliestDocument ? earliestDocument.dayUtc : "";
    }

    /**
     * "YYYY-MM-DD" and a real calendar date.
     *
     * Checked rather than trusted: the day is half of the upsert key, so a
     * malformed one would silently create a row nothing ever reads again.
     */
    static isValidDayUtc(dayUtc)
    {
        if (typeof dayUtc !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dayUtc))
        {
            return false;
        }

        const parsedDate = new Date(`${dayUtc}T00:00:00.000Z`);

        return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === dayUtc;
    }

    /**
     * The UTC day a moment falls in.
     *
     * UTC deliberately, matching the client heatmap's own bucketing — FSRS
     * review timestamps carry no timezone normalisation, so a local-time bucket
     * would put the same review on different days for two readers.
     */
    static toDayUtc(dateValue)
    {
        const resolvedDate = dateValue instanceof Date ? dateValue : new Date(dateValue);

        return Number.isNaN(resolvedDate.getTime()) ? "" : resolvedDate.toISOString().slice(0, 10);
    }
}

module.exports = UserDailyActivityQueryEngine;
