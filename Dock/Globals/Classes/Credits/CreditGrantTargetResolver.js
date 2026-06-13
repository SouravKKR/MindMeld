const DatabaseConstants = require('../../Constants/DatabaseConstants');
const DatabaseConnector = require('../Database/DatabaseConnector');
const OrganizationMemberQueryEngine = require('../Organization/OrganizationMemberQueryEngine');
const { creditGrantTargetTypes } = require('../../Enumerations/CreditGrantTargetTypes');
const { userRoles } = require('../../Enumerations/UserRoles');

/**
 * CreditGrantTargetResolver
 *
 * Resolves an admin credit-grant target specification into the concrete
 * list of recipient users. Three targeting modes are supported:
 *
 *   USER_EMAILS  — an explicit list of email addresses (one or many).
 *   USER_FILTER  — a query over the users collection (email substring,
 *                  role, current balance range). An empty filter matches
 *                  every user — the preview endpoint makes the blast
 *                  radius explicit before anything is granted.
 *   ORGANIZATION — every member of a B2B organization. Members who have
 *                  never signed in have no user document yet and are
 *                  reported back as unmatched instead of silently skipped.
 *
 * Resolution is read-only — the actual granting happens in
 * CreditGrantExecutor so preview and apply share the exact same
 * target-resolution path.
 */
class CreditGrantTargetResolver
{
    // Hard ceiling on a single grant operation. A filter that matches more
    // users than this is refused (not truncated) so the admin narrows it
    // instead of silently missing recipients.
    static MAXIMUM_TARGET_USERS = 1000;

    static #RECIPIENT_PROJECTION = { _id: 0, id: 1, displayName: 1, "additionalData.email": 1, "additionalData.credits": 1 };

    /**
     * @param {{
     *   targetType: number,
     *   emails?: Array<string>,
     *   filter?: { emailContains?: string, role?: number|null, minimumBalance?: number|null, maximumBalance?: number|null },
     *   organizationId?: string
     * }} targetSpecification
     * @returns {Promise<{recipients: Array<{userId: string, email: string, displayName: string, balance: number}>, unmatchedEmails: Array<string>, error: string|null}>}
     */
    static async resolve(targetSpecification)
    {
        if (!targetSpecification || typeof targetSpecification !== "object")
        {
            return CreditGrantTargetResolver.#errorResult("MISSING_TARGET");
        }

        const targetType = targetSpecification.targetType;

        if (targetType === creditGrantTargetTypes.USER_EMAILS)
        {
            return await CreditGrantTargetResolver.#resolveByEmails(targetSpecification.emails);
        }
        if (targetType === creditGrantTargetTypes.USER_FILTER)
        {
            return await CreditGrantTargetResolver.#resolveByFilter(targetSpecification.filter || {});
        }
        if (targetType === creditGrantTargetTypes.ORGANIZATION)
        {
            return await CreditGrantTargetResolver.#resolveOrganizationMembers(targetSpecification.organizationId);
        }

        return CreditGrantTargetResolver.#errorResult("INVALID_TARGET_TYPE");
    }

