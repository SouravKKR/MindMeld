const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const Alerts = require("../Alerts/Alerts");

/**
 * ScriptIntegrityMonitor
 *
 * Detects that a script which is allowed to run on a payment page has CHANGED,
 * and tells a human. [PCI DSS 11.6.1 / handbook controls 29 and 113]
 *
 * ── Why this is not just Subresource Integrity ────────────────────────────
 *
 * SRI answers "is this file the one I pinned?" at load time, and it is the
 * wrong tool for both halves of this application's script surface:
 *
 *   First-party bundles are SAME-ORIGIN. An attacker who can rewrite
 *   Bundle.part-XXXX.js can rewrite the <script integrity="..."> attribute
 *   that points at it in the very same write, so the hash proves nothing. What
 *   does prove something is a hash recorded at BUILD time, on a different
 *   machine, and checked at RUN time — which is what
 *   Common/Scripts/GenerateScriptIntegrityManifest.js produces and this class
 *   verifies.
 *
 *   The Razorpay checkout script CANNOT be pinned. Razorpay ships fixes to
 *   checkout.js continuously; an integrity attribute would break every payment
 *   in the product the moment they did, which is a far larger outage than the
 *   risk it mitigates. See Common/ReadmeFiles/PaymentPageScriptInventory.md,
 *   which records that decision.
 *
 * So the control this class implements is DETECTION, not blocking. That is what
 * 11.6.1 actually asks for — "changes are detected and personnel are alerted" —
 * and it is the only formulation that survives a dependency the vendor mutates
 * deliberately.
 *
 * ── What each half means when it fires ────────────────────────────────────
 *
 *   A first-party mismatch is an INCIDENT. Nothing legitimate rewrites
 *   Dock/Static after a build: the deploy replaces the tree wholesale and the
 *   manifest ships with it. A file that differs from the manifest, has
 *   vanished, or has APPEARED (a dropped webshell looks exactly like an extra
 *   .js) means someone wrote to the origin. Raised as an ERROR.
 *
 *   A third-party change is EXPECTED and still worth seeing. Razorpay
 *   legitimately publishes a new checkout.js; the value of the alert is that
 *   when something else goes wrong, an operator can see whether the payment
 *   script changed that day. Raised as a WARNING so it never drowns the
 *   first-party signal, and the first observation of a script is recorded
 *   silently rather than alerted — a baseline is not a change.
 *
 * Both land in the same admin Alerts tab as the CSP violation reports, so the
 * two halves of the tamper story (unexpected origin, changed script) reach a
 * person the same way.
 */
class ScriptIntegrityMonitor
{
    // Daily. The threat is an attacker who has written to the origin and is
    // harvesting; the window that matters is "before the next settlement", not
    // minutes, and re-hashing the whole served tree is not free.
    static CHECK_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;

    // Waited out before the boot check, so a deploy that is still unpacking is
    // not read as tampering.
    static BOOT_DELAY_MILLISECONDS = 60 * 1000;

    static HASH_ALGORITHM = "sha384";

    static ALERT_SOURCE = "SCRIPT_INTEGRITY";

    static REMOTE_FETCH_TIMEOUT_MILLISECONDS = 15 * 1000;

    // How many changed paths are named in an alert before it is truncated. A
    // tampering event that rewrote the whole bundle would otherwise produce an
    // alert message nobody can read; the count is always exact regardless.
    static MAXIMUM_REPORTED_PATHS = 10;

    // Every remote script that is allowed to execute on a document where a
    // payment can be taken. Keep in step with the "Authorised scripts → Remote"
    // table in Common/ReadmeFiles/PaymentPageScriptInventory.md — an entry there
    // with no entry here is a script nobody is watching.
    static MONITORED_REMOTE_SCRIPTS =
    [
        {
            name: "Razorpay Standard Checkout",
            url: "https://checkout.razorpay.com/v1/checkout.js"
        }
    ];

    static #intervalHandle = null;
    static #bootTimeoutHandle = null;

    static isDisabled()
    {
        return String(process.env.SCRIPT_INTEGRITY_MONITORING_DISABLED || "").toLowerCase() === "true";
    }

    static #getManifestFilePath()
    {
        return path.join(__dirname, "..", "..", "..", "ScriptIntegrityManifest.json");
    }

