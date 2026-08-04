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
    // Email images must be absolute and publicly reachable, so they point at
    // the live site rather than the sending environment's own domain — the
    // logos are identical everywhere and the development / testing nodes are
    // usually parked, which would leave their emails with broken images.
    // Both files are email-sized copies of the brand masters (rendered at twice
    // their display box for retina), because a linked image is a download the
    // recipient pays for on every open.
    static ASSET_BASE_URL = "https://learn.cogniumlabs.io";
    static PRODUCT_LOGO_URL = `${EmailTemplate.ASSET_BASE_URL}/Globals/Assets/Images/Logos/CogniumLearnLogoEmail.png`;
    static COMPANY_LOGO_URL = `${EmailTemplate.ASSET_BASE_URL}/Globals/Assets/Images/Logos/CogniumLabsLogoEmail.png`;

    // Where a notification email's action button points. The frontend is a
    // Web-Component page stack with no URL-addressable routes — PageNavigator
    // pushes history sentinels, not paths — so the app root is the deepest
    // honest target today. Deliberately carries NO query string: the root route
    // 404s when one is appended (packetron path normalisation), so a tracking
    // parameter would have to go on /index.html instead.
    static CALL_TO_ACTION_URL = EmailTemplate.ASSET_BASE_URL;

    static #CONTAINER_STYLE = "font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background-color: #ffffff; color: #1a1a1a;";
    static #BRAND_ROW_STYLE = "margin: 0 0 24px 0;";
    static #PRODUCT_LOGO_STYLE = "display: block; border: 0;";
    static #HEADING_STYLE = "font-size: 20px; margin: 0 0 16px 0;";
    static #PARAGRAPH_STYLE = "font-size: 14px; line-height: 1.5; margin: 0 0 24px 0; color: #4a4a4a;";
    static #FOOTER_STYLE = "font-size: 13px; line-height: 1.5; margin: 24px 0 0 0; color: #6a6a6a;";
    // white-space: nowrap keeps the code on ONE line in every client; the size
    // and letter-spacing are chosen so six digits stay well inside the 480px
    // card even on a narrow phone.
    static #CODE_STYLE = "font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 28px; font-weight: 600; letter-spacing: 6px; white-space: nowrap; padding: 16px 20px; background-color: #f5f5f7; border-radius: 8px; text-align: center; color: #1a1a1a;";
    static #SIGNATURE_STYLE = "margin: 28px 0 0 0; padding-top: 16px; border-top: 1px solid #e5e5e7; font-size: 12px; color: #8a8a8a;";
    // The Cognium Labs lockup is drawn for a dark background, so it keeps its
    // own dark plate here rather than being washed out on the white card.
    static #COMPANY_LOGO_STYLE = "vertical-align: middle; margin-left: 8px; border: 0; border-radius: 6px;";
    // A quoted block for text an admin typed (a support resolution note). The left
    // rule visually separates "what a human wrote to you" from the surrounding
    // automated copy, and the softer background keeps it from competing with the
    // heading.
    static #QUOTE_STYLE = "font-size: 14px; line-height: 1.6; margin: 0 0 24px 0; padding: 16px 20px; background-color: #f5f5f7; border-left: 3px solid #1a1a1a; border-radius: 6px; color: #1a1a1a; white-space: pre-wrap;";
    static #HIGHLIGHT_STYLE = "font-size: 14px; line-height: 1.5; margin: 0 0 24px 0; padding: 14px 18px; background-color: #f0f7f2; border-radius: 6px; color: #1f5132; font-weight: 600;";
    // A plain styled anchor rather than table/VML button chrome: it degrades to
    // an ordinary link in every client, and the same URL is repeated in the
    // plain-text body for the ones that strip styling entirely.
    static #CALL_TO_ACTION_STYLE = "display: inline-block; padding: 12px 24px; margin: 0 0 24px 0; background-color: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;";

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
     * The CogniumLearn logo at the top of every email. The alt text carries the
     * product name on its own, so the header still reads correctly in the many
     * clients that block remote images by default.
     */
    static brandHeader()
    {
        return `<div style="${EmailTemplate.#BRAND_ROW_STYLE}">`
            + `<img src="${EmailTemplate.PRODUCT_LOGO_URL}" width="160" height="80" alt="CogniumLearn" style="${EmailTemplate.#PRODUCT_LOGO_STYLE}">`
            + `</div>`;
    }

    /**
     * The Cognium Labs attribution closing every email, mirroring the "by
     * Cognium Labs" mark on the app's own login screen.
     */
    static companySignature()
    {
        return `<div style="${EmailTemplate.#SIGNATURE_STYLE}">`
            + `<span style="vertical-align: middle;">by</span>`
            + `<img src="${EmailTemplate.COMPANY_LOGO_URL}" width="120" height="53" alt="Cognium Labs" style="${EmailTemplate.#COMPANY_LOGO_STYLE}">`
            + `</div>`;
    }

    /**
     * Convenience for the common heading + intro + code + footer shape, used
     * by both verification-code emails. Returns a fully wrapped HTML document
     * body ready to drop into an EmailMessage.
     */
    static buildCodeEmail(headingText, introText, code, footerText)
    {
        const innerHtml =
            EmailTemplate.brandHeader() +
            EmailTemplate.heading(headingText) +
            EmailTemplate.paragraph(introText) +
            EmailTemplate.codeBlock(code) +
            EmailTemplate.footer(footerText) +
            EmailTemplate.companySignature();

        return EmailTemplate.wrap(innerHtml);
    }

    /**
     * The single primary action of a notification email. Both the label and the
     * URL are escaped — the URL lands in an href attribute, and escapeHtml
     * already neutralises the quote characters that would break out of it.
     */
    static callToActionButton(labelText, targetUrl)
    {
        return `<a href="${EmailTemplate.escapeHtml(targetUrl)}" style="${EmailTemplate.#CALL_TO_ACTION_STYLE}">${EmailTemplate.escapeHtml(labelText)}</a>`;
    }

    /**
     * The generic notification email — "your study set is ready" and every
     * future notification of that shape. Third sibling of buildCodeEmail and
     * buildSupportTicketEmail: same brandHeader() first and companySignature()
     * last, so a completion email carries the CogniumLearn logo and the "by
     * Cognium Labs" mark exactly like the sign-in code email does.
     *
     * Every argument is escaped by the helper it passes through, so callers hand
     * over raw text. Empty highlight / action / footer values omit their block.
     *
     * @param {string} headingText
     * @param {string} introText
     * @param {string} highlightText emphasised one-liner ("" to omit)
     * @param {string} callToActionLabel button label ("" to omit the button)
     * @param {string} callToActionUrl where the button points
     * @param {string} footerText
     * @returns {string}
     */
    static buildNotificationEmail(headingText, introText, highlightText, callToActionLabel, callToActionUrl, footerText)
    {
        const innerHtml =
            EmailTemplate.brandHeader() +
            EmailTemplate.heading(headingText) +
            EmailTemplate.paragraph(introText) +
            (String(highlightText ?? "").trim().length > 0 ? EmailTemplate.highlight(highlightText) : "") +
            (String(callToActionLabel ?? "").trim().length > 0 ? EmailTemplate.callToActionButton(callToActionLabel, callToActionUrl) : "") +
            (String(footerText ?? "").trim().length > 0 ? EmailTemplate.footer(footerText) : "") +
            EmailTemplate.companySignature();

        return EmailTemplate.wrap(innerHtml);
    }

    /**
     * A quoted block carrying text an admin wrote by hand. Newlines are preserved
     * (white-space: pre-wrap) so a multi-paragraph resolution note keeps the shape
     * it was typed in, while the content itself is still escaped.
     */
    static quote(text)
    {
        return `<div style="${EmailTemplate.#QUOTE_STYLE}">${EmailTemplate.escapeHtml(text)}</div>`;
    }

    /**
     * A single emphasised line, used for the credit reward on a resolution email.
     */
    static highlight(text)
    {
        return `<div style="${EmailTemplate.#HIGHLIGHT_STYLE}">${EmailTemplate.escapeHtml(text)}</div>`;
    }

    /**
     * The support-ticket outcome email: heading, a lead-in, the admin's own words
     * in a quote block, an optional reward highlight, and the standard footer.
     *
     * Sibling of buildCodeEmail — same chrome, different middle. Every argument is
     * escaped by the helpers it passes through, so callers hand over raw text.
     *
     * @param {string} headingText
     * @param {string} introText
     * @param {string} quotedMessage the admin's resolution / decline note ("" to omit the block)
     * @param {string} highlightText the reward line ("" to omit)
     * @param {string} footerText
     * @returns {string}
     */
    static buildSupportTicketEmail(headingText, introText, quotedMessage, highlightText, footerText)
    {
        const innerHtml =
            EmailTemplate.brandHeader() +
            EmailTemplate.heading(headingText) +
            EmailTemplate.paragraph(introText) +
            (String(quotedMessage ?? "").trim().length > 0 ? EmailTemplate.quote(quotedMessage) : "") +
            (String(highlightText ?? "").trim().length > 0 ? EmailTemplate.highlight(highlightText) : "") +
            EmailTemplate.footer(footerText) +
            EmailTemplate.companySignature();

        return EmailTemplate.wrap(innerHtml);
    }
}

module.exports = EmailTemplate;
