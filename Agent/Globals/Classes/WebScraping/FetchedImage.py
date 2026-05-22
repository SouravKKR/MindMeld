class FetchedImage:
    """
    Represents a single image extracted from a fetched web page.
    All fields are optional except sourceUrl, pageUrl, captionText, and localCachePath.
    """

    def __init__(
        self,
        source_url:       str,
        page_url:         str,
        caption_text:     str,
        local_cache_path: str,
        content_type:     str = "",
        width_hint:       int = None,
        height_hint:      int = None,
    ) -> None:
        self.__source_url       = source_url
        self.__page_url         = page_url
        self.__caption_text     = caption_text
        self.__local_cache_path = local_cache_path
        self.__content_type     = content_type
        self.__width_hint       = width_hint
        self.__height_hint      = height_hint

    def get_source_url(self) -> str:
        return self.__source_url

    def get_page_url(self) -> str:
        return self.__page_url

    def get_caption_text(self) -> str:
        return self.__caption_text

    def get_local_cache_path(self) -> str:
        return self.__local_cache_path

    def get_content_type(self) -> str:
        return self.__content_type

    def get_width_hint(self) -> int:
        return self.__width_hint

    def get_height_hint(self) -> int:
        return self.__height_hint

    def to_json(self) -> dict:
        return {
            "sourceUrl":      self.__source_url,
            "pageUrl":        self.__page_url,
            "captionText":    self.__caption_text,
            "localCachePath": self.__local_cache_path,
            "contentType":    self.__content_type,
            "widthHint":      self.__width_hint,
            "heightHint":     self.__height_hint,
        }

    @classmethod
    def from_json(cls, data: dict) -> "FetchedImage":
        return cls(
            source_url       = data.get("sourceUrl", ""),
            page_url         = data.get("pageUrl", ""),
            caption_text     = data.get("captionText", ""),
            local_cache_path = data.get("localCachePath", ""),
            content_type     = data.get("contentType", ""),
            width_hint       = data.get("widthHint"),
            height_hint      = data.get("heightHint"),
        )
