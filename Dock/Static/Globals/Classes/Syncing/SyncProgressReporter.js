import SyncEvents from "../../Events/SyncEvents.js";


/**
 * SyncProgressReporter
 *
 * Owns the 0..1 sync-progress fraction and its associated animations.
 * Other parts of the sync pipeline call into this class to update the
 * bar; this class emits SyncEvents.PROGRESS with `(completed, total)`
 * in the high-resolution units defined by #UNIT_RESOLUTION.
 *
 * Only one animation can run at a time. Asymptotic animations are
 * fire-and-forget (used while a network request is in flight, since the
 * caller does not know when it will land). Linear animations return a
 * Promise that resolves at the target — used to glide between sync
 * phases without snapping.
 */
class SyncProgressReporter
{
    static #ANIMATION_TICK_MS = 60;
    static #UNIT_RESOLUTION   = 10000;

    static #currentFraction       = 0;
    static #activeAnimationTimerId = null;

    static getFraction()
    {
        return SyncProgressReporter.#currentFraction;
    }

    /**
     * Sets the fraction and emits a SyncEvents.PROGRESS event. Stops any
     * in-flight animation, so the caller is the new source of truth.
     */
    static setFraction(fraction)
    {
        SyncProgressReporter.stopAnimation();
        SyncProgressReporter.#applyFraction(fraction);
    }

    /**
     * Asymptotic animation (1 - exp(-t/T)) toward `targetFraction` over
     * the expected duration. Never reaches the target on its own — the
     * caller is expected to stopAnimation() + setFraction(target) once
     * the underlying work completes.
     */
    static animateAsymptoticTo(targetFraction, expectedDurationMilliseconds)
    {
        SyncProgressReporter.stopAnimation();

        const startFraction = SyncProgressReporter.#currentFraction;
        const startTime     = performance.now();

        SyncProgressReporter.#activeAnimationTimerId = setInterval(() =>
        {
            const elapsedMilliseconds = performance.now() - startTime;
            const easing              = 1 - Math.exp(-elapsedMilliseconds / expectedDurationMilliseconds);
            const fraction            = startFraction + (targetFraction - startFraction) * easing;
            SyncProgressReporter.#applyFraction(fraction);
        }, SyncProgressReporter.#ANIMATION_TICK_MS);
    }

    /**
     * Linear animation from current fraction to `targetFraction` over
     * `durationMilliseconds`. Returns a Promise that resolves once the
     * bar is at exactly `targetFraction`. Used between sync phases to
     * avoid visible jumps.
     */
    static animateLinearTo(targetFraction, durationMilliseconds)
    {
        SyncProgressReporter.stopAnimation();

        const startFraction = SyncProgressReporter.#currentFraction;

        if (durationMilliseconds <= 0 || Math.abs(targetFraction - startFraction) < 1e-6)
        {
            SyncProgressReporter.#applyFraction(targetFraction);
            return Promise.resolve();
        }

        const startTime = performance.now();

        return new Promise((resolve) =>
        {
            SyncProgressReporter.#activeAnimationTimerId = setInterval(() =>
            {
                const elapsedMilliseconds   = performance.now() - startTime;
                const completionFraction    = Math.min(1, elapsedMilliseconds / durationMilliseconds);
                const interpolatedFraction  = startFraction + (targetFraction - startFraction) * completionFraction;

                SyncProgressReporter.#applyFraction(interpolatedFraction);

                if (completionFraction >= 1)
                {
                    SyncProgressReporter.stopAnimation();
                    resolve();
                }
            }, SyncProgressReporter.#ANIMATION_TICK_MS);
        });
    }

    static stopAnimation()
    {
        if (SyncProgressReporter.#activeAnimationTimerId !== null)
        {
            clearInterval(SyncProgressReporter.#activeAnimationTimerId);
            SyncProgressReporter.#activeAnimationTimerId = null;
        }
    }

    static #applyFraction(fraction)
    {
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        SyncProgressReporter.#currentFraction = clampedFraction;

        const completedUnits = Math.round(clampedFraction * SyncProgressReporter.#UNIT_RESOLUTION);

        window.dispatchEvent(new CustomEvent(SyncEvents.PROGRESS,
        {
            detail: { completed: completedUnits, total: SyncProgressReporter.#UNIT_RESOLUTION },
        }));
    }
}

export default SyncProgressReporter;
