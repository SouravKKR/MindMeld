from typing import List
from urllib.parse import urlparse

from Globals.Classes.WebScraping.FetchedImage import FetchedImage
from Globals.Constants.ReputedSources import ReputedSources


class FetchedPage:
    """
    Represents a single fetched web page along with its extracted images.
    Produced by WebContentFetcher; consumed by FetchWebContent workflow.
    """

    def __init__(
        self,
        url:    str,
        text:   str,
        title:  str = None,
        images: List[FetchedImage] = None,
    ) -> None:
        self.__url    = url
        self.__text   = text or ""
        self.__title  = title
        self.__images = images if images is not None else []

    def get_url(self) -> str:
        return self.__url

    def get_domain(self) -> str:
        return (urlparse(self.__url).hostname or "").lower()

    def is_reputed(self) -> bool:
        return ReputedSources.is_reputed_domain(self.__url)

    def get_text(self) -> str:
        return self.__text

    def get_title(self) -> str:
        return self.__title

    def get_images(self) -> List[FetchedImage]:
        return self.__images

    def to_json(self) -> dict:
        return {
            "url":       self.__url,
            "domain":    self.get_domain(),
            "isReputed": self.is_reputed(),
            "title":     self.__title,
            "text":      self.__text,
            "images":    [image.to_json() for image in self.__images],
        }

    @classmethod
    def from_json(cls, data: dict) -> "FetchedPage":
        return cls(
            url    = data.get("url", ""),
            text   = data.get("text", ""),
            title  = data.get("title"),
            images = [FetchedImage.from_json(entry) for entry in data.get("images", [])],
        )
