// A one-time reward milestone: once a user's cumulative lifetime spend
// reaches `spendThreshold`, they are granted `rewardCredits` exactly once
// (idempotency is enforced by CreditLedger via the reward reference key).

class CreditRewardMilestone
{
    #spendThreshold;
    #rewardCredits;

    constructor({ spendThreshold = 0, rewardCredits = 0 } = {})
    {
        this.setSpendThreshold(spendThreshold);
        this.setRewardCredits(rewardCredits);
    }

    getSpendThreshold()
    {
        return this.#spendThreshold;
    }

    setSpendThreshold(value)
    {
        value = parseFloat(value);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#spendThreshold = value;
    }

    getRewardCredits()
    {
        return this.#rewardCredits;
    }

    setRewardCredits(value)
    {
        value = parseFloat(value);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#rewardCredits = value;
    }

    toJson()
    {
        return {
            spendThreshold: this.getSpendThreshold(),
            rewardCredits: this.getRewardCredits(),
        };
    }

    static fromJson(json)
    {
        return new CreditRewardMilestone({
            spendThreshold: json?.spendThreshold ?? 0,
            rewardCredits: json?.rewardCredits ?? 0,
        });
    }
}

module.exports = CreditRewardMilestone;
