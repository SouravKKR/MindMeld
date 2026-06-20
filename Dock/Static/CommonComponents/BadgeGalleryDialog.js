import DialogBox from "./DialogBox.js";
import StreakBadgeHelper from "../Globals/Classes/Streak/StreakBadgeHelper.js";
import MetricBadgeHelper from "../Globals/Classes/Metrics/MetricBadgeHelper.js";

/**
 * Modal gallery of badges — earned ones in full colour, locked ones greyed with
 * their threshold. Serves both the streak track (show) and a milestone metric
 * track (showMetricCategory). Clicking any tile opens an enlarged view of that
 * badge. Reuses the global `.streak-badge-*` styles (SettingsPage.css) plus the
 * gallery/expanded styles in CommonStyles/BadgeGalleryDialog.css.
 */
class BadgeGalleryDialog
{
    // One gallery tile. The data-* carry everything the expanded view needs, so
    // the click handler can render it without re-deriving from the source list.
    static #tileHtml(badge)
    {
        const imageHtml = (typeof badge.imagePath === "string" && badge.imagePath.length > 0)
            ? `<img src="${badge.imagePath}" alt="${badge.name}" loading="lazy" onerror="this.remove()">`
            : "";
        const fallbackGlyph = badge.isEarned ? StreakBadgeHelper.FALLBACK_BADGE_GLYPH : "🔒";
        return `
            <div class="streak-badge-tile ${badge.isEarned ? "earned" : "locked"}" title="${badge.name} — ${badge.thresholdLabel}"
                data-name="${badge.name}" data-image="${badge.imagePath || ""}" data-threshold="${badge.thresholdLabel}" data-earned="${badge.isEarned ? "1" : "0"}">
                <div class="streak-badge-icon">
                    <span class="streak-badge-fallback">${fallbackGlyph}</span>
                    ${imageHtml}
                </div>
                <div class="streak-badge-name">${badge.name}</div>
                <div class="streak-badge-threshold">${badge.thresholdLabel}</div>
            </div>
        `;
    }

    // Builds the gallery modal and wires tile clicks to the expanded view.
    static #present(title, badges, earnedCount)
    {
        const tilesHtml = badges.map((badge) => BadgeGalleryDialog.#tileHtml(badge)).join("");
        const dialog = DialogBox.modal(`
            <div class="badge-gallery-dialog">
                <div class="badge-gallery-title">${title} — ${earnedCount} / ${badges.length} earned</div>
                <div class="streak-badge-grid">${tilesHtml}</div>
            </div>
        `);

        const grid = dialog.querySelector(".streak-badge-grid");
        if (grid)
        {
            grid.addEventListener("click", (event) =>
            {
                const target = event.target instanceof Element ? event.target : null;
                const tile = target ? target.closest(".streak-badge-tile") : null;
                if (!tile || !grid.contains(tile))
                {
                    return;
                }
                BadgeGalleryDialog.#showExpanded
                ({
                    name: tile.dataset.name,
                    imagePath: tile.dataset.image,
                    thresholdLabel: tile.dataset.threshold,
                    isEarned: tile.dataset.earned === "1"
                });
            });
        }
    }

    // Enlarged single-badge view, opened on top of the gallery.
    static #showExpanded(badge)
    {
        const imageHtml = (typeof badge.imagePath === "string" && badge.imagePath.length > 0)
            ? `<img src="${badge.imagePath}" alt="${badge.name}" onerror="this.remove()">`
            : "";
        const fallbackGlyph = badge.isEarned ? StreakBadgeHelper.FALLBACK_BADGE_GLYPH : "🔒";

        DialogBox.modal(`
            <div class="badge-expanded ${badge.isEarned ? "earned" : "locked"}">
                <div class="badge-expanded-icon">
                    <span class="badge-expanded-fallback">${fallbackGlyph}</span>
                    ${imageHtml}
                </div>
                <div class="badge-expanded-name">${badge.name}</div>
                <div class="badge-expanded-threshold">${badge.thresholdLabel}</div>
                <div class="badge-expanded-status">${badge.isEarned ? "Earned ✓" : "Locked"}</div>
            </div>
        `);
    }

    /** Gallery for a milestone metric category (cards / mock tests / hours / doubts). */
    static showMetricCategory(category, title)
    {
        const definition = MetricBadgeHelper.getCategoryDefinition(category);
        if (!definition)
        {
            return;
        }

        const metrics = MetricBadgeHelper.getMetrics(window["user"]);
        const earnedThresholds = MetricBadgeHelper.getEarnedThresholds(metrics, category);
        const badges = MetricBadgeHelper.getBadgeList(category).map((badge) =>
        ({
            isEarned: earnedThresholds.has(badge.threshold),
            name: badge.name,
            imagePath: badge.imagePath,
            thresholdLabel: MetricBadgeHelper.formatThreshold(category, badge.threshold)
        }));

        BadgeGalleryDialog.#present(title, badges, earnedThresholds.size);
    }

    static show()
    {
        const streakState = StreakBadgeHelper.getStreakState(window["user"]);
        const earnedThresholds = StreakBadgeHelper.getEarnedThresholds(streakState);
        const badges = StreakBadgeHelper.getBadgeDefinitions().map((definition) =>
        ({
            isEarned: earnedThresholds.has(definition.streak),
            name: definition.name,
            imagePath: definition.imagePath,
            thresholdLabel: `${definition.streak}-day streak`
        }));

        BadgeGalleryDialog.#present("Your Badges", badges, earnedThresholds.size);
    }
}

export default BadgeGalleryDialog;
