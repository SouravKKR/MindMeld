/**
 * EmailSheetParser
 *
 * Reusable email extraction from a pasted/typed string OR an uploaded
 * spreadsheet (.xlsx / .xls / .csv) using the already-vendored SheetJS
 * (window.XLSX, loaded from /ThirdParty/SheetJs/xlsx.full.min.js). Column
 * layout is irrelevant — every cell is scanned for email-shaped tokens, the
 * same approach proven in AddMembersDialog. Results are lowercased and
 * de-duplicated.
 */
class EmailSheetParser
{
    static #STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    static #LOOSE_EMAIL_REGEX = /[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+/g;

    /**
     * Extracts valid, lowercased, de-duped emails from arbitrary text
     * (newline / comma / space / semicolon separated, or prose with emails).
     * @param {string} text
     * @returns {Array<string>}
     */
    static parseText(text)
    {
        if (typeof text !== "string" || text.length === 0)
        {
            return [];
        }
        const matches = text.match(EmailSheetParser.#LOOSE_EMAIL_REGEX) || [];
        return EmailSheetParser.#normalise(matches);
    }

    /**
     * Extracts emails from an uploaded spreadsheet or CSV file. Falls back to
     * plain-text parsing for CSV or when SheetJS is unavailable.
     * @param {File} file
     * @returns {Promise<Array<string>>}
     */
    static async parseFile(file)
    {
        if (!file)
        {
            return [];
        }

        const lowerName = (file.name || "").toLowerCase();
        const sheetLibraryReady = typeof window.XLSX === "object" && typeof window.XLSX.read === "function";

        if (!sheetLibraryReady || lowerName.endsWith(".csv"))
        {
            const text = await file.text();
            return EmailSheetParser.parseText(text);
        }

        const arrayBuffer = await file.arrayBuffer();
        const workbook = window.XLSX.read(arrayBuffer, { type: "array" });
        const collected = [];
        for (const sheetName of workbook.SheetNames)
        {
            const worksheet = workbook.Sheets[sheetName];
            for (const cellReference of Object.keys(worksheet))
            {
                if (cellReference.startsWith("!"))
                {
                    continue;
                }
                const cell = worksheet[cellReference];
                const cellText = String((cell && (cell.v ?? cell.w)) ?? "");
                const matches = cellText.match(EmailSheetParser.#LOOSE_EMAIL_REGEX);
                if (matches)
                {
                    for (const match of matches)
                    {
                        collected.push(match);
                    }
                }
            }
        }
        return EmailSheetParser.#normalise(collected);
    }

    static #normalise(rawEmails)
    {
        const seen = new Set();
        const result = [];
        for (const rawEmail of rawEmails)
        {
            const email = String(rawEmail || "").trim().toLowerCase();
            if (email.length === 0 || !EmailSheetParser.#STRICT_EMAIL_REGEX.test(email) || seen.has(email))
            {
                continue;
            }
            seen.add(email);
            result.push(email);
        }
        return result;
    }
}

export default EmailSheetParser;
