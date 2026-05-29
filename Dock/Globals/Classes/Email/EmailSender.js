const nodemailer = require("nodemailer");
const App = require("../App");

class EmailSender
{
    static #transporter = null;

    static #getTransporter()
    {
        if (EmailSender.#transporter !== null)
        {
            return EmailSender.#transporter;
        }

        const host = App.getSmtpHost();
        const port = App.getSmtpPort();
        const user = App.getSmtpUser();
        const password = App.getSmtpPassword();

        if (!host || !port || !user || !password)
        {
            throw new Error("SMTP configuration is incomplete — set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD in Dock/.env");
        }

        EmailSender.#transporter = nodemailer.createTransport
        ({
            host: host,
            port: port,
            secure: port === 465,
            auth:
            {
                user: user,
                pass: password
            }
        });

        return EmailSender.#transporter;
    }

    static async sendOtpEmail(toEmailAddress, sixDigitCode)
    {
        const sourceEmail = App.getSmtpSourceEmail();
        if (!sourceEmail)
        {
            throw new Error("SMTP_SOURCE_EMAIL is not configured");
        }

        const subject = "Your MindMeld sign-in code";
        const plainTextBody =
            `Your MindMeld sign-in code is: ${sixDigitCode}\n\n` +
            `This code expires in 10 minutes. If you didn't request this, you can ignore this email.`;

        const htmlBody =
            `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background-color: #ffffff; color: #1a1a1a;">` +
                `<h1 style="font-size: 20px; margin: 0 0 16px 0;">Your MindMeld sign-in code</h1>` +
                `<p style="font-size: 14px; line-height: 1.5; margin: 0 0 24px 0; color: #4a4a4a;">Enter this code to finish signing in:</p>` +
                `<div style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 32px; font-weight: 600; letter-spacing: 8px; padding: 20px 24px; background-color: #f5f5f7; border-radius: 8px; text-align: center; color: #1a1a1a;">${sixDigitCode}</div>` +
                `<p style="font-size: 13px; line-height: 1.5; margin: 24px 0 0 0; color: #6a6a6a;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>` +
            `</div>`;

        await EmailSender.#getTransporter().sendMail
        ({
            from: sourceEmail,
            to: toEmailAddress,
            subject: subject,
            text: plainTextBody,
            html: htmlBody
        });
    }
}

module.exports = EmailSender;
