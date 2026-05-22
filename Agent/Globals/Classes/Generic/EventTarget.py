class EventTarget:
    def __init__(self):
        self.listeners: dict[str, list] = dict()
        pass

    def addEventListener(self, eventType: str, listener: callable) -> None: 
        
        if eventType in self.listeners:
            if listener in self.listeners[eventType]:
                return
            
            self.listeners[eventType].append(listener)
        
        else:
            self.listeners[eventType] = [listener]
        

    def dispatchEvent(self, eventType: str) -> None:
        if eventType in self.listeners:
            for listener in self.listeners[eventType]:
                listener()

    def removeEventListener(self, eventType: str, listener: callable) -> None:
        if eventType in self.listeners:
            if listener in self.listeners[eventType]:
                self.listeners[eventType].remove(listener)

    def removeAllListeners(self, eventType: str) -> None:
        if eventType in self.listeners:
            self.listeners[eventType] = []