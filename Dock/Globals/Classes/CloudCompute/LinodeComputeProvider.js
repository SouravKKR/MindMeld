const CloudComputeProvider = require("./CloudComputeProvider");
const ComputeInstanceDescriptor = require("./ComputeInstanceDescriptor");
const BurstFleetSettings = require("../Burst/BurstFleetSettings");
const Alerts = require("../Alerts/Alerts");
const { cloudComputeProviders } = require("../../Enumerations/CloudComputeProviders");
const crypto = require("crypto");

// Linode (Akamai) implementation of the cloud compute interface, using Linode
// API v4. The ONLY vendor-specific knowledge in the system lives here — the
// autoscaler talks exclusively to the abstract CloudComputeProvider.
//
// Robustness: every API call is wrapped so a transient failure returns a safe
// value (empty list / null / false) and records an admin alert, instead of
// throwing into the reconcile loop. A throw there could either stall scaling or,
// worse, be retried into runaway provisioning.
//
// Dry-run: when BURST_DRY_RUN is on, no API calls are made — a simulated
// in-memory instance list lets the full autoscaler logic (including the hard cap)
// be exercised with zero spend.

class LinodeComputeProvider extends CloudComputeProvider
{
    static #API_BASE_URL = "https://api.linode.com/v4";
    static #ALERT_SOURCE = "BURST_FLEET";

    // Shared simulated state for dry-run, keyed by instance id.
    static #simulatedInstances = new Map();
    static #simulatedIdCounter = 1;

    #apiToken;

    constructor()
    {
        super();
        this.#apiToken = process.env.LINODE_API_TOKEN || "";
    }

    getProviderEnumValue()
    {
        return cloudComputeProviders.LINODE;
    }

