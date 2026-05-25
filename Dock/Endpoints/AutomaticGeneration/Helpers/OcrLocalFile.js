const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");


class OcrLocalFile
{
    static OCRMYPDF_EXECUTABLE = "ocrmypdf";
    static OCR_LANGUAGE = "eng";
    static DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;

    // Tesseract page-segmentation mode 11 = "sparse text". Default 3
    // assumes one uniform body-text block, which misses the labels
    // scattered around a diagram (e.g. the "Process of MBO" wheel —
    // six peripheral labels + one centre label on a coloured shape).
    // PSM 11 doesn't try to group text into a single column, so
    // isolated labels in graphic regions get a fair shot.
    static TESSERACT_PAGE_SEGMENTATION_MODE = "11";

    // ocrmypdf default oversample is 300dpi. 400dpi catches small or
    // anti-aliased text in slide-deck PNGs without ballooning runtime.
    static OVERSAMPLE_DPI = "400";

    static #buildOutputPath()
    {
        const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
        return path.join(os.tmpdir(), `mindmeld-ocr-${uniqueSuffix}.pdf`);
    }

    static #buildArguments(inputFilePath, outputFilePath)
    {
        // --redo-ocr re-OCRs pages with existing OCR text and OCRs
        // pages with no text. Pages that already carry born-digital
        // text are passed through untouched — so we do NOT rasterize
        // and re-embed those pages. (--force-ocr previously did
        // rasterize everything at --oversample dpi, which is what
        // blew a 5 MB upload to 457 MB.)
        //
        // NOTE: ocrmypdf forbids --deskew, --clean-final and
        // --remove-background under --redo-ocr (it errors with
        // "--redo-ocr is not currently compatible with..."). We give
        // those up to keep the size-safe re-OCR mode.
        //
        // --oversample 400 boosts the OCR-time DPI above the page's
        // native resolution, recovering small or anti-aliased glyphs
        // (the centre label of a coloured-circle diagram is exactly
        // this kind of low-contrast antialiased text).
        //
        // --tesseract-pagesegmode 11 ("sparse text") gives scattered
        // diagram labels a fair shot — see the constant comment.
        return [
            "--redo-ocr",
            "--language",                OcrLocalFile.OCR_LANGUAGE,
            "--oversample",              OcrLocalFile.OVERSAMPLE_DPI,
            "--tesseract-pagesegmode",   OcrLocalFile.TESSERACT_PAGE_SEGMENTATION_MODE,
            "--optimize",                "1",
            "--output-type",             "pdf",
            "--quiet",
            inputFilePath,
            outputFilePath,
        ];
    }

    /**
     * Runs ocrmypdf against a local PDF and writes the OCRed PDF to a
     * temporary file on the same machine. Returns the path of the
     * OCRed output. Callers MUST delete the returned file once they
     * are done with it.
     *
     * The original input file is never modified.
     */
    static run(inputFilePath, timeoutMilliseconds = OcrLocalFile.DEFAULT_TIMEOUT_MILLISECONDS)
    {
        const outputFilePath = OcrLocalFile.#buildOutputPath();
        const commandArguments = OcrLocalFile.#buildArguments(inputFilePath, outputFilePath);

        return new Promise((resolve, reject) =>
        {
            const ocrProcess = spawn(OcrLocalFile.OCRMYPDF_EXECUTABLE, commandArguments);

            let stderrBuffer = "";
            let bSettled = false;

            const settle = (settler, value) =>
            {
                if (bSettled)
                {
                    return;
                }
                bSettled = true;
                settler(value);
            };

            const timeoutHandle = setTimeout(() =>
            {
                ocrProcess.kill("SIGKILL");
                settle(reject, new Error(`ocrmypdf timed out after ${timeoutMilliseconds}ms.`));
            }, timeoutMilliseconds);

            ocrProcess.stderr.on("data", (chunk) =>
            {
                stderrBuffer += chunk.toString();
            });

            ocrProcess.on("error", (spawnError) =>
            {
                clearTimeout(timeoutHandle);
                try { fs.unlinkSync(outputFilePath); } catch (_) {}
                settle(reject, new Error(`Failed to spawn ocrmypdf: ${spawnError.message}`));
            });

            ocrProcess.on("close", (exitCode) =>
            {
                clearTimeout(timeoutHandle);

                if (exitCode === 0)
                {
                    settle(resolve, outputFilePath);
                    return;
                }

                try { fs.unlinkSync(outputFilePath); } catch (_) {}
                const trimmedStderr = stderrBuffer.trim().slice(0, 1000);
                settle(reject, new Error(`ocrmypdf exited with code ${exitCode}. stderr: ${trimmedStderr}`));
            });
        });
    }
}

module.exports = OcrLocalFile;
