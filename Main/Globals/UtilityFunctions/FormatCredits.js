// Formats a credit amount for display: rounds to at most two decimals and
// drops trailing zeros, so a float-drifted balance like 98.28949999999999
// shows as "98.29", a half-credit shows as "0.5", and a whole number like 100
// shows as "100". The underlying stored value is unchanged — this is display
// only. Non-numeric input formats as "0".
export function formatCredits(value)
{
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue))
    {
        return '0';
    }
    return String(Math.round(numericValue * 100) / 100);
}
