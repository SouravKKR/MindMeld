/**
 * MongoQueryFragmentEvaluator
 *
 * Answers "would MongoDB have returned this document for this query?" without
 * asking MongoDB.
 *
 * It exists because the same audience has to be decided in two places that
 * cannot both be a database query. The member list asks Mongo which members a
 * filter selects. The per-request feature gate asks whether ONE already-loaded
 * member matches a permission rule — and it runs on every request, so turning
 * that into a query per rule would put a round trip in front of every action a
 * member takes.
 *
 * The obvious alternative is to give each filter class a second method that
 * checks a document directly. That was rejected: it states the meaning of a
 * range in two places and relies on whoever edits one remembering the other.
 * Here the fragment produced by `toMongoQuery` stays the single definition of
 * what a condition means, and this class only interprets it. There is nothing to
 * keep in step.
 *
 * The correctness risk is subtle and worth naming. Mongo does NOT compare across
 * types: `{$gte: 2020}` does not match the string "2021", so a member whose join
 * year was stored as text is outside a numeric range no matter how the numbers
 * read. A plain JavaScript `>=` would happily match it and hand that member a
 * paid feature the administrator's own preview said they would not get. Every
 * comparison below is therefore bracketed by type the way Mongo brackets it, and
 * VerifyMemberAudienceMatching checks this class against a real server rather
 * than against anyone's belief about it.
 *
 * Unknown operators FAIL CLOSED — they throw rather than being skipped. A
 * skipped clause is a rule that silently matches MORE people than it says, which
 * for a feature grant is the dangerous direction to be wrong in.
 */
class MongoQueryFragmentEvaluator
{
    // Exactly what the member filters emit today. Adding a filter type that
    // needs more than this means adding it here too — deliberately, rather than
    // discovering later that a rule quietly stopped narrowing anything.
    static SUPPORTED_FIELD_OPERATORS = new Set(["$in", "$nin", "$gte", "$lte", "$gt", "$lt", "$eq", "$ne", "$exists", "$regex", "$options"]);

    static SUPPORTED_LOGICAL_OPERATORS = new Set(["$and", "$or", "$nor", "$not"]);

