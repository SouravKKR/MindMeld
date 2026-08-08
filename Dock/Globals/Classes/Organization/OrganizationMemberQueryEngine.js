const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationMember = require("../../Model/OrganizationMember");
const OrganizationQueryEngine = require("./OrganizationQueryEngine");
const OrganizationMemberProfileMutator = require("./OrganizationMemberProfileMutator");
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

        for (const rawEntry of rawEmails)
        {
            // An entry is either a bare email (typed or pasted) or a normalised
            // profile from an imported sheet. Accepting both keeps one insert
            // path, so a member added by hand and one imported from a
            // spreadsheet cannot end up shaped differently.
            const bIsProfile = rawEntry !== null && typeof rawEntry === "object";
            const rawEmail = bIsProfile ? rawEntry.email : rawEntry;

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
                tags: bIsProfile && Array.isArray(rawEntry.tags) ? rawEntry.tags : [],
                attributes: bIsProfile && rawEntry.attributes ? rawEntry.attributes : {},
                attributesNormalised: bIsProfile && rawEntry.attributesNormalised ? rawEntry.attributesNormalised : {},
                attributesComparable: bIsProfile && rawEntry.attributesComparable ? rawEntry.attributesComparable : {},
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

        // Read before deleting: once the row is gone there is no way left to
        // learn whose content has to be taken back.
        const departingUserIds = await OrganizationMemberQueryEngine.#collectUserIds(collection, { id: memberId, organizationId: organizationId });

        const deleteResult = await collection.deleteOne({ id: memberId, organizationId: organizationId });
        if (deleteResult.deletedCount === 1)
        {
            await OrganizationQueryEngine.decrementMemberCountBy(organizationId, 1);
            await OrganizationMemberQueryEngine.#withdrawOrganizationContent(organizationId, departingUserIds);
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

        const departingUserIds = await OrganizationMemberQueryEngine.#collectUserIds(collection, { organizationId: organizationId, id: { $in: safeIds } });

        const deleteResult = await collection.deleteMany
        ({
            organizationId: organizationId,
            id: { $in: safeIds }
        });

        if (deleteResult.deletedCount > 0)
        {
            await OrganizationQueryEngine.decrementMemberCountBy(organizationId, deleteResult.deletedCount);
            await OrganizationMemberQueryEngine.#withdrawOrganizationContent(organizationId, departingUserIds);
        }

        return { removed: deleteResult.deletedCount, notFound: safeIds.length - deleteResult.deletedCount };
    }

    /**
     * The account ids behind the member rows a filter matches. Rows whose
     * member never signed in have no account bound yet and are skipped — they
     * hold no licences, so there is nothing of the organization's to take back.
     */
    static async #collectUserIds(collection, query)
    {
        const memberDocuments = await collection.find(query, { projection: { _id: 0, userId: 1 } }).toArray();
        return memberDocuments
            .map(document => document.userId)
            .filter(userId => typeof userId === "string" && userId.length > 0);
    }

    /**
     * Takes the organization's decks back from people who have just left it.
     *
     * Done HERE, inside the removal itself, rather than at the three endpoints
     * that remove members: an offboarding step that each caller has to remember
     * is one that a fourth caller will not, and the consequence — an ex-member
     * still studying an institute's material indefinitely, their licence still
     * ACTIVE so nothing else ever reclaims it — is silent.
     *
     * Best-effort and non-fatal. The removal itself has already succeeded and
     * must not be reported as failed because the content teardown hit a
     * problem; a licence left behind is picked up by the next explicit
     * withdrawal, whereas a member wrongly reported as still present is acted on
     * by a human.
     */
    static async #withdrawOrganizationContent(organizationId, departingUserIds)
    {
        if (departingUserIds.length === 0)
        {
            return;
        }

        // Lazily required: the withdrawal service reads the member roster, so a
        // top-level require would close a cycle back into this class.
        const OrganizationDeckWithdrawalService = require("./OrganizationDeckWithdrawalService");

        for (const departingUserId of departingUserIds)
        {
            try
            {
                await OrganizationDeckWithdrawalService.withdrawAllForMember(organizationId, departingUserId);
            }
            catch (withdrawalError)
            {
                console.error(`[OrganizationMemberQueryEngine] Could not withdraw ${organizationId} content from ${departingUserId}: ${withdrawalError?.message || withdrawalError}`);
            }
        }
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
            delegatePowers: Number.isInteger(row.delegatePowers) ? row.delegatePowers : 0,
            organization: row.organization
        }));
    }

    /**
     * Applies an imported profile (tags + attributes) to members who already
     * exist, REPLACING what they carried. The sheet is the source of truth: a
     * tag removed from the sheet is removed from the member, because the
     * alternative — merging — means a tag applied by mistake can never be
     * corrected by re-importing a fixed sheet.
     *
     * Members absent from the sheet are untouched; removing people is a
     * separate, explicit action.
     *
     * @param {string} organizationId
     * @param {Array<{email: string, attributes: object, attributesNormalised: object, attributesComparable: object, tags: string[]}>} normalisedProfiles
     * @returns {Promise<{ updated: number }>}
     */
    static async replaceProfilesForExistingMembers(organizationId, normalisedProfiles)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection || !Array.isArray(normalisedProfiles) || normalisedProfiles.length === 0)
        {
            return { updated: 0 };
        }

        const writeOperations = [];
        for (const profile of normalisedProfiles)
        {
            const email = OrganizationMemberQueryEngine.#normaliseEmail(profile?.email);
            if (email.length === 0)
            {
                continue;
            }

            writeOperations.push
            ({
                updateOne:
                {
                    filter: { organizationId: organizationId, email: email },
                    update:
                    {
                        $set:
                        {
                            tags: profile.tags,
                            attributes: profile.attributes,
                            attributesNormalised: profile.attributesNormalised,
                            // All four maps or none. Leaving the comparable copy
                            // behind is not a cosmetic omission: the number and
                            // date range filters read ONLY from it, so a member
                            // whose corrected join year was written to
                            // `attributes` but not here goes on being matched —
                            // and removed, and granted credits — on the value
                            // the sheet replaced.
                            attributesComparable: profile.attributesComparable
                        }
                    }
                }
            });
        }

        if (writeOperations.length === 0)
        {
            return { updated: 0 };
        }

        const bulkResult = await collection.bulkWrite(writeOperations, { ordered: false });
        return { updated: bulkResult.modifiedCount || 0 };
    }

    /**
     * Every attribute key present on at least one member of this organization,
     * and every tag in use. Drives the per-organization filter set: an
     * institute that never uploads a "stream" column is never offered a stream
     * filter, and one that invents "section" gets a section filter for free.
     *
     * @param {string} organizationId
     * @returns {Promise<{ attributeKeys: string[], tags: string[] }>}
     */
    static async listProfileVocabulary(organizationId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return { attributeKeys: [], tags: [] };
        }

        const collection = database.collection(OrganizationMemberQueryEngine.#COLLECTION_NAME);

        // One aggregation rather than a distinct() per key: $objectToArray turns
        // each member's attribute map into rows so the keys can be unioned
        // server-side instead of pulling every member back to count them.
        const attributeKeyRows = await collection.aggregate
        ([
            { $match: { organizationId: organizationId } },
            { $project: { attributePairs: { $objectToArray: { $ifNull: ["$attributes", {}] } } } },
            { $unwind: "$attributePairs" },
            { $group: { _id: "$attributePairs.k" } },
            { $sort: { _id: 1 } }
        ]).toArray();

        const tags = await collection.distinct("tags", { organizationId: organizationId });

        return {
            attributeKeys: attributeKeyRows.map(row => row._id).filter(key => typeof key === "string" && key.length > 0),
            tags: tags.filter(tag => typeof tag === "string" && tag.length > 0).sort()
        };
    }

    /**
     * Deletes every member matching a prepared Mongo filter, giving the seat
     * count back. The filter is built by the caller from the same filter
     * definitions the member list renders, so what is previewed and what is
     * deleted come from one expression.
     *
     * @param {string} organizationId
     * @param {object} additionalQuery a Mongo fragment already scoped by the caller
     * @returns {Promise<{ removed: number }>}
     */
    static async removeMembersMatching(organizationId, additionalQuery)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: 0 };
        }

        const departingUserIds = await OrganizationMemberQueryEngine.#collectUserIds(collection, { ...additionalQuery, organizationId: organizationId });

        const deleteResult = await collection.deleteMany
        ({
            ...additionalQuery,
            organizationId: organizationId
        });

        if (deleteResult.deletedCount > 0)
        {
            await OrganizationQueryEngine.decrementMemberCountBy(organizationId, deleteResult.deletedCount);
            await OrganizationMemberQueryEngine.#withdrawOrganizationContent(organizationId, departingUserIds);
        }

        return { removed: deleteResult.deletedCount };
    }

    /**
     * The members a prepared filter matches, without deleting anything — the
     * dry run behind the confirmation dialog. Returns the full count plus a
     * bounded sample, so a filter that would remove 400 people says so before
     * anyone presses the button.
     *
     * @param {string} organizationId
     * @param {object} additionalQuery
     * @param {number} sampleLimit
     * @returns {Promise<{ matchedCount: number, sample: Array<OrganizationMember> }>}
     */
    static async previewMembersMatching(organizationId, additionalQuery, sampleLimit = 10)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return { matchedCount: 0, sample: [] };
        }

        const scopedQuery = { ...additionalQuery, organizationId: organizationId };
        const matchedCount = await collection.countDocuments(scopedQuery);
        const sampleDocuments = await collection
            .find(scopedQuery, { projection: { _id: 0 } })
            .limit(Math.max(1, sampleLimit))
            .toArray();

        return {
            matchedCount: matchedCount,
            sample: sampleDocuments.map(document => OrganizationMember.fromJson(document))
        };
    }

    /**
     * Removes one attribute from every member of an organization, across all
     * three stored copies.
     *
     * Dropping a column has to take its values with it. The schema is rebuilt
     * from the attribute keys members actually carry, so deleting the
     * description while leaving the data would simply recreate the column on the
     * next read — the institute would delete it, reload, and find it back.
     *
     * @param {string} organizationId
     * @param {string} attributeKey
     * @returns {Promise<{ updated: number }>}
     */
    static async removeAttributeFromAllMembers(organizationId, attributeKey)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        const safeKey = String(attributeKey ?? "").trim();
        if (!collection || safeKey.length === 0)
        {
            return { updated: 0 };
        }

        const unsetFields = {};
        unsetFields[`attributes.${safeKey}`] = "";
        unsetFields[`attributesNormalised.${safeKey}`] = "";
        unsetFields[`attributesComparable.${safeKey}`] = "";

        const updateResult = await collection.updateMany
        (
            { organizationId: organizationId },
            { $unset: unsetFields }
        );

        return { updated: updateResult.modifiedCount || 0 };
    }

    /**
     * Every member matching a prepared Mongo filter. Used where the caller needs
     * the whole matched set rather than a page of it — applying an edit to a
     * filtered cohort, and showing an administrator exactly who a permission rule
     * covers before they save it.
     *
     * Bounded rather than unbounded: an organization is capped at a few thousand
     * seats, so this stays a bounded read, and the caller is told when the cap
     * truncated the answer instead of quietly receiving a short list.
     *
     * @param {string} organizationId
     * @param {object} additionalQuery a Mongo fragment already built by the caller
     * @param {number} maximumMembers
     * @returns {Promise<{ matchedCount: number, members: Array<OrganizationMember>, truncated: boolean }>}
     */
    static async listMembersMatching(organizationId, additionalQuery, maximumMembers)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return { matchedCount: 0, members: [], truncated: false };
        }

        const scopedQuery = { ...additionalQuery, organizationId: organizationId };
        const matchedCount = await collection.countDocuments(scopedQuery);
        const safeMaximum = Math.max(1, Number(maximumMembers) || 1);

        const documents = await collection
            .find(scopedQuery, { projection: { _id: 0 } })
            .sort({ email: 1 })
            .limit(safeMaximum)
            .toArray();

        return {
            matchedCount: matchedCount,
            members: documents.map(document => OrganizationMember.fromJson(document)),
            truncated: matchedCount > documents.length
        };
    }

    /**
     * Applies one mutation to every member matching a prepared Mongo filter.
     *
     * The profile each member ends up with is computed per member rather than
     * pushed down as a single Mongo update, because "add this tag" and "set this
     * column" both depend on what that member already carried, and because all
     * four stored maps have to be re-derived together from the result. A `$set`
     * of `attributes` alone would leave the comparable copy describing the value
     * it replaced.
     *
     * @param {string} organizationId
     * @param {object} additionalQuery a Mongo fragment already built by the caller
     * @param {object} mutation
     * @param {number} maximumMembers
     * @returns {Promise<{ matchedCount: number, updated: number, truncated: boolean }>}
     */
    static async applyMutationToMembersMatching(organizationId, additionalQuery, mutation, maximumMembers)
    {
        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return { matchedCount: 0, updated: 0, truncated: false };
        }

        const scopedQuery = { ...additionalQuery, organizationId: organizationId };
        const matchedCount = await collection.countDocuments(scopedQuery);
        const safeMaximum = Math.max(1, Number(maximumMembers) || 1);

        const documents = await collection
            .find(scopedQuery, { projection: { _id: 0 } })
            .limit(safeMaximum)
            .toArray();

        if (documents.length === 0)
        {
            return { matchedCount: matchedCount, updated: 0, truncated: false };
        }

        const writeOperations = documents.map((document) =>
        {
            const mutatedProfile = OrganizationMemberProfileMutator.buildMutatedProfile(document, mutation);
            return {
                updateOne:
                {
                    filter: { organizationId: organizationId, id: document.id },
                    update:
                    {
                        $set:
                        {
                            tags: mutatedProfile.tags,
                            attributes: mutatedProfile.attributes,
                            attributesNormalised: mutatedProfile.attributesNormalised,
                            attributesComparable: mutatedProfile.attributesComparable
                        }
                    }
                }
            };
        });

        const bulkResult = await collection.bulkWrite(writeOperations, { ordered: false });

        return {
            matchedCount: matchedCount,
            updated: bulkResult.modifiedCount || 0,
            truncated: matchedCount > documents.length
        };
    }

    /**
     * Applies one mutation to a named set of members. The organization scope is
     * part of the filter rather than assumed from the ids, so a payload naming a
     * member of another institute changes nothing rather than reaching them.
     *
     * @param {string} organizationId
     * @param {string[]} memberIds
     * @param {object} mutation
     * @returns {Promise<{ matchedCount: number, updated: number, truncated: boolean }>}
     */
    static async applyMutationToMemberIds(organizationId, memberIds, mutation)
    {
        const safeIds = (Array.isArray(memberIds) ? memberIds : [])
            .filter(memberId => typeof memberId === "string" && memberId.length > 0);

        if (safeIds.length === 0)
        {
            return { matchedCount: 0, updated: 0, truncated: false };
        }

        return await OrganizationMemberQueryEngine.applyMutationToMembersMatching
        (
            organizationId,
            { id: { $in: safeIds } },
            mutation,
            safeIds.length
        );
    }

    /**
     * The membership row for one account in one organization, matched by the
     * back-filled userId OR by email. Both are needed: membership is
     * email-keyed and userId is only filled in at first login, so a member
     * appointed before that would not be found by id alone.
     *
     * Used on the authorization hot path, so it is a single indexed lookup
     * rather than a roster scan — resolving standing must not cost O(members)
     * on every request to an organization.
     *
     * @param {string} organizationId
     * @param {string} userId may be empty
     * @param {string} rawEmail may be empty
     * @returns {Promise<OrganizationMember|null>}
     */
    static async findMemberByUserIdOrEmail(organizationId, userId, rawEmail)
    {
        if (typeof organizationId !== "string" || organizationId.length === 0)
        {
            return null;
        }

        const email = OrganizationMemberQueryEngine.#normaliseEmail(rawEmail);
        const identityConditions = [];

        if (typeof userId === "string" && userId.length > 0)
        {
            identityConditions.push({ userId: userId });
        }
        if (email.length > 0)
        {
            identityConditions.push({ email: email });
        }
        if (identityConditions.length === 0)
        {
            return null;
        }

        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }

        const document = await collection.findOne
        (
            { organizationId: organizationId, $or: identityConditions },
            { projection: { _id: 0 } }
        );

        return document ? OrganizationMember.fromJson(document) : null;
    }

    /**
     * Sets the bitwise delegate powers on one membership row. Only the
     * organization's owner (or a super-admin) may call this — the caller
     * enforces that through OrganizationAuthorityResolver; this is the raw
     * persistence write.
     *
     * @param {string} organizationId
     * @param {string} memberId
     * @param {number} delegatePowers an OrganizationDelegatePowers flag set
     * @returns {Promise<{ updated: boolean }>}
     */
    static async setDelegatePowers(organizationId, memberId, delegatePowers)
    {
        if (!Number.isInteger(delegatePowers) || delegatePowers < 0)
        {
            return { updated: false };
        }

        const collection = await OrganizationMemberQueryEngine.#getCollection();
        if (!collection)
        {
            return { updated: false };
        }

        const updateResult = await collection.updateOne
        (
            { id: memberId, organizationId: organizationId },
            { $set: { delegatePowers: delegatePowers } }
        );

        return { updated: updateResult.matchedCount === 1 };
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
