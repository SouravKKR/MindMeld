import { periodicScopeTypes } from "../Enumerations/PeriodicScopeTypes.js";
import { periodicAssignmentStatuses } from "../Enumerations/PeriodicAssignmentStatuses.js";
import { periodicOnJoinModes } from "../Enumerations/PeriodicOnJoinModes.js";
import { creditGrantAmountModes } from "../Enumerations/CreditGrantAmountModes.js";
import { creditDealPaymentModes } from "../Enumerations/CreditDealPaymentModes.js";
import { creditDealPaymentStatuses } from "../Enumerations/CreditDealPaymentStatuses.js";

/**
 * PeriodicAssignmentReportPdfRenderer
 *
 * Renders the printable report for one periodic credit assignment into a
 * paginated, text-selectable jsPDF document (window.jspdf.jsPDF, loaded from
 * /ThirdParty/JsPdf). Mirrors the constants / footer / ensureRoom machinery of
 * LegalDocumentPdfRenderer and adds a simple wrapped-cell table primitive.
 *
 * Sections (in the order the admin asked for): title + timestamps; meta
 * (scope, period, amount, on-join, valid-until, status); all-time total; the
 * full beneficiary table (current + former, with cumulative credits); the
 * current org-member roster and admin(s) for org scope; and any attached
 * deal / invoice records.
 */
class PeriodicAssignmentReportPdfRenderer
{
    static #PAGE_WIDTH_MM = 210;
    static #PAGE_HEIGHT_MM = 297;
    static #PAGE_MARGIN_MM = 14;
    static #FOOTER_RESERVED_MM = 14;
    static #FONT_FAMILY = "helvetica";
    static #PT_TO_MM = 0.35278;
    static #LINE_HEIGHT_FACTOR = 1.35;

    static #WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    static renderToBlob(report)
    {
        const documentInstance = PeriodicAssignmentReportPdfRenderer.#renderInternal(report);
        return documentInstance.output("blob");
    }

    static #contentWidth()
    {
        return PeriodicAssignmentReportPdfRenderer.#PAGE_WIDTH_MM - 2 * PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM;
    }

    static #lineHeight(fontSizePt)
    {
        return fontSizePt * PeriodicAssignmentReportPdfRenderer.#PT_TO_MM * PeriodicAssignmentReportPdfRenderer.#LINE_HEIGHT_FACTOR;
    }

    static #formatDateTime(isoValue)
    {
        if (typeof isoValue !== "string" || isoValue.length === 0)
        {
            return "—";
        }
        const parsed = new Date(isoValue);
        return isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
    }

    static #formatCredits(value)
    {
        const numeric = typeof value === "number" && isFinite(value) ? value : 0;
        return String(Math.round(numeric * 10000) / 10000);
    }

