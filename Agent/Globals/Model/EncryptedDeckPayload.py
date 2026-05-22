
class EncryptedDeckPayload:
    def __init__(self, deck_id: str = None, key_version: int = 1, iv_base64: str = '', ciphertext_base64: str = '') -> None:
        self.set_deck_id(deck_id)
        self.set_key_version(key_version)
        self.set_iv_base64(iv_base64)
        self.set_ciphertext_base64(ciphertext_base64)

    def get_deck_id(self) -> str:
        return self.__deck_id

    def set_deck_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__deck_id = value

    def get_key_version(self) -> int:
        return self.__key_version

    def set_key_version(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(1, value)
            except (ValueError, TypeError):
                value = 1
        self.__key_version = value

    def get_iv_base64(self) -> str:
        return self.__iv_base64

    def set_iv_base64(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__iv_base64 = value

    def get_ciphertext_base64(self) -> str:
        return self.__ciphertext_base64

    def set_ciphertext_base64(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__ciphertext_base64 = value

    def to_json(self) -> dict:
        return {
            'deckId': self.get_deck_id(),
            'keyVersion': self.get_key_version(),
            'ivBase64': self.get_iv_base64(),
            'ciphertextBase64': self.get_ciphertext_base64(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'EncryptedDeckPayload':
        instance = cls(
            deck_id=data.get('deckId'),
            key_version=data.get('keyVersion'),
            iv_base64=data.get('ivBase64'),
            ciphertext_base64=data.get('ciphertextBase64')
        )
        return instance
