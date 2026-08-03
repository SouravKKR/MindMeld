import DialogBox from "./DialogBox.js";
import StreakBadgeHelper from "../Globals/Classes/Streak/StreakBadgeHelper.js";
import SoundEffects from "../Globals/Classes/SoundEffects.js";
import BlockingOverlayCoordinator from "../Globals/Classes/BlockingOverlayCoordinator.js";

/**
 * The celebratory popup shown when a badge is earned — shared by streak badges
 * and the milestone (cards / mock tests / hours / doubts) badges. Tasteful
 * scale-in + glow + sparkles (styling in CommonStyles/BadgeCelebrationDialog
 * .css). Resolves when dismissed so the caller can show the next pending badge.
 */
class BadgeCelebrationDialog
{
    static #COORDINATOR_OWNER_ID = "BadgeCelebrationDialog";

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
        //
        // This MUST come before claiming the coordinator slot. whenReady() has no
        // timeout: at app bootstrap there has been no gesture yet, so waiting on it
        // while HOLDING the slot pinned it indefinitely with nothing on screen — the
        // badge never mounted, and every overlay queued behind it (the first-launch
        // tutorial, the force-pull sync dialog) waited forever on a celebration that
        // could not appear. Awaiting audio first means the slot is only ever claimed
        // when this dialog can actually present.
        await SoundEffects.whenReady();

        // Wait for the blocking-overlay slot before celebrating. A badge is
        // earned on first login — exactly when the first-launch tutorial is
        // also starting — and the tutorial overlay sits far above the dialog
        // stacking range, so an uncoordinated celebration renders dimmed and
        // unclickable underneath it and dead-ends the tour. Queueing here
        // holds the badge until the tutorial (or sync dialog, or boot overlay)
        // is done, then shows it in the clear.
        await BlockingOverlayCoordinator.request(BadgeCelebrationDialog.#COORDINATOR_OWNER_ID);

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
                // Release before resolving so the next queued overlay — or the
                // next badge in the caller's loop — can take the slot.
                BlockingOverlayCoordinator.release(BadgeCelebrationDialog.#COORDINATOR_OWNER_ID);
                resolve();
            };

            // Escape has no .close-button / .ok-button to fall back to on this
            // dialog, so without an explicit handler it would call close()
            // directly — resolving nothing and leaking the coordinator slot,
            // which would then block every queued overlay behind it.
            dialog.setDismissHandler(() =>
            {
                dialog.close();
                finish();
            });

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
