const crypto = require("crypto");
const App = require("../App");
const Logger = require("../Logger");
const Alerts = require("../Alerts/Alerts");
const TaskManager = require("../Task/TaskManager");
const TaskQueueMode = require("../Task/TaskQueueMode");
const BurstFleetSettings = require("./BurstFleetSettings");
const BurstInstanceState = require("./BurstInstanceState");
const CloudComputeProviderFactory = require("../CloudCompute/CloudComputeProviderFactory");

// Polling reconciliation autoscaler for the burst worker fleet. It NEVER reacts
// to events — every tick it reads the real current state (queue depth + the
// cloud's actual instance list) and converges toward a desired count. This makes
// runaway spend structurally impossible: the worst a bug can do is misjudge one
// tick, and the hard cap + cooldowns bound that.
//
// Lifecycle:
//   - shouldRun(): production only (no --debug), queue enabled, provider configured.
//   - startup(): FIRST tear down every managed instance (so a restart never
//     inherits stray burst VMs — no burst VM exists at boot), THEN begin the
//     reconcile loop, which rebuilds the warm pool.
//
// It depends solely on the abstract CloudComputeProvider, so it is cloud-agnostic.

class BurstAutoscaler
{
    static #ALERT_SOURCE = "BURST_FLEET";
    // Grace before a tracked instance that has vanished from the cloud's list is
    // dropped from local state — protects a just-created instance that hasn't yet
    // appeared in the provider's eventually-consistent listing.
    static #MISSING_INSTANCE_GRACE_MILLISECONDS = 120 * 1000;

    static #instanceStates = new Map();
    static #reconcileTimer = null;
    static #bReconciling = false;
    static #lastScaleUpAtMilliseconds = 0;
    static #lastScaleDownAtMilliseconds = 0;

    /**
     * @returns {boolean} Whether the autoscaler should run in this process.
     */
    static shouldRun()
    {
        if (App.isDebug())
        {
            return false;
        }
        if (!TaskQueueMode.isQueueEnabled())
        {
            return false;
        }

        try
        {
            return CloudComputeProviderFactory.getDefaultProvider().isConfigured();
        }
        catch (providerError)
        {
            console.warn("[BurstAutoscaler] No usable cloud provider; autoscaler disabled:", providerError);
            return false;
        }
    }

    /**
     * Tears down any inherited burst instances, then starts the reconcile loop.
     */
    static async startup()
    {
        const provider = CloudComputeProviderFactory.getDefaultProvider();

        Logger.log(`[BurstAutoscaler] Starting (dryRun=${BurstFleetSettings.isDryRun()}, warmPool=${BurstFleetSettings.getWarmPoolSize()}, maxInstances=${BurstFleetSettings.getMaxInstances()}).`);

        await BurstAutoscaler.#teardownAllManagedInstances(provider);

        // Run one reconcile immediately so the warm pool comes up without waiting
        // a full interval, then poll forever. unref so the timer never keeps the
        // process alive on its own.
        await BurstAutoscaler.reconcileOnce();

        BurstAutoscaler.#reconcileTimer = setInterval(
            () => { BurstAutoscaler.reconcileOnce(); },
            BurstFleetSettings.getReconcileIntervalMilliseconds()
        );

        if (typeof BurstAutoscaler.#reconcileTimer.unref === "function")
        {
            BurstAutoscaler.#reconcileTimer.unref();
        }
    }