    static #renderInternal(report)
    {
        const documentInstance = new window.jspdf.jsPDF({ orientation: "p", unit: "mm", format: "a4" });
        const assignment = report.assignment || {};

        const state =
        {
            documentInstance: documentInstance,
            cursorY: PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM,
            title: assignment.name || "Periodic Credit Assignment"
        };

        PeriodicAssignmentReportPdfRenderer.#renderTitle(state, state.title, "Periodic Credit Assignment Report");

        // ── Meta lines (timestamps, scope, validity, period) ──────────────
        const onJoinLabel = PeriodicAssignmentReportPdfRenderer.#onJoinLabel(assignment.onJoinMode);
        const amountModeLabel = assignment.amountMode === creditGrantAmountModes.TOTAL_SPLIT ? "Total split across list" : "Per user";
        const statusLabel = assignment.status === periodicAssignmentStatuses.TERMINATED ? "Terminated" : "Active";

        const metaLines =
        [
            ["Report generated", PeriodicAssignmentReportPdfRenderer.#formatDateTime(report.generatedAt)],
            ["Assignment created", PeriodicAssignmentReportPdfRenderer.#formatDateTime(assignment.createdAt)],
            ["Started", PeriodicAssignmentReportPdfRenderer.#formatDateTime(assignment.startAt)],
            ["Scope", report.scopeLabel || "—"],
            ["Period", report.periodLabel || "—"],
            ["Amount", `${PeriodicAssignmentReportPdfRenderer.#formatCredits(assignment.amount)} credits (${amountModeLabel})`],
            ["Valid until", report.validUntilLabel === "No end date" ? "No end date" : PeriodicAssignmentReportPdfRenderer.#formatDateTime(report.validUntilLabel)],
            ["Status", statusLabel]
        ];
        if (assignment.scopeType === periodicScopeTypes.ORGANIZATION)
        {
            metaLines.splice(4, 0, ["On new join", onJoinLabel]);
        }
        PeriodicAssignmentReportPdfRenderer.#renderKeyValueBlock(state, metaLines);

        // ── All-time total ────────────────────────────────────────────────
        PeriodicAssignmentReportPdfRenderer.#renderHeading(state, "Total credits granted since day one");
        PeriodicAssignmentReportPdfRenderer.#renderParagraph(state,
            `${PeriodicAssignmentReportPdfRenderer.#formatCredits(report.totalCreditsGivenAllTime)} credits across ${(report.allBeneficiaries || []).length} beneficiary(ies). ` +
            `Ledger cross-check: ${PeriodicAssignmentReportPdfRenderer.#formatCredits(report.ledgerTotalCrossCheck)} credits.`);

        // ── Beneficiaries (current + former) ──────────────────────────────
        PeriodicAssignmentReportPdfRenderer.#renderHeading(state, "All beneficiaries (current and former)");
        const beneficiaries = report.allBeneficiaries || [];
        if (beneficiaries.length === 0)
        {
            PeriodicAssignmentReportPdfRenderer.#renderParagraph(state, "No credits have been granted under this assignment yet.");
        }
        else
        {
            PeriodicAssignmentReportPdfRenderer.#renderTable(state,
            [
                { header: "Email", width: 60, key: "email" },
                { header: "Current", width: 18, key: "current" },
                { header: "On-join", width: 18, key: "onJoin" },
                { header: "Grants", width: 16, key: "grants" },
                { header: "Cumulative", width: 28, key: "cumulative" },
                { header: "Last grant", width: 42, key: "last" }
            ],
            beneficiaries.map(row => (
            {
                email: row.email || "—",
                current: row.isCurrentMember ? "Yes" : "No",
                onJoin: row.onJoinGranted ? "Yes" : "No",
                grants: String(row.grantCount || 0),
                cumulative: PeriodicAssignmentReportPdfRenderer.#formatCredits(row.cumulativeCredits),
                last: PeriodicAssignmentReportPdfRenderer.#formatDateTime(row.lastGrantedAt)
            })));
        }

        // ── Org-scoped extras: current members + admins ───────────────────
        if (assignment.scopeType === periodicScopeTypes.ORGANIZATION)
        {
            PeriodicAssignmentReportPdfRenderer.#renderHeading(state, "Current organization members");
            const members = report.currentOrgMembers || [];
            if (members.length === 0)
            {
                PeriodicAssignmentReportPdfRenderer.#renderParagraph(state, "The organization currently has no members.");
            }
            else
            {
                PeriodicAssignmentReportPdfRenderer.#renderTable(state,
                [
                    { header: "Email", width: 92, key: "email" },
                    { header: "Account linked", width: 34, key: "linked" },
                    { header: "Added", width: 56, key: "added" }
                ],
                members.map(member => (
                {
                    email: member.email || "—",
                    linked: member.userId && member.userId.length > 0 ? "Yes" : "Not yet",
                    added: PeriodicAssignmentReportPdfRenderer.#formatDateTime(member.addedAt)
                })));
            }

            PeriodicAssignmentReportPdfRenderer.#renderHeading(state, "Organization admin(s)");
            const admins = report.orgAdmins || [];
            if (admins.length === 0)
            {
                PeriodicAssignmentReportPdfRenderer.#renderParagraph(state, "No admin on record.");
            }
            else
            {
                for (const admin of admins)
                {
                    PeriodicAssignmentReportPdfRenderer.#renderParagraph(state, `• ${admin.email}${admin.userId ? " (account linked)" : " (not yet signed in)"}`);
                }
            }
        }

        // ── Deals / invoices ──────────────────────────────────────────────
        const deals = report.deals || [];
        if (deals.length > 0)
        {
            PeriodicAssignmentReportPdfRenderer.#renderHeading(state, "Payments & invoices");
            PeriodicAssignmentReportPdfRenderer.#renderTable(state,
            [
                { header: "Label", width: 56, key: "label" },
                { header: "Mode", width: 36, key: "mode" },
                { header: "Status", width: 30, key: "status" },
                { header: "Amount", width: 30, key: "amount" },
                { header: "Invoice", width: 30, key: "invoice" }
            ],
            deals.map(deal => (
            {
                label: deal.label || "—",
                mode: PeriodicAssignmentReportPdfRenderer.#dealModeLabel(deal.mode),
                status: PeriodicAssignmentReportPdfRenderer.#dealStatusLabel(deal.status),
                amount: deal.amountMinor > 0 ? `${(deal.amountMinor / 100).toFixed(2)} ${deal.currency || ""}`.trim() : "—",
                invoice: deal.hasInvoice ? "Attached" : "—"
            })));
        }

        PeriodicAssignmentReportPdfRenderer.#drawFooterOnEveryPage(state);
        return documentInstance;
    }

