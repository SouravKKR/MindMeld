// Converts an UPPER_SNAKE_CASE enumeration name into a human "Title Case"
// label for display, e.g. "ON_SUCCESS" -> "On Success". Purely for the UI;
// the underlying value passed around in code stays the raw enum name.
export function enumerationToTitleCase(enumeration)
{
    return String(enumeration)
        .toLowerCase()
        .split('_')
        .map(
            word => word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join(' ');
}

// Inverse of enumerationToTitleCase: turns a "Title Case" label back into its
// UPPER_SNAKE_CASE enumeration name, e.g. "On Success" -> "ON_SUCCESS".
export function titleCaseToEnumeration(label)
{
    return String(label)
        .trim()
        .split(/\s+/)
        .map(word => word.toUpperCase())
        .join('_');
}