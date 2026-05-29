import LegalDocumentPdfRenderer from "../../../Globals/Classes/LegalDocumentPdfRenderer.js";

/**
 * LegalDocumentDownloader
 *
 * Terms-of-Service / Privacy-Policy downloader used by the LoginPage.
 * Renders the document to a PDF (preserving headings / bullets / bold
 * runs) via LegalDocumentPdfRenderer — the same renderer the
 * authenticated SPA uses — so the downloaded artifact matches what a
 * logged-in user would receive.
 *
 * The renderer relies on the jsPDF UMD bundle being loaded as a plain
 * <script> tag (it reads `window.jspdf.jsPDF`). login.html includes
 * that script tag; if it ever fails to load or PDF rendering throws,
 * we fall back to a plain-text download so users can still leave with
 * a readable copy of the document.
 *
 * The fully-featured TermsAndConditionsManager continues to own the
 * post-login agreement modal flow inside the authenticated SPA; this
 * class is the slim, modal-less subset used by the login shell.
 */
class LegalDocumentDownloader
{
    static #LEGAL_DOCUMENTS_ENDPOINT = "/LegalDocuments";

    static async download(documentKey)
    {
        let legalDocuments;
        try
        {
            const response = await fetch(LegalDocumentDownloader.#LEGAL_DOCUMENTS_ENDPOINT);
            if (!response.ok)
            {
                console.error(`[LegalDocumentDownloader] HTTP ${response.status}`);
                return;
            }
            legalDocuments = await response.json();
        }
        catch (fetchError)
        {
            console.error("[LegalDocumentDownloader] fetch failed:", fetchError);
            return;
        }

        const matchingDocument = Array.isArray(legalDocuments)
            ? legalDocuments.find((entry) => entry.key === documentKey)
            : null;

        if (!matchingDocument)
        {
            return;
        }

        LegalDocumentDownloader.#triggerDownload(matchingDocument);
    }

    static #triggerDownload(legalDocument)
    {
        let blob;
        let fileExtension;
        try
        {
            blob = LegalDocumentPdfRenderer.renderToBlob(legalDocument);
            fileExtension = "pdf";
        }
        catch (renderError)
        {
            // Fall back to plain text only if the PDF pipeline outright
            // fails (e.g. jsPDF script missing on a stripped login shell
            // build) so users can still leave with a readable copy.
            console.error("[LegalDocumentDownloader] PDF render failed, falling back to plain text:", renderError);
            const plainText = LegalDocumentDownloader.#stripHtmlToPlainText(legalDocument.contentHtml);
            blob = new Blob([plainText], { type: "text/plain;charset=utf-8" });
            fileExtension = "txt";
        }

        const downloadUrl = URL.createObjectURL(blob);
        const safeBaseName = (legalDocument.title || "Legal-Document").replace(/\s+/g, "-");
        const fileName = `${safeBaseName}.${fileExtension}`;

        const anchorElement = document.createElement("a");
        anchorElement.href     = downloadUrl;
        anchorElement.download = fileName;
        document.body.appendChild(anchorElement);
        anchorElement.click();
        anchorElement.remove();

        URL.revokeObjectURL(downloadUrl);
    }

    static #stripHtmlToPlainText(rawHtml)
    {
        if (typeof rawHtml !== "string")
        {
            return "";
        }
        const parser = new DOMParser();
        const parsedDocument = parser.parseFromString(rawHtml, "text/html");
        return parsedDocument.body.innerText.trim();
    }
}

export default LegalDocumentDownloader;
