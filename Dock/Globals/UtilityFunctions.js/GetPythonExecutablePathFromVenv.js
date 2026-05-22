const path = require("path");
const fs = require("fs");

/**
 * Returns the path to the Python executable for the given virtual environment.
 * If the virtual environment is on Windows, the path will be to "python.exe" in the "Scripts" directory.
 * If the virtual environment is on a Unix-like platform, the path will be to either "python" or "python3" in the "bin" directory, depending on which one exists.
 * @param {string} venvPath - The path to the virtual environment.
 * @returns {string} - The path to the Python executable for the given virtual environment.
 */
function getPythonExecutablePathFromVenv(venvPath)
{
    if (process.platform === "win32")
    {
        return path.join(venvPath, "Scripts", "python.exe");
    }

    const unixPython = path.join(venvPath, "bin", "python");
    const unixPython3 = path.join(venvPath, "bin", "python3");

    if (fs.existsSync(unixPython))
    {
        return unixPython;
    }

    return unixPython3;
}

module.exports = { getPythonExecutablePathFromVenv };