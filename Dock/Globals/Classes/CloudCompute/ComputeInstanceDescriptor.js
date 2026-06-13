// A provider-neutral view of a single cloud compute instance. Every
// CloudComputeProvider normalizes its vendor-specific instance representation
// into this shape, so the autoscaler and everything above it never has to know
// which cloud the instance came from. Swapping providers therefore never ripples
// past the provider implementation.

class ComputeInstanceDescriptor
{
    #instanceId;
    #label;
    #status;
    #privateIpAddress;
    #createdAt;

    /**
     * @param {object} options
     * @param {string} options.instanceId - Provider-assigned unique id (as a string).
     * @param {string} options.label - Human-readable label used to identify managed instances.
     * @param {string} options.status - Provider-neutral status string (e.g. "running", "provisioning", "offline").
     * @param {string} options.privateIpAddress - VPC private IP, or "" if not yet assigned.
     * @param {Date|null} options.createdAt - Creation timestamp, or null if unknown.
     */
    constructor({ instanceId, label, status, privateIpAddress, createdAt } = {})
    {
        this.#instanceId = instanceId !== undefined && instanceId !== null ? String(instanceId) : "";
        this.#label = label || "";
        this.#status = status || "";
        this.#privateIpAddress = privateIpAddress || "";
        this.#createdAt = createdAt instanceof Date ? createdAt : null;
    }

    getInstanceId()
    {
        return this.#instanceId;
    }

    getLabel()
    {
        return this.#label;
    }

    getStatus()
    {
        return this.#status;
    }

    getPrivateIpAddress()
    {
        return this.#privateIpAddress;
    }

    getCreatedAt()
    {
        return this.#createdAt;
    }

    toJson()
    {
        return {
            instanceId: this.#instanceId,
            label: this.#label,
            status: this.#status,
            privateIpAddress: this.#privateIpAddress,
            createdAt: this.#createdAt ? this.#createdAt.toISOString() : null
        };
    }
}

module.exports = ComputeInstanceDescriptor;