    static #onJoinLabel(onJoinMode)
    {
        if (onJoinMode === periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC)
        {
            return "On join + periodic";
        }
        if (onJoinMode === periodicOnJoinModes.ON_JOIN_PLUS_PERIODIC_SKIP_FIRST)
        {
            return "On join + periodic (skip first installment)";
        }
        return "Periodic only";
    }

    static #dealModeLabel(mode)
    {
        if (mode === creditDealPaymentModes.ON_SPOT_RAZORPAY) return "On-spot";
        if (mode === creditDealPaymentModes.INDEPENDENT) return "Independent";
        return "None";
    }

    static #dealStatusLabel(status)
    {
        if (status === creditDealPaymentStatuses.CAPTURED) return "Captured";
        if (status === creditDealPaymentStatuses.PENDING) return "Pending";
        if (status === creditDealPaymentStatuses.RECORDED) return "Recorded";
        if (status === creditDealPaymentStatuses.FAILED) return "Failed";
        return "None";
    }

    // ── Layout primitives ──────────────────────────────────────────────────

    static #ensureRoom(state, requiredMm)
    {
        const usableHeight = PeriodicAssignmentReportPdfRenderer.#PAGE_HEIGHT_MM
            - PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM
            - PeriodicAssignmentReportPdfRenderer.#FOOTER_RESERVED_MM;
        if (state.cursorY + requiredMm > usableHeight)
        {
            state.documentInstance.addPage();
            state.cursorY = PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM;
            return true;
        }
        return false;
    }

