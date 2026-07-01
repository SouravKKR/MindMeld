const PeriodicAssignmentQueryEngine = require("../../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const PeriodicCreditReconciler = require("../../../Globals/Classes/Credits/PeriodicCreditReconciler");
const CreditGrantTargetResolver = require("../../../Globals/Classes/Credits/CreditGrantTargetResolver");
const OrganizationQueryEngine = require("../../../Globals/Classes/Organization/OrganizationQueryEngine");
const PeriodicCreditAssignment = require("../../../Globals/Model/PeriodicCreditAssignment");
const { periodicScopeTypes } = require("../../../Globals/Enumerations/PeriodicScopeTypes");
const { periodicScheduleTypes } = require("../../../Globals/Enumerations/PeriodicScheduleTypes");
const { periodicOnJoinModes } = require("../../../Globals/Enumerations/PeriodicOnJoinModes");
const { creditGrantAmountModes } = require("../../../Globals/Enumerations/CreditGrantAmountModes");
const { creditGrantTargetTypes } = require("../../../Globals/Enumerations/CreditGrantTargetTypes");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

const MAXIMUM_PEOPLE_SET = 1000;

function normaliseEmail(email)
{
    return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * POST /Admin/Credits/Periodic/Create
 *
 * Creates a recurring credit assignment (ORGANIZATION or PEOPLE_SET scope).
 * The assignment is ACTIVE immediately — there is no scheduler; the lazy
 * reconciler materialises installments when each recipient next acts. On
 * create we also run a best-effort synchronous reconcile over the current
 * recipients so any on-join bonus lands "at creation time" for members who
 * already have an account.
 *
 * Body: { name, scopeType, organizationId?, peopleEmails?, amount, amountMode,
 *         scheduleType, intervalDays?, dayOfWeek?, dayOfMonth?, onJoinMode?,
 *         hasValidUntil?, validUntil? }
 */
async function createPeriodicAssignment(request, response)
{
    const body = await request.getBody();
    if (!body || typeof body !== "object")
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY });
        return;
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_NAME });
        return;
    }

    const scopeType = body.scopeType;
    if (scopeType !== periodicScopeTypes.ORGANIZATION && scopeType !== periodicScopeTypes.PEOPLE_SET)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_SCOPE });
        return;
    }

    const amount = parseFloat(body.amount);
    if (!isFinite(amount) || amount <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_AMOUNT });
        return;
    }

    let amountMode = body.amountMode;
    if (!Object.values(creditGrantAmountModes).includes(amountMode) || amountMode === creditGrantAmountModes.UNKNOWN)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_AMOUNT_MODE });
        return;
    }
    // TOTAL_SPLIT is undefined against a dynamic org roster — force PER_USER.
    if (scopeType === periodicScopeTypes.ORGANIZATION)
    {
        amountMode = creditGrantAmountModes.PER_USER;
    }

    // Schedule validation.
    const scheduleType = body.scheduleType;
    const intervalDays = parseInt(body.intervalDays, 10);
    const dayOfWeek = parseInt(body.dayOfWeek, 10);
    const dayOfMonth = parseInt(body.dayOfMonth, 10);
    if (scheduleType === periodicScheduleTypes.INTERVAL_DAYS)
    {
        if (!Number.isInteger(intervalDays) || intervalDays < 1)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_SCHEDULE });
            return;
        }
    }
    else if (scheduleType === periodicScheduleTypes.DAY_OF_WEEK)
    {
        if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_SCHEDULE });
            return;
        }
    }
    else if (scheduleType === periodicScheduleTypes.DAY_OF_MONTH)
    {
        if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_SCHEDULE });
            return;
        }
    }
    else
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_SCHEDULE });
        return;
    }

    // On-join applies to both scopes: for an org it fires when a new member
    // joins; for a people-set it grants an immediate bonus the first time each
    // listed person is reconciled. Default to PERIODIC_ONLY for a missing or
    // invalid value.
    let onJoinMode = body.onJoinMode;
    if (!Object.values(periodicOnJoinModes).includes(onJoinMode))
    {
        onJoinMode = periodicOnJoinModes.PERIODIC_ONLY;
    }

    // Scope-specific resolution.
    let organizationId = "";
    let peopleEmails = [];
    if (scopeType === periodicScopeTypes.ORGANIZATION)
    {
        organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
        if (organizationId.length === 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.MISSING_ORGANIZATION_ID });
            return;
        }
        const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        if (!organization)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.ORG_NOT_FOUND });
            return;
        }
    }
    else
    {
        const rawEmails = Array.isArray(body.peopleEmails) ? body.peopleEmails : [];
        peopleEmails = [...new Set(rawEmails.map(normaliseEmail).filter(email => email.length > 0 && email.indexOf("@") > 0))];
        if (peopleEmails.length === 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.MISSING_EMAILS });
            return;
        }
        if (peopleEmails.length > MAXIMUM_PEOPLE_SET)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.BATCH_LIMIT_EXCEEDED });
            return;
        }
    }

    const now = new Date();
    const hasValidUntil = body.hasValidUntil === true;
    let validUntil = now;
    if (hasValidUntil)
    {
        const parsedValidUntil = body.validUntil ? new Date(body.validUntil) : null;
        if (!parsedValidUntil || isNaN(parsedValidUntil.getTime()) || parsedValidUntil.getTime() <= now.getTime())
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
            return;
        }
        validUntil = parsedValidUntil;
    }

    const assignment = new PeriodicCreditAssignment
    ({
        name: name,
        scopeType: scopeType,
        organizationId: organizationId,
        peopleEmails: peopleEmails,
        amount: amount,
        amountMode: amountMode,
        scheduleType: scheduleType,
        intervalDays: scheduleType === periodicScheduleTypes.INTERVAL_DAYS ? intervalDays : 0,
        dayOfWeek: scheduleType === periodicScheduleTypes.DAY_OF_WEEK ? dayOfWeek : 0,
        dayOfMonth: scheduleType === periodicScheduleTypes.DAY_OF_MONTH ? dayOfMonth : 1,
        onJoinMode: onJoinMode,
        startAt: now,
        hasValidUntil: hasValidUntil,
        validUntil: validUntil,
        createdByUserId: request.user ? request.user.getId() : "",
        createdAt: now
    });

    await PeriodicAssignmentQueryEngine.createAssignment(assignment);

    // Best-effort synchronous seed — reconcile every CURRENT recipient who
    // already has an account so the on-join bonus + any immediately-due
    // installment land now. Recipients without an account get reconciled on
    // their first GetUser / AI use. Never fail creation on a seed error.
    let seededRecipients = 0;
    try
    {
        const target = scopeType === periodicScopeTypes.ORGANIZATION
            ? { targetType: creditGrantTargetTypes.ORGANIZATION, organizationId: organizationId }
            : { targetType: creditGrantTargetTypes.USER_EMAILS, emails: peopleEmails };
        const resolution = await CreditGrantTargetResolver.resolve(target);
        for (const recipient of resolution.recipients)
        {
            await PeriodicCreditReconciler.reconcileForUser(recipient.userId, recipient.email, now);
            seededRecipients++;
        }
    }
    catch (seedError)
    {
        console.warn(`[CreatePeriodicAssignment] Seed reconcile failed for ${assignment.getId()}: ${seedError?.message || seedError}`);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, assignment: assignment.toJson(), seededRecipients: seededRecipients });
}

module.exports = { createPeriodicAssignment };
