import Deck from "../../../Globals/Model/Deck.js";


/**
 * Renders a GitHub-style heatmap of the student's spaced-repetition
 * review activity for the deck (and all its descendants).
 *
 * Each cell is a discrete coloured rectangle: brightness is a flat
 * `--accent-color` opacity scaled by the day's review count
 * (normalised to the busiest day in the chosen span). Cells are
 * separated by a small gap so they read as individual days rather
 * than blending.
 *
 * Source of truth: every card's `progress.getProgressPoints()`. The
 * only call site that appends to that history is `Card.attempt(...)`
 * from a `SpacedRepetitionSession` — mock-test attempts, content
 * reads, and curated-study reads all run on separate code paths that
 * never touch this history. So filtering to "spaced repetition only"
 * is automatic.
 *
 * Axis labels:
 *   • Day-of-week column on the left (Mon..Sun — every row labelled)
 *     stays anchored when the grid scrolls horizontally on long
 *     spans.
 *   • Month labels row above the grid; each month label is anchored
 *     to the column where that month's first week starts.
 *   • For the 1 Week span the day-row labels carry the full date
 *     instead of just the weekday, and the top row shows the range
 *     since "month" isn't meaningful at that resolution.
 *
 * Time-span selector: 1 Week (default) / 1 Month / 1 Year / All Time.
 */
class StudyActivityHeatmap extends HTMLElement
{
    static TIME_SPANS = Object.freeze({
        WEEK:     "WEEK",
        MONTH:    "MONTH",
        YEAR:     "YEAR",
        ALL_TIME: "ALL_TIME",
    });

    static SPAN_BUTTON_DEFINITIONS = [
        { spanKey: "WEEK",     label: "1 Week" },
        { spanKey: "MONTH",    label: "1 Month" },
        { spanKey: "YEAR",     label: "1 Year" },
        { spanKey: "ALL_TIME", label: "All Time" },
    ];

    static MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
    static CELL_SIZE_PIXELS     = 16;
    static CELL_GAP_PIXELS      = 2;
    static IDLE_CELL_OPACITY    = 0.07;
    static MIN_ACTIVE_OPACITY   = 0.20;
    static DAY_OF_WEEK_LABELS   = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    static MONTH_LABELS         = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    #deck = null;
    #currentSpan = StudyActivityHeatmap.TIME_SPANS.WEEK;
    #reviewTimestampsMilliseconds = [];

