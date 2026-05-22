import SearchableDropdown from "./SearchableDropdown.js";


/**
 * Thin wrapper around SearchableDropdown that wires up the
 * server-paginated /Templates/Search endpoint. The dialog only
 * resolves the chosen template `key`; the calling page fetches the
 * full template payload via /Templates/Get in a separate round trip.
 */
class TemplatePickerDialog
{
    static SEARCH_ENDPOINT     = "/Templates/Search";
    static DEFAULT_RESULT_LIMIT = 20;

    /**
     * @returns {Promise<string|null>} Template key, or null on cancel.
     */
    static show()
    {
        return SearchableDropdown.show
        ({
            title:             "Choose a generation template",
            searchPlaceholder: "Search templates...",
            resultLimit:       TemplatePickerDialog.DEFAULT_RESULT_LIMIT,
            emptyStateMessage: "No templates match your search.",
            loadItems: async (queryText, resultLimit, abortSignal) =>
            {
                const requestUrl = new URL(TemplatePickerDialog.SEARCH_ENDPOINT, window.location.origin);
                if (queryText)
                {
                    requestUrl.searchParams.set("query", queryText);
                }
                requestUrl.searchParams.set("limit", String(resultLimit));

                const response = await fetch(requestUrl.toString(),
                {
                    signal: abortSignal,
                    credentials: "same-origin",
                });

                if (!response.ok)
                {
                    throw new Error(`/Templates/Search returned ${response.status}`);
                }

                return await response.json();
            },
        });
    }
}

export default TemplatePickerDialog;