    static #renderTitle(state, title, subtitle)
    {
        const { documentInstance } = state;
        documentInstance.setFont(PeriodicAssignmentReportPdfRenderer.#FONT_FAMILY, "bold");
        documentInstance.setFontSize(18);
        documentInstance.setTextColor(0, 0, 0);
        const lines = documentInstance.splitTextToSize(title, PeriodicAssignmentReportPdfRenderer.#contentWidth());
        documentInstance.text(lines, PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM, state.cursorY + PeriodicAssignmentReportPdfRenderer.#lineHeight(18) - 1);
        state.cursorY += lines.length * PeriodicAssignmentReportPdfRenderer.#lineHeight(18);

        documentInstance.setFont(PeriodicAssignmentReportPdfRenderer.#FONT_FAMILY, "normal");
        documentInstance.setFontSize(10);
        documentInstance.setTextColor(120, 120, 120);
        documentInstance.text(subtitle, PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM, state.cursorY + PeriodicAssignmentReportPdfRenderer.#lineHeight(10) - 1);
        state.cursorY += PeriodicAssignmentReportPdfRenderer.#lineHeight(10) + 4;
        documentInstance.setTextColor(0, 0, 0);
    }

    static #renderHeading(state, text)
    {
        state.cursorY += 3;
        PeriodicAssignmentReportPdfRenderer.#ensureRoom(state, PeriodicAssignmentReportPdfRenderer.#lineHeight(13) + 2);
        const { documentInstance } = state;
        documentInstance.setFont(PeriodicAssignmentReportPdfRenderer.#FONT_FAMILY, "bold");
        documentInstance.setFontSize(13);
        documentInstance.setTextColor(0, 0, 0);
        documentInstance.text(text, PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM, state.cursorY + PeriodicAssignmentReportPdfRenderer.#lineHeight(13) - 1);
        state.cursorY += PeriodicAssignmentReportPdfRenderer.#lineHeight(13) + 2;
    }

    static #renderParagraph(state, text)
    {
        const { documentInstance } = state;
        documentInstance.setFont(PeriodicAssignmentReportPdfRenderer.#FONT_FAMILY, "normal");
        documentInstance.setFontSize(10.5);
        documentInstance.setTextColor(0, 0, 0);
        const lines = documentInstance.splitTextToSize(text, PeriodicAssignmentReportPdfRenderer.#contentWidth());
        for (const line of lines)
        {
            PeriodicAssignmentReportPdfRenderer.#ensureRoom(state, PeriodicAssignmentReportPdfRenderer.#lineHeight(10.5));
            documentInstance.text(line, PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM, state.cursorY + PeriodicAssignmentReportPdfRenderer.#lineHeight(10.5) - 1);
            state.cursorY += PeriodicAssignmentReportPdfRenderer.#lineHeight(10.5);
        }
        state.cursorY += 2;
    }

    static #renderKeyValueBlock(state, pairs)
    {
        const { documentInstance } = state;
        const labelWidth = 42;
        const valueX = PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM + labelWidth;
        const valueWidth = PeriodicAssignmentReportPdfRenderer.#contentWidth() - labelWidth;

        for (const [label, value] of pairs)
        {
            documentInstance.setFont(PeriodicAssignmentReportPdfRenderer.#FONT_FAMILY, "normal");
            documentInstance.setFontSize(10);
            const valueLines = documentInstance.splitTextToSize(String(value), valueWidth);
            const rowHeight = Math.max(1, valueLines.length) * PeriodicAssignmentReportPdfRenderer.#lineHeight(10);
            PeriodicAssignmentReportPdfRenderer.#ensureRoom(state, rowHeight);

            const baselineY = state.cursorY + PeriodicAssignmentReportPdfRenderer.#lineHeight(10) - 1;
            documentInstance.setTextColor(110, 110, 110);
            documentInstance.text(label, PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM, baselineY);
            documentInstance.setTextColor(0, 0, 0);
            documentInstance.text(valueLines, valueX, baselineY);
            state.cursorY += rowHeight;
        }
        state.cursorY += 2;
    }

    static #renderTable(state, columns, rows)
    {
        const cellPadding = 2;
        const headerFontSize = 9;
        const bodyFontSize = 9.5;

        const drawHeader = () =>
        {
            const { documentInstance } = state;
            const headerHeight = PeriodicAssignmentReportPdfRenderer.#lineHeight(headerFontSize) + 2 * cellPadding;
            PeriodicAssignmentReportPdfRenderer.#ensureRoom(state, headerHeight);
            documentInstance.setFillColor(238, 238, 238);
            documentInstance.rect(PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM, state.cursorY, PeriodicAssignmentReportPdfRenderer.#contentWidth(), headerHeight, "F");
            documentInstance.setFont(PeriodicAssignmentReportPdfRenderer.#FONT_FAMILY, "bold");
            documentInstance.setFontSize(headerFontSize);
            documentInstance.setTextColor(60, 60, 60);
            let columnX = PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM;
            for (const column of columns)
            {
                documentInstance.text(column.header, columnX + cellPadding, state.cursorY + cellPadding + PeriodicAssignmentReportPdfRenderer.#lineHeight(headerFontSize) - 1);
                columnX += column.width;
            }
            state.cursorY += headerHeight;
            documentInstance.setTextColor(0, 0, 0);
        };

        drawHeader();

        for (const row of rows)
        {
            const { documentInstance } = state;
            documentInstance.setFont(PeriodicAssignmentReportPdfRenderer.#FONT_FAMILY, "normal");
            documentInstance.setFontSize(bodyFontSize);

            // Pre-wrap each cell to compute the row height.
            const wrappedCells = columns.map(column =>
                documentInstance.splitTextToSize(String(row[column.key] ?? ""), column.width - 2 * cellPadding));
            const maxLines = wrappedCells.reduce((maximum, lines) => Math.max(maximum, lines.length), 1);
            const rowHeight = maxLines * PeriodicAssignmentReportPdfRenderer.#lineHeight(bodyFontSize) + 2 * cellPadding;

            if (PeriodicAssignmentReportPdfRenderer.#ensureRoom(state, rowHeight))
            {
                drawHeader();
            }

            let columnX = PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM;
            const baselineY = state.cursorY + cellPadding + PeriodicAssignmentReportPdfRenderer.#lineHeight(bodyFontSize) - 1;
            for (let columnIndex = 0; columnIndex < columns.length; columnIndex++)
            {
                documentInstance.text(wrappedCells[columnIndex], columnX + cellPadding, baselineY);
                columnX += columns[columnIndex].width;
            }

            // Row separator.
            documentInstance.setDrawColor(225, 225, 225);
            documentInstance.line(
                PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM,
                state.cursorY + rowHeight,
                PeriodicAssignmentReportPdfRenderer.#PAGE_MARGIN_MM + PeriodicAssignmentReportPdfRenderer.#contentWidth(),
                state.cursorY + rowHeight
            );
            state.cursorY += rowHeight;
        }
        state.cursorY += 4;
    }

    static #drawFooterOnEveryPage(state)
    {
        const total = state.documentInstance.internal.getNumberOfPages();
        for (let pageNumber = 1; pageNumber <= total; pageNumber++)
        {
            state.documentInstance.setPage(pageNumber);
            state.documentInstance.setFont(PeriodicAssignmentReportPdfRenderer.#FONT_FAMILY, "normal");
            state.documentInstance.setFontSize(8);
            state.documentInstance.setTextColor(140, 140, 140);
            state.documentInstance.text(
                `${state.title}  ·  Page ${pageNumber} of ${total}`,
                PeriodicAssignmentReportPdfRenderer.#PAGE_WIDTH_MM / 2,
                PeriodicAssignmentReportPdfRenderer.#PAGE_HEIGHT_MM - 9,
                { align: "center" }
            );
            state.documentInstance.setTextColor(0, 0, 0);
        }
    }
}

export default PeriodicAssignmentReportPdfRenderer;
