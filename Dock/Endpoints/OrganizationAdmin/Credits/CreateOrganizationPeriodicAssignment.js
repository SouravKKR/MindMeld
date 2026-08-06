const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationCreditLedger = require("../../../Globals/Classes/Organization/OrganizationCreditLedger");
const PeriodicAssignmentQueryEngine = require("../../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const PeriodicCreditAssignment = require("../../../Globals/Model/PeriodicCreditAssignment");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const { periodicScopeTypes } = require("../../../Globals/Enumerations/PeriodicScopeTypes");
const { periodicScheduleTypes } = require("../../../Globals/Enumerations/PeriodicScheduleTypes");
const { periodicOnJoinModes } = require("../../../Globals/Enumerations/PeriodicOnJoinModes");
const { periodicAssignmentStatuses } = require("../../../Globals/Enumerations/PeriodicAssignmentStatuses");
const { creditGrantAmountModes } = require("../../../Globals/Enumerations/CreditGrantAmountModes");
const { tagMatchModes } = require("../../../Globals/Enumerations/TagMatchModes");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Credits/Periodic/Create
 *
 * Body: { organizationId, name, tagFilter?, tagMatchMode?, amount,
 *         scheduleType, intervalDays?, dayOfWeek?, dayOfMonth?, onJoinMode?,
 *         hasValidUntil?, validUntil? }
 *
 * A recurring distribution the organization runs on its own people — monthly
 * credits to the first-year cohort, say.
 *
 * The scope and the organization are forced from the caller's standing, never
 * read from the body, so an organization admin cannot create an assignment
 * that pays somebody else's members.
 *
 * The amount mode is forced to PER_USER. TOTAL_SPLIT divides a fixed pot
 * between recipients, which is meaningless against a roster that changes
 * between cycles — the same pot would buy each person less every time someone
 * joined.
 *
 * Each cycle draws from the organization's pool when it runs. Nothing is
 * reserved up front: reserving would mean showing two balances, and a cycle
 * whose cost changes with the roster cannot be reserved accurately anyway. The
 * credits section shows the projected next-cycle cost against the balance, and
 * a cycle the pool cannot cover is skipped with a notification rather than
 * borrowed.
 */
async function createOrganizationPeriodicAssignment(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.DISTRIBUTE_CREDITS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length === 0 || name.length > 256)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_NAME });
        return;
    }

    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_AMOUNT });
        return;
    }

    const scheduleType = body?.scheduleType;
    const intervalDays = parseInt(body?.intervalDays, 10);
    const dayOfWeek = parseInt(body?.dayOfWeek, 10);
    const dayOfMonth = parseInt(body?.dayOfMonth, 10);

    if (scheduleType === periodicScheduleTypes.INTERVAL_DAYS)
    {
        if (!Number.isInteger(intervalDays) || intervalDays < 1)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
            return;
        }
    }
    else if (scheduleType === periodicScheduleTypes.DAY_OF_WEEK)
    {
        if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
            return;
        }
    }
    else if (scheduleType === periodicScheduleTypes.DAY_OF_MONTH)
    {
        if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
            return;
        }
    }
    else
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    let onJoinMode = body?.onJoinMode;
    if (!Object.values(periodicOnJoinModes).includes(onJoinMode))
    {
        onJoinMode = periodicOnJoinModes.PERIODIC_ONLY;
    }

    let tagMatchMode = body?.tagMatchMode;
    if (!Object.values(tagMatchModes).includes(tagMatchMode))
    {
        tagMatchMode = tagMatchModes.EVERYONE;
    }

    const now = new Date();
    const bHasValidUntil = body?.hasValidUntil === true;
    let validUntil = now;
    if (bHasValidUntil)
    {
        const parsedValidUntil = body?.validUntil ? new Date(body.validUntil) : null;
        if (!parsedValidUntil || isNaN(parsedValidUntil.getTime()) || parsedValidUntil.getTime() <= now.getTime())
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
            return;
        }
        validUntil = parsedValidUntil;
    }

    const assignment = new PeriodicCreditAssignment
    ({
        name: name.slice(0, 256),
        scopeType: periodicScopeTypes.ORGANIZATION,
        organizationId: organizationId,
        peopleEmails: [],
        tagFilter: Array.isArray(body?.tagFilter) ? body.tagFilter.map(tag => String(tag).trim().toLowerCase()).filter(tag => tag.length > 0) : [],
        tagMatchMode: tagMatchMode,
        amount: amount,
        // Forced: a fixed pot split between a roster that changes between
        // cycles gives each person a different amount every time.
        amountMode: creditGrantAmountModes.PER_USER,
        scheduleType: scheduleType,
        intervalDays: scheduleType === periodicScheduleTypes.INTERVAL_DAYS ? intervalDays : 0,
        dayOfWeek: scheduleType === periodicScheduleTypes.DAY_OF_WEEK ? dayOfWeek : 0,
        dayOfMonth: scheduleType === periodicScheduleTypes.DAY_OF_MONTH ? dayOfMonth : 1,
        onJoinMode: onJoinMode,
        startAt: now,
        hasValidUntil: bHasValidUntil,
        validUntil: validUntil,
        status: periodicAssignmentStatuses.ACTIVE,
        terminatedAt: now,
        createdByUserId: request.user.getId(),
        createdAt: now,
        additionalData: {}
    });

    await PeriodicAssignmentQueryEngine.createAssignment(assignment);

    const pool = await OrganizationCreditLedger.getPool(organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        assignment: assignment.toJson(),
        poolBalance: pool ? pool.getBalance() : 0
    });
}

module.exports = { createOrganizationPeriodicAssignment };
