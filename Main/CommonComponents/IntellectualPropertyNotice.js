/**
 * IntellectualPropertyNotice
 *
 * The single source of the third-party-content disclaimer shown wherever a user
 * moves material across the platform boundary. It exists as one component,
 * rather than as markup repeated per dialog, so the wording and the styling of
 * the notice cannot drift between the places it appears — the legal text is the
 * point of it, and two copies would eventually say two different things.
 *
 * Variants, selected with the `context` attribute:
 *
 *   context="export"   — the user is taking a deck OUT of the platform and
 *                        potentially sharing it. The risk being disclaimed is
 *                        redistribution.
 *
 *   context="upload"   — the user is bringing a document IN for generation. The
 *                        risk being disclaimed is uploading material they do not
 *                        hold the rights to. This is the wording that matters
 *                        most: an uploaded textbook is the case the per-user
 *                        storage split (see InformationSourceUpload.js) is built
 *                        around, and the notice is what makes the user's
 *                        responsibility explicit at the moment they act.
 *
 * An unrecognised or absent context falls back to the upload wording, because
 * an over-broad disclaimer is harmless where a missing one is not.
 */
class IntellectualPropertyNotice extends HTMLElement
{
    static tagName = "intellectual-property-notice";

    static #STYLE_ID = "intellectual-property-notice-style";

    static #EXPORT_CONTEXT = "export";

    // Kept as data rather than branching markup so adding a context is one entry
    // here, not another template literal to keep in sync.
    static #NOTICE_TEXT_BY_CONTEXT =
    {
        export:
        {
            heading: "You are responsible for any third-party content in this deck.",
            body: "By exporting and sharing it, you confirm you have the rights to do so. CogniumLearn does not verify ownership of exported material."
        },
        upload:
        {
            heading: "You are responsible for any third-party content you upload.",
            body: "By uploading this document you confirm you own it or otherwise have the rights to use it here. Your upload is stored privately to your account and is never shared with other users. CogniumLearn does not verify ownership of uploaded material."
        }
    };

    connectedCallback()
    {
        IntellectualPropertyNotice.#ensureStylesInjected();

        const requestedContext = (this.getAttribute("context") || "").trim().toLowerCase();
        const noticeText = IntellectualPropertyNotice.#NOTICE_TEXT_BY_CONTEXT[requestedContext]
            ?? IntellectualPropertyNotice.#NOTICE_TEXT_BY_CONTEXT.upload;

        this.innerHTML =
        `
            <strong>${noticeText.heading}</strong>
            ${noticeText.body}
        `;
    }

    /**
     * Injects the shared stylesheet once per document. The notice is rendered
     * inside dialogs that are created and destroyed repeatedly, so styling it
     * from a per-instance <style> block would accumulate duplicate rules.
     */
    static #ensureStylesInjected()
    {
        if (document.getElementById(IntellectualPropertyNotice.#STYLE_ID) !== null)
        {
            return;
        }

        const styleElement = document.createElement("style");
        styleElement.id = IntellectualPropertyNotice.#STYLE_ID;
        styleElement.textContent =
        `
            intellectual-property-notice
            {
                display: block;
                margin: 0 0 6px 0;
                padding: 8px 10px;
                border-radius: 6px;
                border: 1px solid rgba(220, 150, 60, 0.5);
                background-color: rgba(220, 150, 60, 0.08);
                font-size: 12px;
                line-height: 1.4;
            }

            intellectual-property-notice strong
            {
                color: rgb(230, 170, 80);
            }

            @media (orientation: portrait), (max-width: 600px)
            {
                intellectual-property-notice
                {
                    font-size: 11.5px;
                    padding: 7px 9px;
                }
            }
        `;

        document.head.appendChild(styleElement);
    }
}

customElements.define(IntellectualPropertyNotice.tagName, IntellectualPropertyNotice);
export default IntellectualPropertyNotice;
