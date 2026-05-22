import os

class PromptLoader(type):
    
    def __getattr__(cls, name):
    
        base_dir = os.path.dirname(os.path.abspath(__file__))
        prompts_dir = os.path.join(base_dir, "Prompts")
        file_path = os.path.join(prompts_dir, f"{name}.txt")

        if os.path.exists(file_path):
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            
            setattr(cls, name, content)
            return content
        
        raise AttributeError(f"Prompt '{name}' not found at {file_path}")

class PromptPool(metaclass=PromptLoader):
    """Access prompts statically via PromptPool.FILENAME"""
    pass