from enum import IntEnum

class LocalLlmExecutionBackends(IntEnum):
    WEBGPU = 0
    WASM = 1
