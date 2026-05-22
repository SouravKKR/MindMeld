class Glicko2
{
    static #defaultRating = 1500;
    static #defaultRatingDeviation = 350;
    static #defaultRatingVolatility = 0.06;
    static #tau = 0.5;
    static #epsilon = 0.000001;
    static #minRating = 1000;
    static #maxRating = 2200;

    #rating;
    #ratingDeviation;
    #ratingVolatility;
    

    static #scaleDown(r)
    {
        return (r - 1500) / 173.7178;
    }

    static #scaleUp(r)
    {
        return Math.min(Glicko2.#maxRating, Math.max(Glicko2.#minRating, r * 173.7178 + 1500));
    }

    static #g(phi)
    {
        return 1 / Math.sqrt(1 + 3 * phi * phi / Math.PI / Math.PI);
    }

    static #E(mu, mu_j, phi_j)
    {
        return 1 / (1 + Math.exp(-Glicko2.#g(phi_j) * (mu - mu_j)));
    }

    static #updateVolatility(phi, v, delta, sigma)
    {
        const a = Math.log(sigma * sigma);
        let A = a;
        let B;

        if (delta * delta > phi * phi + v)
        {
            B = Math.log(delta * delta - phi * phi - v);
        }
        else
        {
            let k = 1;
            const MAX_K = 50;

            while (k < MAX_K)
            {
                B = a - k * Glicko2.#tau;
                if (Glicko2.#f(B, delta, phi, v, a) < 0) break;
                k++;
            }

            if (k === MAX_K)
            {
                return sigma; 
            }
        }

        let fA = Glicko2.#f(A, delta, phi, v, a);
        let fB = Glicko2.#f(B, delta, phi, v, a);

        while (Math.abs(B - A) > Glicko2.#epsilon)
        {
            const C = A + (A - B) * fA / (fB - fA);
            const fC = Glicko2.#f(C, delta, phi, v, a);

            if (fC * fB < 0)
            {
                A = B;
                fA = fB;
            }
            else
            {
                fA /= 2;
            }

            B = C;
            fB = fC;
        }

        return Math.exp(A / 2);
    }

    static #f(x, delta, phi, v, a)
    {
        const ex = Math.exp(x);
        return (
            ex * (delta * delta - phi * phi - v - ex) /
            (2 * (phi * phi + v + ex) * (phi * phi + v + ex)) -
            (x - a) / (Glicko2.#tau * Glicko2.#tau)
        );
    }

    static fromJson(json)
    {
        return new Glicko2(json.rating, json.ratingDeviation, json.ratingVolatility);
    }
    
    static fromCard(card)
    {
        return new Glicko2(card.getBaseDifficulty(), Glicko2.#defaultRatingDeviation, Glicko2.#defaultRatingVolatility);
    }
    
    static run(userGlicko, cardGlicko, fsrs, rawOutcome)
    { 
        const userState = userGlicko.getState();
        const cardState = cardGlicko.getState();

        // ----------------------------
        // FSRS-derived signals
        // ----------------------------
        const fsrsStability = fsrs.getState().stability || 1;
        const fsrsLastReview = fsrs.getState().lastReview;


        let daysSinceLastReview = 0;
        if (fsrsLastReview)
        {
            daysSinceLastReview = Math.max(0, (Date.now() - new Date(fsrsLastReview).getTime()) / (1000 * 60 * 60 * 24));
        }

        const fsrsRetrievability = fsrsStability > 0 ? Math.pow(1 + daysSinceLastReview / (9 * fsrsStability), -1) : 1;

        // Shape outcome using FSRS context
        const adjustedOutcome = Math.min(1 - Glicko2.#epsilon, Math.max(Glicko2.#epsilon, rawOutcome * fsrsRetrievability));


        // ----------------------------
        // User Glicko parameters
        // ----------------------------
        const userMu = Glicko2.#scaleDown(userState.rating);

        let userPhi = userState.ratingDeviation / 173.7178;
        let userSigma = userState.ratingVolatility;


        // ----------------------------
        // Card Glicko parameters
        // ----------------------------
        const cardMu = Glicko2.#scaleDown(cardState.rating);
        const cardPhi = cardState.ratingDeviation / 173.7178;

        // ----------------------------
        // Expected score
        // ----------------------------
        const expectedUserScore = Glicko2.#E(userMu, cardMu, cardPhi);


        // ----------------------------
        // Variance
        // ----------------------------
        const opponentImpactFactor = Glicko2.#g(cardPhi);

        const ratingVariance = 1 / (opponentImpactFactor * opponentImpactFactor * expectedUserScore * (1 - expectedUserScore));


        // ----------------------------
        // Delta
        // ----------------------------
        const ratingDelta = ratingVariance * opponentImpactFactor * (adjustedOutcome - expectedUserScore);

        // ----------------------------
        // Volatility update
        // ----------------------------
        const updatedUserVolatility = Glicko2.#updateVolatility(userPhi, ratingVariance, ratingDelta, userSigma);

        // ----------------------------
        // Rating deviation update
        // ----------------------------
        const preRatingDeviation = Math.sqrt(userPhi * userPhi + updatedUserVolatility * updatedUserVolatility);

        let updatedUserPhi = 1 / Math.sqrt(1 / (preRatingDeviation * preRatingDeviation) + 1 / ratingVariance);

        // Stabilize confidence using FSRS stability
        updatedUserPhi /= Math.exp(fsrsStability / 15);
        updatedUserPhi = Math.max(updatedUserPhi, 0.3);

        // ----------------------------
        // Update the glicko state of the user and make a new glicko state
        // This will be stored in the progress point along with the new FSRS state
        // ----------------------------
        const updatedUserMu = userMu + updatedUserPhi * updatedUserPhi * opponentImpactFactor * (adjustedOutcome - expectedUserScore);


        const newUserGlicko2State = new Glicko2(Glicko2.#scaleUp(updatedUserMu), updatedUserPhi * 173.7178, updatedUserVolatility);
        
        return newUserGlicko2State;
    }

    constructor(rating = Glicko2.#defaultRating, ratingDeviation = Glicko2.#defaultRatingDeviation, ratingVolatility = Glicko2.#defaultRatingVolatility)
    {
        this.#rating = Math.min(Glicko2.#maxRating, Math.max(Glicko2.#minRating, rating));
        this.#ratingDeviation = ratingDeviation;
        this.#ratingVolatility = ratingVolatility; 
    }

    getState()
    {
        return {
            rating: this.#rating,
            ratingDeviation: this.#ratingDeviation,
            ratingVolatility: this.#ratingVolatility
        };
    }

    toJson()
    {
        return this.getState();
    }
}

export default Glicko2;