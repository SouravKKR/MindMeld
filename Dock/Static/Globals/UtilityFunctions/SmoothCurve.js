export function smoothCurve(points, smoothness = 5)
{
    if (!points || points.length === 0)
    {
        return [];
    }

    const sorted = [...points].sort((a, b) => a.x - b.x);
    const result = [];

    const sigma = smoothness;
    const twoSigmaSq = 2 * sigma * sigma;

    for (let i = 0; i < sorted.length; i++)
    {
        const xi = sorted[i].x;

        let weightedSum = 0;
        let weightTotal = 0;

        for (let j = 0; j < sorted.length; j++)
        {
            const dx = xi - sorted[j].x;
            const weight = Math.exp(-(dx * dx) / twoSigmaSq);

            weightedSum += sorted[j].y * weight;
            weightTotal += weight;
        }

        result.push({
            x: xi,
            y: weightedSum / weightTotal
        });
    }

    return result;
}