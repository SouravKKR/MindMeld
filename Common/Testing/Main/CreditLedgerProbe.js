// Reads the credit ledger straight from MongoDB for the browser suites.
//
// Credit charging is invisible from the app: a generation that completes and
// charges nothing produces decks, a happy user, and no signal whatsoever in the
// UI. The only trustworthy assertion is therefore a database read taken across
// a run driven through the real interface — which is what this exists for.
//
// It borrows Dock's driver and .env rather than installing its own copy: the
// test directory installs only Puppeteer, and a second Mongo driver here would
// be a second version to keep in step with the server's.

const path = require("path");

class CreditLedgerProbe
{
    // Mirrored from the server's own enumerations rather than written as magic
    // numbers at the call sites: Common/Enumerations/CreditTransactionTypes.json
    // and Agent/Globals/Enumerations/TaskTypes.py.
    static TRANSACTION_TYPE_TASK_CHARGE = 1;
    static TRANSACTION_TYPE_REFUND = 6;
    static TRANSACTION_STATUS_APPLIED = "applied";

    static TASK_TYPE_MAP_TOPICS_WITH_CONTENT = 9;
    static TASK_TYPE_PROCESS_SYLLABUS = 11;
    static TASK_TYPE_FLASHCARD_GENERATION_WORKER = 17;
    static TASK_TYPE_STUDY_MATERIAL_GENERATION_WORKER = 18;
    static TASK_TYPE_MOCK_TEST_GENERATION_WORKER = 19;
    static TASK_TYPE_ASK_AI_BASIC = 31;

    // The worker types whose charge is metered on TOKENS rather than wall clock.
    // At least one of these must appear with non-zero input AND output tokens
    // after a generation — that pair is the regression these suites exist for.
    static TOKEN_METERED_TASK_TYPES =
    [
        CreditLedgerProbe.TASK_TYPE_FLASHCARD_GENERATION_WORKER,
        CreditLedgerProbe.TASK_TYPE_STUDY_MATERIAL_GENERATION_WORKER,
        CreditLedgerProbe.TASK_TYPE_MOCK_TEST_GENERATION_WORKER,
    ];

    // CreditLedger rounds credits to four decimals and moves the balance with a
    // separate $inc from the one that writes the row, so exact equality on a
    // float would be a coin flip. One hundredth of a credit sits far below the
    // smallest configured charge (0.1).
    static COMPARISON_TOLERANCE = 0.01;

    #client = null;
    #database = null;
    #accountId = "";

    constructor(accountId)
    {
        this.#accountId = accountId;
    }

    static creditsAreEqual(leftValue, rightValue)
    {
        return Math.abs(leftValue - rightValue) <= CreditLedgerProbe.COMPARISON_TOLERANCE;
    }

    /**
     * Connects using Dock's driver and configuration. Returns false when the
     * database is not configured or unreachable — callers treat that as an
     * ENVIRONMENT problem, never as the app being wrong.
     */
    async connect(repositoryRoot)
    {
        const dockDirectory = path.join(repositoryRoot, "Dock");

        try
        {
            require(path.join(dockDirectory, "node_modules", "dotenv"))
                .config({ path: path.join(dockDirectory, ".env"), quiet: true });

            const { MongoClient } = require(path.join(dockDirectory, "node_modules", "mongodb"));

            const databaseUrl = process.env.MONGODB_URL;
            const databaseName = process.env.MONGODB_DATABASE_NAME;

            if (!databaseUrl || !databaseName)
            {
                return false;
            }

            this.#client = new MongoClient(databaseUrl, { serverSelectionTimeoutMS: 10000 });
            await this.#client.connect();
            this.#database = this.#client.db(databaseName);

            // Prove the connection rather than trusting a lazily-created client.
            await this.#database.command({ ping: 1 });
            return true;
        }
        catch (connectionError)
        {
            this.#client = null;
            this.#database = null;
            return false;
        }
    }

