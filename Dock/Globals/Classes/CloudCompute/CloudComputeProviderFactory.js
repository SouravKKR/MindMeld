const LinodeComputeProvider = require("./LinodeComputeProvider");
const { cloudComputeProviders } = require("../../Enumerations/CloudComputeProviders");

// Selects the active cloud compute backend from DEFAULT_CLOUD_COMPUTE_PROVIDER,
// exactly mirroring PaymentProviderFactory. Adding a new cloud is one new
// concrete file + one switch branch + one CloudComputeProviders.json entry — the
// autoscaler never changes.

class CloudComputeProviderFactory
{
    static #cache = new Map();

    static getProvider(providerEnumValue)
    {
        if (CloudComputeProviderFactory.#cache.has(providerEnumValue))
        {
            return CloudComputeProviderFactory.#cache.get(providerEnumValue);
        }

        let provider = null;

        switch (providerEnumValue)
        {
            case cloudComputeProviders.LINODE:
                provider = new LinodeComputeProvider();
                break;
            default:
                throw new Error(`Unknown cloud compute provider: ${providerEnumValue}`);
        }

        CloudComputeProviderFactory.#cache.set(providerEnumValue, provider);
        return provider;
    }

    static getDefaultProvider()
    {
        const configuredName = (process.env.DEFAULT_CLOUD_COMPUTE_PROVIDER || "LINODE").toUpperCase();
        const enumValue = cloudComputeProviders[configuredName];

        if (enumValue === undefined)
        {
            console.warn(`[CloudComputeProviderFactory] Unknown DEFAULT_CLOUD_COMPUTE_PROVIDER="${configuredName}"; falling back to LINODE.`);
            return CloudComputeProviderFactory.getProvider(cloudComputeProviders.LINODE);
        }

        return CloudComputeProviderFactory.getProvider(enumValue);
    }
}

module.exports = CloudComputeProviderFactory;
