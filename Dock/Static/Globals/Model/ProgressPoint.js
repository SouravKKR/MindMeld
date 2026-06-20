import Fsrs from "../Classes/Fsrs.js";
import Glicko2 from "../Classes/Glicko2.js";

class ProgressPoint
{
    #fsrs = null;
    #glicko = null;

    constructor(fsrs = new Fsrs(), glicko = new Glicko2())
    {
        this.#fsrs = fsrs;
        this.#glicko = glicko;
    }

    getFsrsState()
    {
        return this.#fsrs.getState();
    }

    getGlickoState()
    {
        return this.#glicko.getState();
    }

    generateNext(userRating, card)
    {
        const newFsrs = this.#fsrs.review(userRating);

        const userGlicko = this.#glicko;
        const cardGlicko = Glicko2.fromCard(card);
        const fsrs = this.#fsrs;
        const rawOutcome = userRating;

        const newGlicko = Glicko2.run(userGlicko, cardGlicko, fsrs, rawOutcome);

        return new ProgressPoint(newFsrs, newGlicko);
    }

    toJson()
    {
        return {
            fsrs: this.#fsrs.toJson(),
            glicko: this.#glicko.toJson()
        }
    }

    static fromJson(json)
    {
        return new ProgressPoint(Fsrs.fromJson(json.fsrs), Glicko2.fromJson(json.glicko));
    }

}

export default ProgressPoint;