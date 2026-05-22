class ModelTierMetadata:
    ORDER = ["FREE","BASIC","PRO","PRO_PLUS"]
    FREE = {"label":"Free","tagline":"On-device, simple queries","description":"Runs locally on this device. Best for short, simple questions about the selected text. No internet required once the model is installed.","apiPath":None}
    BASIC = {"label":"Basic","tagline":"Best optimized for most tasks","description":"Server-side cloud model tuned for fast, accurate answers on non-reasoning questions. Charged per use.","apiPath":"/BrowserLlm/Query/Basic"}
    PRO = {"label":"Pro","tagline":"Moderate reasoning","description":"Server-side cloud model with light step-by-step reasoning. Use when the question needs a small chain of thought.","apiPath":"/BrowserLlm/Query/Pro"}
    PRO_PLUS = {"label":"Pro Plus","tagline":"Mathematics + advanced reasoning","description":"Server-side cloud model with the strongest reasoning available. Use for math, multi-step proofs, and questions that require deep analysis.","apiPath":"/BrowserLlm/Query/ProPlus"}
