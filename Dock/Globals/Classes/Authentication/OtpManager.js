const crypto = require("crypto");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const DatabaseConnector = require("../Database/DatabaseConnector");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const EmailSender = require("../Email/EmailSender");
const User = require("../../Model/User");
const { authenticationProviders } = require("../../Enumerations/AuthenticationProviders");

class OtpManager
{
    static OTP_EXPIRY_MINUTES = 10;
    static MAX_ATTEMPTS = 5;
    static RESEND_COOLDOWN_SECONDS = 60;

    static #normaliseEmail(rawEmail)
    {
        if (typeof rawEmail !== "string")
        {
            return "";
        }
        return rawEmail.trim().toLowerCase();
    }

    static #hashCode(plaintextCode)
    {
        return crypto.createHash("sha256").update(plaintextCode).digest("hex");
    }

    static #generateSixDigitCode()
    {
        const randomNumber = crypto.randomInt(0, 1000000);
        return String(randomNumber).padStart(6, "0");
    }

    static async #getOtpCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        return database.collection(DatabaseConstants.OTP_REQUESTS_COLLECTION);
    }

    static async requestOtp(rawEmail)
    {
        const email = OtpManager.#normaliseEmail(rawEmail);
        if (!email)
        {
            return { ok: false, reason: ErrorCodes.INVALID_EMAIL };
        }

        const collection = await OtpManager.#getOtpCollection();
        const now = new Date();

        const existingRequest = await collection.findOne({ email: email });
        if (existingRequest)
        {
            const secondsSinceLastIssue = (now.getTime() - new Date(existingRequest.createdAt).getTime()) / 1000;
            if (secondsSinceLastIssue < OtpManager.RESEND_COOLDOWN_SECONDS)
            {
                const retryAfterSeconds = Math.ceil(OtpManager.RESEND_COOLDOWN_SECONDS - secondsSinceLastIssue);
                return { ok: false, reason: ErrorCodes.RATE_LIMITED, retryAfterSeconds: retryAfterSeconds };
            }
        }

        const sixDigitCode = OtpManager.#generateSixDigitCode();
        const codeHash = OtpManager.#hashCode(sixDigitCode);
        const expirationDate = new Date(now.getTime() + OtpManager.OTP_EXPIRY_MINUTES * 60 * 1000);

        await collection.updateOne
        (
            { email: email },
            {
                $set:
                {
                    email: email,
                    codeHash: codeHash,
                    attempts: 0,
                    createdAt: now,
                    expirationDate: expirationDate
                }
            },
            { upsert: true }
        );

        await EmailSender.sendOtpEmail(email, sixDigitCode);

        const existingUser = await AuthenticationQueryEngine.getUserByEmail(email);

        return {
            ok: true,
            isNewUser: !existingUser,
            retryAfterSeconds: OtpManager.RESEND_COOLDOWN_SECONDS
        };
    }

    static async verifyOtp(rawEmail, submittedCode, rawDisplayName)
    {
        const email = OtpManager.#normaliseEmail(rawEmail);
        if (!email)
        {
            return { ok: false, reason: ErrorCodes.INVALID_EMAIL };
        }

        if (typeof submittedCode !== "string" || !/^\d{6}$/.test(submittedCode))
        {
            return { ok: false, reason: ErrorCodes.INVALID_CODE };
        }

        const collection = await OtpManager.#getOtpCollection();
        const now = new Date();

        const otpDocument = await collection.findOne({ email: email });
        if (!otpDocument)
        {
            return { ok: false, reason: ErrorCodes.EXPIRED };
        }

        if (new Date(otpDocument.expirationDate) <= now)
        {
            await collection.deleteOne({ email: email });
            return { ok: false, reason: ErrorCodes.EXPIRED };
        }

        const incrementResult = await collection.findOneAndUpdate
        (
            { email: email },
            { $inc: { attempts: 1 } },
            { returnDocument: "after" }
        );
        const updatedDocument = incrementResult?.value || incrementResult;
        const currentAttempts = updatedDocument?.attempts ?? (otpDocument.attempts + 1);

        if (currentAttempts > OtpManager.MAX_ATTEMPTS)
        {
            await collection.deleteOne({ email: email });
            return { ok: false, reason: ErrorCodes.TOO_MANY_ATTEMPTS };
        }

        const submittedHash = OtpManager.#hashCode(submittedCode);
        const storedHash = otpDocument.codeHash;

        const submittedBuffer = Buffer.from(submittedHash, "hex");
        const storedBuffer = Buffer.from(storedHash, "hex");
        const hashesMatch = submittedBuffer.length === storedBuffer.length
            && crypto.timingSafeEqual(submittedBuffer, storedBuffer);

        if (!hashesMatch)
        {
            return { ok: false, reason: ErrorCodes.INVALID_CODE, attemptsRemaining: Math.max(0, OtpManager.MAX_ATTEMPTS - currentAttempts) };
        }

        let user = await AuthenticationQueryEngine.getUserByEmail(email);

        if (!user)
        {
            const trimmedDisplayName = typeof rawDisplayName === "string" ? rawDisplayName.trim() : "";
            if (!trimmedDisplayName)
            {
                return { ok: false, reason: ErrorCodes.NAME_REQUIRED };
            }

            user = new User
            ({
                id: email,
                displayName: trimmedDisplayName.slice(0, 256),
                provider: authenticationProviders.EMAIL_OTP,
                joinDate: new Date(),
                preferences: {},
                // The signup credit grant is applied through CreditLedger
                // below so it is admin-configurable and idempotent — kept
                // consistent with the Google login path.
                additionalData:
                {
                    email: email
                }
            });

            await AuthenticationQueryEngine.createUser(user);

            try
            {
                const CreditConfigurationStore = require("../Credits/CreditConfigurationStore");
                const CreditLedger = require("../Credits/CreditLedger");
                const { creditTransactionTypes } = require("../../Enumerations/CreditTransactionTypes");

                const creditConfiguration = await CreditConfigurationStore.load();
                const signupGrantAmount = creditConfiguration.getSignupGrant();
                await CreditLedger.grant(
                    user.getId(),
                    signupGrantAmount,
                    creditTransactionTypes.SIGNUP_GRANT,
                    `signup:${user.getId()}`,
                    {}
                );

                // Welcome the brand-new user with their starter credits. In-app
                // only — they have no push token yet. Best-effort.
                try
                {
                    const NotificationDispatcher = require("../Notifications/NotificationDispatcher");
                    const NotificationContent = require("../Notifications/NotificationContent");
                    await NotificationDispatcher.dispatch(user.getId(), NotificationContent.signupCreditsGranted(signupGrantAmount), NotificationDispatcher.IN_APP_ONLY);
                }
                catch (welcomeNotifyError)
                {
                    console.warn(`[OtpManager] signup welcome notification failed for ${user.getId()}: ${welcomeNotifyError.message}`);
                }
            }
            catch (signupGrantError)
            {
                console.warn(`[OtpManager] signup grant failed for ${user.getId()}: ${signupGrantError.message}`);
            }
        }

        await collection.deleteOne({ email: email });

        return { ok: true, userId: user.getId() };
    }
}

module.exports = OtpManager;