    /**
     * @param {object} document a plain member document
     * @param {object} queryFragment the output of buildFilterQuery / toMongoQuery
     * @returns {boolean}
     * @throws {Error} when the fragment uses an operator this cannot evaluate
     */
    static matches(document, queryFragment)
    {
        if (!queryFragment || typeof queryFragment !== "object")
        {
            // No constraint is not the same as no match: an empty filter selects
            // everyone, which is what it does in Mongo too.
            return true;
        }

        for (const [fieldName, condition] of Object.entries(queryFragment))
        {
            if (fieldName === "$and")
            {
                if (!MongoQueryFragmentEvaluator.#asArray(condition).every(clause => MongoQueryFragmentEvaluator.matches(document, clause)))
                {
                    return false;
                }
                continue;
            }

            if (fieldName === "$or")
            {
                if (!MongoQueryFragmentEvaluator.#asArray(condition).some(clause => MongoQueryFragmentEvaluator.matches(document, clause)))
                {
                    return false;
                }
                continue;
            }

            if (fieldName === "$nor")
            {
                if (MongoQueryFragmentEvaluator.#asArray(condition).some(clause => MongoQueryFragmentEvaluator.matches(document, clause)))
                {
                    return false;
                }
                continue;
            }

            if (fieldName.startsWith("$"))
            {
                throw new Error(`MongoQueryFragmentEvaluator cannot evaluate the operator "${fieldName}"`);
            }

            if (!MongoQueryFragmentEvaluator.#matchesFieldCondition(document, fieldName, condition))
            {
                return false;
            }
        }

        return true;
    }

    static #asArray(value)
    {
        return Array.isArray(value) ? value : [];
    }

    /**
     * Whether one field of the document satisfies one condition.
     */
    static #matchesFieldCondition(document, fieldPath, condition)
    {
        const candidateValues = MongoQueryFragmentEvaluator.#resolveCandidateValues(document, fieldPath);

        if (!MongoQueryFragmentEvaluator.#isOperatorObject(condition))
        {
            // A bare value is an equality test, and against an array field it
            // matches when ANY element equals it — the semantics that make
            // { tags: "final-year" } find a member carrying several tags.
            return candidateValues.some(candidateValue => MongoQueryFragmentEvaluator.#isEqual(candidateValue, condition));
        }

        for (const operatorName of Object.keys(condition))
        {
            if (!MongoQueryFragmentEvaluator.SUPPORTED_FIELD_OPERATORS.has(operatorName))
            {
                throw new Error(`MongoQueryFragmentEvaluator cannot evaluate the operator "${operatorName}"`);
            }
        }

        for (const [operatorName, operand] of Object.entries(condition))
        {
            // Carried by $regex rather than evaluated on its own.
            if (operatorName === "$options")
            {
                continue;
            }

            if (!MongoQueryFragmentEvaluator.#matchesOperator(candidateValues, operatorName, operand, condition))
            {
                return false;
            }
        }

        return true;
    }

    static #isOperatorObject(condition)
    {
        if (!condition || typeof condition !== "object" || Array.isArray(condition) || condition instanceof Date || condition instanceof RegExp)
        {
            return false;
        }

        return Object.keys(condition).some(key => key.startsWith("$"));
    }

    static #matchesOperator(candidateValues, operatorName, operand, wholeCondition)
    {
        if (operatorName === "$exists")
        {
            const bPresent = candidateValues.some(candidateValue => candidateValue !== undefined);
            return operand ? bPresent : !bPresent;
        }

        if (operatorName === "$in")
        {
            const operandValues = MongoQueryFragmentEvaluator.#asArray(operand);
            return candidateValues.some(candidateValue => operandValues.some(operandValue => MongoQueryFragmentEvaluator.#isEqual(candidateValue, operandValue)));
        }

        if (operatorName === "$nin")
        {
            const operandValues = MongoQueryFragmentEvaluator.#asArray(operand);
            return !candidateValues.some(candidateValue => operandValues.some(operandValue => MongoQueryFragmentEvaluator.#isEqual(candidateValue, operandValue)));
        }

        if (operatorName === "$eq")
        {
            return candidateValues.some(candidateValue => MongoQueryFragmentEvaluator.#isEqual(candidateValue, operand));
        }

        if (operatorName === "$ne")
        {
            return !candidateValues.some(candidateValue => MongoQueryFragmentEvaluator.#isEqual(candidateValue, operand));
        }

        if (operatorName === "$regex")
        {
            const regularExpression = new RegExp(operand, typeof wholeCondition.$options === "string" ? wholeCondition.$options : "");
            return candidateValues.some(candidateValue => typeof candidateValue === "string" && regularExpression.test(candidateValue));
        }

        if (operatorName === "$gte" || operatorName === "$lte" || operatorName === "$gt" || operatorName === "$lt")
        {
            return candidateValues.some(candidateValue => MongoQueryFragmentEvaluator.#matchesComparison(candidateValue, operatorName, operand));
        }

        throw new Error(`MongoQueryFragmentEvaluator cannot evaluate the operator "${operatorName}"`);
    }

    /**
     * One ordering comparison, bracketed by type exactly as Mongo brackets it.
     *
     * A value of a different type than the bound is NOT out of range — it is
     * outside the comparison entirely, and matches nothing. This is the rule
     * that keeps a join year stored as text from being swept into a numeric
     * range by JavaScript's willingness to compare anything with anything.
     */
    static #matchesComparison(candidateValue, operatorName, boundValue)
    {
        if (candidateValue === undefined || candidateValue === null)
        {
            return false;
        }

        if (MongoQueryFragmentEvaluator.#canonicalTypeOf(candidateValue) !== MongoQueryFragmentEvaluator.#canonicalTypeOf(boundValue))
        {
            return false;
        }

        const leftValue = candidateValue instanceof Date ? candidateValue.getTime() : candidateValue;
        const rightValue = boundValue instanceof Date ? boundValue.getTime() : boundValue;

        if (operatorName === "$gte")
        {
            return leftValue >= rightValue;
        }
        if (operatorName === "$lte")
        {
            return leftValue <= rightValue;
        }
        if (operatorName === "$gt")
        {
            return leftValue > rightValue;
        }
        return leftValue < rightValue;
    }

    /**
     * The type bracket a value compares within. Mongo orders values by type
     * first and only compares within a bracket, so this is what decides whether
     * two values are comparable at all.
     */
    static #canonicalTypeOf(value)
    {
        if (value === null || value === undefined)
        {
            return "null";
        }
        if (value instanceof Date)
        {
            return "date";
        }
        if (Array.isArray(value))
        {
            return "array";
        }
        if (typeof value === "number")
        {
            return "number";
        }
        if (typeof value === "string")
        {
            return "string";
        }
        if (typeof value === "boolean")
        {
            return "boolean";
        }
        return "object";
    }

    static #isEqual(leftValue, rightValue)
    {
        if (leftValue instanceof Date && rightValue instanceof Date)
        {
            return leftValue.getTime() === rightValue.getTime();
        }

        if (MongoQueryFragmentEvaluator.#canonicalTypeOf(leftValue) !== MongoQueryFragmentEvaluator.#canonicalTypeOf(rightValue))
        {
            return false;
        }

        return leftValue === rightValue;
    }

    /**
     * Every value a dotted path can reach, flattened.
     *
     * An array along the way contributes each of its elements rather than
     * itself, because that is how Mongo reads a path through an array: a member
     * whose `tags` holds three entries is matched by a condition satisfied by
     * any one of them. The array itself is kept as a candidate too, so a
     * condition written against the whole array still works.
     */
    static #resolveCandidateValues(document, fieldPath)
    {
        let currentValues = [document];

        for (const pathSegment of String(fieldPath).split("."))
        {
            const nextValues = [];

            for (const currentValue of currentValues)
            {
                if (currentValue === null || currentValue === undefined)
                {
                    continue;
                }

                if (Array.isArray(currentValue))
                {
                    for (const element of currentValue)
                    {
                        if (element && typeof element === "object" && pathSegment in element)
                        {
                            nextValues.push(element[pathSegment]);
                        }
                    }
                    continue;
                }

                if (typeof currentValue === "object")
                {
                    nextValues.push(currentValue[pathSegment]);
                }
            }

            currentValues = nextValues;
        }

        const candidateValues = [];
        for (const currentValue of currentValues)
        {
            candidateValues.push(currentValue);
            if (Array.isArray(currentValue))
            {
                for (const element of currentValue)
                {
                    candidateValues.push(element);
                }
            }
        }

        return candidateValues.length > 0 ? candidateValues : [undefined];
    }
}

module.exports = MongoQueryFragmentEvaluator;
