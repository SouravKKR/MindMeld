export function htmlToSearchableText(htmlString)
{
    const container = document.createElement("div");
    container.innerHTML = htmlString;

    container.querySelectorAll("img, video, audio, svg, canvas, iframe").forEach(element => element.remove());

    return container.textContent || "";
}