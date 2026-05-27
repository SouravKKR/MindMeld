class ModelTierMetadata
{
    static ORDER = ["FREE","BASIC","PRO","PRO_PLUS"];
    static FREE = {"label":"Free","tagline":"On-device, simple queries","description":"Runs locally on this device. Best for short, simple questions about the selected text. No internet required once the model is installed.","apiPath":null,"modelId":null,"supportsImageInput":false,"enableGoogleSearchGrounding":false,"supportsAdvancedReasoning":false};
    static BASIC = {"label":"Basic","tagline":"Best optimized for most tasks","description":"Server-side cloud model tuned for fast, accurate answers on non-reasoning questions. Charged per use.","apiPath":"/AskAi/Query/Basic","modelId":"gemini-2.5-flash-lite","supportsImageInput":true,"enableGoogleSearchGrounding":false,"supportsAdvancedReasoning":false};
    static PRO = {"label":"Pro","tagline":"Moderate reasoning","description":"Server-side cloud model with light step-by-step reasoning. Use when the question needs a small chain of thought.","apiPath":"/AskAi/Query/Pro","modelId":"gemini-3.1-flash-lite","supportsImageInput":true,"enableGoogleSearchGrounding":true,"supportsAdvancedReasoning":false};
    static PRO_PLUS = {"label":"Pro Plus","tagline":"Mathematics + advanced reasoning","description":"Server-side cloud model with the strongest reasoning available. Use for math, multi-step proofs, and questions that require deep analysis.","apiPath":"/AskAi/Query/ProPlus","modelId":"gemini-3.1-pro-preview","supportsImageInput":true,"enableGoogleSearchGrounding":true,"supportsAdvancedReasoning":true};
}

export default ModelTierMetadata;
