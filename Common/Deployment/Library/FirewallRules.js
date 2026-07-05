// Firewall-rule generator for the MindMeld environment provisioner
// (Common/Deployment/provision-environment.sh). Prints the `rules` object of a
// Linode Cloud Firewall create/update body as JSON on stdout, so the bash
// orchestrator never has to hand-build the nested structure.
//
// Every environment gets three firewalls, mirroring the production layout:
//   * server-colocated — base node that also hosts Mongo (Development). Inbound:
//     SSH from the admin CIDR, Redis (6379) and Mongo (27017) from the VPC CIDR.
//   * server-separate  — base node with Mongo on its own VM (Testing / Production).
//     Inbound: SSH from the admin CIDR, Redis (6379) from the VPC CIDR.
//   * database         — the standalone Mongo VM. Inbound: SSH from the admin
//     CIDR, Mongo (27017) from the VPC CIDR.
//   * burst            — the throwaway worker VMs. Inbound DROP with no rules;
//     outbound ACCEPT. They reach Redis/Mongo over the VPC and the LLM APIs
//     outbound, and never accept a single inbound packet.
//
// Usage: node FirewallRules.js <role> <vpcCidr> <adminCidr>
//   role      one of server-colocated | server-separate | database | burst
//   vpcCidr   the environment's VPC subnet CIDR (e.g. 10.10.0.0/24)
//   adminCidr the CIDR allowed to SSH in (e.g. 203.0.113.7/32)

function buildAllowRule(label, port, addressCidr)
{
    return {
        label,
        action: "ACCEPT",
        protocol: "TCP",
        ports: String(port),
        addresses: { ipv4: [addressCidr], ipv6: [] }
    };
}

function buildRulesForRole(role, vpcCidr, adminCidr)
{
    const inbound = [];

    if (role === "burst")
    {
        return { inbound_policy: "DROP", outbound_policy: "ACCEPT", inbound: [], outbound: [] };
    }

    // Every non-burst node accepts SSH only from the admin CIDR.
    inbound.push(buildAllowRule("allow-ssh-admin", 22, adminCidr));

    if (role === "server-colocated")
    {
        inbound.push(buildAllowRule("allow-redis-vpc", 6379, vpcCidr));
        inbound.push(buildAllowRule("allow-mongo-vpc", 27017, vpcCidr));
    }
    else if (role === "server-separate")
    {
        inbound.push(buildAllowRule("allow-redis-vpc", 6379, vpcCidr));
    }
    else if (role === "database")
    {
        inbound.push(buildAllowRule("allow-mongo-vpc", 27017, vpcCidr));
    }
    else
    {
        process.stderr.write(`FirewallRules.js: unknown role "${role}"\n`);
        process.exit(2);
    }

    return { inbound_policy: "DROP", outbound_policy: "ACCEPT", inbound, outbound: [] };
}

function main()
{
    const role = process.argv[2];
    const vpcCidr = process.argv[3];
    const adminCidr = process.argv[4];

    if (!role || !vpcCidr || !adminCidr)
    {
        process.stderr.write("FirewallRules.js: usage: node FirewallRules.js <role> <vpcCidr> <adminCidr>\n");
        process.exit(2);
    }

    process.stdout.write(JSON.stringify(buildRulesForRole(role, vpcCidr, adminCidr)));
}

main();
