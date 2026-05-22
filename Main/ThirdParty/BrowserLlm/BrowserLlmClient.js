import { WebLLM, Transformers } from "./BrowserLlm.js";

const GPU_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const CPU_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";

class BrowserLlmClient
{
    #engine = null;
    #pipeline = null;
    #useWebGpu = !!navigator.gpu;
    #initialized = false;

    isGpu()
    {
        return this.#useWebGpu;
    }

    isInitialized()
    {
        return this.#initialized;
    }

    async initialize(onProgress = null)
    {
        if (this.#initialized) return;

        if (this.#useWebGpu)
        {
            this.#engine = await WebLLM.CreateMLCEngine(GPU_MODEL, {
                initProgressCallback: (p) => onProgress?.(p.text)
            });
        }
        else
        {
            onProgress?.("Loading CPU-optimized model...");
            this.#pipeline = await Transformers.pipeline("text-generation", CPU_MODEL, {
                device: "wasm"
            });
        }

        this.#initialized = true;
    }

    // Interface method — to swap the underlying library, change only the two private methods below
    async complete(systemPrompt, userPrompt, onProgress = null)
    {
        if (!this.#initialized) await this.initialize(onProgress);

        return this.#useWebGpu
            ? await this.#completeWithWebLlm(systemPrompt, userPrompt)
            : await this.#completeWithTransformers(systemPrompt, userPrompt);
    }

    async #completeWithWebLlm(systemPrompt, userPrompt)
    {
        const response = await this.#engine.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user",   content: userPrompt   }
            ]
        });
        return response.choices[0].message.content.trim();
    }

    async #completeWithTransformers(systemPrompt, userPrompt)
    {
        const prompt = `System: ${systemPrompt}\nUser: ${userPrompt}\nAssistant:`;
        const results = await this.#pipeline(prompt, { max_new_tokens: 256, temperature: 0.7 });
        return results[0].generated_text.slice(prompt.length).trim();
    }
}

export const sharedBrowserLlmClient = new BrowserLlmClient();
export default BrowserLlmClient;
