Drop the offline AI model directory here.

Expected layout (one subdirectory per model id):

  Dock/Assets/Models/Qwen2.5-3B-Instruct-q4f16_1-MLC/
      mlc-chat-config.json
      ndarray-cache.json
      tokenizer.json
      tokenizer_config.json
      params_shard_0.bin
      params_shard_1.bin
      ...
      <model_id>-webgpu.wasm

The MODEL_ID currently expected by the frontend is configured in
Common/Constants/BrowserLlmDownloadConstants.json. Update that file
(and rerun setup.bat) if you place a different model id here.

These files are served as static content at /Assets/Models/<model id>/...
by Dock/index.js. They are intentionally kept OUTSIDE Dock/Static/ so
the CopyStaticFiles step doesn't wipe them.
