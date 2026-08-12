const crypto = require("crypto");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const LicenseConstants = require("../../Constants/LicenseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const User = require("../../Model/User");
const UserSession = require("../../Model/UserSession");
const Device = require("../../Model/Device");
const DatabaseConnector = require("./DatabaseConnector");
const DeviceLimitReachedError = require("./DeviceLimitReachedError");
const PlanMetadata = require("../Plans/PlanMetadata");
const PlanTierResolver = require("../Plans/PlanTierResolver");

class AuthenticationQueryEngine
{
    /**
     * The concurrent-session cap for a user, from their plan tier. Falls back
     * to UserSession.MAX_ACTIVE_SESSIONS_PER_USER when the tier cannot be
     * resolved, so a lookup hiccup never evicts more aggressively than the base.
     * @param {string} userId
     * @returns {Promise<number>}
     */
    static async #getMaxSessionsForUser(userId)
    {
        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (user)
        {
            return PlanMetadata.getMaxSessions(PlanTierResolver.getEffectiveTier(user));
        }
        return UserSession.MAX_ACTIVE_SESSIONS_PER_USER;
    }

    /**
     * The device cap for a user, from their plan tier. Falls back to
     * LicenseConstants.MAX_DEVICES_PER_USER when the tier cannot be resolved.
     * @param {string} userId
     * @returns {Promise<number>}
     */
    static async #getMaxDevicesForUser(userId)
    {
        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (user)
        {
            return PlanMetadata.getMaxDevices(PlanTierResolver.getEffectiveTier(user));
        }
        return LicenseConstants.MAX_DEVICES_PER_USER;
    }

    static async createUser(user)
    {
        const userJson = user.toJson();

        // Every login path funnels through here for both new and existing
        // users, so deriving normalizedEmail here — rather than at each of
        // Google/OTP's call sites — is what keeps it in sync automatically.
        // Written alongside additionalData.email rather than as its own
        // top-level field, since additionalData is what toJson()/$set
        // already carries wholesale.
        const rawEmail = userJson.additionalData?.email;
        if (typeof rawEmail === "string" && rawEmail.trim().length > 0)
        {
            userJson.additionalData.normalizedEmail = rawEmail.trim().toLowerCase();
        }

        await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION)
            .updateOne({ id: user.getId() }, { $set: userJson }, { upsert: true });
    }

    static async getUserById(id)
    {
        const query = { id: id };
        const userJson = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION)
            .findOne(query);
        return userJson ? User.fromJson(userJson) : null;
    }

    static async getUserByEmail(email)
    {
        const matchingUsers = await AuthenticationQueryEngine.getUsersByEmail(email);
        return matchingUsers.length > 0 ? matchingUsers[0] : null;
    }

    /**
     * Returns every user document whose additionalData.email matches,
     * case-insensitively — plural because more than one can legitimately
     * exist: a Google-provider row and an Email+OTP-provider row created
     * independently for the same person before either login path
     * cross-checked the other's identity space. getUserByEmail's single
     * result would silently hide that a second match exists; callers that
     * need to detect (and resolve) a split identity must use this instead.
     * @param {string} email
     * @returns {Promise<User[]>}
     */
    static async getUsersByEmail(email)
    {
        if (typeof email !== "string" || email.length === 0)
        {
            return [];
        }

        const normalisedEmail = email.trim().toLowerCase();
        if (normalisedEmail.length === 0)
        {
            return [];
        }

        // Matches on the fast, exact normalizedEmail field wherever it has
        // already been backfilled (createUser writes it on every login —
        // new or returning), and falls back to the legacy case-insensitive
        // regex on additionalData.email for any account that has not
        // logged in since normalizedEmail was introduced, so this stays
        // complete through the transition rather than silently missing
        // not-yet-backfilled rows. Anchor + escape the regex branch to
        // prevent regex injection from the caller's input.
        const escapedEmail = normalisedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const emailRegex = new RegExp(`^${escapedEmail}$`, "i");

        const userDocuments = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION)
            .find({ $or: [{ "additionalData.normalizedEmail": normalisedEmail }, { "additionalData.email": emailRegex }] })
            .toArray();

        return userDocuments.map((userDocument) => User.fromJson(userDocument));
    }

    static async updateUserAdditionalData(userId, partialAdditionalData)
    {
        if (!userId || !partialAdditionalData || typeof partialAdditionalData !== "object")
        {
            return null;
        }

        const setOperations = {};

        for (const fieldKey of Object.keys(partialAdditionalData))
        {
            setOperations[`additionalData.${fieldKey}`] = partialAdditionalData[fieldKey];
        }

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION);

        const result = await collection.findOneAndUpdate
        (
            { id: userId },
            { $set: setOperations },
            { returnDocument: "after" }
        );

        const updatedDocument = result?.value || result;

        if (!updatedDocument)
        {
            return null;
        }

        return updatedDocument.additionalData || null;
    }

    static async getSession(sessionId)
    {
        const query = { id: sessionId };

        const session = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.SESSIONS_COLLECTION)
            .findOne(query);

        return session ? UserSession.fromJson(session) : null;
    }

    static async createSession(userId, provider, deviceId)
    {
        const sessionId = crypto.randomUUID();
        const now = new Date();

        const session = new UserSession
        (
            sessionId,
            userId,
            provider,
            deviceId || "",
            now,
            now,
            new Date(now.getTime() + UserSession.getExpirationTime())
        );

        await AuthenticationQueryEngine.refreshSession(session);
        await AuthenticationQueryEngine.#enforceSessionLimit(userId);

        return session;
    }

    /**
     * Caps a user at UserSession.MAX_ACTIVE_SESSIONS_PER_USER concurrent
     * sessions. Called right after a freshly-minted session is persisted:
     * the new session always sorts first (its lastRefreshDate is "now"), so
     * keeping the N most-recently-refreshed rows and deleting the rest
     * evicts the oldest / least-recently-active sessions when the user signs
     * in on an (N+1)th surface. Both login paths funnel through
     * createSession, so this is the single chokepoint for the policy.
     *
     * @param {string} userId
     */
    static async #enforceSessionLimit(userId)
    {
        if (!userId)
        {
            return;
        }

        const maximumActiveSessions = await AuthenticationQueryEngine.#getMaxSessionsForUser(userId);

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.SESSIONS_COLLECTION);

        const sessions = await collection
            .find({ userId: userId })
            .sort({ lastRefreshDate: -1 })
            .toArray();

        if (sessions.length <= maximumActiveSessions)
        {
            return;
        }

        const sessionIdsToEvict = sessions
            .slice(maximumActiveSessions)
            .map(sessionDocument => sessionDocument.id);

        if (sessionIdsToEvict.length > 0)
        {
            await collection.deleteMany({ id: { $in: sessionIdsToEvict } });
        }
    }

    static async deleteSession(sessionId)
    {
        await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.SESSIONS_COLLECTION)
            .deleteOne({ id: sessionId });
    }

    static async deleteAllSessions()
    {
        const result = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.SESSIONS_COLLECTION)
            .deleteMany({});
        return result.deletedCount || 0;
    }

    static async refreshSession(session)
    {
        session.refresh();
        await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.SESSIONS_COLLECTION)
            .updateOne({ id: session.getId() }, { $set: session.toJson() }, { upsert: true });
    }

    // ── Device management ─────────────────────────────────────────────────

    /**
     * Resolves an incoming device registration to a Device row, with
     * three lookup strategies tried in priority order:
     *
     *   1. (userId, fingerprintHash) — the new physical-device key.
     *      Multiple browsers on the same machine produce the same
     *      hash and merge onto the same row, so the 4-device limit
     *      counts physical devices, not browsers.
     *
     *   2. (userId, id == legacyDeviceId) — migration fallback for
     *      pre-existing Device rows created before fingerprintHash
     *      existed. On first hit we backfill fingerprintHash onto
     *      that row so subsequent logins from other browsers on the
     *      same machine consolidate via strategy 1.
     *
     *   3. Create a brand-new row, after enforcing MAX_DEVICES_PER_USER
     *      against active devices (those seen within the offline grace
     *      window). Throws DeviceLimitReachedError when full so the
     *      endpoint handler can respond 409 with the current device
     *      list.
     *
     * @param {string} userId
     * @param {{
     *   fingerprintHash?: string,
     *   legacyDeviceId?: string,
     *   deviceName?: string,
     *   platform?: number,
     *   userAgent?: string,
     *   publicKeyFingerprint?: string
     * }} registrationPayload
     * @returns {Promise<Device>}
     * @throws {DeviceLimitReachedError}
     */
    static async resolveOrCreateDevice(userId, registrationPayload)
    {
        if (!userId)
        {
            return null;
        }

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.DEVICES_COLLECTION);

        const fingerprintHash = (registrationPayload && registrationPayload.fingerprintHash) || "";
        const legacyDeviceId = (registrationPayload && registrationPayload.legacyDeviceId) || "";

        if (fingerprintHash.length > 0)
        {
            const existingByFingerprint = await collection.findOne({ userId: userId, fingerprintHash: fingerprintHash });
            if (existingByFingerprint)
            {
                return await AuthenticationQueryEngine.#refreshDeviceFromPayload(collection, existingByFingerprint, registrationPayload);
            }
        }

        if (legacyDeviceId.length > 0)
        {
            const existingByLegacyId = await collection.findOne({ userId: userId, id: legacyDeviceId });
            if (existingByLegacyId)
            {
                return await AuthenticationQueryEngine.#refreshDeviceFromPayload(collection, existingByLegacyId, registrationPayload);
            }
        }

        const activeDeviceCount = await AuthenticationQueryEngine.countActiveDevices
        (
            userId,
            LicenseConstants.OFFLINE_GRACE_DAYS_FOR_DEVICE_SIGNOUT
        );
        // Per-plan device cap. Only NEW device creation is gated here; existing
        // devices refresh above without a count check, so a downgrade that
        // lowers the cap never locks a user out of devices they already use.
        const maximumDevices = await AuthenticationQueryEngine.#getMaxDevicesForUser(userId);
        if (activeDeviceCount >= maximumDevices)
        {
            const currentDevices = await AuthenticationQueryEngine.listUserDevices(userId);
            throw new DeviceLimitReachedError(currentDevices.map((device) => device.toJson()));
        }

        return await AuthenticationQueryEngine.#createDeviceFromPayload(collection, userId, registrationPayload);
    }

    /**
     * Updates an existing Device row from a fresh registration
     * payload — bumps lastSeenDate and overwrites mutable metadata
     * (deviceName, userAgent, platform, publicKeyFingerprint,
     * fingerprintHash) only when the payload supplied a value. Empty
     * payload fields are ignored so partial registrations can't blank
     * out previously-stored values.
     */
    static async #refreshDeviceFromPayload(collection, existingDocument, registrationPayload)
    {
        const device = Device.fromJson(existingDocument);
        device.setLastSeenDate(new Date());

        if (registrationPayload.deviceName)
        {
            device.setDeviceName(registrationPayload.deviceName);
        }
        if (registrationPayload.userAgent)
        {
            device.setUserAgent(registrationPayload.userAgent);
        }
        if (typeof registrationPayload.platform === "number")
        {
            device.setPlatform(registrationPayload.platform);
        }
        if (registrationPayload.publicKeyFingerprint)
        {
            device.setPublicKeyFingerprint(registrationPayload.publicKeyFingerprint);
        }
        if (registrationPayload.fingerprintHash)
        {
            device.setFingerprintHash(registrationPayload.fingerprintHash);
        }

        await collection.updateOne
        (
            { id: device.getId() },
            { $set: device.toJson() },
            { upsert: true }
        );

        return device;
    }

    /**
     * Creates a fresh Device row. The id is server-assigned (UUID
     * minted by the Device constructor) — the client-side
     * fingerprintHash is the lookup key, not the PK.
     */
    static async #createDeviceFromPayload(collection, userId, registrationPayload)
    {
        const now = new Date();
        const device = new Device
        ({
            userId: userId,
            deviceName: registrationPayload.deviceName || "Unknown Device",
            platform: registrationPayload.platform || 0,
            userAgent: registrationPayload.userAgent || "",
            createdAt: now,
            lastSeenDate: now,
            lastSyncDate: now,
            publicKeyFingerprint: registrationPayload.publicKeyFingerprint || "",
            fingerprintHash: registrationPayload.fingerprintHash || "",
            additionalData: {}
        });

        await collection.updateOne
        (
            { id: device.getId() },
            { $set: device.toJson() },
            { upsert: true }
        );

        // A genuinely first-seen device — the one clean "new sign-in" signal.
        // This belongs HERE and not in #refreshDeviceFromPayload: that method is
        // the returning-device path, so firing from there would alert on every
        // login from an already-known device (and it has no userId in scope,
        // which is what made /Auth/Devices/Register throw a ReferenceError).
        // Security notice: in-app + push. Lazy-required so this boot-critical
        // module never pulls the notification stack at load; best-effort.
        try
        {
            const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
            const NotificationContent = require("../Notifications/NotificationContent");
            const { notificationChannels } = require("../../Enumerations/NotificationChannels");
            await NotificationDispatcher.dispatch(userId, NotificationContent.newDeviceSignIn(device.getDeviceName()), notificationChannels.IN_APP | notificationChannels.PUSH);
        }
        catch (notifyError)
        {
            // Log the DEVICE id, never a value that may not be bound. A
            // best-effort notice must not be able to fail device registration —
            // and an error handler that can itself throw defeats the try/catch
            // that was meant to guarantee exactly that.
            console.warn(`[AuthenticationQueryEngine] Failed to dispatch new-device notification for device ${device.getId()}: ${notifyError.message}`);
        }

        return device;
    }

    /**
     * Legacy entry point — preserved so callers that still pass a
     * `{ id, ... }` shape (heartbeat refresh, list-by-id paths) keep
     * working. New code should call resolveOrCreateDevice directly.
     */
    static async createOrUpdateDevice(userId, deviceFingerprint)
    {
        if (!userId)
        {
            return null;
        }

        return await AuthenticationQueryEngine.resolveOrCreateDevice(userId,
        {
            fingerprintHash: deviceFingerprint?.fingerprintHash || "",
            legacyDeviceId: deviceFingerprint?.id || "",
            deviceName: deviceFingerprint?.deviceName || "",
            platform: deviceFingerprint?.platform,
            userAgent: deviceFingerprint?.userAgent || "",
            publicKeyFingerprint: deviceFingerprint?.publicKeyFingerprint || ""
        });
    }

    static async getDeviceById(deviceId)
    {
        if (!deviceId)
        {
            return null;
        }

        const document = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.DEVICES_COLLECTION)
            .findOne({ id: deviceId });

        return document ? Device.fromJson(document) : null;
    }

    static async listUserDevices(userId)
    {
        if (!userId)
        {
            return [];
        }

        const documents = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.DEVICES_COLLECTION)
            .find({ userId: userId })
            .sort({ lastSeenDate: -1 })
            .toArray();

        return documents.map(document => Device.fromJson(document));
    }

    static async countActiveDevices(userId, gracePeriodDays)
    {
        if (!userId)
        {
            return 0;
        }

        const cutoffDate = new Date(Date.now() - gracePeriodDays * 24 * 60 * 60 * 1000);

        return await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.DEVICES_COLLECTION)
            .countDocuments({ userId: userId, lastSeenDate: { $gte: cutoffDate } });
    }

    static async refreshDeviceHeartbeat(deviceId)
    {
        if (!deviceId)
        {
            return;
        }

        await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.DEVICES_COLLECTION)
            .updateOne({ id: deviceId }, { $set: { lastSeenDate: new Date() } });
    }

    static async signOutDevice(userId, targetDeviceId, requesterDeviceId)
    {
        if (!userId || !targetDeviceId)
        {
            return { success: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        const device = await AuthenticationQueryEngine.getDeviceById(targetDeviceId);

        if (!device || device.getUserId() !== userId)
        {
            return { success: false, reason: ErrorCodes.NOT_FOUND };
        }

        const isSelf = targetDeviceId === requesterDeviceId;
        const offlineCutoff = new Date(Date.now() - LicenseConstants.OFFLINE_GRACE_DAYS_FOR_DEVICE_SIGNOUT * 24 * 60 * 60 * 1000);
        const isOfflineLongEnough = device.getLastSeenDate() < offlineCutoff;

        if (!isSelf && !isOfflineLongEnough)
        {
            return { success: false, reason: ErrorCodes.DEVICE_STILL_ACTIVE };
        }

        const database = await DatabaseConnector.getDatabase();
        await database
            .collection(DatabaseConstants.SESSIONS_COLLECTION)
            .deleteMany({ userId: userId, deviceId: targetDeviceId });

        await database
            .collection(DatabaseConstants.DEVICES_COLLECTION)
            .deleteOne({ id: targetDeviceId, userId: userId });

        return { success: true };
    }
}

module.exports = AuthenticationQueryEngine;
