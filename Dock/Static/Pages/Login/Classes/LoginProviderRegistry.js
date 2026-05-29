/**
 * LoginProviderRegistry
 *
 * Static registry of available LoginProvider instances. LoginPage reads
 * from here at render time to build its picker, so adding a provider
 * is a single `register(...)` call from the provider's own module — no
 * changes to LoginPage required.
 */
class LoginProviderRegistry
{
    static #providers = [];

    static register(provider)
    {
        LoginProviderRegistry.#providers.push(provider);
    }

    static getAll()
    {
        return [...LoginProviderRegistry.#providers];
    }
}

export default LoginProviderRegistry;
