const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationMember = require("../../Model/OrganizationMember");
const OrganizationQueryEngine = require("./OrganizationQueryEngine");
const { organizationStatus } = require("../../Enumerations/OrganizationStatus");


/**
 * OrganizationMemberQueryEngine
 *
 * Membership is keyed by email — `userId` is back-filled on first
 * login (or via backfillUserId from the login-path reconciliator).
 * The unique (organizationId, email) index makes both single-add and
 * bulk-add E11000-safe; on a duplicate the caller rolls back the
 * cap-increment that was already reserved.
 *
 * Add / bulk-add do NOT mint Purchase + License rows themselves —
 * OrganizationAutoAssigner is called from the endpoint handler after
 * this engine returns success, so the cap accounting stays here and
 * the auto-assign logic stays in its own class (CLAUDE.md §3 single
 * responsibility).
 */
class OrganizationMemberQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(OrganizationMemberQueryEngine.#COLLECTION_NAME);
    }

    static #normaliseEmail(email)
    {
        if (typeof email !== "string")
        {
            return "";
        }
        return email.trim().toLowerCase();
    }

    /**
     * Adds a single member. Inserts after the caller has already
     * incremented the cap via OrganizationQueryEngine.tryIncrementMemberCount.
     * Returns ADDED / ALREADY_MEMBER / INVALID_EMAIL — on
     * ALREADY_MEMBER the caller MUST decrement the cap back.
     */
    static async addMember(organizationId, rawEmail, addedByUserId)
    {
        const email = OrganizationMemberQueryEngine.#normaliseEmail(rawEmail);
        if (email.length === 0 || email.indexOf("@") < 0)
        {
            return { status: "INVALID_EMAIL" };
        }

        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        // Codegen constructor auto-generates the UUID id — no setId
        // call needed (and the class doesn't expose one).
        const member = new OrganizationMember
        ({
            organizationId: organizationId,
            email: email,
            userId: "",
            addedBy: typeof addedByUserId === "string" ? addedByUserId : "",
            addedAt: new Date()
        });

        try
        {
            await collection.insertOne(member.toJson());
            return { status: "ADDED", member: member };
        }
        catch (insertError)
        {
            if (insertError && insertError.code === 11000)
            {
                return { status: "ALREADY_MEMBER" };
            }
            throw insertError;
        }
    }

    /**
     * Bulk-add. The cap has ALREADY been reserved by
     * OrganizationQueryEngine.tryIncrementMemberCountBy(emails.length)
     * before this is called — but only AFTER the caller has already
     * de-duped against existing members. So in the normal path every
     * email here is genuinely new; a duplicate at this stage indicates
     * a race against another concurrent admin and we decrement the cap
     * back for any rows we couldn't insert.
     *
     * @param {string} organizationId
     * @param {Array<string>} rawEmails (already de-duped against the visible members list, NOT against the DB)
     * @param {string} addedByUserId
     * @returns {Promise<{ added: Array<{email, member}>, alreadyMember: Array<string>, invalidEmail: Array<string> }>}
     */
    static async bulkAddMembers(organizationId, rawEmails, addedByUserId)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            throw new Error("Database unavailable");
        }

        const result = { added: [], alreadyMember: [], invalidEmail: [] };
        const validatedRows = [];

        for (const rawEmail of rawEmails)
        {
            const email = OrganizationMemberQueryEngine.#normaliseEmail(rawEmail);
            if (email.length === 0 || email.indexOf("@") < 0)
            {
                result.invalidEmail.push(typeof rawEmail === "string" ? rawEmail : "");
                continue;
            }
            // Constructor auto-generates UUID id.
            const member = new OrganizationMember
            ({
                organizationId: organizationId,
                email: email,
                userId: "",
                addedBy: typeof addedByUserId === "string" ? addedByUserId : "",
                addedAt: new Date()
            });
            validatedRows.push({ email: email, member: member });
        }

        if (validatedRows.length === 0)
        {
            return result;
        }

        try
        {
            await collection.insertMany
            (
                validatedRows.map(row => row.member.toJson()),
                { ordered: false }
            );
            for (const row of validatedRows)
            {
                result.added.push({ email: row.email, member: row.member });
            }
        }
        catch (bulkError)
        {
            // ordered: false sets insertedCount even when some rows
            // collide; the writeErrors array tells us which rows failed
            // with E11000 (duplicate) so we can surface them as
            // ALREADY_MEMBER and roll the cap back for those.
            const writeErrors = bulkError?.writeErrors || bulkError?.result?.result?.writeErrors || [];
            const failedIndexes = new Set(writeErrors.map(writeError => writeError.index));

            for (let rowIndex = 0; rowIndex < validatedRows.length; rowIndex++)
            {
                const row = validatedRows[rowIndex];
                if (failedIndexes.has(rowIndex))
                {
                    const errorCode = writeErrors.find(writeError => writeError.index === rowIndex)?.code;
                    if (errorCode === 11000)
                    {
                        result.alreadyMember.push(row.email);
                    }
                    else
                    {
                        // A non-duplicate write error on a member row is
                        // unexpected; surface as already-member rather than
                        // crash the whole batch — the caller will see a count
                        // mismatch in its summary.
                        result.alreadyMember.push(row.email);
                    }
                }
                else
                {
                    result.added.push({ email: row.email, member: row.member });
                }
            }
        }

        // Roll back the cap for rows we couldn't actually insert.
        const failedCount = result.alreadyMember.length + result.invalidEmail.length;
        if (failedCount > 0)
        {
            await OrganizationQueryEngine.decrementMemberCountBy(organizationId, failedCount);
        }

        return result;
    }

    static async removeMember(organizationId, memberId)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: 0 };
        }

        const deleteResult = await collection.deleteOne({ id: memberId, organizationId: organizationId });
        if (deleteResult.deletedCount === 1)
        {
            await OrganizationQueryEngine.decrementMemberCountBy(organizationId, 1);
        }
        return { removed: deleteResult.deletedCount };
    }

    static async bulkRemoveMembers(organizationId, memberIds)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: 0, notFound: memberIds.length };
        }

        const safeIds = Array.isArray(memberIds) ? memberIds.filter(memberId => typeof memberId === "string" && memberId.length > 0) : [];
        if (safeIds.length === 0)
        {
            return { removed: 0, notFound: 0 };
        }

        const deleteResult = await collection.deleteMany
        ({
            organizationId: organizationId,
            id: { $in: safeIds }
        });

        if (deleteResult.deletedCount > 0)
        {
            await OrganizationQueryEngine.decrementMemberCountBy(organizationId, deleteResult.deletedCount);
        }

        return { removed: deleteResult.deletedCount, notFound: safeIds.length - deleteResult.deletedCount };
    }

    static async listMembers(organizationId)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({ organizationId: organizationId }, { projection: { _id: 0 } })
            .sort({ addedAt: -1 })
            .toArray();
        return documents.map(document => OrganizationMember.fromJson(document));
    }

    static async listExistingEmails(organizationId, candidateEmails)
    {
        if (!Array.isArray(candidateEmails) || candidateEmails.length === 0)
        {
            return new Set();
        }
        const normalisedCandidates = candidateEmails
            .map(email => OrganizationMemberQueryEngine.#normaliseEmail(email))
            .filter(email => email.length > 0);
        if (normalisedCandidates.length === 0)
        {
            return new Set();
        }

        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return new Set();
        }

        const documents = await collection
            .find({ organizationId: organizationId, email: { $in: normalisedCandidates } }, { projection: { email: 1, _id: 0 } })
            .toArray();
        return new Set(documents.map(document => document.email));
    }

    /**
     * For the pricing engine. Returns every (organizationId, addedAt)
     * pair where this email is currently a member of an ACTIVE org.
     * The pricing path joins these with the perk table by deckId.
     */
    static async findActiveMembershipsByEmail(rawEmail)
    {
        const email = OrganizationMemberQueryEngine.#normaliseEmail(rawEmail);
        if (email.length === 0)
        {
            return [];
        }

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return [];
        }

        // Aggregation: find member rows by email, then $lookup their
        // organization to filter to status=ACTIVE. Keeps the membership
        // anchor (addedAt) intact for the duration-window check.
        const pipeline =
        [
            { $match: { email: email } },
            {
                $lookup:
                {
                    from: DatabaseConstants.ORGANIZATIONS_COLLECTION,
                    localField: "organizationId",
                    foreignField: "id",
                    as: "organization"
                }
            },
            { $unwind: "$organization" },
            { $match: { "organization.status": organizationStatus.ACTIVE } }
        ];

        const rows = await database
            .collection(OrganizationMemberQueryEngine.#COLLECTION_NAME)
            .aggregate(pipeline)
            .toArray();

        return rows.map(row => (
        {
            organizationId: row.organizationId,
            email: row.email,
            addedAt: row.addedAt instanceof Date ? row.addedAt : new Date(row.addedAt),
            organization: row.organization
        }));
    }

    /**
     * Back-fills userId on every membership row matching this email.
     * Called from the login-path right after role reconciliation, so
     * downstream queries that need to join (rare today, may grow) can
     * use the indexed userId instead of email.
     */
    static async backfillUserId(rawEmail, userId)
    {
        const email = OrganizationMemberQueryEngine.#normaliseEmail(rawEmail);
        if (email.length === 0 || typeof userId !== "string" || userId.length === 0)
        {
            return { updated: 0 };
        }

        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return { updated: 0 };
        }

        const updateResult = await collection.updateMany
        (
            { email: email, $or: [{ userId: "" }, { userId: { $exists: false } }] },
            { $set: { userId: userId } }
        );
        return { updated: updateResult.modifiedCount };
    }
}

module.exports = OrganizationMemberQueryEngine;
