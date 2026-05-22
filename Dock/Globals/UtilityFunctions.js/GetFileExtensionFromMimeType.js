const mime = require("mime-types");

function getFileExtensionFromMimeType(mimeType)
{
    const ext = mime.extension(mimeType);
    return ext ? "." + ext : "";
}

module.exports = { getFileExtensionFromMimeType };