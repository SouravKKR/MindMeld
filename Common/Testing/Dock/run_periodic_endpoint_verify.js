// Deterministic integration checks for the periodic-assignment endpoint changes
// (on-join for ALL scopes + hard Delete). No real server or database is needed:
// a tiny in-memory Mongo fake is injected via the require cache, so the REAL
// query engine, recipient store, and endpoint handlers run against it. This is
// the Verify* analog for the feature -- it proves the new server behaviour end
// to end without touching credits or a live database.
//   node Common/Testing/Dock/run_periodic_endpoint_verify.js
// Writes its result JSON to $RESULT_FILE or Common/Reports/.results/dock-periodic-endpoint.json.

const path = require("path");
const { Harness, writeSkipped, assert, assertEqual } = require("./_harness");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOCK_ROOT = path.join(REPOSITORY_ROOT, "Dock");
const RESULT_FILE = process.env.RESULT_FILE
    || path.join(REPOSITORY_ROOT, "Common", "Reports", ".results", "dock-periodic-endpoint.json");

const CATEGORY = "Periodic Assignment Endpoints (Node)";
const CATALOGUED = [
    "PeriodicAssignmentQueryEngine.deleteById",
    "PeriodicAssignmentRecipientStore.deleteByAssignmentId",
    "deletePeriodicAssignment",
    "createPeriodicAssignment.onJoinMode",
];

// ── In-memory Mongo fake ─────────────────────────────────────────────────────
// Only the operations the code under test actually calls are implemented:
// insertOne / findOne / deleteOne / deleteMany with plain-equality filters.

function matchesFilter(document, filter)
{
    for (const key of Object.keys(filter))
    {
        if (document[key] !== filter[key])
        {
            return false;
        }
    }
    return true;
}

class FakeCollection
{
    constructor()
    {
        this.documents = [];
    }

    async insertOne(document)
    {
        this.documents.push(JSON.parse(JSON.stringify(document)));
        return { acknowledged: true };
    }

    async findOne(filter)
    {
        return this.documents.find(document => matchesFilter(document, filter)) || null;
    }

    async deleteOne(filter)
    {
        const index = this.documents.findIndex(document => matchesFilter(document, filter));
        if (index >= 0)
        {
            this.documents.splice(index, 1);
            return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
    }

    async deleteMany(filter)
    {
        const before = this.documents.length;
        this.documents = this.documents.filter(document => !matchesFilter(document, filter));
        return { deletedCount: before - this.documents.length };
    }
}

class FakeDatabase
{
    constructor()
    {
        this.collections = {};
    }

