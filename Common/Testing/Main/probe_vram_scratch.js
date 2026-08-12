// Throwaway: can a device's ability to hold a model's working set be MEASURED
// cheaply, instead of guessed from adapter limits? Deleted after answering.
const path = require("path");
const puppeteer = require(path.join(__dirname, "node_modules", "puppeteer"));

async function main()
{
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        protocolTimeout: 300000,
    });
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:3000/index.html");

    const report = await page.evaluate(async () =>
    {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();

        // Allocate in chunks no larger than the adapter's own binding limit,
        // which is how the engine lays a model's shards out anyway.
        const attempt = async (targetMegabytes) =>
        {
            const chunkBytes = Math.min(adapter.limits.maxStorageBufferBindingSize, 128 * 1048576);
            const chunkCount = Math.ceil((targetMegabytes * 1048576) / chunkBytes);
            const buffers = [];

            device.pushErrorScope("out-of-memory");
            try
            {
                for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++)
                {
                    buffers.push(device.createBuffer({ size: chunkBytes, usage: GPUBufferUsage.STORAGE }));
                }
            }
            catch (allocationError)
            {
                buffers.forEach((buffer) => buffer.destroy());
                await device.popErrorScope();
                return { targetMegabytes, ok: false, how: `threw: ${allocationError.message}` };
            }

            const outOfMemoryError = await device.popErrorScope();
            const bAllocated = outOfMemoryError === null;
            buffers.forEach((buffer) => buffer.destroy());

            return {
                targetMegabytes,
                ok: bAllocated,
                how: bAllocated ? `allocated ${chunkCount} x ${(chunkBytes / 1048576).toFixed(0)} MiB` : `error scope: ${outOfMemoryError.message}`,
            };
        };

        const results = [];
        for (const targetMegabytes of [1630, 4096, 16384, 65536, 262144])
        {
            results.push(await attempt(targetMegabytes));
        }

        return {
            maxBufferSizeMebibytes: adapter.limits.maxBufferSize / 1048576,
            maxStorageBufferBindingSizeMebibytes: adapter.limits.maxStorageBufferBindingSize / 1048576,
            deviceMemoryGigabytes: navigator.deviceMemory ?? null,
            results,
        };
    });

    console.log(`adapter maxBufferSize:               ${report.maxBufferSizeMebibytes} MiB`);
    console.log(`adapter maxStorageBufferBindingSize: ${report.maxStorageBufferBindingSizeMebibytes} MiB`);
    console.log(`navigator.deviceMemory:              ${report.deviceMemoryGigabytes} GB`);
    console.log("");
    for (const result of report.results)
    {
        console.log(`  request ${String(result.targetMegabytes).padStart(7)} MiB -> ${result.ok ? "OK  " : "FAIL"}  ${result.how}`);
    }

    await browser.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
