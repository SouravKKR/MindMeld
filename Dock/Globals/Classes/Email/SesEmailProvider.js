const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const EmailProvider = require("./EmailProvider");
const App = require("../App");
const { emailProviderTypes } = require("../../Enumerations/EmailProviderTypes");

/**
 * The active email transport: Amazon SES via @aws-sdk/client-sesv2 — the v2 SES
 * API (2019-09-27) AWS recommends for new applications. Credentials and region
 * come from env through App (SES_REGION / SES_ACCESS_KEY_ID /
 * SES_SECRET_ACCESS_KEY) — the same env-then-GSM pattern the S3 storage client
 * already uses. The SESv2Client is created lazily and cached so a single client
 * is reused across the process.
 */
class SesEmailProvider extends EmailProvider
{
    #client = null;

    getProviderEnumValue()
    {
        return emailProviderTypes.SES;
    }

    isConfigured()
    {
        return App.getSesRegion().length > 0
            && App.getSesAccessKeyId().length > 0
            && App.getSesSecretAccessKey().length > 0;
    }

    #getClient()
    {
        if (this.#client !== null)
        {
            return this.#client;
        }

        if (!this.isConfigured())
        {
            throw new Error("AWS SES is not configured — set SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY in Dock/.env");
        }

        this.#client = new SESv2Client
        ({
            region: App.getSesRegion(),
            credentials:
            {
                accessKeyId: App.getSesAccessKeyId(),
                secretAccessKey: App.getSesSecretAccessKey()
            }
        });

        return this.#client;
    }

    /**
     * Builds the SESv2 SendEmailCommand input from an EmailMessage. Split out
     * from sendEmail so the mapping is unit-testable without a live SES client.
     * The v2 API nests the message under Content.Simple and names the sender
     * FromEmailAddress (the v1 API used Source + a top-level Message).
     *
     * FromEmailAddress takes the full formatted address, so a message carrying
     * a display name arrives as `"CogniumLearn Security" <noreply@…>`. Only the
     * address part has to be a verified SES identity — the name beside it is
     * free text SES passes straight through.
     */
    buildSendEmailCommandInput(emailMessage)
    {
        return {
            FromEmailAddress: emailMessage.getFormattedSourceAddress(),
            Destination:
            {
                ToAddresses: [emailMessage.getRecipientEmail()]
            },
            Content:
            {
                Simple:
                {
                    Subject:
                    {
                        Data: emailMessage.getSubject(),
                        Charset: "UTF-8"
                    },
                    Body:
                    {
                        Text:
                        {
                            Data: emailMessage.getPlainTextBody(),
                            Charset: "UTF-8"
                        },
                        Html:
                        {
                            Data: emailMessage.getHtmlBody(),
                            Charset: "UTF-8"
                        }
                    }
                }
            }
        };
    }

    async sendEmail(emailMessage)
    {
        if (!emailMessage.isDispatchable())
        {
            throw new Error("SesEmailProvider.sendEmail() received an incomplete EmailMessage");
        }

        const command = new SendEmailCommand(this.buildSendEmailCommandInput(emailMessage));
        await this.#getClient().send(command);
    }
}

module.exports = SesEmailProvider;