    static async #resolveByEmails(rawEmails)
    {
        if (!Array.isArray(rawEmails) || rawEmails.length === 0)
        {
            return CreditGrantTargetResolver.#errorResult("MISSING_EMAILS");
        }

        const normalisedEmails = [...new Set(
            rawEmails
                .map(email => CreditGrantTargetResolver.#normaliseEmail(email))
                .filter(email => email.length > 0 && email.indexOf("@") >= 0)
        )];

        if (normalisedEmails.length === 0)
        {
            return CreditGrantTargetResolver.#errorResult("MISSING_EMAILS");
        }
        if (normalisedEmails.length > CreditGrantTargetResolver.MAXIMUM_TARGET_USERS)
        {
            return CreditGrantTargetResolver.#errorResult("TOO_MANY_TARGET_USERS");
        }

        const documents = await CreditGrantTargetResolver.#findUserDocumentsByEmails(normalisedEmails);
        const recipients = documents.map(document => CreditGrantTargetResolver.#recipientFromUserDocument(document));

        const matchedEmails = new Set(recipients.map(recipient => recipient.email.toLowerCase()));
        const unmatchedEmails = normalisedEmails.filter(email => !matchedEmails.has(email));

        return { recipients: recipients, unmatchedEmails: unmatchedEmails, error: null };
    }

    static async #resolveByFilter(filter)
    {
        const pipeline = [];

        const emailContains = typeof filter.emailContains === "string" ? filter.emailContains.trim() : "";
        if (emailContains.length > 0)
        {
            const escapedFragment = CreditGrantTargetResolver.#escapeRegex(emailContains);
            pipeline.push({ $match: { "additionalData.email": { $regex: escapedFragment, $options: "i" } } });
        }

        const roleValue = filter.role;
        if (roleValue !== null && roleValue !== undefined)
        {
            if (!Object.values(userRoles).includes(roleValue))
            {
                return CreditGrantTargetResolver.#errorResult("INVALID_ROLE_FILTER");
            }
            pipeline.push({ $match: { role: roleValue } });
        }

        // Balance comparisons coalesce a missing credits field to 0 so a
        // never-charged user still matches "balance below X" filters.
        const balanceConditions = {};
        if (typeof filter.minimumBalance === "number" && isFinite(filter.minimumBalance))
        {
            balanceConditions.$gte = filter.minimumBalance;
        }
        if (typeof filter.maximumBalance === "number" && isFinite(filter.maximumBalance))
        {
            balanceConditions.$lte = filter.maximumBalance;
        }
        if (Object.keys(balanceConditions).length > 0)
        {
            pipeline.push({ $addFields: { effectiveBalance: { $ifNull: ["$additionalData.credits", 0] } } });
            pipeline.push({ $match: { effectiveBalance: balanceConditions } });
        }

        pipeline.push({ $project: CreditGrantTargetResolver.#RECIPIENT_PROJECTION });
        pipeline.push({ $limit: CreditGrantTargetResolver.MAXIMUM_TARGET_USERS + 1 });

        const usersCollection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION);
        const documents = await usersCollection.aggregate(pipeline).toArray();

        if (documents.length > CreditGrantTargetResolver.MAXIMUM_TARGET_USERS)
        {
            return CreditGrantTargetResolver.#errorResult("TOO_MANY_TARGET_USERS");
        }

        const recipients = documents.map(document => CreditGrantTargetResolver.#recipientFromUserDocument(document));
        return { recipients: recipients, unmatchedEmails: [], error: null };
    }

    static async #resolveOrganizationMembers(organizationId)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return CreditGrantTargetResolver.#errorResult("MISSING_ORGANIZATION_ID");
        }

        const members = await OrganizationMemberQueryEngine.listMembers(organizationId);
        if (members.length === 0)
        {
            return { recipients: [], unmatchedEmails: [], error: null };
        }
        if (members.length > CreditGrantTargetResolver.MAXIMUM_TARGET_USERS)
        {
            return CreditGrantTargetResolver.#errorResult("TOO_MANY_TARGET_USERS");
        }

        const usersCollection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION);

        // First pass — members whose userId was already back-filled on login.
        const backfilledUserIds = members
            .map(member => member.getUserId())
            .filter(userId => typeof userId === "string" && userId.length > 0);

        const documentsById = backfilledUserIds.length > 0
            ? await usersCollection
                .find({ id: { $in: backfilledUserIds } }, { projection: CreditGrantTargetResolver.#RECIPIENT_PROJECTION })
                .toArray()
            : [];

        const recipientsByUserId = new Map();
        for (const document of documentsById)
        {
            recipientsByUserId.set(document.id, CreditGrantTargetResolver.#recipientFromUserDocument(document));
        }

        // Second pass — members with no back-filled userId (or whose id lookup
        // missed) are matched by email instead.
        const resolvedEmails = new Set(
            [...recipientsByUserId.values()].map(recipient => recipient.email.toLowerCase())
        );
        const memberEmailsNeedingLookup = [...new Set(
            members
                .map(member => CreditGrantTargetResolver.#normaliseEmail(member.getEmail()))
                .filter(email => email.length > 0 && !resolvedEmails.has(email))
        )];

        const documentsByEmail = memberEmailsNeedingLookup.length > 0
            ? await CreditGrantTargetResolver.#findUserDocumentsByEmails(memberEmailsNeedingLookup)
            : [];

        for (const document of documentsByEmail)
        {
            if (!recipientsByUserId.has(document.id))
            {
                recipientsByUserId.set(document.id, CreditGrantTargetResolver.#recipientFromUserDocument(document));
            }
        }

        const matchedEmails = new Set(
            [...recipientsByUserId.values()].map(recipient => recipient.email.toLowerCase())
        );
        const unmatchedEmails = [...new Set(
            members
                .map(member => CreditGrantTargetResolver.#normaliseEmail(member.getEmail()))
                .filter(email => email.length > 0 && !matchedEmails.has(email))
        )];

        return { recipients: [...recipientsByUserId.values()], unmatchedEmails: unmatchedEmails, error: null };
    }

    /**
     * Case-insensitive batch email lookup. Stored emails keep whatever
     * casing the OAuth provider returned, so matching lowercases the
     * stored value instead of trusting it to already be lowercase.
     */
    static async #findUserDocumentsByEmails(normalisedEmails)
    {
        const usersCollection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION);

        const pipeline =
        [
            { $addFields: { lowercasedEmail: { $toLower: { $ifNull: ["$additionalData.email", ""] } } } },
            { $match: { lowercasedEmail: { $in: normalisedEmails } } },
            { $project: CreditGrantTargetResolver.#RECIPIENT_PROJECTION }
        ];

        return await usersCollection.aggregate(pipeline).toArray();
    }

    static #recipientFromUserDocument(document)
    {
        const balance = document.additionalData?.credits;
        return {
            userId: document.id,
            email: document.additionalData?.email || "",
            displayName: document.displayName || "",
            balance: typeof balance === "number" ? balance : 0
        };
    }

    static #normaliseEmail(email)
    {
        if (typeof email !== "string")
        {
            return "";
        }
        return email.trim().toLowerCase();
    }

    static #escapeRegex(text)
    {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    static #errorResult(error)
    {
        return { recipients: [], unmatchedEmails: [], error: error };
    }
}

module.exports = CreditGrantTargetResolver;
