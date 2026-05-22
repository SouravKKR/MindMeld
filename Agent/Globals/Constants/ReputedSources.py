from urllib.parse import urlparse


class ReputedSources:
    """
    Flat ordered list of academic / open-textbook domains used for the
    REPUTED_EXTERNAL_SOURCES information-source type.

    Order matters: entries near the top are tried first when search results
    mix multiple sources. LibreTexts and OpenStax are kept at the top per
    explicit product preference.

    Edit this list freely.
    WebScraper.search_scoped consumes it as a flat OR-of-site: query;
    is_reputed_domain does suffix-matching against this same array.
    """

    DOMAINS = [
        "libretexts.org",
        "openstax.org",
        "opentextbc.ca",
        "saylor.org",
        "oercommons.org",
        "open.umn.edu",
        "merlot.org",
        "wikieducator.org",
        "wikiversity.org",
        "wikibooks.org",
        "arxiv.org",
        "phet.colorado.edu",
        "khanacademy.org",
        "academic.oup.com",
        "journals.plos.org",
        "ncbi.nlm.nih.gov",
        "nature.com",
        "sciencedaily.com",
        "mathworld.wolfram.com",
        "biology-pages.info",
        "developer.mozilla.org",
        "geeksforgeeks.org",
        "w3schools.com",
        "freecodecamp.org",
        "devdocs.io",
        "tutorialspoint.com",
        "git-scm.com",
        "docs.python.org",
        "react.dev",
        "web.dev",
        "investopedia.com",
        "openknowledge.worldbank.org",
        "imf.org",
        "nber.org",
        "federalreserve.gov",
        "economicsnetwork.ac.uk",
        "accountingcoach.com",
        "thebalance.com",
        "corporatefinanceinstitute.com",
        "stlouisfed.org",
        "gutenberg.org",
        "wiktionary.org",
        "plato.stanford.edu",
        "etymonline.com",
        "tatoeba.org",
        "sacred-texts.com",
        "metmuseum.org",
        "digitalhistory.uh.edu",
        "britishmuseum.org",
        "historyextra.com",
        "ssrn.com",
        "doabooks.org",
        "doaj.org",
        "core.ac.uk",
        "jstor.org",
        "archive.org",
        "base-search.net",
        "researchgate.net",
        "academia.edu",
        "digital.library.upenn.edu",
    ]

    @staticmethod
    def is_reputed_domain(url: str) -> bool:
        if not url:
            return False
        host = (urlparse(url).hostname or "").lower()
        if not host:
            return False
        return any(host == domain or host.endswith("." + domain) for domain in ReputedSources.DOMAINS)

    @staticmethod
    def get_priority_rank(url: str) -> int:
        """
        Returns the position of the url's domain in DOMAINS (lower = higher priority).
        Returns len(DOMAINS) for non-reputed URLs so they sort last.
        """
        if not url:
            return len(ReputedSources.DOMAINS)
        host = (urlparse(url).hostname or "").lower()
        if not host:
            return len(ReputedSources.DOMAINS)
        for index, domain in enumerate(ReputedSources.DOMAINS):
            if host == domain or host.endswith("." + domain):
                return index
        return len(ReputedSources.DOMAINS)
