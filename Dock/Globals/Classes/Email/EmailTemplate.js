/**
 * Builds the shared CogniumLearn email HTML shell so every transactional email
 * — sign-in codes today, notification / feature-release messages later — reads
 * as one brand. Callers supply only their heading and inner body markup; the
 * outer card, spacing, and footer note are applied here. This is deliberately
 * the ONLY place email chrome lives, so a future email type never re-invents
 * the layout and a brand tweak is a single edit.
 */
class EmailTemplate
{
    static #CONTAINER_STYLE = "font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background-color: #ffffff; color: #1a1a1a;";
    static #HEADING_STYLE = "font-size: 20px; margin: 0 0 16px 0;";
    static #PARAGRAPH_STYLE = "font-size: 14px; line-height: 1.5; margin: 0 0 24px 0; color: #4a4a4a;";
    static #FOOTER_STYLE = "font-size: 13px; line-height: 1.5; margin: 24px 0 0 0; color: #6a6a6a;";
    static #CODE_STYLE = "font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 32px; font-weight: 600; letter-spacing: 8px; padding: 20px 24px; background-color: #f5f5f7; border-radius: 8px; text-align: center; color: #1a1a1a;";

    /**
     * Escapes a value for safe interpolation into email HTML. Every dynamic
     * value (codes, names, organization names) passes through here so a stray
     * "<" or "&" can never break the markup or inject content.
     */
    static escapeHtml(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * Wraps caller-provided inner HTML in the standard card. `innerHtml` is
     * assumed to already be built from EmailTemplate helpers (and therefore
     * already escaped) — it is inserted verbatim.
     */
    static wrap(innerHtml)
    {
        return `<div style="${EmailTemplate.#CONTAINER_STYLE}">${innerHtml}</div>`;
    }

    static heading(text)
    {
        return `<h1 style="${EmailTemplate.#HEADING_STYLE}">${EmailTemplate.escapeHtml(text)}</h1>`;
    }

    static paragraph(text)
    {
        return `<p style="${EmailTemplate.#PARAGRAPH_STYLE}">${EmailTemplate.escapeHtml(text)}</p>`;
    }

    static footer(text)
    {
        return `<p style="${EmailTemplate.#FOOTER_STYLE}">${EmailTemplate.escapeHtml(text)}</p>`;
    }

    /**
     * The large monospace code block shared by the sign-in and org-admin
     * verification emails.
     */
    static codeBlock(code)
    {
        return `<div style="${EmailTemplate.#CODE_STYLE}">${EmailTemplate.escapeHtml(code)}</div>`;
    }

    /**
     * Convenience for the common heading + intro + code + footer shape, used
     * by both verification-code emails. Returns a fully wrapped HTML document
     * body ready to drop into an EmailMessage.
     */
    static buildCodeEmail(headingText, introText, code, footerText)
    {
        const innerHtml =
            EmailTemplate.heading(headingText) +
            EmailTemplate.paragraph(introText) +
            EmailTemplate.codeBlock(code) +
            EmailTemplate.footer(footerText);

        return EmailTemplate.wrap(innerHtml);
    }
}

module.exports = EmailTemplate;
