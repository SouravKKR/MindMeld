import socket


class NetworkAddressPreference:
    """
    Makes every outbound connection the Agent opens try IPv4 addresses before IPv6 ones.

    Networks that hand out a globally-routable IPv6 address while silently dropping IPv6
    egress are common (several consumer ISPs do exactly this). On such a network the
    operating system's resolver still returns the AAAA records first, and the HTTP stacks
    the Agent depends on walk that list strictly in order:

        - botocore / urllib3 (Linode Object Storage, Google auth token fetches)
        - httpcore's synchronous backend (httpx)

    None of them implement Happy Eyeballs, so each unreachable IPv6 address costs a full
    TCP SYN timeout — roughly twenty seconds apiece — before the resolver list advances to
    a working IPv4 address. An endpoint publishing six AAAA records therefore stalls a
    single storage read for minutes, which surfaces as a generation pipeline that appears
    to hang on the storage-heavy stages.

    Reordering rather than filtering keeps IPv6 as a fallback, so a genuinely IPv6-only
    network still connects; the preference only decides which family is attempted first.
    The sort is stable, so the resolver's own ordering within each family is preserved.
    """

    IPV4_PREFERENCE_RANK = 0
    IPV6_PREFERENCE_RANK = 1

    __is_installed = False

    @staticmethod
    def __address_family_rank(resolved_address):
        address_family = resolved_address[0]

        if address_family == socket.AF_INET:
            return NetworkAddressPreference.IPV4_PREFERENCE_RANK

        return NetworkAddressPreference.IPV6_PREFERENCE_RANK

    @staticmethod
    def prefer_ipv4_addresses():
        """
        Installs the preference process-wide. Patching socket.getaddrinfo covers every
        client library at once — urllib3, httpcore and aiohttp all resolve through it,
        directly or via the asyncio event loop. Idempotent, so repeated calls (or a second
        entry point importing this module) never stack wrappers.
        """
        if NetworkAddressPreference.__is_installed:
            return

        original_getaddrinfo = socket.getaddrinfo

        def getaddrinfo_preferring_ipv4(*positional_arguments, **keyword_arguments):
            resolved_addresses = original_getaddrinfo(*positional_arguments, **keyword_arguments)
            return sorted(resolved_addresses, key=NetworkAddressPreference.__address_family_rank)

        socket.getaddrinfo = getaddrinfo_preferring_ipv4
        NetworkAddressPreference.__is_installed = True
