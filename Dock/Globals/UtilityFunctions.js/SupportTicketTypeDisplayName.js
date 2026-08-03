const { supportTicketTypes } = require("../Enumerations/SupportTicketTypes");

// Maps a SupportTicketTypes VALUE back to its enum NAME once, so the lookup below
// is a plain object read rather than a scan per row.
const SUPPORT_TICKET_TYPE_NAME_BY_VALUE = Object.fromEntries(Object.entries(supportTicketTypes).map(([typeName, typeValue]) => [typeValue, typeName]));

function titleCaseEnumerationName(enumerationName)
{
    return String(enumerationName)
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (firstCharacter) => firstCharacter.toUpperCase());
}

/**
 * Resolves a SupportTicketTypes enum VALUE to the label shown in the admin list.
 *
 * There is deliberately no override table: the enum member names were chosen so a
 * plain title-casing reads correctly ("GENERATION_QUALITY" → "Generation Quality"),
 * which lets the client dropdown title-case the very same names through
 * ConvertElementToEnumSelect without a second label map to keep in sync.
 *
 * @param {number} issueTypeValue
 * @returns {string}
 */
function supportTicketTypeDisplayName(issueTypeValue)
{
    const enumerationName = SUPPORT_TICKET_TYPE_NAME_BY_VALUE[issueTypeValue];

    if (!enumerationName || issueTypeValue === supportTicketTypes.UNKNOWN)
    {
        return "Other";
    }

    return titleCaseEnumerationName(enumerationName);
}

module.exports = { supportTicketTypeDisplayName };
