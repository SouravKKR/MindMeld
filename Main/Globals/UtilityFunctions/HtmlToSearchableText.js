export function htmlToSearchableText(htmlString)
{
    // Parse into an INERT document (DOMParser) rather than assigning to a
    // live element's innerHTML. The input is untrusted card / study-material
    // HTML; a live `document.createElement("div").innerHTML = htmlString`
    // would fire `<img src=x onerror=...>` / `<svg onload>` the instant it is
    // assigned — before any cleanup runs. An inert document never loads
    // resources or runs handlers, so reading its text is safe.
    const parsedDocument = new DOMParser().parseFromString(
        "<!doctype html><body>" + (htmlString || "") + "</body>",
        "text/html"
    );

    parsedDocument.body.querySelectorAll("img, video, audio, svg, canvas, iframe").forEach(element => element.remove());

    return parsedDocument.body.textContent || "";
}