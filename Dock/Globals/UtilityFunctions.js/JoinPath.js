function joinPath(separator, ...parts)
{
    return parts
        .filter(part => part)
        .map(part => part.replaceAll("\\", separator).split(separator).filter(segment => segment).join(separator))
        .join(separator);
}

module.exports = { joinPath };