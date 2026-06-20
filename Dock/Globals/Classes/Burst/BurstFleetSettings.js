// Single home for every burst-fleet tunable. All values come from the
// environment so the fleet can be retuned without code changes (per the
// requirement that anything like instance type / region / caps is env-driven).
// Vendor-neutral where possible; vendor credentials (e.g. the Linode token) are
// read by the concrete provider, not here.
//
// The autoscaler reads scaling knobs from here and asks for a vendor-neutral
// provisioning specification it can hand to ANY CloudComputeProvider.

const path = require("path");
const fs = require("fs");

class BurstFleetSettings
{
    static #resolvePositiveIntegerSetting(environmentVariableName, fallbackValue)
    {
        const rawValue = process.env[environmentVariableName];

        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "")
        {
            return fallbackValue;
        }

        const parsedValue = Number(rawValue);

        if (!Number.isFinite(parsedValue) || parsedValue <= 0)
        {
            console.warn(`[BurstFleetSettings] Ignoring invalid ${environmentVariableName}="${rawValue}"; using default ${fallbackValue}.`);
            return fallbackValue;
        }

        return Math.floor(parsedValue);
    }

    static #resolveNonNegativeIntegerSetting(environmentVariableName, fallbackValue)
    {
        const rawValue = process.env[environmentVariableName];

        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "")
        {
            return fallbackValue;
        }

        const parsedValue = Number(rawValue);

        if (!Number.isFinite(parsedValue) || parsedValue < 0)
        {
            console.warn(`[BurstFleetSettings] Ignoring invalid ${environmentVariableName}="${rawValue}"; using default ${fallbackValue}.`);
            return fallbackValue;
        }

        return Math.floor(parsedValue);
    }

    static #resolveStringSetting(environmentVariableName, fallbackValue)
    {
        const rawValue = process.env[environmentVariableName];

        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "")
        {
            return fallbackValue;
        }

        return String(rawValue).trim();
    }

    static #resolveBooleanSetting(environmentVariableName, fallbackValue)
    {
        const rawValue = process.env[environmentVariableName];

        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "")
        {
            return fallbackValue;
        }

        const normalized = String(rawValue).trim().toLowerCase();
        return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
    }

    // ── Scaling knobs ───────────────────────────────────────────────────────
    static getWarmPoolSize()
    {
        return BurstFleetSettings.#resolveNonNegativeIntegerSetting("BURST_WARM_POOL_SIZE", 2);
    }

    static getMaxInstances()
    {
        // The hard cap. Never provision beyond this — the runaway-spend guard.
        return BurstFleetSettings.#resolvePositiveIntegerSetting("BURST_MAX_INSTANCES", 8);
    }

    static getTasksPerInstance()
    {
        return BurstFleetSettings.#resolvePositiveIntegerSetting("BURST_TASKS_PER_INSTANCE", 2);
    }

    static getIdleTimeoutMilliseconds()
    {
        return BurstFleetSettings.#resolvePositiveIntegerSetting("BURST_IDLE_TIMEOUT_SECONDS", 600) * 1000;
    }

    static getReconcileIntervalMilliseconds()
    {
        return BurstFleetSettings.#resolvePositiveIntegerSetting("BURST_RECONCILE_INTERVAL_SECONDS", 30) * 1000;
    }

    static getScaleUpCooldownMilliseconds()
    {
        return BurstFleetSettings.#resolvePositiveIntegerSetting("BURST_SCALE_UP_COOLDOWN_SECONDS", 60) * 1000;
    }

    static getScaleDownCooldownMilliseconds()
    {
        return BurstFleetSettings.#resolvePositiveIntegerSetting("BURST_SCALE_DOWN_COOLDOWN_SECONDS", 300) * 1000;
    }

    static getScaleUpBatchSize()
    {
        return BurstFleetSettings.#resolvePositiveIntegerSetting("BURST_SCALE_UP_BATCH", 1);
    }

    static isDryRun()
    {
        return BurstFleetSettings.#resolveBooleanSetting("BURST_DRY_RUN", false);
    }

    // ── Identity / provisioning inputs (vendor-neutral) ──────────────────────
    static getManagementTag()
    {
        return BurstFleetSettings.#resolveStringSetting("BURST_MANAGEMENT_TAG", "mindmeld-burst");
    }

    static getLabelPrefix()
    {
        return BurstFleetSettings.#resolveStringSetting("BURST_LABEL_PREFIX", "mindmeld-burst-");
    }

    static getRegion()
    {
        return BurstFleetSettings.#resolveStringSetting("BURST_REGION", "");
    }

    static getImageId()
    {
        return BurstFleetSettings.#resolveStringSetting("BURST_IMAGE_ID", "");
    }

    static getInstanceType()
    {
        return BurstFleetSettings.#resolveStringSetting("BURST_INSTANCE_TYPE", "");
    }

    static getVpcId()
    {
        return BurstFleetSettings.#resolveStringSetting("BURST_VPC_ID", "");
    }

    static getSubnetId()
    {
        return BurstFleetSettings.#resolveStringSetting("BURST_SUBNET_ID", "");
    }

    static getFirewallId()
    {
        // The Cloud Firewall every burst VM is bound to at creation — the same
        // firewall that protects the Dock Linode. Required: the provider refuses
        // to create unprotected instances when this is unset (fail-closed).
        return BurstFleetSettings.#resolveStringSetting("BURST_FIREWALL_ID", "");
    }

    static getWorkersPerInstance()
    {
        return BurstFleetSettings.#resolvePositiveIntegerSetting("AGENT_WORKERS_PER_VM", 1);
    }

    /**
     * The environment a burst worker container needs at runtime. Redis/Mongo
     * default to dedicated VPC-private URLs so burst VMs reach them over the
     * private network; falling back to the main URLs only if those aren't set.
     * @returns {Record<string, string>}
     */
    static getWorkerRuntimeEnvironment()
    {
        const environment = {
            REDIS_URL: BurstFleetSettings.#resolveStringSetting("BURST_WORKER_REDIS_URL", process.env.REDIS_URL || "redis://127.0.0.1:6379"),
            MONGODB_URL: BurstFleetSettings.#resolveStringSetting("BURST_WORKER_MONGODB_URL", process.env.MONGODB_URL || ""),
            MONGODB_DATABASE_NAME: process.env.MONGODB_DATABASE_NAME || "",
            AGENT_WORKERS_PER_VM: String(BurstFleetSettings.getWorkersPerInstance())
        };

        // LLM keys (GEMINI/OPENAI) are NOT part of Dock's env and are never loaded
        // into Dock's process — Dock makes no LLM calls. They live solely in the
        // Agent env file and are used only by the Agent. We read them straight from
        // that file here for the sole purpose of forwarding them to the burst
        // worker, which runs the Agent but has no env file baked into its image.
        Object.assign(environment, BurstFleetSettings.#readAgentLlmKeys());

        return environment;
    }

    /**
     * Reads ONLY the LLM keys from the sibling Agent env file (same relative
     * layout as the repo: Agent/ next to Dock/), without injecting anything into
     * Dock's own process.env. Anchored to __dirname so the launch cwd is
     * irrelevant. Returns {} (with a warning) if the file is absent/unreadable.
     * @returns {Record<string, string>}
     */
    static #readAgentLlmKeys()
    {
        const environmentFileName = process.argv.includes("--debug") ? ".env" : ".production.env";
        const agentEnvironmentPath = path.join(__dirname, "..", "..", "..", "..", "Agent", environmentFileName);

        try
        {
            const parsedAgentEnvironment = require("dotenv").parse(fs.readFileSync(agentEnvironmentPath));
            const llmKeys = {};
            for (const key of ["GEMINI_API_KEY", "OPENAI_API_KEY"])
            {
                if (parsedAgentEnvironment[key])
                {
                    llmKeys[key] = parsedAgentEnvironment[key];
                }
            }
            return llmKeys;
        }
        catch (readError)
        {
            console.warn(`[BurstFleetSettings] Could not read Agent LLM keys from ${agentEnvironmentPath}; burst workers may lack GEMINI_API_KEY/OPENAI_API_KEY: ${readError.message}`);
            return {};
        }
    }

    /**
     * Builds a vendor-neutral provisioning specification the autoscaler hands to
     * whichever CloudComputeProvider is active. The concrete provider maps these
     * generic fields onto its own API.
     * @param {string} label
     * @returns {object}
     */
    static buildProvisioningSpecification(label)
    {
        return {
            label: label,
            tags: [BurstFleetSettings.getManagementTag()],
            region: BurstFleetSettings.getRegion(),
            imageId: BurstFleetSettings.getImageId(),
            instanceType: BurstFleetSettings.getInstanceType(),
            vpcId: BurstFleetSettings.getVpcId(),
            subnetId: BurstFleetSettings.getSubnetId(),
            firewallId: BurstFleetSettings.getFirewallId(),
            workerEnvironment: BurstFleetSettings.getWorkerRuntimeEnvironment()
        };
    }
}

module.exports = BurstFleetSettings;
