/**
 * Validates a user-supplied URL before it is accepted onto a generation's
 * information sources and persisted.
 *
 * This is the FRONT DOOR, not the security boundary. Dock resolves no DNS, so
 * it cannot know that an innocent-looking hostname actually points at a VPC
 * address. The authoritative SSRF gate is the Agent's SafeUrlValidator, which
 * resolves every hop and pins the connection to the address it inspected.
 *
 * What this class buys is (a) a clear, immediate rejection message instead of
 * a job that silently fetches nothing, (b) keeping obviously-unfetchable URLs
 * out of the database, where a stored source is replayed on every regeneration,
 * and (c) a second lock on the blatant cases (localhost, literal private IPs,
 * non-web schemes, odd ports, credential-smuggling userinfo).
 *
 * IPv6 literals are matched by prefix rather than fully parsed — the exhaustive
 * check belongs to (and lives in) SafeUrlValidator, so a rare literal form that
 * slips past here is still refused at fetch time.
 */
class PublicUrlValidator
{
    static ALLOWED_PROTOCOLS = ["http:", "https:"];
    static ALLOWED_PORTS = [80, 443];
    static MAXIMUM_URL_LENGTH = 2048;

    static BLOCKED_HOSTNAMES = ["localhost", "metadata", "metadata.google.internal", "instance-data"];
    static BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

    // Link-local (169.254/16) covers the cloud-metadata endpoints; the rest are
    // the private, loopback, carrier-NAT, benchmark, multicast and reserved
    // ranges that a public website can never legitimately live on.
    static BLOCKED_IPV4_RANGES = [
        {firstOctet: 0},
        {firstOctet: 10},
        {firstOctet: 127},
        {firstOctet: 169, secondOctet: 254},
        {firstOctet: 172, secondOctetMinimum: 16, secondOctetMaximum: 31},
        {firstOctet: 192, secondOctet: 0, thirdOctet: 0},
        {firstOctet: 192, secondOctet: 168},
        {firstOctet: 198, secondOctetMinimum: 18, secondOctetMaximum: 19},
        {firstOctetMinimum: 100, firstOctetMaximum: 100, secondOctetMinimum: 64, secondOctetMaximum: 127},
        {firstOctetMinimum: 224, firstOctetMaximum: 255},
    ];

    static BLOCKED_IPV6_LITERALS = ["::", "::1", "fd00:ec2::254"];
    static BLOCKED_IPV6_PREFIXES = ["fc", "fd", "fe8", "fe9", "fea", "feb"];
    static IPV4_MAPPED_IPV6_PREFIX = "::ffff:";

    static IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

    /**
     * Validates a URL and returns its normalized form.
     *
     * @param {string} urlText the raw URL the user submitted
     * @param {string} sourceLabel human-readable prefix for the error message
     *
     * @returns {string} the normalized URL
     *
     * @throws {Error} when the URL is malformed or may not be fetched
     */
    static validate(urlText, sourceLabel)
    {
        const trimmedUrl = (urlText || "").trim();

        if (trimmedUrl.length === 0)
        {
            throw new Error(`${sourceLabel}: the URL is empty.`);
        }

        if (trimmedUrl.length > PublicUrlValidator.MAXIMUM_URL_LENGTH)
        {
            throw new Error(`${sourceLabel}: the URL is too long (maximum ${PublicUrlValidator.MAXIMUM_URL_LENGTH} characters).`);
        }

        let parsedUrl = null;

        try
        {
            parsedUrl = new URL(trimmedUrl);
        }
        catch (parseError)
        {
            throw new Error(`${sourceLabel}: "${trimmedUrl}" is not a valid URL. Include the full address, for example https://example.com/paper.pdf.`);
        }

        if (!PublicUrlValidator.ALLOWED_PROTOCOLS.includes(parsedUrl.protocol))
        {
            throw new Error(`${sourceLabel}: only http:// and https:// links can be used (got "${parsedUrl.protocol}").`);
        }

        if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0)
        {
            throw new Error(`${sourceLabel}: the URL may not carry a username or password.`);
        }

        if (parsedUrl.port.length > 0 && !PublicUrlValidator.ALLOWED_PORTS.includes(Number(parsedUrl.port)))
        {
            throw new Error(`${sourceLabel}: only the standard web ports 80 and 443 can be used (got "${parsedUrl.port}").`);
        }

        PublicUrlValidator.#assertHostnameIsPublic(parsedUrl.hostname, sourceLabel);

