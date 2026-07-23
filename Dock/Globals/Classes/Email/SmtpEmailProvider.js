const nodemailer = require("nodemailer");
const EmailProvider = require("./EmailProvider");
const App = require("../App");
const { emailProviderTypes } = require("../../Enumerations/EmailProviderTypes");

/**
 * SMTP email transport via nodemailer. This is the platform's previous email
 * path, preserved as a selectable provider (DEFAULT_EMAIL_PROVIDER=SMTP) so a
 * fallback exists and nothing is lost in the move to SES. Not the active
 * provider by default.
 */
class SmtpEmailProvider extends EmailProvider
{
    #transporter = null;

    getProviderEnumValue()
    {
        return emailProviderTypes.SMTP;
    }

    isConfigured()
    {
        return App.getSmtpHost().length > 0
            && App.getSmtpPort() > 0
            && App.getSmtpUser().length > 0
            && App.getSmtpPassword().length > 0;
    }

    #getTransporter()
    {
        if (this.#transporter !== null)
        {
            return this.#transporter;
        }

        if (!this.isConfigured())
        {
            throw new Error("SMTP is not configured — set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD in Dock/.env");
        }

        const port = App.getSmtpPort();

        this.#transporter = nodemailer.createTransport
        ({
            host: App.getSmtpHost(),
            port: port,
            secure: port === 465,
            auth:
            {
                user: App.getSmtpUser(),
                pass: App.getSmtpPassword()
            }
        });

        return this.#transporter;
    }

    async sendEmail(emailMessage)
    {
        if (!emailMessage.isDispatchable())
        {
            throw new Error("SmtpEmailProvider.sendEmail() received an incomplete EmailMessage");
        }

        await this.#getTransporter().sendMail
        ({
            from: emailMessage.getSourceEmail(),
            to: emailMessage.getRecipientEmail(),
            subject: emailMessage.getSubject(),
            text: emailMessage.getPlainTextBody(),
            html: emailMessage.getHtmlBody()
        });
    }
}

module.exports = SmtpEmailProvider;
