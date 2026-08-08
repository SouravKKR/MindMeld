const path = require("path");

const DOCK_DIRECTORY = path.resolve(__dirname, "..", "..", "..", "Dock");

require(path.join(DOCK_DIRECTORY, "node_modules", "dotenv")).config({ path: path.join(DOCK_DIRECTORY, ".env") });
const { MongoClient } = require(path.join(DOCK_DIRECTORY, "node_modules", "mongodb"));

/**
 * FixtureRegistry — everything a browser suite created, and the discipline that
 * gets rid of it.
 *
 * WHY THIS IS ITS OWN CLASS. The deck suites can create a throwaway deck and
 * delete it through the UI. Organization and paid-deck suites cannot: they
 * leave behind memberships, credit ledger rows, encrypted master content and
 * licences, and three of those do not delete through any API at all.
 *
 *   - The credit ledger is append-only BY DESIGN. CreditLedger has no delete
 *     method and should not grow one, so a granted credit cannot be un-granted.
 *     The suite removes its own rows by referenceKey directly, as a test-only
 *     teardown, and restores the balance it moved.
 *   - A paid deck cannot be deleted while a licence is active — the very rule
 *     these suites exercise — so teardown has to revoke first, in order.
 *   - Master content has no delete outside the retirement path, so it is swept
 *     explicitly.
 *
 * REVERSE ORDER, ALWAYS. Registration order is creation order, so teardown
 * walks it backwards: a licence is removed before the deck it points at, a
 * member before the organization they belong to.
 *
 * AND THE SUITE ASSERTS IT WORKED. verifyNothingLeaked counts what is left
 * under the fixture prefix and reports it. A suite that leaks is a failing
 * suite, not a passing one with debris — otherwise the second run fails for
 * reasons the first run caused, and whoever investigates starts from a lie.
 */
class FixtureRegistry
{
    #mongoClient = null;
    #database = null;
    #entries = [];
    #fixturePrefix = "";

    constructor(fixturePrefix)
    {
        this.#fixturePrefix = fixturePrefix;
    }

    async connect()
    {
        this.#mongoClient = new MongoClient(process.env.MONGODB_URL);
        await this.#mongoClient.connect();
        this.#database = this.#mongoClient.db(process.env.MONGODB_DATABASE_NAME);
        return this.#database;
    }

    getDatabase()
    {
        return this.#database;
    }

    /**
     * Registers something to be removed later.
     *
     * Called the MOMENT the thing exists, not after the assertions that use it.
     * A case that fails between creating and registering is exactly the case
     * that leaks, and it is the one most likely to happen.
     */
    register(collectionName, filter)
    {
        this.#entries.push({ kind: "delete", collectionName: collectionName, filter: filter });
    }

    /**
     * Registers a REVERSION rather than a deletion, for state a suite changed
     * on something it did not create.
     *
     * Deleting is not always the undo. Elevating the test account's role so it
     * can reach the organization surfaces, or moving a credit balance, has to
     * be put back exactly as it was — deleting the user would be a far worse
     * outcome than leaving the change. Reversions run in the same reverse order
     * as deletions, so a change made after another is undone before it.
     */
    registerRestore(description, restoreCallback)
    {
        this.#entries.push({ kind: "restore", description: description, restoreCallback: restoreCallback });
    }

    /**
     * Removes everything registered, newest first, and reports what it could
     * not remove rather than throwing.
     *
     * Never throws: teardown runs in a finally, and a teardown that throws
     * would mask the failure that brought the suite there.
     */
    async teardown()
    {
        const failures = [];

        for (let entryIndex = this.#entries.length - 1; entryIndex >= 0; entryIndex -= 1)
        {
            const entry = this.#entries[entryIndex];

            try
            {
                if (entry.kind === "restore")
                {
                    await entry.restoreCallback();
                }
                else
                {
                    await this.#database.collection(entry.collectionName).deleteMany(entry.filter);
                }
            }
            catch (teardownError)
            {
                failures.push(`${entry.kind === "restore" ? entry.description : entry.collectionName}: ${teardownError.message}`);
            }
        }

        this.#entries = [];

        return failures;
    }

    /**
     * Counts anything still carrying the fixture prefix, across every
     * collection a suite could have touched.
     *
     * The prefix sweep is deliberately wider than the registry: it catches
     * things a case created and never registered, which is the failure the
     * registry alone cannot see.
     */
    async verifyNothingLeaked(collectionFieldPairs)
    {
        const leaks = [];

        for (const { collectionName, fieldName } of collectionFieldPairs)
        {
            const remainingCount = await this.#database
                .collection(collectionName)
                .countDocuments({ [fieldName]: { $regex: `^${this.#fixturePrefix}` } });

            if (remainingCount > 0)
            {
                leaks.push(`${collectionName}.${fieldName} × ${remainingCount}`);
            }
        }

        return leaks;
    }

    /**
     * Removes anything left over from an earlier crashed run before this one
     * starts.
     *
     * Without it a suite killed mid-run poisons every later run, and the person
     * investigating sees a failure that has nothing to do with their change.
     */
    async sweepPreviousRuns(collectionFieldPairs)
    {
        let sweptCount = 0;

        for (const { collectionName, fieldName } of collectionFieldPairs)
        {
            const result = await this.#database
                .collection(collectionName)
                .deleteMany({ [fieldName]: { $regex: `^${this.#fixturePrefix}` } });

            sweptCount += result.deletedCount || 0;
        }

        return sweptCount;
    }

    async close()
    {
        if (this.#mongoClient)
        {
            await this.#mongoClient.close();
            this.#mongoClient = null;
        }
    }
}

module.exports = { FixtureRegistry };
