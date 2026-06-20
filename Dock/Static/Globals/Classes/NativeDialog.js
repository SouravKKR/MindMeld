import { dataFormats } from "../Enumerations/DataFormats.js";
import { platforms } from "../Enumerations/Platforms.js";
import Persistence from "./Persistence.js";
import Platform from "./Platform.js";

class NativeDialog
{
    /**
     * Opens a directory selector dialog and returns the selected directory as a string.
     * If bMultiple is true, the function will return an array of strings, otherwise it will return a single string.
     * If no directory is selected, the function will return null.
     * This function is only supported on native platforms.
     * @param {boolean} bMultiple - Whether to allow selecting multiple directories
     * @returns {Promise<string|Array<string>>} - The selected directory(ies)
     */
    static async directorySelector(bMultiple = false)
    {
        if(Platform.get() == platforms.APP)
        {
            return await window.__TAURI__.dialog.open(
            {
                directory: true,
                multiple: bMultiple
            });
        }
        else if(Platform.get() == platforms.WEB)
        {
            throw new Error("Not Supported!");
        }
    }

    /**
     * Opens a file selector dialog and returns the selected file(s) as an array of objects with the following properties:
     *   - name: The name of the file
     *   - size: The size of the file in bytes
     *   - type: The MIME type of the file
     *   - buffer: The contents of the file as a buffer
     *   - path: The path of the file (only available on native platform)
     * If bMultiple is true, the function will return an array of objects, otherwise it will return a single object.
     * If no file is selected, the function will return null.
     * @param {boolean} bMultiple - Whether to allow selecting multiple files
     * @returns {Promise<Object|Array<Object>>} - The selected file(s)
     */
    static async fileSelector(bMultiple = false, extensions = [])
    {
        if (Platform.get() == platforms.APP)
        {
            const result = await window.__TAURI__.dialog.open(
            {
                multiple: bMultiple,
                filters: extensions.length > 0
                    ? [{
                        name: "Files",
                        extensions: extensions.map(extension => extension.replace(".", ""))
                    }]
                    : undefined
            });

            if (!result)
            {
                return null;
            }

            const paths = bMultiple ? result : [result];
            const files = [];

            for (const path of paths)
            {
                const buffer = await Persistence.read(path, dataFormats.BUFFER);

                files.push(
                {
                    name: path.split(/[\\/]/).pop(),
                    size: buffer.byteLength,
                    type: "", // MIME not reliable on native
                    buffer,
                    path
                });
            }

            return bMultiple ? files : files[0];
        }
        else if (Platform.get() == platforms.WEB)
        {
            return await new Promise((resolve) =>
            {
                const input = document.createElement("input");
                input.type = "file";
                input.multiple = bMultiple;

                if (extensions.length > 0)
                {
                    input.accept = extensions.join(",");
                }

                input.onchange = async () =>
                {
                    if (!input.files || input.files.length === 0)
                    {
                        resolve(null);
                        return;
                    }

                    const fileList = bMultiple ? [...input.files] : [input.files[0]];
                    const files = [];

                    for (const file of fileList)
                    {
                        const buffer = new Uint8Array(await file.arrayBuffer());

                        files.push(
                        {
                            name: file.name,
                            size: file.size,
                            type: file.type,
                            buffer
                        });
                    }

                    resolve(bMultiple ? files : files[0]);
                };

                input.click();
            });
        }
    }
        
}

export default NativeDialog;
