const AdminAuditEventQueryEngine = require("../Database/AdminAuditEventQueryEngine");

/**
 * AdminActionAuditor
 *
 * Shared by the EnsureAdmin and EnsureOrgAdmin plugins to record every privileged
 * request into the admin audit trail. It attaches a one-shot "finish" listener to
 * the response so it captures the FINAL status code — whether the action
 * succeeded (2xx/3xx), was blocked by the gate itself (401/403), or errored
 * (5xx). Attaching it from the gate plugin (which runs before the handler) means
 * every admin route is covered automatically with no per-endpoint wiring, so a
 * newly added admin endpoint cannot silently escape the audit log.
 *
 * The endpoint path is resolved the same way the rate-limit logger does (URL with
 * the query string stripped). The actor is read from the request-memoized user
 * (the gate has already resolved it); the source IP is resolved up front because
 * request.getIp() is async and the finish callback is synchronous.
 */
class AdminActionAuditor
{
    static #getEndpointPath(request)
    {
        const rawUrl = typeof request.url === "string" ? request.url : "";
        return rawUrl.split("?")[0] || "/";
    }

    static async #resolveClientIp(request)
    {
        try
        {
            return (await request.getIp()) || "unknown";
        }
        catch (ipLookupError)
        {
            return (request.socket && request.socket.remoteAddress) || "unknown";
        }
    }

    /**
     * Attaches the audit-recording finish listener for this request. Idempotent —
     * if both a role gate and some other path call it, only one listener attaches.
     *
     * @param {PacketronRequest} request
     * @param {PacketronResponse} response
     * @param {number|null} actorRole - the role enum the gate authorized against
     */
    static async attach(request, response, actorRole = null)
    {
        if (response.__adminAuditAttached)
        {
            return;
        }
        response.__adminAuditAttached = true;

        const endpoint = AdminActionAuditor.#getEndpointPath(request);
        const method = request.method || "";
        const ipAddress = await AdminActionAuditor.#resolveClientIp(request);

        response.on("finish", () =>
        {
            try
            {
                // request.__user is populated by getUser() (called inside the gate
                // before this fires). It is null for a blocked anonymous attempt.
                const user = request.__user || null;
                const additionalData = user && typeof user.getAdditionalData === "function" ? (user.getAdditionalData() || {}) : {};

                AdminAuditEventQueryEngine.record
                ({
                    actorUserId: user && typeof user.getId === "function" ? user.getId() : null,
                    actorEmail: additionalData.email || null,
                    actorRole: user && typeof user.getRole === "function" ? user.getRole() : actorRole,
                    endpoint: endpoint,
                    method: method,
                    statusCode: response.statusCode,
                    ipAddress: ipAddress
                }).catch(() => {});
            }
            catch (auditError)
            {
                console.error("[AdminActionAuditor] Failed to record admin audit event:", auditError);
            }
        });
    }
}

module.exports = AdminActionAuditor;
