const SesEmailProvider = require("./SesEmailProvider");
const SmtpEmailProvider = require("./SmtpEmailProvider");
const { emailProviderTypes } = require("../../Enumerations/EmailProviderTypes");

/**
 * Selects and caches the active email transport, mirroring
 * PaymentProviderFactory. The active provider is chosen by the
 * DEFAULT_EMAIL_PROVIDER env var (name of an EmailProviderTypes member),
 * defaulting to SES. EmailSender always dispatches through
 * getDefaultProvider(), so switching transports is a single env change with no
 * code edits.
 */
class EmailProviderFactory
{
    static #cache = new Map();

    static getProvider(providerEnumValue)
    {
        if (EmailProviderFactory.#cache.has(providerEnumValue))
        {
            return EmailProviderFactory.#cache.get(providerEnumValue);
        }

        let provider = null;

        switch (providerEnumValue)
        {
            case emailProviderTypes.SES:
                provider = new SesEmailProvider();
                break;
            case emailProviderTypes.SMTP:
                provider = new SmtpEmailProvider();
                break;
            default:
                throw new Error(`Unknown email provider: ${providerEnumValue}`);
        }

        EmailProviderFactory.#cache.set(providerEnumValue, provider);
        return provider;
    }

    static getDefaultProvider()
    {
        const configuredName = (process.env.DEFAULT_EMAIL_PROVIDER || "SES").toUpperCase();
        const enumValue = emailProviderTypes[configuredName];

        if (enumValue === undefined)
        {
            return EmailProviderFactory.getProvider(emailProviderTypes.SES);
        }

        return EmailProviderFactory.getProvider(enumValue);
    }

    static listAvailableProviders()
    {
        const available = [];

        for (const [name, enumValue] of Object.entries(emailProviderTypes))
        {
            try
            {
                const provider = EmailProviderFactory.getProvider(enumValue);
                if (provider.isConfigured())
                {
                    available.push({ name: name, enumValue: enumValue });
                }
            }
            catch (factoryError)
            {
                continue;
            }
        }

        return available;
    }
}

module.exports = EmailProviderFactory;