    connectedCallback()
    {
        this.#deck = Deck.getById(this.getAttribute("deck-id"));
        if (!this.#deck)
        {
            this.innerHTML = "";
            return;
        }

        this.#reviewTimestampsMilliseconds = StudyActivityHeatmap.#collectReviewTimestamps(this.#deck);
        this.#renderShell();
        this.#renderGrid();
        this.#bindSpanButtons();
    }

    #renderShell()
    {
        const buttonsHtml = StudyActivityHeatmap.SPAN_BUTTON_DEFINITIONS.map((spanDefinition) =>
        {
            const isSelected = spanDefinition.spanKey === this.#currentSpan;
            const selectedClass = isSelected ? " study-activity-heatmap-span-button--selected" : "";
            return `<button class="study-activity-heatmap-span-button${selectedClass}" data-span-key="${spanDefinition.spanKey}">${spanDefinition.label}</button>`;
        }).join("");

        this.innerHTML =
        `
            <h2 align="center">Study Activity</h2>
            <div class="study-activity-heatmap-span-row">${buttonsHtml}</div>
            <div class="study-activity-heatmap-grid-container">
                <div class="study-activity-heatmap-grid-row">
                    <div class="study-activity-heatmap-day-labels"></div>
                    <div class="study-activity-heatmap-scrollable">
                        <div class="study-activity-heatmap-top-labels"></div>
                        <div class="study-activity-heatmap-grid"></div>
                    </div>
                </div>
                <div class="study-activity-heatmap-summary"></div>
            </div>
        `;
    }

    #bindSpanButtons()
    {
        const spanButtons = this.querySelectorAll(".study-activity-heatmap-span-button");
        for (const spanButton of spanButtons)
        {
            spanButton.addEventListener("click", () =>
            {
                const requestedSpan = spanButton.getAttribute("data-span-key");
                if (!Object.values(StudyActivityHeatmap.TIME_SPANS).includes(requestedSpan))
                {
                    return;
                }
                if (requestedSpan === this.#currentSpan)
                {
                    return;
                }

                this.#currentSpan = requestedSpan;
                this.#refreshSpanButtonHighlight();
                this.#renderGrid();
            });
        }
    }

    #refreshSpanButtonHighlight()
    {
        const spanButtons = this.querySelectorAll(".study-activity-heatmap-span-button");
        for (const spanButton of spanButtons)
        {
            const isSelected = spanButton.getAttribute("data-span-key") === this.#currentSpan;
            spanButton.classList.toggle("study-activity-heatmap-span-button--selected", isSelected);
        }
    }

    #renderGrid()
    {
        const cellsGrid     = this.querySelector(".study-activity-heatmap-grid");
        const dayLabels     = this.querySelector(".study-activity-heatmap-day-labels");
        const topLabels     = this.querySelector(".study-activity-heatmap-top-labels");
        const summaryElement = this.querySelector(".study-activity-heatmap-summary");
        if (!cellsGrid || !dayLabels || !topLabels || !summaryElement)
        {
            return;
        }

        const spanRange = this.#computeSpanRange();
        if (spanRange === null)
        {
            cellsGrid.innerHTML = "";
            dayLabels.innerHTML = "";
            topLabels.innerHTML = "";
            summaryElement.textContent = "No reviews yet — once you study a few cards, your activity will appear here.";
            return;
        }

        const dailyCounts  = this.#bucketByDay(spanRange.actualStartDayUtcMilliseconds, spanRange.endDayUtcMilliseconds);
        const maximumCount = StudyActivityHeatmap.#computeMaximumCount(dailyCounts);

        StudyActivityHeatmap.#renderCells(cellsGrid, spanRange, dailyCounts, maximumCount);
        StudyActivityHeatmap.#renderDayLabels(dayLabels, this.#currentSpan, spanRange.actualStartDayUtcMilliseconds);
        StudyActivityHeatmap.#renderTopLabels(topLabels, this.#currentSpan, spanRange.startDayUtcMilliseconds, spanRange.actualStartDayUtcMilliseconds, spanRange.endDayUtcMilliseconds, spanRange.weekColumnCount);

        const totalReviews = Array.from(dailyCounts.values()).reduce((runningTotal, dayCount) => runningTotal + dayCount, 0);
        const dayCount = dailyCounts.size;
        summaryElement.textContent = `${totalReviews} review(s) across ${dayCount} day(s) in this span.`;
    }

    /**
     * Returns the inclusive [startDayUtcMilliseconds, endDayUtcMilliseconds]
     * range for the current span, or `null` when the deck has no
     * recorded reviews and the span is ALL_TIME. For fixed spans
     * (WEEK / MONTH / YEAR) the range is anchored on "today" so the
     * grid always extends right up to the present.
     */
    #computeSpanRange()
    {
        const today = StudyActivityHeatmap.#truncateToUtcDay(Date.now());

        if (this.#currentSpan === StudyActivityHeatmap.TIME_SPANS.WEEK)
        {
            const startDay = today - 6 * StudyActivityHeatmap.MILLISECONDS_PER_DAY;
            return StudyActivityHeatmap.#buildSpanRange(startDay, today);
        }
        if (this.#currentSpan === StudyActivityHeatmap.TIME_SPANS.MONTH)
        {
            const startDay = today - 29 * StudyActivityHeatmap.MILLISECONDS_PER_DAY;
            return StudyActivityHeatmap.#buildSpanRange(startDay, today);
        }
        if (this.#currentSpan === StudyActivityHeatmap.TIME_SPANS.YEAR)
        {
            const startDay = today - 364 * StudyActivityHeatmap.MILLISECONDS_PER_DAY;
            return StudyActivityHeatmap.#buildSpanRange(startDay, today);
        }

        // ALL_TIME — span starts at the earliest review the user has on
        // the deck. If there are no reviews at all, the caller renders an
        // empty-state and we bail out here.
        if (this.#reviewTimestampsMilliseconds.length === 0)
        {
            return null;
        }
        const earliestReviewMilliseconds = Math.min(...this.#reviewTimestampsMilliseconds);
        const earliestDayUtc = StudyActivityHeatmap.#truncateToUtcDay(earliestReviewMilliseconds);
        return StudyActivityHeatmap.#buildSpanRange(earliestDayUtc, today);
    }

    static #buildSpanRange(startDayUtcMilliseconds, endDayUtcMilliseconds)
    {
        // The grid uses days-of-week (Mon..Sun) as the seven rows and
        // weeks as the columns. Pad the start back to a Monday so the
        // first column starts at the top row — keeps the grid aligned
        // for any range. Days outside the actual span are rendered as
        // invisible placeholders to maintain column structure.
        const dayOfWeek = StudyActivityHeatmap.#mondayBasedDayOfWeek(new Date(startDayUtcMilliseconds));
        const paddedStartDayUtc = startDayUtcMilliseconds - dayOfWeek * StudyActivityHeatmap.MILLISECONDS_PER_DAY;

        const totalDays = Math.round((endDayUtcMilliseconds - paddedStartDayUtc) / StudyActivityHeatmap.MILLISECONDS_PER_DAY) + 1;
        const weekColumnCount = Math.max(1, Math.ceil(totalDays / 7));

        return {
            startDayUtcMilliseconds:       paddedStartDayUtc,
            actualStartDayUtcMilliseconds: startDayUtcMilliseconds,
            endDayUtcMilliseconds:         endDayUtcMilliseconds,
            weekColumnCount:               weekColumnCount,
        };
    }

    /**
     * Aggregates `this.#reviewTimestampsMilliseconds` into a Map keyed
     * by the UTC-day-start timestamp of each review. The map only
     * contains days the user actually studied on — zero-review days are
     * absent (and treated as zero downstream).
     */
    #bucketByDay(startDayUtcMilliseconds, endDayUtcMilliseconds)
    {
        const dailyCounts = new Map();
        for (const reviewMilliseconds of this.#reviewTimestampsMilliseconds)
        {
            const reviewDayUtc = StudyActivityHeatmap.#truncateToUtcDay(reviewMilliseconds);
            if (reviewDayUtc < startDayUtcMilliseconds || reviewDayUtc > endDayUtcMilliseconds)
            {
                continue;
            }
            dailyCounts.set(reviewDayUtc, (dailyCounts.get(reviewDayUtc) || 0) + 1);
        }
        return dailyCounts;
    }

    static #computeMaximumCount(dailyCounts)
    {
        let maximumCount = 0;
        for (const dayCount of dailyCounts.values())
        {
            if (dayCount > maximumCount)
            {
                maximumCount = dayCount;
            }
        }
        return maximumCount;
    }

    /**
     * Renders the 7×N grid of day cells. Each cell is a discrete
     * coloured rectangle: opacity scales `--accent-color` from the
     * idle baseline up to fully saturated on the day with the most
     * reviews. Days outside the actual span (the back-pad to Monday
     * at the leftmost column) render as fully-transparent placeholder
     * cells so the column / row alignment stays intact.
     */
    static #renderCells(cellsGrid, spanRange, dailyCounts, maximumCount)
    {
        cellsGrid.style.setProperty("--study-activity-heatmap-cell-size", StudyActivityHeatmap.CELL_SIZE_PIXELS + "px");
        cellsGrid.style.setProperty("--study-activity-heatmap-cell-gap", StudyActivityHeatmap.CELL_GAP_PIXELS + "px");

        const cellHtmlPieces = [];
        for (let weekColumnIndex = 0; weekColumnIndex < spanRange.weekColumnCount; weekColumnIndex++)
        {
            for (let dayRowIndex = 0; dayRowIndex < 7; dayRowIndex++)
            {
                const cellDayUtcMilliseconds = spanRange.startDayUtcMilliseconds + (weekColumnIndex * 7 + dayRowIndex) * StudyActivityHeatmap.MILLISECONDS_PER_DAY;

                if (cellDayUtcMilliseconds < spanRange.actualStartDayUtcMilliseconds || cellDayUtcMilliseconds > spanRange.endDayUtcMilliseconds)
                {
                    cellHtmlPieces.push(`<div class="study-activity-heatmap-cell study-activity-heatmap-cell--placeholder"></div>`);
                    continue;
                }

                const dayCount   = dailyCounts.get(cellDayUtcMilliseconds) || 0;
                const cellOpacity = StudyActivityHeatmap.#computeCellOpacity(dayCount, maximumCount);
                const tooltipText = `${dayCount} review${dayCount === 1 ? "" : "s"} on ${StudyActivityHeatmap.#formatDayLabel(cellDayUtcMilliseconds)}`;

                cellHtmlPieces.push(
                    `<div class="study-activity-heatmap-cell" style="--study-activity-heatmap-cell-opacity:${cellOpacity.toFixed(3)};" title="${StudyActivityHeatmap.#escapeAttribute(tooltipText)}"></div>`
                );
            }
        }

        cellsGrid.innerHTML = cellHtmlPieces.join("");
    }

    static #computeCellOpacity(dayCount, maximumCount)
    {
        if (dayCount <= 0 || maximumCount <= 0)
        {
            return StudyActivityHeatmap.IDLE_CELL_OPACITY;
        }
        const normalised = dayCount / maximumCount;
        return Math.min(1.0, StudyActivityHeatmap.MIN_ACTIVE_OPACITY + (1.0 - StudyActivityHeatmap.MIN_ACTIVE_OPACITY) * normalised);
    }

    /**
     * Renders the day-of-week column on the left of the grid. Every
     * row is labelled — Mon..Sun — at all span widths. For the 1 Week
     * view the labels carry the full date too, so each row maps back
     * to a specific calendar day without consulting the tooltip.
     */
    static #renderDayLabels(dayLabelsContainer, currentSpan, actualStartDayUtcMilliseconds)
    {
        const cellSize = StudyActivityHeatmap.CELL_SIZE_PIXELS;
        const cellGap  = StudyActivityHeatmap.CELL_GAP_PIXELS;
        dayLabelsContainer.style.setProperty("--study-activity-heatmap-cell-size", cellSize + "px");
        dayLabelsContainer.style.setProperty("--study-activity-heatmap-cell-gap", cellGap + "px");
        dayLabelsContainer.style.height = (7 * cellSize + 6 * cellGap) + "px";

        if (currentSpan === StudyActivityHeatmap.TIME_SPANS.WEEK)
        {
            // The padded grid for a 1-week span starts on the Monday
            // *containing* the requested 7-day window. We walk 7
            // calendar days forward from the requested start and label
            // each visible row with its weekday + short date.
            const labels = [];
            for (let visibleDayIndex = 0; visibleDayIndex < 7; visibleDayIndex++)
            {
                const cellDayUtcMilliseconds = actualStartDayUtcMilliseconds + visibleDayIndex * StudyActivityHeatmap.MILLISECONDS_PER_DAY;
                const dayOfWeekIndex = StudyActivityHeatmap.#mondayBasedDayOfWeek(new Date(cellDayUtcMilliseconds));
                labels.push({
                    rowIndex: dayOfWeekIndex,
                    text:     `${StudyActivityHeatmap.DAY_OF_WEEK_LABELS[dayOfWeekIndex]} ${StudyActivityHeatmap.#formatShortDateLabel(cellDayUtcMilliseconds)}`,
                });
            }

            dayLabelsContainer.innerHTML = labels.map((labelEntry) =>
            {
                const topOffsetPixels = labelEntry.rowIndex * (cellSize + cellGap);
                return `<span class="study-activity-heatmap-day-label" style="top:${topOffsetPixels}px;">${StudyActivityHeatmap.#escapeHtml(labelEntry.text)}</span>`;
            }).join("");
            return;
        }

        // MONTH / YEAR / ALL_TIME — label every row of the week.
        dayLabelsContainer.innerHTML = StudyActivityHeatmap.DAY_OF_WEEK_LABELS.map((dayLabel, dayRowIndex) =>
        {
            const topOffsetPixels = dayRowIndex * (cellSize + cellGap);
            return `<span class="study-activity-heatmap-day-label" style="top:${topOffsetPixels}px;">${StudyActivityHeatmap.#escapeHtml(dayLabel)}</span>`;
        }).join("");
    }

    /**
     * Renders the labels along the top of the grid:
     *  • 1 Week — a single label showing the date range.
     *  • 1 Month / 1 Year / All Time — month abbreviations anchored to
     *    the column where each month begins.
     */
    static #renderTopLabels(topLabelsContainer, currentSpan, paddedStartDayUtcMilliseconds, actualStartDayUtcMilliseconds, endDayUtcMilliseconds, weekColumnCount)
    {
        const cellSize = StudyActivityHeatmap.CELL_SIZE_PIXELS;
        const cellGap  = StudyActivityHeatmap.CELL_GAP_PIXELS;
        topLabelsContainer.style.width = (weekColumnCount * cellSize + Math.max(0, weekColumnCount - 1) * cellGap) + "px";

        if (currentSpan === StudyActivityHeatmap.TIME_SPANS.WEEK)
        {
            const rangeText = `${StudyActivityHeatmap.#formatShortDateLabel(actualStartDayUtcMilliseconds)} — ${StudyActivityHeatmap.#formatShortDateLabel(endDayUtcMilliseconds)}`;
            topLabelsContainer.innerHTML = `<span class="study-activity-heatmap-top-label study-activity-heatmap-top-label--range">${StudyActivityHeatmap.#escapeHtml(rangeText)}</span>`;
            return;
        }

        // For wider spans we anchor a month label to the column where
        // each month's first day appears. The first column always
        // emits the month of its first in-span day so the leftmost
        // gradient region has context.
        const labels = [];
        let previousMonthIndex = -1;

        for (let weekColumnIndex = 0; weekColumnIndex < weekColumnCount; weekColumnIndex++)
        {
            // Find the first in-span day in this column. If the whole
            // column is out-of-span, skip — no label would be useful.
            let columnAnchorDayUtc = null;
            for (let dayRowIndex = 0; dayRowIndex < 7; dayRowIndex++)
            {
                const cellDayUtcMilliseconds = paddedStartDayUtcMilliseconds + (weekColumnIndex * 7 + dayRowIndex) * StudyActivityHeatmap.MILLISECONDS_PER_DAY;
                if (cellDayUtcMilliseconds >= actualStartDayUtcMilliseconds && cellDayUtcMilliseconds <= endDayUtcMilliseconds)
                {
                    columnAnchorDayUtc = cellDayUtcMilliseconds;
                    break;
                }
            }
            if (columnAnchorDayUtc === null)
            {
                continue;
            }

            const anchorDate = new Date(columnAnchorDayUtc);
            const monthIndex = anchorDate.getUTCMonth();

            if (monthIndex !== previousMonthIndex)
            {
                labels.push({
                    columnIndex: weekColumnIndex,
                    text:        StudyActivityHeatmap.MONTH_LABELS[monthIndex],
                });
                previousMonthIndex = monthIndex;
            }
        }

        topLabelsContainer.innerHTML = labels.map((labelEntry) =>
        {
            const leftOffsetPixels = labelEntry.columnIndex * (cellSize + cellGap);
            return `<span class="study-activity-heatmap-top-label" style="left:${leftOffsetPixels}px;">${StudyActivityHeatmap.#escapeHtml(labelEntry.text)}</span>`;
        }).join("");
    }

    static #formatDayLabel(dayUtcMilliseconds)
    {
        const labelDate = new Date(dayUtcMilliseconds);
        return labelDate.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }

    static #formatShortDateLabel(dayUtcMilliseconds)
    {
        const labelDate = new Date(dayUtcMilliseconds);
        return labelDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    static #escapeAttribute(rawText)
    {
        if (typeof rawText !== "string")
        {
            return "";
        }
        return rawText.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    static #escapeHtml(rawText)
    {
        if (typeof rawText !== "string")
        {
            return "";
        }
        return rawText
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * Walks every card in the deck (recursive) and returns the
     * millisecond timestamp of each progress-point's `fsrs.lastReview`.
     * Invalid / missing timestamps are skipped rather than zeroed so
     * the heatmap doesn't get a phantom epoch-day spike.
     */
    static #collectReviewTimestamps(deck)
    {
        const collected = [];
        const cards = deck.getCards(true);

        for (const card of cards)
        {
            const progress = card.getProgress();
            if (!progress)
            {
                continue;
            }
            const progressPoints = progress.getProgressPoints();
            for (const progressPoint of progressPoints)
            {
                const fsrsState = (typeof progressPoint?.getFsrsState === "function") ? progressPoint.getFsrsState() : null;
                const lastReviewValue = fsrsState ? fsrsState.lastReview : null;

                let timestampMilliseconds = NaN;
                if (lastReviewValue instanceof Date)
                {
                    timestampMilliseconds = lastReviewValue.getTime();
                }
                else if (typeof lastReviewValue === "string")
                {
                    timestampMilliseconds = Date.parse(lastReviewValue);
                }
                else if (typeof lastReviewValue === "number")
                {
                    timestampMilliseconds = lastReviewValue;
                }

                if (Number.isFinite(timestampMilliseconds) && timestampMilliseconds > 0)
                {
                    collected.push(timestampMilliseconds);
                }
            }
        }

        return collected;
    }

    static #truncateToUtcDay(timestampMilliseconds)
    {
        // ISO-day truncation. We use UTC here rather than the user's
        // local timezone because the source timestamps (FSRS lastReview)
        // are stored as Date / ISO strings without timezone
        // normalisation — staying in UTC keeps the buckets consistent
        // regardless of where the user is studying.
        const dayStart = new Date(timestampMilliseconds);
        dayStart.setUTCHours(0, 0, 0, 0);
        return dayStart.getTime();
    }

    static #mondayBasedDayOfWeek(dateValue)
    {
        // Date.getUTCDay() returns 0..6 with Sunday=0. Re-base so
        // Monday=0 .. Sunday=6 to match the grid's top-to-bottom order.
        const sundayBasedDayOfWeek = dateValue.getUTCDay();
        return (sundayBasedDayOfWeek + 6) % 7;
    }
}

customElements.define("study-activity-heatmap", StudyActivityHeatmap);
export default StudyActivityHeatmap;