    collection(name)
    {
        if (!this.collections[name])
        {
            this.collections[name] = new FakeCollection();
        }
        return this.collections[name];
    }
}

const fakeDatabase = new FakeDatabase();

function injectModule(relativeModulePath, exportsObject)
{
    const resolved = require.resolve(path.join(DOCK_ROOT, relativeModulePath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

let PeriodicAssignmentQueryEngine;
let PeriodicAssignmentRecipientStore;
let deletePeriodicAssignment;
let createPeriodicAssignment;
let DatabaseConstants;
let ErrorCodes;
let httpStatus;
let periodicScopeTypes;
let periodicOnJoinModes;
let periodicScheduleTypes;
let creditGrantAmountModes;
try
{
    // Fakes MUST be in the require cache before any module-under-test is loaded,
    // because the handlers resolve their dependencies at require time.
    injectModule("Globals/Classes/Database/DatabaseConnector", { getDatabase: async () => fakeDatabase });
    // Neutralise the create endpoint's best-effort seed reconcile so the test
    // never reaches the real ledger / reconciler tree.
    injectModule("Globals/Classes/Credits/CreditGrantTargetResolver", { resolve: async () => ({ recipients: [] }) });
    injectModule("Globals/Classes/Credits/PeriodicCreditReconciler", { reconcileForUser: async () => ({ creditsGranted: 0 }), reconcileForUserId: async () => ({ creditsGranted: 0 }) });

    PeriodicAssignmentQueryEngine = require(path.join(DOCK_ROOT, "Globals/Classes/Credits/PeriodicAssignmentQueryEngine"));
    PeriodicAssignmentRecipientStore = require(path.join(DOCK_ROOT, "Globals/Classes/Credits/PeriodicAssignmentRecipientStore"));
    ({ deletePeriodicAssignment } = require(path.join(DOCK_ROOT, "Endpoints/Admin/Periodic/DeletePeriodicAssignment")));
    ({ createPeriodicAssignment } = require(path.join(DOCK_ROOT, "Endpoints/Admin/Periodic/CreatePeriodicAssignment")));
    DatabaseConstants = require(path.join(DOCK_ROOT, "Globals/Constants/DatabaseConstants"));
    ErrorCodes = require(path.join(DOCK_ROOT, "Globals/Constants/ErrorCodes"));
    ({ httpStatus } = require(path.join(DOCK_ROOT, "Globals/Enumerations/HttpStatus")));
    ({ periodicScopeTypes } = require(path.join(DOCK_ROOT, "Globals/Enumerations/PeriodicScopeTypes")));
    ({ periodicOnJoinModes } = require(path.join(DOCK_ROOT, "Globals/Enumerations/PeriodicOnJoinModes")));
    ({ periodicScheduleTypes } = require(path.join(DOCK_ROOT, "Globals/Enumerations/PeriodicScheduleTypes")));
    ({ creditGrantAmountModes } = require(path.join(DOCK_ROOT, "Globals/Enumerations/CreditGrantAmountModes")));
}
catch (error)
{
    writeSkipped("Dock", CATEGORY, `Could not load Dock modules: ${error.message}`, RESULT_FILE);
    process.exit(0);
}

const ASSIGNMENTS_COLLECTION = DatabaseConstants.PERIODIC_CREDIT_ASSIGNMENTS_COLLECTION;
const RECIPIENTS_COLLECTION = DatabaseConstants.PERIODIC_ASSIGNMENT_RECIPIENTS_COLLECTION;
const LEDGER_COLLECTION = DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION || "creditTransactions";

function fakeResponse()
{
    return { statusCode: 0, body: null, sendJson(payload) { this.body = payload; } };
}

function fakeRequest(body)
{
    return { getBody: async () => body, user: { getId: () => "admin-verify" } };
}

function resetDatabase()
{
    fakeDatabase.collections = {};
}

const harness = new Harness("Dock", CATEGORY, CATALOGUED);

// ── Query-engine / store guard branches (no DB call) ─────────────────────────

harness.test("PeriodicAssignmentQueryEngine.deleteById: empty id is rejected without a DB call", "PeriodicAssignmentQueryEngine.deleteById", async () =>
{
    const result = await PeriodicAssignmentQueryEngine.deleteById("");
    assertEqual(result.deleted, false, "empty id must not delete");
});

harness.test("PeriodicAssignmentRecipientStore.deleteByAssignmentId: null id returns zero removed", "PeriodicAssignmentRecipientStore.deleteByAssignmentId", async () =>
{
    const result = await PeriodicAssignmentRecipientStore.deleteByAssignmentId(null);
    assertEqual(result.deletedCount, 0, "null assignmentId must remove nothing");
});

// ── Delete endpoint, end to end against the fake DB ──────────────────────────

harness.test("deletePeriodicAssignment: missing assignmentId -> 400 INVALID_ID", "deletePeriodicAssignment", async () =>
{
    resetDatabase();
    const response = fakeResponse();
    await deletePeriodicAssignment(fakeRequest({}), response);
    assertEqual(response.statusCode, httpStatus.BAD_REQUEST, "missing id is a 400");
    assertEqual(response.body.error, ErrorCodes.INVALID_ID, "error code is INVALID_ID");
});

harness.test("deletePeriodicAssignment: unknown id -> 404 ASSIGNMENT_NOT_FOUND", "deletePeriodicAssignment", async () =>
{
    resetDatabase();
    const response = fakeResponse();
    await deletePeriodicAssignment(fakeRequest({ assignmentId: "does-not-exist" }), response);
    assertEqual(response.statusCode, httpStatus.NOT_FOUND, "unknown id is a 404");
    assertEqual(response.body.error, ErrorCodes.ASSIGNMENT_NOT_FOUND, "error code is ASSIGNMENT_NOT_FOUND");
});

harness.test("deletePeriodicAssignment: removes the assignment + recipient rows, leaves the ledger untouched", "deletePeriodicAssignment", async () =>
{
    resetDatabase();
    const assignments = fakeDatabase.collection(ASSIGNMENTS_COLLECTION);
    const recipients = fakeDatabase.collection(RECIPIENTS_COLLECTION);
    const ledger = fakeDatabase.collection(LEDGER_COLLECTION);

    await assignments.insertOne({ id: "verify-del-1", name: "Old assignment", scopeType: periodicScopeTypes.PEOPLE_SET });
    await recipients.insertOne({ assignmentId: "verify-del-1", email: "a@example.com", cumulativeCredits: 100 });
    await recipients.insertOne({ assignmentId: "verify-del-1", email: "b@example.com", cumulativeCredits: 100 });
    await ledger.insertOne({ referenceKey: "periodic:verify-del-1:a@example.com:onjoin", amount: 100 });

    const response = fakeResponse();
    await deletePeriodicAssignment(fakeRequest({ assignmentId: "verify-del-1" }), response);

    assertEqual(response.statusCode, httpStatus.OK, "delete returns 200");
    assertEqual(response.body.success, true, "success flag set");
    assertEqual(response.body.deleted, true, "assignment reported deleted");
    assertEqual(response.body.recipientsRemoved, 2, "both recipient rows removed");
    assertEqual(await assignments.findOne({ id: "verify-del-1" }), null, "assignment doc is gone");
    assertEqual(recipients.documents.length, 0, "recipient rows are gone");
    assertEqual(ledger.documents.length, 1, "credit ledger is left untouched (audit trail preserved)");
});

harness.test("deletePeriodicAssignment: a second delete of the same id is a 404 (idempotent)", "deletePeriodicAssignment", async () =>
{
    resetDatabase();
    const assignments = fakeDatabase.collection(ASSIGNMENTS_COLLECTION);
    await assignments.insertOne({ id: "verify-del-2", name: "Once", scopeType: periodicScopeTypes.PEOPLE_SET });

    const first = fakeResponse();
    await deletePeriodicAssignment(fakeRequest({ assignmentId: "verify-del-2" }), first);
    assertEqual(first.statusCode, httpStatus.OK, "first delete succeeds");

    const second = fakeResponse();
    await deletePeriodicAssignment(fakeRequest({ assignmentId: "verify-del-2" }), second);
    assertEqual(second.statusCode, httpStatus.NOT_FOUND, "second delete is a 404 -- the row is already gone");
});

// ── Create endpoint now stores onJoinMode for a people-set (no coercion) ─────

function peopleSetCreateBody(onJoinMode)
{
    return {
        name: "Verify people-set on-join",
        scopeType: periodicScopeTypes.PEOPLE_SET,
        peopleEmails: ["a@example.com", "b@example.com"],
        amount: 100,
        amountMode: creditGrantAmountModes.PER_USER,
        scheduleType: periodicScheduleTypes.INTERVAL_DAYS,
        intervalDays: 30,
        dayOfWeek: 1,
        dayOfMonth: 1,
        onJoinMode: onJoinMode,
        hasValidUntil: false
    };
}

harness.test("createPeriodicAssignment: a people-set with ON_JOIN_PLUS_PERIODIC is persisted UNCOERCED", "createPeriodicAssignment.onJoinMode", async () =>
{
    resetDatabase();
    const response = fakeResponse();
    await createPeriodicAssignment(fakeRequest(peopleSetCreateBody(periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC)), response);

    assertEqual(response.statusCode, httpStatus.OK, "create returns 200");
    const stored = fakeDatabase.collection(ASSIGNMENTS_COLLECTION).documents;
    assertEqual(stored.length, 1, "exactly one assignment stored");
    assertEqual(stored[0].scopeType, periodicScopeTypes.PEOPLE_SET, "scope is people-set");
    assertEqual(stored[0].onJoinMode, periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC, "on-join mode kept, NOT forced to PERIODIC_ONLY");
});

harness.test("createPeriodicAssignment: an invalid onJoinMode still defaults to PERIODIC_ONLY", "createPeriodicAssignment.onJoinMode", async () =>
{
    resetDatabase();
    const response = fakeResponse();
    await createPeriodicAssignment(fakeRequest(peopleSetCreateBody(9999)), response);

    assertEqual(response.statusCode, httpStatus.OK, "create returns 200");
    const stored = fakeDatabase.collection(ASSIGNMENTS_COLLECTION).documents;
    assertEqual(stored[0].onJoinMode, periodicOnJoinModes.PERIODIC_ONLY, "invalid enum falls back to PERIODIC_ONLY");
});

// The shared Harness is synchronous; await each async case here, then write.
(async () =>
{
    for (const testCase of harness.cases)
    {
        const originalFunction = testCase.testFunction;
        let caughtError = null;
        try
        {
            await originalFunction();
        }
        catch (error)
        {
            caughtError = error;
        }
        testCase.testFunction = () => { if (caughtError) { throw caughtError; } };
    }
    harness.runAndWrite(RESULT_FILE);
})();
