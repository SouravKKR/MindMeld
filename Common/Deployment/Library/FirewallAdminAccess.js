// Reasons about a Linode Cloud Firewall's inbound rules with respect to ONE
// admin CIDR needing SSH, for the deploy orchestrator's temporary-access step
// (Common/Deployment/deploy-environment.sh).
//
// Two commands, both reading the firewall's current `rules` object on stdin:
//
//   node FirewallAdminAccess.js check <adminCidr>
//       Prints "allowed" or "blocked". A CIDR is allowed when an ACCEPT rule
//       covers TCP/22 for an address range that contains it (0.0.0.0/0 counts).
//
//   node FirewallAdminAccess.js grant <adminCidr> <ruleLabel>
//       Prints the rules object with a temporary ACCEPT rule for TCP/22
//       PREPENDED to inbound. Prepended, not appended: Linode evaluates inbound
//       rules in order, so a leading rule cannot be pre-empted by an earlier
//       DROP.
//
// Only IPv4 is considered — the deploy path SSHes over IPv4 and the firewalls
// this repo provisions never carry IPv6 admin rules.

function parseIpv4ToInteger(address)
{
    const octets = address.split(".").map(Number);

    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255))
    {
        return null;
    }

    // >>> 0 keeps the result unsigned; a leading octet above 127 would
    // otherwise make the shifted value negative.
    return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function parseCidr(cidrText)
{
    const [addressPart, prefixPart] = String(cidrText).split("/");
    const address = parseIpv4ToInteger(addressPart);
    const prefixLength = prefixPart === undefined ? 32 : Number(prefixPart);

    if (address === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32)
    {
        return null;
    }

    const mask = prefixLength === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLength)) >>> 0;
    return { network: (address & mask) >>> 0, mask, prefixLength };
}

function cidrContains(outerCidrText, innerCidrText)
{
    const outer = parseCidr(outerCidrText);
    const inner = parseCidr(innerCidrText);

    if (outer === null || inner === null)
    {
        return false;
    }

    // A range can only contain one that is at least as specific.
    if (inner.prefixLength < outer.prefixLength)
    {
        return false;
    }

    return ((inner.network & outer.mask) >>> 0) === outer.network;
}

// Linode port specs are comma-separated singles and ranges: "22", "80,443",
// "8000-8080".
function portSpecIncludes(portSpecText, wantedPort)
{
    return String(portSpecText || "").split(",").some((piece) =>
    {
        const trimmed = piece.trim();
        if (trimmed.includes("-"))
        {
            const [low, high] = trimmed.split("-").map(Number);
            return Number.isInteger(low) && Number.isInteger(high) && wantedPort >= low && wantedPort <= high;
        }
        return Number(trimmed) === wantedPort;
    });
}

function isSshAllowedFor(rules, adminCidr)
{
    const inboundRules = Array.isArray(rules.inbound) ? rules.inbound : [];

    return inboundRules.some((rule) =>
    {
        if (String(rule.action).toUpperCase() !== "ACCEPT")
        {
            return false;
        }
        const protocol = String(rule.protocol || "").toUpperCase();
        if (protocol !== "TCP" && protocol !== "ALL")
        {
            return false;
        }
        if (protocol === "TCP" && !portSpecIncludes(rule.ports, 22))
        {
            return false;
        }
        const allowedRanges = (rule.addresses && Array.isArray(rule.addresses.ipv4)) ? rule.addresses.ipv4 : [];
        return allowedRanges.some(range => cidrContains(range, adminCidr));
    });
}

function buildRulesWithTemporaryAccess(rules, adminCidr, ruleLabel)
{
    const temporaryRule = {
        label: ruleLabel,
        action: "ACCEPT",
        protocol: "TCP",
        ports: "22",
        addresses: { ipv4: [adminCidr], ipv6: [] }
    };

    return {
        ...rules,
        inbound: [temporaryRule, ...(Array.isArray(rules.inbound) ? rules.inbound : [])]
    };
}

const [command, adminCidr, ruleLabel] = process.argv.slice(2);

let standardInput = "";
process.stdin.on("data", chunk => standardInput += chunk);
process.stdin.on("end", () =>
{
    let rules;
    try
    {
        rules = JSON.parse(standardInput || "{}");
    }
    catch (parseError)
    {
        process.stderr.write(`FirewallAdminAccess.js: could not parse the firewall rules: ${parseError.message}\n`);
        process.exit(1);
    }

    if (parseCidr(adminCidr) === null)
    {
        process.stderr.write(`FirewallAdminAccess.js: "${adminCidr}" is not a valid IPv4 CIDR.\n`);
        process.exit(1);
    }

    if (command === "check")
    {
        process.stdout.write(isSshAllowedFor(rules, adminCidr) ? "allowed" : "blocked");
        return;
    }

    if (command === "grant")
    {
        process.stdout.write(JSON.stringify(buildRulesWithTemporaryAccess(rules, adminCidr, ruleLabel || "temp-deploy-ssh")));
        return;
    }

    process.stderr.write(`FirewallAdminAccess.js: unknown command "${command}" (expected check|grant).\n`);
    process.exit(1);
});
