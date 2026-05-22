const crypto = require("crypto");
const fs = require("fs");

function computeFileSha512Hash(filePath)
{
    return new Promise((resolve, reject) =>
    {
        const hash = crypto.createHash("sha512");
        const stream = fs.createReadStream(filePath);

        stream.on("data", (chunk) =>
        {
            hash.update(chunk);
        });

        stream.on("end", () =>
        {
            resolve(hash.digest("hex"));
        });

        stream.on("error", reject);
    });
}

module.exports = { computeFileSha512Hash };