    async close()
    {
        if (this.#client)
        {
            await this.#client.close().catch(() => {});
            this.#client = null;
            this.#database = null;
        }
    }

    getDatabase()
    {
        return this.#database;
    }

    getDatabaseName()
    {
        return process.env.MONGODB_DATABASE_NAME || "";
    }

    /**
     * Everything the assertions compare against, read in one place so "before"
     * and "after" can never be measured from two different shapes.
     */
    async readCreditState()
    {
        const storedUser = await this.#database.collection("users").findOne({ id: this.#accountId });
        const additionalData = (storedUser && storedUser.additionalData) || {};

        return {
            bExists: Boolean(storedUser),
            balance: typeof additionalData.credits === "number" ? additionalData.credits : 0,
            lifetimeSpent: typeof additionalData.lifetimeCreditsSpent === "number" ? additionalData.lifetimeCreditsSpent : 0,
            plan: additionalData.plan ?? null,
            planExpiresAt: additionalData.planExpiresAt ?? null,
        };
    }

    /**
     * Applied charges this account picked up since the snapshot, oldest first.
     * Filtered on status so a claim still "pending" — or one rejected by a
     * balance floor — is never mistaken for money actually taken.
     */
    async readAppliedChargesSince(snapshotDate)
    {
        return this.#database.collection("creditTransactions").find
        ({
            userId: this.#accountId,
            type: CreditLedgerProbe.TRANSACTION_TYPE_TASK_CHARGE,
            status: CreditLedgerProbe.TRANSACTION_STATUS_APPLIED,
            createdAt: { $gte: snapshotDate },
        }).sort({ createdAt: 1 }).toArray();
    }

    /**
     * Polls for charges to appear. The charge is fired and NOT awaited —
     * TaskCreditCharger settles after the work is reported done — so the UI can
     * show a finished run a beat before the ledger row lands. Reading once would
     * make this suite flaky in the one direction that matters.
     */
    async waitForAppliedCharges(snapshotDate, timeoutMilliseconds, minimumRowCount = 1)
    {
        const deadline = Date.now() + timeoutMilliseconds;
        let charges = [];

        while (Date.now() < deadline)
        {
            charges = await this.readAppliedChargesSince(snapshotDate);
            if (charges.length >= minimumRowCount)
            {
                // Let any sibling rows from the same run land before returning,
                // so a caller summing them does not race the last one in.
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this.readAppliedChargesSince(snapshotDate);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        return charges;
    }

    /**
     * The first applied charge for a specific task type since the snapshot, or
     * null. Used by the cheap Ask AI probe, which expects exactly one row.
     */
    async waitForChargeOfTaskType(taskType, snapshotDate, timeoutMilliseconds)
    {
        const deadline = Date.now() + timeoutMilliseconds;

        while (Date.now() < deadline)
        {
            const charges = await this.readAppliedChargesSince(snapshotDate);
            const match = charges.find(charge => charge.metadata && charge.metadata.taskType === taskType);
            if (match)
            {
                return match;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        return null;
    }

    static sumChargedCredits(charges)
    {
        const total = charges.reduce((runningTotal, charge) => runningTotal + Math.abs(charge.amount), 0);
        return Math.round(total * 10000) / 10000;
    }

    /**
     * Makes the account able to run a generation at all, idempotently, and
     * reports what it had to change.
     *
     * Both fields are ledger-owned (CreditLedger.LEDGER_OWNED_ADDITIONAL_DATA_KEYS)
     * so the server refuses to let a client set them — a direct write is the only
     * way, and it is exactly what an admin top-up would do. The balance is SET to
     * a target rather than incremented, so running the suite fifty times does not
     * leave the account holding fifty top-ups.
     */
    async ensureCanRunGeneration(requiredPlanTier, minimumBalance, toppedUpBalance)
    {
        const state = await this.readCreditState();
        if (!state.bExists)
        {
            return { bReady: false, detail: `no "${this.#accountId}" account in ${this.getDatabaseName()}` };
        }

        const adjustments = [];
        const updateFields = {};

        // AUTOMATIC_GENERATION is a Pro-tier feature and the entitlement gate
        // re-reads the STORED plan on every request. A seeded account has no plan
        // key at all, so it resolves to FREE and the run is refused before any
        // credit is spent — which reads on screen as "you are not allowed to
        // start this generation" and looks nothing like the missing field it is.
        if (Number(state.plan) !== requiredPlanTier)
        {
            updateFields["additionalData.plan"] = requiredPlanTier;
            adjustments.push(`plan ${state.plan ?? "(absent)"} -> ${requiredPlanTier}`);
        }

        // A stored expiry in the past degrades the tier back to FREE at read
        // time, so setting the plan alone is not enough.
        const oneYearFromNow = Date.now() + 365 * 24 * 60 * 60 * 1000;
        if (Number(state.planExpiresAt || 0) < Date.now())
        {
            updateFields["additionalData.planExpiresAt"] = oneYearFromNow;
            adjustments.push("planExpiresAt refreshed");
        }

        if (state.balance < minimumBalance)
        {
            updateFields["additionalData.credits"] = toppedUpBalance;
            adjustments.push(`credits ${state.balance} -> ${toppedUpBalance}`);
        }

        if (Object.keys(updateFields).length > 0)
        {
            await this.#database.collection("users").updateOne({ id: this.#accountId }, { $set: updateFields });
        }

        return { bReady: true, detail: adjustments.length > 0 ? adjustments.join(", ") : "already ready" };
    }

    /**
     * Removes information-source rows this suite created. Belt and braces on top
     * of the per-run byte-uniqueness: a crashed run's row would otherwise sit
     * there, and its stored blob is on TEMPORARY retention anyway.
     */
    async deleteFixtureInformationSources(fixturePrefix)
    {
        const result = await this.#database.collection("informationSources").deleteMany
        ({
            userId: this.#accountId,
            name: { $regex: `^${fixturePrefix}` },
        });
        return result.deletedCount || 0;
    }
}

module.exports = CreditLedgerProbe;
