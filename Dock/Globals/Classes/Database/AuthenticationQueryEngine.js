const crypto = require("crypto");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const LicenseConstants = require("../../Constants/LicenseConstants");
const User = require("../../Model/User");
const UserSession = require("../../Model/UserSession");
const Device = require("../../Model/Device");
const DatabaseConnector = require("./DatabaseConnector");
const DeviceLimitReachedError = require("./DeviceLimitReachedError");

class AuthenticationQueryEngine
{
    static async createUser(user)
    {
        await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION)
            .updateOne({ id: user.getId() }, { $set: user.toJson() }, { upsert: true });
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
        if (typeof email !== "string" || email.length === 0)
        {
            return null;
        }

        const normalisedEmail = email.trim().toLowerCase();
        if (normalisedEmail.length === 0)
        {
            return null;
        }

        // Case-insensitive match — existing Google-flow users may have
        // stored their email with whatever casing Google returned (the
        // OAuth payload is not guaranteed lowercase), while OTP-flow
        // users are always lowercased on write. Anchor + escape to
        // prevent any regex injection from the caller's input.
        const escapedEmail = normalisedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const emailRegex = new RegExp(`^${escapedEmail}$`, "i");

        const userJson = await (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION)
            .findOne({ "additionalData.email": emailRegex });
        return userJson ? User.fromJson(userJson) : null;
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

        return session;
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
        if (activeDeviceCount >= LicenseConstants.MAX_DEVICES_PER_USER)
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
            return { success: false, reason: "INVALID_REQUEST" };
        }

        const device = await AuthenticationQueryEngine.getDeviceById(targetDeviceId);

        if (!device || device.getUserId() !== userId)
        {
            return { success: false, reason: "NOT_FOUND" };
        }

        const isSelf = targetDeviceId === requesterDeviceId;
        const offlineCutoff = new Date(Date.now() - LicenseConstants.OFFLINE_GRACE_DAYS_FOR_DEVICE_SIGNOUT * 24 * 60 * 60 * 1000);
        const isOfflineLongEnough = device.getLastSeenDate() < offlineCutoff;

        if (!isSelf && !isOfflineLongEnough)
        {
            return { success: false, reason: "DEVICE_STILL_ACTIVE" };
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
