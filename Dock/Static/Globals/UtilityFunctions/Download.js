export function download(buffer, fileName, mimeType = "application/octet-stream")
{
    if(typeof buffer === "string")
    {
        buffer = new TextEncoder().encode(buffer);
    }

    const blob = new Blob([buffer],
    {
        type: mimeType
    });

    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();

    URL.revokeObjectURL(url);
}