    isConfigured()
    {
        // In dry-run we deliberately report configured so the autoscaler can run
        // its full logic against the simulated cloud without any real token.
        if (BurstFleetSettings.isDryRun())
        {
            return true;
        }

        return Boolean(this.#apiToken && BurstFleetSettings.getImageId() && BurstFleetSettings.getRegion() && BurstFleetSettings.getInstanceType());
    }

    async #request(method, pathSuffix, bodyObject)
    {
        const response = await fetch(LinodeComputeProvider.#API_BASE_URL + pathSuffix,
        {
            method: method,
            headers:
            {
                "Authorization": `Bearer ${this.#apiToken}`,
                "Content-Type": "application/json"
            },
            body: bodyObject ? JSON.stringify(bodyObject) : undefined
        });

        if (!response.ok)
        {
            const errorText = await response.text();
            throw new Error(`Linode API ${method} ${pathSuffix} failed: ${response.status} ${errorText}`);
        }

        // DELETE / shutdown return an empty body.
        const responseText = await response.text();
        return responseText ? JSON.parse(responseText) : {};
    }

    #normalizeInstance(linodeInstance)
    {
        const privateIpAddress = Array.isArray(linodeInstance.ipv4)
            ? (linodeInstance.ipv4.find(address => LinodeComputeProvider.#isPrivateIpv4(address)) || "")
            : "";

        return new ComputeInstanceDescriptor({
            instanceId: linodeInstance.id,
            label: linodeInstance.label,
            status: linodeInstance.status,
            privateIpAddress: privateIpAddress,
            createdAt: linodeInstance.created ? new Date(linodeInstance.created) : null
        });
    }

    static #isPrivateIpv4(address)
    {
        return typeof address === "string" && (address.startsWith("192.168.") || address.startsWith("10.") || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(address));
    }

    async listManagedInstances(managementTag)
    {
        if (BurstFleetSettings.isDryRun())
        {
            return Array.from(LinodeComputeProvider.#simulatedInstances.values());
        }

        try
        {
            const xFilter = JSON.stringify({ tags: managementTag });
            const response = await fetch(`${LinodeComputeProvider.#API_BASE_URL}/linode/instances`,
            {
                method: "GET",
                headers:
                {
                    "Authorization": `Bearer ${this.#apiToken}`,
                    "Content-Type": "application/json",
                    "X-Filter": xFilter
                }
            });

            if (!response.ok)
            {
                const errorText = await response.text();
                throw new Error(`Linode list failed: ${response.status} ${errorText}`);
            }

            const payload = await response.json();
            const data = Array.isArray(payload.data) ? payload.data : [];
            return data.map(instance => this.#normalizeInstance(instance));
        }
        catch (listError)
        {
            // Returning [] is the safe failure: the autoscaler will see "no managed
            // instances", but its cooldowns + hard cap prevent a thrash, and the
            // next successful poll self-corrects.
            await Alerts.error(LinodeComputeProvider.#ALERT_SOURCE, "Failed to list burst instances", String(listError));
            return [];
        }
    }

    /**
     * Builds the cloud-init user-data that injects the worker runtime env onto a
     * fresh burst VM and (re)starts the worker service baked into the image. This
     * is the only OS-specific code in the framework; it targets the Debian-based
     * baked image documented in Common/ReadmeFiles/Deployment.md.
     */
    #buildCloudInitUserData(workerEnvironment)
    {
        const environmentLines = Object.entries(workerEnvironment || {})
            .map(([key, value]) => `${key}=${value}`)
            .join("\n");

        const cloudConfig = [
            "#cloud-config",
            "write_files:",
            "  - path: /etc/mindmeld/worker.env",
            "    permissions: '0600'",
            "    content: |",
            ...environmentLines.split("\n").map(line => `      ${line}`),
            "runcmd:",
            "  - systemctl restart mindmeld-worker.service"
        ].join("\n");

        return Buffer.from(cloudConfig, "utf-8").toString("base64");
    }

    async createInstance(provisioningSpecification)
    {
        if (BurstFleetSettings.isDryRun())
        {
            const simulatedId = String(LinodeComputeProvider.#simulatedIdCounter++);
            const descriptor = new ComputeInstanceDescriptor({
                instanceId: simulatedId,
                label: provisioningSpecification.label,
                status: "running",
                privateIpAddress: `10.0.0.${LinodeComputeProvider.#simulatedInstances.size + 2}`,
                createdAt: new Date()
            });
            LinodeComputeProvider.#simulatedInstances.set(simulatedId, descriptor);
            console.log(`[BURST_DRY_RUN] Would create instance "${provisioningSpecification.label}" (type=${provisioningSpecification.instanceType}, region=${provisioningSpecification.region}).`);
            return descriptor;
        }

        try
        {
            const requestBody = {
                label: provisioningSpecification.label,
                region: provisioningSpecification.region,
                type: provisioningSpecification.instanceType,
                image: provisioningSpecification.imageId,
                tags: provisioningSpecification.tags,
                private_ip: true,
                booted: true,
                root_pass: crypto.randomBytes(24).toString("base64") + "Aa1!",
                metadata: { user_data: this.#buildCloudInitUserData(provisioningSpecification.workerEnvironment) }
            };

            if (provisioningSpecification.vpcId && provisioningSpecification.subnetId)
            {
                requestBody.interfaces = [
                    {
                        purpose: "vpc",
                        vpc_id: Number(provisioningSpecification.vpcId),
                        subnet_id: Number(provisioningSpecification.subnetId)
                    }
                ];
            }

            const created = await this.#request("POST", "/linode/instances", requestBody);
            return this.#normalizeInstance(created);
        }
        catch (createError)
        {
            await Alerts.error(LinodeComputeProvider.#ALERT_SOURCE, "Failed to create burst instance", String(createError));
            return null;
        }
    }

    async shutdownInstance(instanceId)
    {
        if (BurstFleetSettings.isDryRun())
        {
            const descriptor = LinodeComputeProvider.#simulatedInstances.get(String(instanceId));
            if (descriptor)
            {
                LinodeComputeProvider.#simulatedInstances.set(String(instanceId), new ComputeInstanceDescriptor({ ...descriptor.toJson(), status: "offline" }));
            }
            console.log(`[BURST_DRY_RUN] Would shut down instance ${instanceId}.`);
            return true;
        }

        try
        {
            await this.#request("POST", `/linode/instances/${instanceId}/shutdown`, {});
            return true;
        }
        catch (shutdownError)
        {
            await Alerts.error(LinodeComputeProvider.#ALERT_SOURCE, "Failed to shut down burst instance", String(shutdownError), { instanceId });
            return false;
        }
    }

    async deleteInstance(instanceId)
    {
        if (BurstFleetSettings.isDryRun())
        {
            LinodeComputeProvider.#simulatedInstances.delete(String(instanceId));
            console.log(`[BURST_DRY_RUN] Would delete instance ${instanceId}.`);
            return true;
        }

        try
        {
            await this.#request("DELETE", `/linode/instances/${instanceId}`);
            return true;
        }
        catch (deleteError)
        {
            await Alerts.error(LinodeComputeProvider.#ALERT_SOURCE, "Failed to delete burst instance", String(deleteError), { instanceId });
            return false;
        }
    }

    async getInstance(instanceId)
    {
        if (BurstFleetSettings.isDryRun())
        {
            return LinodeComputeProvider.#simulatedInstances.get(String(instanceId)) || null;
        }

        try
        {
            const instance = await this.#request("GET", `/linode/instances/${instanceId}`);
            return this.#normalizeInstance(instance);
        }
        catch (getError)
        {
            // A 404 (deleted) is expected during teardown — return null quietly.
            return null;
        }
    }
}

module.exports = LinodeComputeProvider;
