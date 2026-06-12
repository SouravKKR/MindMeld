import ipaddress
import socket
from typing import List, NamedTuple
from urllib.parse import urlparse


class SafeUrlValidator:
    """
    Validates a URL against a strict allow-list designed to remove the common
    SSRF attack surface while still accepting virtually every legitimate public
    web URL. A URL is considered safe only when:

      * its scheme is http or https (nothing else — no file://, gopher://, …),
      * its port is 80 or 443,
      * its hostname resolves, and EVERY resolved address is a public address
        (private, loopback, link-local, reserved, multicast and unspecified
        ranges are all rejected — that already covers the 169.254.169.254
        family of cloud-metadata endpoints, which are additionally listed
        explicitly below).

    validate() returns the concrete IP the caller MUST connect to. Pinning the
    connection to the exact address that was inspected is what closes the
    DNS-rebinding window between the check and the request — a hostname that
    resolves to a public IP during validation cannot be swapped for an internal
    IP at connection time.

    Redirects are not transparent to this class: every hop is a fresh URL and
    the caller must call validate() again for each one.
    """

    ALLOWED_SCHEMES        = ("http", "https")
    ALLOWED_PORTS          = (80, 443)
    DEFAULT_PORT_BY_SCHEME = {"http": 80, "https": 443}

    # Cloud-metadata endpoints. 169.254.169.254 and fd00:ec2::254 already fall
    # inside the link-local range that is rejected below; they are listed here
    # too so the intent is explicit, and so providers (e.g. Alibaba Cloud) that
    # expose a routable-looking metadata address are blocked as well.
    BLOCKED_LITERAL_ADDRESSES = frozenset({
        "169.254.169.254",
        "fd00:ec2::254",
        "100.100.100.200",
    })

    class UrlValidationError(Exception):
        """Raised when a URL fails any SSRF safety check."""

    class ValidatedTarget(NamedTuple):
        scheme:     str
        host:       str
        port:       int
        connect_ip: str    # the literal IP the caller must connect to
        is_ipv6:    bool

    @staticmethod
    def validate(url: str) -> "SafeUrlValidator.ValidatedTarget":
        parsed = urlparse(url)

        scheme = (parsed.scheme or "").lower()
        if scheme not in SafeUrlValidator.ALLOWED_SCHEMES:
            raise SafeUrlValidator.UrlValidationError(f"Scheme '{scheme}' is not allowed (only http/https).")

        host = parsed.hostname
        if not host:
            raise SafeUrlValidator.UrlValidationError("URL has no hostname.")

        try:
            port = parsed.port if parsed.port is not None else SafeUrlValidator.DEFAULT_PORT_BY_SCHEME[scheme]
        except ValueError:
            raise SafeUrlValidator.UrlValidationError("URL has an invalid port.")

        if port not in SafeUrlValidator.ALLOWED_PORTS:
            raise SafeUrlValidator.UrlValidationError(f"Port {port} is not allowed (only 80/443).")

        resolved_addresses = SafeUrlValidator.__resolve_all_addresses(host, port)
        if not resolved_addresses:
            raise SafeUrlValidator.UrlValidationError(f"Hostname '{host}' did not resolve to any address.")

        for address in resolved_addresses:
            SafeUrlValidator.__assert_address_is_public(address, host)

        connect_ip = resolved_addresses[0]
        is_ipv6    = ipaddress.ip_address(connect_ip).version == 6

        return SafeUrlValidator.ValidatedTarget(
            scheme     = scheme,
            host       = host,
            port       = port,
            connect_ip = connect_ip,
            is_ipv6    = is_ipv6,
        )

    @staticmethod
    def __resolve_all_addresses(host: str, port: int) -> List[str]:
        # getaddrinfo returns an IP literal unchanged, so this also normalizes
        # the "host is already an IP" case through the same public-address gate.
        try:
            address_info = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        except socket.gaierror as resolution_error:
            raise SafeUrlValidator.UrlValidationError(f"Could not resolve hostname '{host}': {resolution_error}")

        addresses: List[str] = []
        for family, socket_type, protocol, canonical_name, socket_address in address_info:
            ip_text = socket_address[0]
            if ip_text not in addresses:
                addresses.append(ip_text)
        return addresses

    @staticmethod
    def __assert_address_is_public(address_text: str, host: str) -> None:
        try:
            ip = ipaddress.ip_address(address_text)
        except ValueError:
            raise SafeUrlValidator.UrlValidationError(f"Resolved address '{address_text}' is not a valid IP.")

        # Unwrap an IPv4 address carried inside an IPv4-mapped IPv6 address so an
        # internal IPv4 (e.g. ::ffff:127.0.0.1) can't be smuggled past the checks.
        if ip.version == 6:
            mapped_ipv4 = getattr(ip, "ipv4_mapped", None)
            if mapped_ipv4 is not None:
                ip = mapped_ipv4

        if str(ip) in SafeUrlValidator.BLOCKED_LITERAL_ADDRESSES or address_text in SafeUrlValidator.BLOCKED_LITERAL_ADDRESSES:
            raise SafeUrlValidator.UrlValidationError(f"Address '{address_text}' is a blocked metadata endpoint.")

        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
            or not ip.is_global
        ):
            raise SafeUrlValidator.UrlValidationError(f"Host '{host}' resolves to a non-public address '{address_text}'.")
