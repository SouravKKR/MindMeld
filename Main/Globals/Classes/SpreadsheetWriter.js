/**
 * SpreadsheetWriter
 *
 * Writes a real spreadsheet from rows of values, so exports arrive as something
 * an administrator can open, sort and hand on — not as a PDF they have to
 * retype, which is what every export in this app produced before.
 *
 * It wraps the SheetJS build already vendored for READING uploads
 * (Main/ThirdParty/SheetJs/xlsx.full.min.js), which can write as well. That
 * keeps a whole spreadsheet library out of the dependency list for the sake of
 * one download.
 *
 * CSV is offered alongside .xlsx because a CSV needs no library at all: if
 * SheetJS has not loaded, an export still succeeds rather than failing at the
 * moment the user asked for their data.
 */
class SpreadsheetWriter
{
    static #XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    static #CSV_MIME_TYPE = "text/csv;charset=utf-8;";

    // Excel truncates a sheet name past 31 characters and rejects several
    // punctuation marks outright, so the name is trimmed rather than left to
    // produce a file the user cannot open.
    static #MAXIMUM_SHEET_NAME_LENGTH = 31;

    static isXlsxAvailable()
    {
        return typeof window !== "undefined" && typeof window.XLSX !== "undefined";
    }

    static #sanitiseSheetName(rawSheetName)
    {
        const cleaned = String(rawSheetName || "Sheet1").replace(/[\\/?*[\]:]/g, " ").trim();
        return (cleaned.length > 0 ? cleaned : "Sheet1").slice(0, SpreadsheetWriter.#MAXIMUM_SHEET_NAME_LENGTH);
    }

    /**
     * One CSV cell. Quoted whenever the value contains a comma, a quote or a
     * newline, with inner quotes doubled — the escaping every spreadsheet
     * expects, and the reason a name like "Rao, Arjun" does not silently split
     * into two columns.
     */
    static #toCsvCell(rawValue)
    {
        const stringValue = rawValue === null || rawValue === undefined ? "" : String(rawValue);
        if (/[",\n\r]/.test(stringValue))
        {
            return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
    }

    /**
     * Serialises rows to CSV text.
     * @param {Array<Array<*>>} rows array of arrays, the first being the header
     * @returns {string}
     */
    static toCsv(rows)
    {
        const safeRows = Array.isArray(rows) ? rows : [];
        return safeRows
            .map(row => (Array.isArray(row) ? row : []).map(cell => SpreadsheetWriter.#toCsvCell(cell)).join(","))
            .join("\r\n");
    }

    /**
     * Triggers a browser download of `rows` as a .xlsx workbook, falling back to
     * CSV when SheetJS is unavailable. The extension always matches what was
     * actually written, so a file never claims to be a workbook it is not.
     *
     * @param {Array<Array<*>>} rows first row is the header
     * @param {string} fileNameWithoutExtension
     * @param {string} sheetName
     * @returns {{ downloaded: boolean, format: string }}
     */
    static downloadWorkbook(rows, fileNameWithoutExtension, sheetName = "Sheet1")
    {
        const safeRows = Array.isArray(rows) ? rows : [];
        const safeFileName = String(fileNameWithoutExtension || "export").replace(/[^a-zA-Z0-9._-]+/g, "-");

        if (SpreadsheetWriter.isXlsxAvailable())
        {
            const worksheet = window.XLSX.utils.aoa_to_sheet(safeRows);
            const workbook = window.XLSX.utils.book_new();
            window.XLSX.utils.book_append_sheet(workbook, worksheet, SpreadsheetWriter.#sanitiseSheetName(sheetName));

            const workbookBytes = window.XLSX.write(workbook, { bookType: "xlsx", type: "array" });
            SpreadsheetWriter.#triggerDownload(new Blob([workbookBytes], { type: SpreadsheetWriter.#XLSX_MIME_TYPE }), `${safeFileName}.xlsx`);
            return { downloaded: true, format: "xlsx" };
        }

        SpreadsheetWriter.downloadCsv(safeRows, safeFileName);
        return { downloaded: true, format: "csv" };
    }

    /**
     * Triggers a browser download of `rows` as CSV. Prefixed with a UTF-8 BOM
     * so Excel opens non-ASCII names correctly instead of mangling them.
     */
    static downloadCsv(rows, fileNameWithoutExtension)
    {
        const safeFileName = String(fileNameWithoutExtension || "export").replace(/[^a-zA-Z0-9._-]+/g, "-");
        const csvText = `﻿${SpreadsheetWriter.toCsv(rows)}`;
        SpreadsheetWriter.#triggerDownload(new Blob([csvText], { type: SpreadsheetWriter.#CSV_MIME_TYPE }), `${safeFileName}.csv`);
    }

    static #triggerDownload(blob, fileName)
    {
        const objectUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement("a");
        downloadLink.href = objectUrl;
        downloadLink.download = fileName;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        // Revoked on the next tick rather than immediately: some browsers have
        // not started reading the blob when click() returns, and revoking too
        // early produces an empty file.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
}

export default SpreadsheetWriter;
