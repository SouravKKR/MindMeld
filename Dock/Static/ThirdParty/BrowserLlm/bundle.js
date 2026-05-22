import * as esbuild from "esbuild";

/**
 * bundle.js
 *
 * Builds a single self-contained ESM file (BrowserLlm.js) that exports
 * the WebLLM + Transformers.js entry points. The frontend then imports
 * this one file instead of pulling either library from a CDN at run-
 * time — which matters because:
 *
 *   - MindMeld's "no CDN at run-time" rule means the Free-tier LLM
 *     code path is fully local, including its WebLLM / Transformers
 *     dependencies.
 *   - One bundled file is simpler to ship via the existing
 *     Main → Dock/Static copy step than a tree of node_modules.
 *
 * Run:
 *
 *     cd Main/ThirdParty/BrowserLlm
 *     npm install
 *     npm run build
 *
 * Output: Main/ThirdParty/BrowserLlm/BrowserLlm.js (overwrites the
 * checked-in copy). Rerun whenever you bump @mlc-ai/web-llm or
 * @huggingface/transformers.
 *
 * Adapted from the reference implementation at
 * F:/Testing/MindMeld/browserllm/bundle.js. The httpPlugin lets esbuild
 * pull the CDN-only source distributions during bundling without us
 * having to host them in package.json.
 */
const httpPlugin =
{
    name: "http-resolver",
    setup(build)
    {
        // 1. Resolve remote https?:// URLs.
        build.onResolve({ filter: /^https?:\/\// }, (args) => (
        {
            path: args.path,
            namespace: "http-url",
        }));

        // 2. Handle relative imports within remote files.
        build.onResolve({ filter: /^\./, namespace: "http-url" }, (args) =>
        {
            const resolvedUrl = new URL(args.path, args.importer).toString();
            return {
                path: resolvedUrl,
                namespace: "http-url",
            };
        });

        // 3. Mark Node.js built-ins as external so they don't break the browser build.
        const nodeBuiltins = ["url", "path", "fs", "crypto", "os", "util", "buffer", "stream"];
        build.onResolve({ filter: new RegExp(`^(${nodeBuiltins.join("|")})$`) }, (args) => (
        {
            path: args.path,
            external: true
        }));

        // 4. Fetch the content.
        build.onLoad({ filter: /.*/, namespace: "http-url" }, async (args) =>
        {
            const response = await fetch(args.path);
            if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
            const contents = await response.text();
            return { contents, loader: "js" };
        });
    },
};

async function createVendorBundle()
{
    const entryContent = `
        export * as WebLLM from "https://esm.run/@mlc-ai/web-llm";
        export * as Transformers from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";
    `;

    try
    {
        console.log("[bundle.js] Building browser-compatible BrowserLlm.js …");

        await esbuild.build(
        {
            stdin:
            {
                contents: entryContent,
                resolveDir: process.cwd(),
                loader: "js",
            },
            bundle: true,
            format: "esm",
            outfile: "BrowserLlm.js",
            minify: true,
            platform: "browser",
            target: ["es2020"],
            plugins: [httpPlugin],
            define:
            {
                "process.env.NODE_ENV": "\"production\"",
                "global": "window"
            },
            mainFields: ["module", "main"],
            logLevel: "info",
        });

        console.log("[bundle.js] SUCCESS — BrowserLlm.js written.");
    }
    catch (bundleError)
    {
        console.error("[bundle.js] BUNDLE FAILED:", bundleError.message);
        process.exit(1);
    }
}

createVendorBundle();
