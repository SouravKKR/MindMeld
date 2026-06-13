// Abstract base for a cloud compute backend. The burst autoscaler depends ONLY
// on this interface — never on a concrete vendor — so moving from Linode to any
// other provider is "add one concrete file + one factory branch", exactly like
// the PaymentProvider abstraction.
//
// Every method that talks to the cloud is async and MUST normalize results into
// provider-neutral types (ComputeInstanceDescriptor) and MUST NOT throw into the
// reconcile loop on transient API errors — concrete providers catch, record an
// admin alert, and return a safe value (empty list / null) so one bad API call
// can never kill the autoscaler or, worse, cause runaway provisioning.

class CloudComputeProvider
{
    /**
     * @returns {number} The CloudComputeProviders enum value this provider implements.
     */
    getProviderEnumValue()
    {
        throw new Error("CloudComputeProvider.getProviderEnumValue() must be implemented by subclass");
    }

    /**
     * @returns {boolean} True when every credential/setting the provider needs is present.
     */
    isConfigured()
    {
        throw new Error("CloudComputeProvider.isConfigured() must be implemented by subclass");
    }

    /**
     * Lists every instance this framework manages, identified by the management
     * tag/label. Must never include unrelated instances in the account.
     * @param {string} managementTag
     * @returns {Promise<Array<import('./ComputeInstanceDescriptor')>>}
     */
    async listManagedInstances(managementTag)
    {
        throw new Error("CloudComputeProvider.listManagedInstances() must be implemented by subclass");
    }

    /**
     * Provisions and boots one new managed instance from the given vendor-neutral
     * specification, returning its normalized descriptor (or null on failure).
     * @param {object} provisioningSpecification
     * @returns {Promise<import('./ComputeInstanceDescriptor')|null>}
     */
    async createInstance(provisioningSpecification)
    {
        throw new Error("CloudComputeProvider.createInstance() must be implemented by subclass");
    }

    /**
     * Powers the instance off (without deleting it). Returns true on success.
     * @param {string} instanceId
     * @returns {Promise<boolean>}
     */
    async shutdownInstance(instanceId)
    {
        throw new Error("CloudComputeProvider.shutdownInstance() must be implemented by subclass");
    }

    /**
     * Destroys the instance permanently. Returns true on success.
     * @param {string} instanceId
     * @returns {Promise<boolean>}
     */
    async deleteInstance(instanceId)
    {
        throw new Error("CloudComputeProvider.deleteInstance() must be implemented by subclass");
    }

    /**
     * Fetches a single instance's current descriptor, or null if it no longer exists.
     * @param {string} instanceId
     * @returns {Promise<import('./ComputeInstanceDescriptor')|null>}
     */
    async getInstance(instanceId)
    {
        throw new Error("CloudComputeProvider.getInstance() must be implemented by subclass");
    }
}

module.exports = CloudComputeProvider;
