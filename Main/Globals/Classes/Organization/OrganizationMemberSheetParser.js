/**
 * OrganizationMemberSheetParser
 *
 * Reads a roster spreadsheet into members WITH their details, rather than
 * scraping it for anything email-shaped and discarding the rest — which is what
 * the existing EmailSheetParser does, and is still the right behaviour where
 * only addresses are wanted.
 *
 * The shape it expects:
 *
 *   - a HEADER row, whose first column is `email`
 *   - a `tags` column, if present, holding several tags separated by `;`
 *   - every other headed column becomes an attribute, keyed by its camelCased
 *     header, so "Roll Number", "roll_number" and "rollNumber" all land on one
 *     attribute instead of three
 *   - any trailing columns with NO header are read as bare tags, so the plain
 *     "email, tag, tag, tag" sheet works without a header for every tag
 *
 * The recommended template is `email, name, joinYear, role, stream, rollNumber,
 * tags` — enough to select ranges over a real roster (a year group, a stream, a
 * span of roll numbers) without asking anyone to invent a schema.
 *
 * `role` is a suggestion, not a schema. A roster is rarely all students: the
 * teachers on it carry different columns, and telling them apart is what most
 * rules turn out to need first. It stays ordinary text, decided by whatever the
 * institute writes on the form it hands out, rather than a fixed list this
 * product would have to guess in advance and every institute would then have to
 * argue with.
 *
 * Only `email` is required. Every other column here can be renamed, retyped,
 * reordered or dropped by the institute, and any column NOT listed here works
 * exactly as well — the sheet decides the schema, not this list.
 *
 * Nothing here decides what a value MEANS: whether joinYear is a number or a
 * string is worked out server-side from the values actually stored, so one
 * organization typing "2024" and another typing "AY2024-25" both get a working
 * range filter.
 */
class OrganizationMemberSheetParser
{
    static EMAIL_COLUMN_NAME = "email";
    static TAGS_COLUMN_NAME = "tags";
    static TAG_SEPARATOR_PATTERN = /[;|]/;

    static RECOMMENDED_HEADERS = ["email", "name", "joinYear", "role", "stream", "rollNumber", "tags"];

    static #STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    /**
     * The template every organization is pointed at, as rows ready for
     * SpreadsheetWriter. The example row is there because a header-only file
     * gives no clue how to write the tags column.
     */
    static buildTemplateRows()
    {
        return [
            OrganizationMemberSheetParser.RECOMMENDED_HEADERS.slice(),
            ["arjun.rao@example.edu", "Arjun Rao", "2024", "student", "B.Tech CSE", "A0142", "first-year;scholarship"],
            ["meera.iyer@example.edu", "Meera Iyer", "2022", "student", "B.Tech ECE", "E0317", "final-year"],
            // A teacher, carrying only the columns that apply to them. The blank
            // cells are the point: a roster is not one kind of person, and an
            // absent value stays absent rather than becoming an empty one.
            ["s.khan@example.edu", "S Khan", "", "teacher", "Physics", "", "staff"]
        ];
    }

    static #normaliseHeader(rawHeader)
    {
        return String(rawHeader ?? "").trim().toLowerCase();
    }

    /**
     * Reads a File into a matrix of cell strings. `.xlsx` / `.xls` go through
     * SheetJS; `.csv` — and anything at all when SheetJS has not loaded — is
     * parsed directly, so an import never fails purely because a library is
     * missing.
     *
     * @param {File} file
     * @returns {Promise<Array<Array<string>>>}
     */
    static async readMatrix(file)
    {
        const fileName = (file?.name || "").toLowerCase();
        const bIsSpreadsheet = fileName.endsWith(".xlsx") || fileName.endsWith(".xls");

        if (bIsSpreadsheet && typeof window !== "undefined" && typeof window.XLSX !== "undefined")
        {
            const arrayBuffer = await file.arrayBuffer();
            const workbook = window.XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
            const firstSheetName = workbook.SheetNames[0];
            if (!firstSheetName)
            {
                return [];
            }
            const rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { header: 1, blankrows: false, defval: "" });
            return rows.map(row => (Array.isArray(row) ? row.map(cell => String(cell ?? "").trim()) : []));
        }

