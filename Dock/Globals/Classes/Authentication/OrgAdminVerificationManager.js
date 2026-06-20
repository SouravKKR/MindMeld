const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const EmailSender = require("../Email/EmailSender");


/**
 * OrgAdminVerificationManager
 *
 * Parallels [OtpManager.js] but is scoped to one-shot organization-
 * admin email verification. Critical differences from OtpManager:
 *
 *   1. Does NOT create a User row on verification success — the
 *      appointed admin doesn't need an account yet; their first
 *      Google / email-OTP login will create the account normally
 *      and the UserRoleReconciliator will promote them to ORG_ADMIN
 *      at that time.
 *   2. Does NOT create a session — the super-admin is the one logged
 *      in during this flow, not the appointed admin.
 *   3. Returns a one-time verificationToken on success that the
 *      super-admin's frontend then submits to /Admin/Organizations/Create.
 *      The token is consumed when the org transitions to ACTIVE
 *      (either immediately for free orgs OR after Razorpay webhook/
 *      verify for paid orgs).
 *
 * Single row per email at any time (unique index). The TTL on
 * expirationDate purges stale rows automatically — no manual cleanup.
 */
class OrgAdminVerificationManager
{
    static EXPIRY_MINUTES = 60;
    static MAX_ATTEMPTS = 5;
    static RESEND_COOLDOWN_SECONDS = 60;
    static CODE_PHASE_EXPIRY_MINUTES = 10;

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

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(DatabaseConstants.ORG_ADMIN_VERIFICATIONS_COLLECTION);
    }

    static async requestVerification(rawEmail, organizationName)
    {
        const email = OrgAdminVerificationManager.#normaliseEmail(rawEmail);
        if (email.length === 0 || email.indexOf("@") < 0)
        {
            return { ok: false, reason: ErrorCodes.INVALID_EMAIL };
        }

        const collection = await OrgAdminVerificationManager.#getCollection();
        if (!collection)
        {
            return { ok: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const now = new Date();

        const existingRow = await collection.findOne({ email: email });
        if (existingRow && existingRow.createdAt)
        {
            const secondsSinceLastIssue = (now.getTime() - new Date(existingRow.createdAt).getTime()) / 1000;
            if (secondsSinceLastIssue < OrgAdminVerificationManager.RESEND_COOLDOWN_SECONDS)
            {
                const retryAfterSeconds = Math.ceil(OrgAdminVerificationManager.RESEND_COOLDOWN_SECONDS - secondsSinceLastIssue);
                return { ok: false, reason: ErrorCodes.RATE_LIMITED, retryAfterSeconds: retryAfterSeconds };
            }
        }

        const sixDigitCode = OrgAdminVerificationManager.#generateSixDigitCode();
        const codeHash = OrgAdminVerificationManager.#hashCode(sixDigitCode);
        const expirationDate = new Date(now.getTime() + OrgAdminVerificationManager.CODE_PHASE_EXPIRY_MINUTES * 60 * 1000);

        await collection.updateOne
        (
            { email: email },
            {
                $set:
                {
                    email: email,
                    codeHash: codeHash,
                    attempts: 0,
                    verificationToken: "",
                    createdAt: now,
                    expirationDate: expirationDate
                },
                $setOnInsert:
                {
                    id: crypto.randomUUID()
                }
            },
            { upsert: true }
        );

        await EmailSender.sendOrgAdminVerificationEmail(email, sixDigitCode, organizationName || "");

        return { ok: true, retryAfterSeconds: OrgAdminVerificationManager.RESEND_COOLDOWN_SECONDS };
    }

    /**
     * Verifies the 6-digit code and issues an opaque, single-use token
     * the super-admin's Create flow will quote back. The token's
     * lifetime is EXPIRY_MINUTES from the moment it is issued (which
     * extends past the code-phase expiry so the super-admin has time
     * to fill out the rest of the creation form + payment).
     */
    static async verifyAndIssueToken(rawEmail, submittedCode)
    {
        const email = OrgAdminVerificationManager.#normaliseEmail(rawEmail);
        if (email.length === 0)
        {
            return { ok: false, reason: ErrorCodes.INVALID_EMAIL };
        }
        if (typeof submittedCode !== "string" || !/^\d{6}$/.test(submittedCode))
        {
            return { ok: false, reason: ErrorCodes.INVALID_CODE };
        }

        const collection = await OrgAdminVerificationManager.#getCollection();
        if (!collection)
        {
            return { ok: false, reason: ErrorCodes.DATABASE_UNAVAILABLE };
        }

        const now = new Date();

        const row = await collection.findOne({ email: email });
        if (!row || !row.codeHash || row.codeHash.length === 0)
        {
            return { ok: false, reason: ErrorCodes.EXPIRED };
        }
        if (new Date(row.expirationDate) <= now)
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
        const currentAttempts = updatedDocument?.attempts ?? ((row.attempts || 0) + 1);

        if (currentAttempts > OrgAdminVerificationManager.MAX_ATTEMPTS)
        {
            await collection.deleteOne({ email: email });
            return { ok: false, reason: ErrorCodes.TOO_MANY_ATTEMPTS };
        }

        const submittedHash = OrgAdminVerificationManager.#hashCode(submittedCode);
        const storedHash = row.codeHash;
        const submittedBuffer = Buffer.from(submittedHash, "hex");
        const storedBuffer = Buffer.from(storedHash, "hex");
        const hashesMatch = submittedBuffer.length === storedBuffer.length
            && crypto.timingSafeEqual(submittedBuffer, storedBuffer);

        if (!hashesMatch)
        {
            return { ok: false, reason: ErrorCodes.INVALID_CODE, attemptsRemaining: Math.max(0, OrgAdminVerificationManager.MAX_ATTEMPTS - currentAttempts) };
        }

        // Code phase passes. Issue a verification token, blank the code
        // hash so it can't be reused, and extend the expiry to give the
        // super-admin time to finish creating the org. Old rows whose
        // expirationDate was set during the code phase get bumped here.
        const verificationToken = crypto.randomUUID();
        const newExpiry = new Date(now.getTime() + OrgAdminVerificationManager.EXPIRY_MINUTES * 60 * 1000);

        await collection.updateOne
        (
            { email: email },
            {
                $set:
                {
                    codeHash: "",
                    attempts: 0,
                    verificationToken: verificationToken,
                    expirationDate: newExpiry
                }
            }
        );

        return { ok: true, verificationToken: verificationToken };
    }

    /**
     * One-shot consumption: returns true iff the supplied token matches
     * an unexpired row for the supplied email, and DELETES the row in
     * the same operation so the token can't be reused.
     */
    static async consumeToken(rawEmail, verificationToken)
    {
        const email = OrgAdminVerificationManager.#normaliseEmail(rawEmail);
        if (email.length === 0 || typeof verificationToken !== "string" || verificationToken.length === 0)
        {
            return false;
        }

        const collection = await OrgAdminVerificationManager.#getCollection();
        if (!collection)
        {
            return false;
        }

        const now = new Date();
        const deleteResult = await collection.findOneAndDelete
        ({
            email: email,
            verificationToken: verificationToken,
            expirationDate: { $gt: now }
        });
        return Boolean(deleteResult && (deleteResult.value || deleteResult.email));
    }

    /**
     * Non-destructive check used by /Admin/Organizations/Create to
     * accept a verification token without consuming it (consumption
     * happens at activation time — either immediately for amount=0 or
     * at VerifyCreationPayment / webhook for paid orgs).
     */
    static async isTokenValid(rawEmail, verificationToken)
    {
        const email = OrgAdminVerificationManager.#normaliseEmail(rawEmail);
        if (email.length === 0 || typeof verificationToken !== "string" || verificationToken.length === 0)
        {
            return false;
        }

        const collection = await OrgAdminVerificationManager.#getCollection();
        if (!collection)
        {
            return false;
        }

        const now = new Date();
        const row = await collection.findOne
        ({
            email: email,
            verificationToken: verificationToken,
            expirationDate: { $gt: now }
        });
        return row !== null && row !== undefined;
    }
}

module.exports = OrgAdminVerificationManager;
