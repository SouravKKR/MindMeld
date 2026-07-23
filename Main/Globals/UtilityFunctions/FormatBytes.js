// Formats a byte count for display using binary units (KiB/MiB/GiB shown as
// KB/MB/GB, matching the plan copy). Picks the largest unit under which the
// value is at least 1, rounds to at most one decimal, and drops a trailing
// ".0" — so 20971520 shows as "20 MB", 262144000 as "250 MB", 2147483648 as
// "2 GB", and 0 as "0 B". Non-numeric or negative input formats as "0 B".
export function formatBytes(value)
{
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0)
    {
        return '0 B';
    }

    const unitLabels = ['B', 'KB', 'MB', 'GB', 'TB'];
    const bytesPerStep = 1024;

    let unitIndex = 0;
    let scaledValue = numericValue;
    while (scaledValue >= bytesPerStep && unitIndex < unitLabels.length - 1)
    {
        scaledValue = scaledValue / bytesPerStep;
        unitIndex = unitIndex + 1;
    }

    const roundedValue = Math.round(scaledValue * 10) / 10;
    return `${roundedValue} ${unitLabels[unitIndex]}`;
}
