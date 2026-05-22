import Fsrs from "../Classes/Fsrs.js";
import Glicko2 from "../Classes/Glicko2.js";
import ProgressPoint from "./ProgressPoint.js";


// The progress class is designed in such a way that we use the append function to add new progress points.
// Using the existing object and the new progress point, we can update the progress object.
// This is the core of both progress tracking and spaced repitition
// Uses Glicko 2 based rating system to determine things such as:
//      1) How good he knows a given question/topic
//      2) How confused he is 
//      3) How fast he is learning
//      4) If he is forgetting a given question/topic over time
// Later on, a system can be integrated where we use AI and the progress data to make him a curated study material

class Progress
{
    static #historySize = 20;

    #progressPoints = [];

    static fromJson(json)
    {
        return new Progress(json.progressPoints.map((progressPoint) => ProgressPoint.fromJson(progressPoint)));
    }

    /**
     * Appends a new progress point to the existing progress array.
     * This is how we track the progress of the user over time.
     * @param {ProgressPoint} progressPoint - The new progress point to be appended.
     */
    append(progressPoint)
    {
        if(this.#progressPoints.length >= Progress.#historySize)
        {
            this.#progressPoints.shift();
        }

        this.#progressPoints.push(progressPoint);
    }


    getNextSchedule()
    {

    }

    toJson()
    {
        return {
            progressPoints: this.#progressPoints.map((progressPoint) => progressPoint.toJson())
        }
    }

    constructor(progressPoints = [])
    {
        this.#progressPoints = progressPoints;
    }

    getFsrsState()
    {
        if(this.#progressPoints.length > 0)
        {
            return this.#progressPoints[this.#progressPoints.length - 1].getFsrsState();
        }
        else
        {
            return new Fsrs().getState();
        }
    }

    /**
     * Gets the Glicko state of the most recent progress point.
     * If there are no progress points, it returns a new Glicko2 state.
     * @returns {Object} The Glicko state of the most recent progress point.
     */
    getGlickoState()
    {
        if(this.#progressPoints.length > 0)
        {
            return this.#progressPoints[this.#progressPoints.length - 1].getGlickoState();
        }
        else
        {
            return new Glicko2().getState();
        }
    }

    getCurrentProgressPoint()
    {
        if(this.#progressPoints.length > 0)
        {
            return this.#progressPoints[this.#progressPoints.length - 1];
        }
        else
        {
            return new ProgressPoint(new Fsrs(), new Glicko2()); 
        }
    }

    /**
     * Returns the progress point closest to the given date.
     * If there are no progress points on or before the given date, it returns a new ProgressPoint.
     * @param {Date} date - The date to find the closest progress point to.
     * @returns {ProgressPoint} The closest progress point to the given date.
     */
    getProgressPointOnDate(date)
    {
        if (!date || !(date instanceof Date))
        {
            return new ProgressPoint(new Fsrs(), new Glicko2());
        }

        
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        let result = null;

        for (const point of this.#progressPoints)
        {
            const fsrsState = point.getFsrsState();
            const lastReview = fsrsState.lastReview;

            if (!lastReview)
            {
                continue;
            }

            const reviewDate = new Date(lastReview);

            if (reviewDate <= endOfDay)
            {
                if (!result)
                {
                    result = point;
                }
                else
                {
                    const existingDate = new Date(result.getFsrsState().lastReview);

                    if (reviewDate > existingDate)
                    {
                        result = point;
                    }
                }
            }
        }

        return result ?? new ProgressPoint(new Fsrs(), new Glicko2());
    }

    getProgressPoints()
    {
        return [...this.#progressPoints];
    }

    reset()
    {
        this.#progressPoints = [];
    }
}

export default Progress;