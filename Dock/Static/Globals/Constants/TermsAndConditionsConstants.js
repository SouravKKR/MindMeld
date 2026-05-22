/**
 * Static UI strings for the legal-document agreement flow. Real document
 * content (Terms of Service, Privacy Policy) is fetched at login from
 * the server's `/LegalDocuments` endpoint; only the button copy +
 * download filename lives here, because those don't change per document.
 */
class TermsAndConditionsConstants
{
    static DOWNLOAD_FILE_NAME_TEMPLATE = "MindMeld-{title}.{ext}";

    static AGREE_BUTTON_LABEL    = "I Agree";
    static DECLINE_BUTTON_LABEL  = "Decline & Log out";
    static DOWNLOAD_BUTTON_LABEL = "Download";
}

export default TermsAndConditionsConstants;