    static #getStaticDirectory()
    {
        return path.join(__dirname, "..", "..", "..", "Static");
    }

    static hashFileContents(fileContents)
    {
        return `${ScriptIntegrityMonitor.HASH_ALGORITHM}-${crypto.createHash(ScriptIntegrityMonitor.HASH_ALGORITHM).update(fileContents).digest("base64")}`;
    }

    /**
     * Starts the periodic check plus a delayed boot check. Safe to call twice;
     * the second call is ignored rather than stacking a second timer.
     */
    static start()
    {
        if (ScriptIntegrityMonitor.isDisabled() || ScriptIntegrityMonitor.#intervalHandle !== null)
        {
            return;
        }

        ScriptIntegrityMonitor.#intervalHandle = setInterval
        (
            ScriptIntegrityMonitor.#tick,
            ScriptIntegrityMonitor.CHECK_INTERVAL_MILLISECONDS
        );

        ScriptIntegrityMonitor.#bootTimeoutHandle = setTimeout
        (
            ScriptIntegrityMonitor.#tick,
            ScriptIntegrityMonitor.BOOT_DELAY_MILLISECONDS
        );

        // Neither timer should hold the process open on its own.
        if (typeof ScriptIntegrityMonitor.#intervalHandle.unref === "function")
        {
            ScriptIntegrityMonitor.#intervalHandle.unref();
        }
        if (typeof ScriptIntegrityMonitor.#bootTimeoutHandle.unref === "function")
        {
            ScriptIntegrityMonitor.#bootTimeoutHandle.unref();
        }
    }

    static stop()
    {
        if (ScriptIntegrityMonitor.#intervalHandle !== null)
        {
            clearInterval(ScriptIntegrityMonitor.#intervalHandle);
            ScriptIntegrityMonitor.#intervalHandle = null;
        }

        if (ScriptIntegrityMonitor.#bootTimeoutHandle !== null)
        {
            clearTimeout(ScriptIntegrityMonitor.#bootTimeoutHandle);
            ScriptIntegrityMonitor.#bootTimeoutHandle = null;
        }
    }

    static async #tick()
    {
        try
        {
            await ScriptIntegrityMonitor.sweep();
        }
        catch (sweepError)
        {
            console.error("[ScriptIntegrityMonitor] Sweep failed:", sweepError);
        }
    }

    /**
     * One full pass. The two halves are independent — a network failure
     * reaching Razorpay must not stop the first-party check, which is the one
     * that detects an actual compromise of this origin.
     *
     * @returns {Promise<{firstParty: object, remote: Array<object>}>}
     */
    static async sweep()
    {
        const firstPartyOutcome = await ScriptIntegrityMonitor.verifyServedBundle();

        const remoteOutcomes = [];
        for (const monitoredScript of ScriptIntegrityMonitor.MONITORED_REMOTE_SCRIPTS)
        {
            try
            {
                remoteOutcomes.push(await ScriptIntegrityMonitor.verifyRemoteScript(monitoredScript));
            }
            catch (remoteError)
            {
                console.error(`[ScriptIntegrityMonitor] Could not check ${monitoredScript.name}:`, remoteError);
                remoteOutcomes.push({ name: monitoredScript.name, checked: false, reason: "FETCH_FAILED" });
            }
        }

        return { firstParty: firstPartyOutcome, remote: remoteOutcomes };
    }

    /**
     * Re-hashes the served tree and compares it against the build manifest.
     *
     * A missing manifest is NOT reported as tampering. It means the build never
     * wrote one — a developer running the server against a hand-made Static
     * tree, say — and crying wolf there would train an operator to ignore the
     * alert that matters.
     *
     * @returns {Promise<{checked: boolean, reason?: string, fileCount: number, changed: string[], missing: string[], added: string[]}>}
     */
    static async verifyServedBundle()
    {
        const emptyOutcome = { checked: false, fileCount: 0, changed: [], missing: [], added: [] };

        const manifestFilePath = ScriptIntegrityMonitor.#getManifestFilePath();
        const staticDirectory = ScriptIntegrityMonitor.#getStaticDirectory();

        if (!fs.existsSync(manifestFilePath) || !fs.existsSync(staticDirectory))
        {
            return { ...emptyOutcome, reason: "NO_MANIFEST" };
        }

        let manifest = null;
        try
        {
            manifest = JSON.parse(fs.readFileSync(manifestFilePath, "utf8"));
        }
        catch (parseError)
        {
            console.error("[ScriptIntegrityMonitor] The integrity manifest could not be parsed:", parseError);
            return { ...emptyOutcome, reason: "UNREADABLE_MANIFEST" };
        }

        const expectedHashes = manifest?.files && typeof manifest.files === "object" ? manifest.files : {};
        const observedHashes = ScriptIntegrityMonitor.#hashServedTree(staticDirectory);

        const changed = [];
        const missing = [];
        const added = [];

        for (const [relativePath, expectedHash] of Object.entries(expectedHashes))
        {
            const observedHash = observedHashes[relativePath];

            if (observedHash === undefined)
            {
                missing.push(relativePath);
            }
            else if (observedHash !== expectedHash)
            {
                changed.push(relativePath);
            }
        }

        for (const relativePath of Object.keys(observedHashes))
        {
            if (expectedHashes[relativePath] === undefined)
            {
                added.push(relativePath);
            }
        }

        const outcome =
        {
            checked: true,
            fileCount: Object.keys(expectedHashes).length,
            changed: changed,
            missing: missing,
            added: added
        };

        if (changed.length > 0 || missing.length > 0 || added.length > 0)
        {
            await ScriptIntegrityMonitor.#raiseFirstPartyAlert(manifest, outcome);
        }

        return outcome;
    }

    static #hashServedTree(staticDirectory)
    {
        // Mirrors GenerateScriptIntegrityManifest's walk exactly. The two lists
        // MUST agree on which extensions count: an extension hashed there but
        // not here reads as a missing file on every single check.
        const hashedExtensions = new Set([".js", ".mjs", ".html"]);
        const skippedDirectoryNames = new Set(["node_modules", ".git"]);
        const observedHashes = {};

        const walk = (absoluteDirectory) =>
        {
            for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true }))
            {
                if (skippedDirectoryNames.has(entry.name))
                {
                    continue;
                }

                const entryAbsolutePath = path.join(absoluteDirectory, entry.name);

                if (entry.isDirectory())
                {
                    walk(entryAbsolutePath);
                    continue;
                }

                if (!hashedExtensions.has(path.extname(entry.name).toLowerCase()))
                {
                    continue;
                }

                const relativePath = path
                    .relative(staticDirectory, entryAbsolutePath)
                    .split(path.sep)
                    .join("/");

                observedHashes[relativePath] = ScriptIntegrityMonitor.hashFileContents(fs.readFileSync(entryAbsolutePath));
            }
        };

        walk(staticDirectory);

        return observedHashes;
    }

    /**
     * Fetches a remote script, hashes it, and compares it against the last hash
     * recorded for that URL.
     *
     * @param {{name: string, url: string}} monitoredScript
     * @returns {Promise<{name: string, checked: boolean, changed: boolean, firstObservation: boolean, hash: string}>}
     */
    static async verifyRemoteScript(monitoredScript)
    {
        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => abortController.abort(), ScriptIntegrityMonitor.REMOTE_FETCH_TIMEOUT_MILLISECONDS);

        let scriptBytes = null;
        try
        {
            const remoteResponse = await fetch(monitoredScript.url, { signal: abortController.signal, redirect: "follow" });

            if (!remoteResponse.ok)
            {
                return { name: monitoredScript.name, checked: false, changed: false, firstObservation: false, hash: "", reason: `HTTP_${remoteResponse.status}` };
            }

            scriptBytes = Buffer.from(await remoteResponse.arrayBuffer());
        }
        finally
        {
            clearTimeout(timeoutHandle);
        }

        const observedHash = ScriptIntegrityMonitor.hashFileContents(scriptBytes);
        const baselineCollection = await ScriptIntegrityMonitor.#getBaselineCollection();

        if (!baselineCollection)
        {
            // No database means no baseline to compare against. Report the hash
            // so a caller running this by hand still learns something, but do
            // not claim it is unchanged.
            return { name: monitoredScript.name, checked: false, changed: false, firstObservation: false, hash: observedHash, reason: "NO_DATABASE" };
        }

        const storedBaseline = await baselineCollection.findOne({ url: monitoredScript.url });
        const previousHash = typeof storedBaseline?.hash === "string" ? storedBaseline.hash : "";
        const firstObservation = previousHash.length === 0;
        const changed = !firstObservation && previousHash !== observedHash;

        await baselineCollection.updateOne
        (
            { url: monitoredScript.url },
            {
                $set:
                {
                    url: monitoredScript.url,
                    name: monitoredScript.name,
                    hash: observedHash,
                    byteLength: scriptBytes.length,
                    lastCheckedAt: new Date(),
                    ...(changed || firstObservation ? { lastChangedAt: new Date() } : {}),
                    ...(changed ? { previousHash: previousHash } : {})
                }
            },
            { upsert: true }
        );

        if (changed)
        {
            await Alerts.raise
            ({
                severity: Alerts.SEVERITY.WARNING,
                source: ScriptIntegrityMonitor.ALERT_SOURCE,
                title: "A third-party payment script changed",
                message: `${monitoredScript.name} (${monitoredScript.url}) is serving different bytes than the last check. This is USUALLY the vendor shipping an update and needs no action — but it is the one place a supply-chain compromise of the checkout would show, so confirm it coincides with no payment incident.`,
                metadata:
                {
                    name: monitoredScript.name,
                    url: monitoredScript.url,
                    previousHash: previousHash,
                    currentHash: observedHash,
                    byteLength: scriptBytes.length
                }
            });
        }

        return { name: monitoredScript.name, checked: true, changed: changed, firstObservation: firstObservation, hash: observedHash };
    }

    static async #getBaselineCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }

        return database.collection(DatabaseConstants.SCRIPT_INTEGRITY_BASELINES_COLLECTION);
    }

    static #describePaths(relativePaths)
    {
        if (relativePaths.length <= ScriptIntegrityMonitor.MAXIMUM_REPORTED_PATHS)
        {
            return relativePaths.join(", ");
        }

        const namedPaths = relativePaths.slice(0, ScriptIntegrityMonitor.MAXIMUM_REPORTED_PATHS).join(", ");
        return `${namedPaths} (and ${relativePaths.length - ScriptIntegrityMonitor.MAXIMUM_REPORTED_PATHS} more)`;
    }

    static async #raiseFirstPartyAlert(manifest, outcome)
    {
        const descriptionParts = [];
        if (outcome.changed.length > 0)
        {
            descriptionParts.push(`${outcome.changed.length} changed (${ScriptIntegrityMonitor.#describePaths(outcome.changed)})`);
        }
        if (outcome.missing.length > 0)
        {
            descriptionParts.push(`${outcome.missing.length} missing (${ScriptIntegrityMonitor.#describePaths(outcome.missing)})`);
        }
        if (outcome.added.length > 0)
        {
            descriptionParts.push(`${outcome.added.length} unexpected (${ScriptIntegrityMonitor.#describePaths(outcome.added)})`);
        }

        await Alerts.raise
        ({
            severity: Alerts.SEVERITY.ERROR,
            source: ScriptIntegrityMonitor.ALERT_SOURCE,
            title: "The served scripts no longer match the build",
            message: `Dock/Static differs from the integrity manifest written by the build of ${manifest?.generatedAt || "an unknown time"}: ${descriptionParts.join("; ")}. Nothing legitimate rewrites the served tree after a deploy, so treat this as a possible compromise of the origin: compare against the deployed artifact before serving another payment.`,
            metadata:
            {
                manifestGeneratedAt: manifest?.generatedAt || "",
                fileCount: outcome.fileCount,
                changed: outcome.changed.slice(0, ScriptIntegrityMonitor.MAXIMUM_REPORTED_PATHS),
                changedCount: outcome.changed.length,
                missing: outcome.missing.slice(0, ScriptIntegrityMonitor.MAXIMUM_REPORTED_PATHS),
                missingCount: outcome.missing.length,
                added: outcome.added.slice(0, ScriptIntegrityMonitor.MAXIMUM_REPORTED_PATHS),
                addedCount: outcome.added.length
            }
        });
    }
}

module.exports = ScriptIntegrityMonitor;
