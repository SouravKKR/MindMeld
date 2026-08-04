/**
 * Writes text to the system clipboard, falling back to the legacy execCommand
 * path where the async Clipboard API is unavailable — older webviews, and any
 * non-secure context (plain-http local development, where navigator.clipboard
 * is simply not exposed).
 *
 * Resolves to true when the text is believed to have reached the clipboard, so
 * a caller can decide whether to show "Copied" feedback or leave the user to
 * select the text by hand.
 */
export async function copyTextToClipboard(text)
{
    const textToCopy = typeof text === "string" ? text : "";
    if (textToCopy.length === 0)
    {
        return false;
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function")
    {
        try
        {
            await navigator.clipboard.writeText(textToCopy);
            return true;
        }
        catch (clipboardError)
        {
            console.warn(`[copyTextToClipboard] Clipboard API write failed; falling back to execCommand. ${clipboardError?.message || clipboardError}`);
        }
    }

    // Legacy fallback: drop the text into an off-screen textarea, select it,
    // execCommand("copy"), then remove the helper.
    const helperTextarea = document.createElement("textarea");
    helperTextarea.value = textToCopy;
    helperTextarea.setAttribute("readonly", "");
    helperTextarea.style.position = "fixed";
    helperTextarea.style.top = "-1000px";
    helperTextarea.style.left = "-1000px";
    document.body.appendChild(helperTextarea);
    helperTextarea.select();

    let bCopySucceeded = false;
    try
    {
        bCopySucceeded = document.execCommand("copy");
    }
    catch (legacyCopyError)
    {
        console.warn(`[copyTextToClipboard] execCommand copy fallback failed. ${legacyCopyError?.message || legacyCopyError}`);
    }

    helperTextarea.remove();
    return bCopySucceeded;
}
