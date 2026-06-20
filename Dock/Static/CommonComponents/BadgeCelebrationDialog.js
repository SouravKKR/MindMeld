import DialogBox from "./DialogBox.js";
import StreakBadgeHelper from "../Globals/Classes/Streak/StreakBadgeHelper.js";
import SoundEffects from "../Globals/Classes/SoundEffects.js";

/**
 * The celebratory popup shown when a badge is earned — shared by streak badges
 * and the milestone (cards / mock tests / hours / doubts) badges. Tasteful
 * scale-in + glow + sparkles (styling in CommonStyles/BadgeCelebrationDialog
 * .css). Resolves when dismissed so the caller can show the next pending badge.
 */
class BadgeCelebrationDialog
{
    /**
     * Generic celebration. `imagePath` may be empty (milestone art not yet
     * supplied) — the 🏅 fallback glyph shows and no broken <img> is rendered.
     * @param {{name:string, imagePath:string, sound:string, subtitleHtml:string, nextHtml:string}} options
     * @returns {Promise<void>}
     */
    static async present(options)
    {
        // Hold the popup until audio can play (immediate once unlocked; otherwise
        // until the first user gesture). This keeps the achievement jingle in sync
        // with the popup appearing, instead of it being deferred to a later click —
        // for streak and milestone badges alike, since both come through here.
        await SoundEffects.whenReady();

        const sparkles = ["✨", "⭐", "✨", "🌟", "✨", "⭐"]
            .map((glyph, index) => `<span class="badge-celebration-sparkle sparkle-${index}">${glyph}</span>`)
            .join("");

        const hasImage = typeof options.imagePath === "string" && options.imagePath.length > 0;
        const imageHtml = hasImage
            ? `<img src="${options.imagePath}" alt="${options.name}" onerror="this.remove()">`
            : "";

        const dialog = DialogBox.modal(`
            <div class="badge-celebration">
                <div class="badge-celebration-sparkles">${sparkles}</div>
                <div class="badge-celebration-header">New Badge Earned!</div>
                <div class="badge-celebration-icon">
                    <span class="badge-celebration-fallback">${StreakBadgeHelper.FALLBACK_BADGE_GLYPH}</span>
                    ${imageHtml}
                </div>
                <div class="badge-celebration-name">${options.name}</div>
                <div class="badge-celebration-streak">${options.subtitleHtml}</div>
                <div class="badge-celebration-next">${options.nextHtml}</div>
                <button class="badge-celebration-continue" type="button">Keep it up!</button>
            </div>
        `);

        // Audio is unlocked by now (we awaited whenReady above), so the badge's
        // jingle plays the instant the celebration appears.
        SoundEffects.playClip(options.sound);

        return new Promise((resolve) =>
        {
            let settled = false;
            const finish = () =>
            {
                if (settled)
                {
                    return;
                }
                settled = true;
                resolve();
            };

            const continueButton = dialog.querySelector(".badge-celebration-continue");
            continueButton.addEventListener("click", () =>
            {
                // Achievement jingle played on open; the OK click cue plays here.
                SoundEffects.playOk();
                dialog.close();
                finish();
            });

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", finish);
            }
        });
    }

    /**
     * Streak-badge celebration.
     * @param {object} badge — { streak, name, imagePath, sound }
     * @param {number} currentStreak
     */
    static show(badge, currentStreak)
    {
        const nextBadge = StreakBadgeHelper.getNextBadge(currentStreak);
        const dayWord = currentStreak === 1 ? "day" : "days";

        let nextHtml;
        if (nextBadge)
        {
            const daysAway = Math.max(0, nextBadge.streak - currentStreak);
            const daysAwayWord = daysAway === 1 ? "day" : "days";
            nextHtml = `<strong>${daysAway}</strong> more ${daysAwayWord} until <strong>${nextBadge.name}</strong>`;
        }
        else
        {
            nextHtml = `You've earned <strong>every</strong> badge. Legendary. 🎉`;
        }

        return BadgeCelebrationDialog.present
        ({
            name: badge.name,
            imagePath: badge.imagePath,
            sound: badge.sound,
            subtitleHtml: `${currentStreak} ${dayWord} streak 🔥`,
            nextHtml: nextHtml
        });
    }
}

export default BadgeCelebrationDialog;
