

class PromptPool
{
    static #PROMPTS_BASE_URL = new URL("./Prompts/", import.meta.url);

    static #cache = new Map();

    static async get(name)
    {
        if (this.#cache.has(name)) return this.#cache.get(name);

        const url = new URL(`${name}.txt`, PromptPool.#PROMPTS_BASE_URL);
        const response = await fetch(url.href);

        if (!response.ok) throw new Error(`Prompt '${name}' not found at ${url.href}`);

        const content = await response.text();
        this.#cache.set(name, content);
        return content;
    }

    static fill(template, variables)
    {
        return Object.entries(variables).reduce(
            (text, [key, value]) => text.replaceAll(`{${key}}`, value),
            template
        );
    }
}

export default PromptPool;
