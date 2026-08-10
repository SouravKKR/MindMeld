import ViewIdentity from "../View/ViewIdentity.js";

/**
 * OrganizationContextIdentity
 *
 * The organization-specific face of ViewIdentity.
 *
 * The app already namespaces every stored path under `Users/<identity>/`, and
 * `Deck` rebuilds itself from scratch whenever the identity changes. Making an
 * organization view a DIFFERENT IDENTITY rather than a filter over the personal
 * one therefore costs nothing and buys everything: the personal decks are not
 * in memory at all while the view is active, so no surface — search, the deck
 * pickers, the storage manager, export — can leak one library into the other by
 * forgetting a predicate.
 *
 *     personal      <userId>
 *     org view      <userId>::org:<organizationId>
 *
 * The grammar itself moved to ViewIdentity when a second kind of view (the
 * administrator's simulated plan sandbox) arrived, because extractUserId has to
 * be correct for EVERY kind and two parsers would eventually disagree about a
 * malformed identity. This class stayed rather than being deleted, and every
 * body below is a one-line delegate: its callers ask an ORGANIZATION question
 * and must keep getting an organization answer. PaidDeckStudyGate in particular
 * uses isOrganizationIdentity to decide whether to try the passwordless
 * organization unlock — a plan-scoped licence must never take that path, and it
 * cannot, because the check below still only looks for `::org:`.
 */
class OrganizationContextIdentity
{
    static SEPARATOR = ViewIdentity.ORGANIZATION_SEPARATOR;

    /**
     * The identity for a view. A blank organization id means the personal view,
     * so a caller can pass whatever it has without branching first.
     *
     * @param {string} userId
     * @param {string} organizationId
     * @returns {string}
     */
    static compose(userId, organizationId)
    {
        return ViewIdentity.composeOrganization(userId, organizationId);
    }

    /**
     * The account id inside an identity, whichever view it names.
     *
     * @param {string} identity
     * @returns {string}
     */
    static extractUserId(identity)
    {
        return ViewIdentity.extractUserId(identity);
    }

    /**
     * The organization an identity is viewing, or "" for the personal view.
     *
     * @param {string} identity
     * @returns {string}
     */
    static extractOrganizationId(identity)
    {
        return ViewIdentity.extractOrganizationId(identity);
    }

    /**
     * True when this identity names an organization view. Deliberately false for
     * a plan sandbox — see the note in the class comment.
     */
    static isOrganizationIdentity(identity)
    {
        return ViewIdentity.isOrganizationIdentity(identity);
    }
}

export default OrganizationContextIdentity;