        return OrganizationMemberSheetParser.parseDelimitedText(await file.text());
    }

    /**
     * Parses CSV text into a matrix, honouring quoted cells so a value
     * containing a comma stays one value.
     *
     * @param {string} text
     * @returns {Array<Array<string>>}
     */
    static parseDelimitedText(text)
    {
        const rows = [];
        let currentRow = [];
        let currentCell = "";
        let bInsideQuotes = false;

        const safeText = String(text ?? "");

        for (let characterIndex = 0; characterIndex < safeText.length; characterIndex++)
        {
            const character = safeText[characterIndex];

            if (bInsideQuotes)
            {
                if (character === '"')
                {
                    // A doubled quote inside a quoted cell is a literal quote.
                    if (safeText[characterIndex + 1] === '"')
                    {
                        currentCell = currentCell + '"';
                        characterIndex = characterIndex + 1;
                    }
                    else
                    {
                        bInsideQuotes = false;
                    }
                }
                else
                {
                    currentCell = currentCell + character;
                }
                continue;
            }

            if (character === '"')
            {
                bInsideQuotes = true;
            }
            else if (character === ",")
            {
                currentRow.push(currentCell.trim());
                currentCell = "";
            }
            else if (character === "\n")
            {
                currentRow.push(currentCell.trim());
                rows.push(currentRow);
                currentRow = [];
                currentCell = "";
            }
            else if (character !== "\r")
            {
                currentCell = currentCell + character;
            }
        }

        if (currentCell.length > 0 || currentRow.length > 0)
        {
            currentRow.push(currentCell.trim());
            rows.push(currentRow);
        }

        return rows.filter(row => row.some(cell => String(cell).trim().length > 0));
    }

    /**
     * Turns a cell matrix into members.
     *
     * @param {Array<Array<string>>} matrix
     * @returns {{ members: Array<{email: string, attributes: object, tags: string[]}>, invalidRows: Array<{rowNumber: number, value: string}>, headers: string[], bHadHeaderRow: boolean }}
     */
    static parseMatrix(matrix)
    {
        const safeMatrix = Array.isArray(matrix) ? matrix : [];
        const result = { members: [], invalidRows: [], headers: [], bHadHeaderRow: false };

        if (safeMatrix.length === 0)
        {
            return result;
        }

        const firstRow = safeMatrix[0].map(cell => String(cell ?? "").trim());
        const bHasHeaderRow = OrganizationMemberSheetParser.#normaliseHeader(firstRow[0]) === OrganizationMemberSheetParser.EMAIL_COLUMN_NAME;

        result.bHadHeaderRow = bHasHeaderRow;
        result.headers = bHasHeaderRow ? firstRow : [];

        const dataRows = bHasHeaderRow ? safeMatrix.slice(1) : safeMatrix;
        const memberByEmail = new Map();

        for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++)
        {
            const row = Array.isArray(dataRows[rowIndex]) ? dataRows[rowIndex] : [];
            const rowNumber = bHasHeaderRow ? rowIndex + 2 : rowIndex + 1;

            const email = String(row[0] ?? "").trim().toLowerCase();
            if (!OrganizationMemberSheetParser.#STRICT_EMAIL_REGEX.test(email))
            {
                if (row.some(cell => String(cell ?? "").trim().length > 0))
                {
                    result.invalidRows.push({ rowNumber: rowNumber, value: String(row[0] ?? "").trim() });
                }
                continue;
            }

            const attributes = {};
            const tags = [];

            for (let columnIndex = 1; columnIndex < row.length; columnIndex++)
            {
                const cellValue = String(row[columnIndex] ?? "").trim();
                if (cellValue.length === 0)
                {
                    continue;
                }

                const rawHeader = bHasHeaderRow ? String(firstRow[columnIndex] ?? "").trim() : "";
                const normalisedHeader = OrganizationMemberSheetParser.#normaliseHeader(rawHeader);

                if (normalisedHeader.length === 0 || normalisedHeader === OrganizationMemberSheetParser.TAGS_COLUMN_NAME)
                {
                    // Either the declared tags column, or a headerless trailing
                    // column — both are read as tags.
                    for (const tagPart of cellValue.split(OrganizationMemberSheetParser.TAG_SEPARATOR_PATTERN))
                    {
                        const tag = tagPart.trim();
                        if (tag.length > 0)
                        {
                            tags.push(tag);
                        }
                    }
                    continue;
                }

                attributes[rawHeader] = cellValue;
            }

            // A repeated address is a re-export or a merged file, not an error;
            // the last row wins, matching what the server does on import.
            memberByEmail.set(email, { email: email, attributes: attributes, tags: tags });
        }

        result.members = Array.from(memberByEmail.values());
        return result;
    }

    /**
     * Reads a File straight into members.
     * @param {File} file
     */
    static async parseFile(file)
    {
        return OrganizationMemberSheetParser.parseMatrix(await OrganizationMemberSheetParser.readMatrix(file));
    }

    /**
     * Reads pasted text straight into members.
     * @param {string} text
     */
    static parseText(text)
    {
        return OrganizationMemberSheetParser.parseMatrix(OrganizationMemberSheetParser.parseDelimitedText(text));
    }
}

export default OrganizationMemberSheetParser;