        return parsedUrl.toString();
    }

    static #assertHostnameIsPublic(rawHostname, sourceLabel)
    {
        // WHATWG URL keeps IPv6 literals in their bracketed form.
        const hostname = rawHostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

        if (hostname.length === 0)
        {
            throw new Error(`${sourceLabel}: the URL has no hostname.`);
        }

        if (PublicUrlValidator.BLOCKED_HOSTNAMES.includes(hostname))
        {
            throw new Error(`${sourceLabel}: "${hostname}" is an internal address and cannot be used as a source.`);
        }

        for (const blockedSuffix of PublicUrlValidator.BLOCKED_HOSTNAME_SUFFIXES)
        {
            if (hostname.endsWith(blockedSuffix))
            {
                throw new Error(`${sourceLabel}: "${hostname}" is an internal address and cannot be used as a source.`);
            }
        }

        if (PublicUrlValidator.#isBlockedIpv4Literal(hostname))
        {
            throw new Error(`${sourceLabel}: "${hostname}" is a private or reserved IP address and cannot be used as a source.`);
        }

        if (hostname.includes(":") && PublicUrlValidator.#isBlockedIpv6Literal(hostname))
        {
            throw new Error(`${sourceLabel}: "${hostname}" is a private or reserved IP address and cannot be used as a source.`);
        }
    }

    static #isBlockedIpv4Literal(hostname)
    {
        const match = PublicUrlValidator.IPV4_PATTERN.exec(hostname);
        if (match === null)
        {
            return false;
        }

        const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];

        for (const octet of octets)
        {
            if (octet > 255)
            {
                // Not a real IPv4 literal — it will simply fail to resolve.
                return false;
            }
        }

        for (const blockedRange of PublicUrlValidator.BLOCKED_IPV4_RANGES)
        {
            if (PublicUrlValidator.#matchesBlockedRange(octets, blockedRange))
            {
                return true;
            }
        }

        return false;
    }

    static #matchesBlockedRange(octets, blockedRange)
    {
        const checks = [
            {value: octets[0], exact: blockedRange.firstOctet, minimum: blockedRange.firstOctetMinimum, maximum: blockedRange.firstOctetMaximum},
            {value: octets[1], exact: blockedRange.secondOctet, minimum: blockedRange.secondOctetMinimum, maximum: blockedRange.secondOctetMaximum},
            {value: octets[2], exact: blockedRange.thirdOctet, minimum: blockedRange.thirdOctetMinimum, maximum: blockedRange.thirdOctetMaximum},
        ];

        for (const check of checks)
        {
            if (check.exact !== undefined && check.value !== check.exact)
            {
                return false;
            }

            if (check.minimum !== undefined && check.value < check.minimum)
            {
                return false;
            }

            if (check.maximum !== undefined && check.value > check.maximum)
            {
                return false;
            }
        }

        return true;
    }

    static #isBlockedIpv6Literal(hostname)
    {
        if (PublicUrlValidator.BLOCKED_IPV6_LITERALS.includes(hostname))
        {
            return true;
        }

        for (const blockedPrefix of PublicUrlValidator.BLOCKED_IPV6_PREFIXES)
        {
            if (hostname.startsWith(blockedPrefix))
            {
                return true;
            }
        }

        // An IPv4-mapped address (::ffff:127.0.0.1) is judged on the IPv4 it carries.
        const mappedIpv4Address = PublicUrlValidator.#mappedIpv4Address(hostname);
        if (mappedIpv4Address !== null)
        {
            return PublicUrlValidator.#isBlockedIpv4Literal(mappedIpv4Address);
        }

        return false;
    }

    /**
     * Returns the dotted-quad IPv4 carried by an IPv4-mapped IPv6 literal, or
     * null when the hostname is not one.
     *
     * Both spellings have to be handled: the WHATWG URL parser rewrites
     * "::ffff:127.0.0.1" into its compressed hex form "::ffff:7f00:1", so
     * matching only the dotted spelling would miss every mapped address that
     * actually arrives from a parsed URL.
     */
    static #mappedIpv4Address(hostname)
    {
        if (!hostname.startsWith(PublicUrlValidator.IPV4_MAPPED_IPV6_PREFIX))
        {
            return null;
        }

        const remainder = hostname.slice(PublicUrlValidator.IPV4_MAPPED_IPV6_PREFIX.length);

        if (PublicUrlValidator.IPV4_PATTERN.test(remainder))
        {
            return remainder;
        }

        const hextets = remainder.split(":");
        if (hextets.length !== 2)
        {
            return null;
        }

        const highGroup = Number.parseInt(hextets[0], 16);
        const lowGroup = Number.parseInt(hextets[1], 16);

        if (!Number.isInteger(highGroup) || !Number.isInteger(lowGroup))
        {
            return null;
        }

        if (highGroup < 0 || highGroup > 0xffff || lowGroup < 0 || lowGroup > 0xffff)
        {
            return null;
        }

        return `${(highGroup >> 8) & 0xff}.${highGroup & 0xff}.${(lowGroup >> 8) & 0xff}.${lowGroup & 0xff}`;
    }
}


module.exports = PublicUrlValidator;