    /**
     * Deletes every instance carrying the management tag. Called only at startup.
     * @param {import('../CloudCompute/CloudComputeProvider')} provider
     */
    static async #teardownAllManagedInstances(provider)
    {
        try
        {
            const managementTag = BurstFleetSettings.getManagementTag();
            const instances = await provider.listManagedInstances(managementTag);

            if (instances.length === 0)
            {
                Logger.log("[BurstAutoscaler] Startup teardown: no inherited burst instances.");
            }
            else
            {
                Logger.log(`[BurstAutoscaler] Startup teardown: deleting ${instances.length} inherited burst instance(s).`);
                for (const instance of instances)
                {
                    await provider.deleteInstance(instance.getInstanceId());
                }
            }
        }
        catch (teardownError)
        {
            await Alerts.error(BurstAutoscaler.#ALERT_SOURCE, "Startup teardown failed", String(teardownError));
        }
        finally
        {
            BurstAutoscaler.#instanceStates.clear();
        }
    }

    /**
     * One reconciliation pass. Fully guarded — a thrown error logs but never kills
     * the interval, and never triggers provisioning.
     */
    static async reconcileOnce()
    {
        if (BurstAutoscaler.#bReconciling)
        {
            // A previous (slow) tick is still running — skip rather than overlap.
            return;
        }
        BurstAutoscaler.#bReconciling = true;

        try
        {
            const provider = CloudComputeProviderFactory.getDefaultProvider();
            const nowMilliseconds = Date.now();

            const queueDepth = await TaskManager.getQueueDepth();
            const pending = queueDepth.pending;
            const processing = queueDepth.processing;

            const managementTag = BurstFleetSettings.getManagementTag();
            const providerInstances = await provider.listManagedInstances(managementTag);
            const providerInstanceIds = new Set(providerInstances.map(instance => instance.getInstanceId()));

            BurstAutoscaler.#reconcileInstanceStates(providerInstances, providerInstanceIds, nowMilliseconds);

            // Any work at all keeps the whole pool's idle clock fresh.
            if (pending + processing > 0)
            {
                for (const state of BurstAutoscaler.#instanceStates.values())
                {
                    state.markBusy(nowMilliseconds);
                }
            }

            const warmPoolSize = BurstFleetSettings.getWarmPoolSize();
            const maxInstances = BurstFleetSettings.getMaxInstances();
            const tasksPerInstance = BurstFleetSettings.getTasksPerInstance();

            const currentCount = BurstAutoscaler.#instanceStates.size;
            const demandFromBacklog = Math.ceil(pending / tasksPerInstance);
            const desiredCount = Math.max(warmPoolSize, Math.min(Math.max(warmPoolSize, demandFromBacklog), maxInstances));

            // Only log the reconcile status when something is actually happening —
            // a scaling decision or queue activity — so an idle fleet does not emit
            // a status line every reconcile tick (~every 30s).
            if (desiredCount !== currentCount || (pending + processing) > 0)
            {
                Logger.log(`[BurstAutoscaler] pending=${pending} processing=${processing} current=${currentCount} desired=${desiredCount} (cap=${maxInstances}).`);
            }

            if (desiredCount > currentCount)
            {
                await BurstAutoscaler.#scaleUp(provider, currentCount, desiredCount, maxInstances, nowMilliseconds);
            }
            else if (desiredCount < currentCount)
            {
                await BurstAutoscaler.#scaleDown(provider, providerInstances, currentCount, warmPoolSize, nowMilliseconds);
            }
        }
        catch (reconcileError)
        {
            console.error("[BurstAutoscaler] reconcile tick failed (continuing):", reconcileError);
            await Alerts.error(BurstAutoscaler.#ALERT_SOURCE, "Reconcile tick failed", String(reconcileError));
        }
        finally
        {
            BurstAutoscaler.#bReconciling = false;
        }
    }

    static #reconcileInstanceStates(providerInstances, providerInstanceIds, nowMilliseconds)
    {
        // Track any newly observed instance.
        for (const instance of providerInstances)
        {
            if (!BurstAutoscaler.#instanceStates.has(instance.getInstanceId()))
            {
                BurstAutoscaler.#instanceStates.set(
                    instance.getInstanceId(),
                    new BurstInstanceState(instance.getInstanceId(), instance.getLabel(), nowMilliseconds)
                );
            }
        }

        // Drop tracked instances that have disappeared from the cloud — but only
        // after a grace window, so a just-created instance not yet listed survives.
        for (const [instanceId, state] of BurstAutoscaler.#instanceStates)
        {
            if (providerInstanceIds.has(instanceId))
            {
                continue;
            }
            if ((nowMilliseconds - state.getFirstSeenAtMilliseconds()) > BurstAutoscaler.#MISSING_INSTANCE_GRACE_MILLISECONDS)
            {
                BurstAutoscaler.#instanceStates.delete(instanceId);
            }
        }
    }

    static async #scaleUp(provider, currentCount, desiredCount, maxInstances, nowMilliseconds)
    {
        if ((nowMilliseconds - BurstAutoscaler.#lastScaleUpAtMilliseconds) < BurstFleetSettings.getScaleUpCooldownMilliseconds())
        {
            return;
        }

        const scaleUpBatchSize = BurstFleetSettings.getScaleUpBatchSize();
        const headroom = maxInstances - currentCount;
        const createCount = Math.min(scaleUpBatchSize, desiredCount - currentCount, headroom);

        let createdAny = false;
        for (let createIndex = 0; createIndex < createCount; createIndex++)
        {
            const created = await BurstAutoscaler.#createOneInstance(provider, maxInstances, nowMilliseconds);
            if (created)
            {
                createdAny = true;
            }
            else
            {
                break;
            }
        }

        if (createdAny)
        {
            BurstAutoscaler.#lastScaleUpAtMilliseconds = nowMilliseconds;
        }
    }

    static async #createOneInstance(provider, maxInstances, nowMilliseconds)
    {
        // The single most important runaway-spend guard: never exceed the cap,
        // checked unconditionally right before every create.
        if (BurstAutoscaler.#instanceStates.size >= maxInstances)
        {
            Logger.log(`[BurstAutoscaler] At hard cap (${maxInstances}); refusing to create more.`);
            return false;
        }

        const label = BurstFleetSettings.getLabelPrefix() + crypto.randomBytes(4).toString("hex");
        const provisioningSpecification = BurstFleetSettings.buildProvisioningSpecification(label);

        const descriptor = await provider.createInstance(provisioningSpecification);
        if (descriptor === null)
        {
            return false;
        }

        BurstAutoscaler.#instanceStates.set(
            descriptor.getInstanceId(),
            new BurstInstanceState(descriptor.getInstanceId(), descriptor.getLabel(), nowMilliseconds)
        );
        Logger.log(`[BurstAutoscaler] Created burst instance ${descriptor.getInstanceId()} (${label}).`);
        return true;
    }

    static async #scaleDown(provider, providerInstances, currentCount, warmPoolSize, nowMilliseconds)
    {
        if (currentCount <= warmPoolSize)
        {
            return;
        }
        if ((nowMilliseconds - BurstAutoscaler.#lastScaleDownAtMilliseconds) < BurstFleetSettings.getScaleDownCooldownMilliseconds())
        {
            return;
        }

        const idleTimeoutMilliseconds = BurstFleetSettings.getIdleTimeoutMilliseconds();

        // Only consider instances the cloud actually lists, that have a tracked
        // state, and that have been idle past the timeout. Pick the most idle.
        const shutdownCandidates = providerInstances
            .map(instance =>
            {
                const state = BurstAutoscaler.#instanceStates.get(instance.getInstanceId());
                return state ? { instance: instance, idleMilliseconds: state.idleMilliseconds(nowMilliseconds) } : null;
            })
            .filter(candidate => candidate !== null && candidate.idleMilliseconds > idleTimeoutMilliseconds)
            .sort((firstCandidate, secondCandidate) => secondCandidate.idleMilliseconds - firstCandidate.idleMilliseconds);

        if (shutdownCandidates.length === 0)
        {
            return;
        }

        const victim = shutdownCandidates[0].instance;
        const deleted = await provider.deleteInstance(victim.getInstanceId());
        if (deleted)
        {
            BurstAutoscaler.#instanceStates.delete(victim.getInstanceId());
            BurstAutoscaler.#lastScaleDownAtMilliseconds = nowMilliseconds;
            Logger.log(`[BurstAutoscaler] Scaled down idle burst instance ${victim.getInstanceId()}.`);
        }
    }

    /**
     * Stops the reconcile loop (process shutdown). Leaves instances in place —
     * the next startup tears them down before rebuilding the warm pool.
     */
    static stop()
    {
        if (BurstAutoscaler.#reconcileTimer !== null)
        {
            clearInterval(BurstAutoscaler.#reconcileTimer);
            BurstAutoscaler.#reconcileTimer = null;
        }
    }
}

module.exports = BurstAutoscaler;
