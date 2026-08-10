const crypto = require("crypto");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const DatabaseConnector = require("../Database/DatabaseConnector");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const EmailSender = require("../Email/EmailSender");
const User = require("../../Model/User");
const { authenticationProviders } = require("../../Enumerations/AuthenticationProviders");
const { otpPurposes } = require("../../Enumerations/OtpPurposes");

/**
 * OtpManager — issues and checks the six-digit codes emailed to an address.
 *
 * Codes are SCOPED BY PURPOSE. A code is issued for exactly one thing — signing
 * in, or confirming the contact address on an intellectual-property complaint —
 * and it is only ever accepted back for that same thing. The document is keyed
 * on (email, purpose), so the two live side by side.
 *
 * That scoping is not tidiness. Before it, the collection held one row per
 * email: a rightsholder confirming a copyright complaint would silently
 * invalidate the sign-in code the same person had just asked for, and — far
 * worse — a code issued for the complaint form would have been accepted by the
 * login endpoint, turning "prove you can read this inbox" into "here is a
 * session". Purpose is therefore compared on the way in AND on the way out.
 *
 * A complaint code never provisions an account. Only the LOGIN purpose runs the
 * signup path below; every other purpose returns a bare confirmation of the
 * address, because a complainant is a correspondent and not a user.
 *
 * Backward compatibility: a stored document written before purposes existed has
 * no `purpose` field and reads as LOGIN, so codes in flight across a deploy
 * still verify.
 */
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

    /**
     * Coerces a caller-supplied purpose to a known enum value, defaulting to
     * LOGIN. The default is what makes an un-migrated stored document — and any
     * caller that predates this parameter — behave exactly as it used to.
     *
     * @param {number} rawPurpose
     * @returns {number}
     */
    static #normalisePurpose(rawPurpose)
    {
        const parsedPurpose = Number(rawPurpose);

        if (!Number.isInteger(parsedPurpose))
        {
            return otpPurposes.LOGIN;
        }

        return Object.values(otpPurposes).includes(parsedPurpose) ? parsedPurpose : otpPurposes.LOGIN;
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

    /**
     * The filter that selects one email's code for one purpose.
     *
     * LOGIN also matches documents with no purpose at all — those are rows
     * written before this field existed, and they were all login codes. Every
     * other purpose matches its own value exactly, so a legacy row can never be
     * mistaken for a complaint confirmation.
     *
     * @param {string} email
     * @param {number} purpose
     * @returns {object}
     */
    static #buildOtpFilter(email, purpose)
    {
        if (purpose === otpPurposes.LOGIN)
        {
            return { email: email, purpose: { $in: [otpPurposes.LOGIN, null] } };
        }

        return { email: email, purpose: purpose };
    }

    /**
     * Issues a code for one email and one purpose, and emails it.
     *
     * The cooldown is per (email, purpose): asking to confirm a copyright
     * complaint must not tell a user their sign-in code is rate limited, and
     * vice versa.
     *
     * @param {string} rawEmail
     * @param {number} purpose an otpPurposes value; defaults to LOGIN
     * @returns {Promise<{ok: boolean, reason?: string, isNewUser?: boolean, retryAfterSeconds?: number}>}
     */
    static async requestOtp(rawEmail, purpose = otpPurposes.LOGIN)
    {
        const email = OtpManager.#normaliseEmail(rawEmail);
        if (!email)
        {
            return { ok: false, reason: ErrorCodes.INVALID_EMAIL };
        }

        const effectivePurpose = OtpManager.#normalisePurpose(purpose);
        const collection = await OtpManager.#getOtpCollection();
        const now = new Date();
        const otpFilter = OtpManager.#buildOtpFilter(email, effectivePurpose);

        const existingRequest = await collection.findOne(otpFilter);
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

        // The upsert is keyed on the exact (email, purpose) pair rather than on
        // the read filter above: the legacy-null branch of that filter must not
        // become the $setOnInsert shape, or a fresh login row would be written
        // with purpose null forever.
        await collection.updateOne
        (
            { email: email, purpose: effectivePurpose },
            {
                $set:
                {
                    email: email,
                    purpose: effectivePurpose,
                    codeHash: codeHash,
                    attempts: 0,
                    createdAt: now,
                    expirationDate: expirationDate
                }
            },
            { upsert: true }
        );

        // A legacy row for this email (purpose absent) would otherwise sit
        // alongside the new one and be found first by the LOGIN filter, pinning
        // the user to a code that has just been superseded.
        if (effectivePurpose === otpPurposes.LOGIN)
        {
            await collection.deleteMany({ email: email, purpose: { $exists: false } });
        }

        await OtpManager.#deliverCode(email, sixDigitCode, effectivePurpose);

        // Only meaningful for a login: it drives the "tell us your name" step of
        // the sign-in dialog. A complaint confirmation deliberately does not
        // disclose whether the address belongs to an account.
        if (effectivePurpose !== otpPurposes.LOGIN)
        {
            return { ok: true, retryAfterSeconds: OtpManager.RESEND_COOLDOWN_SECONDS };
        }

        const existingUser = await AuthenticationQueryEngine.getUserByEmail(email);

        return {
            ok: true,
            isNewUser: !existingUser,
            retryAfterSeconds: OtpManager.RESEND_COOLDOWN_SECONDS
        };
    }

    /**
     * Sends the code with the wording that matches what it is for. Kept here
     * rather than at the call sites so a new purpose cannot ship without
     * deciding what the recipient is told they are confirming.
     *
     * @param {string} email
     * @param {string} sixDigitCode
     * @param {number} purpose
     * @returns {Promise<void>}
     */
    static async #deliverCode(email, sixDigitCode, purpose)
    {
        if (purpose === otpPurposes.INTELLECTUAL_PROPERTY_COMPLAINT_VERIFICATION)
        {
            await EmailSender.sendIntellectualPropertyComplaintCodeEmail(email, sixDigitCode);
            return;
        }

        await EmailSender.sendOtpEmail(email, sixDigitCode);
    }

    /**
     * Checks a submitted code against the one issued for the same email AND the
     * same purpose.
     *
     * For LOGIN this also provisions the account on first sign-in. For every
     * other purpose it does not: it answers only "yes, whoever submitted this
     * can read that inbox", which is the entire question a complaint form is
     * asking.
     *
     * @param {string} rawEmail
     * @param {string} submittedCode
     * @param {number} purpose an otpPurposes value; defaults to LOGIN
     * @param {string} rawDisplayName only read on the LOGIN signup path
     * @returns {Promise<{ok: boolean, reason?: string, userId?: string, attemptsRemaining?: number}>}
     */
    static async verifyOtp(rawEmail, submittedCode, purpose = otpPurposes.LOGIN, rawDisplayName = "")
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

        const effectivePurpose = OtpManager.#normalisePurpose(purpose);
        const collection = await OtpManager.#getOtpCollection();
        const now = new Date();
        const otpFilter = OtpManager.#buildOtpFilter(email, effectivePurpose);

        const otpDocument = await collection.findOne(otpFilter);
        if (!otpDocument)
        {
            return { ok: false, reason: ErrorCodes.EXPIRED };
        }

        if (new Date(otpDocument.expirationDate) <= now)
        {
            await collection.deleteOne(otpFilter);
            return { ok: false, reason: ErrorCodes.EXPIRED };
        }

        const incrementResult = await collection.findOneAndUpdate
        (
            otpFilter,
            { $inc: { attempts: 1 } },
            { returnDocument: "after" }
        );
        const updatedDocument = incrementResult?.value || incrementResult;
        const currentAttempts = updatedDocument?.attempts ?? (otpDocument.attempts + 1);

        if (currentAttempts > OtpManager.MAX_ATTEMPTS)
        {
            await collection.deleteOne(otpFilter);
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

        // Everything below is the sign-in path. A non-login purpose stops here
        // deliberately: confirming a copyright complaint must never create an
        // account for the complainant, who did not ask for one and is not a user.
        if (effectivePurpose !== otpPurposes.LOGIN)
        {
            await collection.deleteOne(otpFilter);
            return { ok: true, email: email };
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

        await collection.deleteOne(otpFilter);

        return { ok: true, userId: user.getId() };
    }
}

module.exports = OtpManager;
