/**
 * PaymentEnvironmentValidator
 *
 * Boot-time guard against the single most expensive payment misconfiguration:
 * running an environment against the WRONG key mode. Both directions are
 * failures, and both are silent without this check.
 *
 *   • A test key in production — customers complete checkout, see a success
 *     screen, and no money is ever captured or settled. Nothing errors; the
 *     loss is invisible until someone reconciles the bank account.
 *   • A live key outside production — a development or testing run charges
 *     real cards. Worse than the first case, and far easier to do by accident
 *     when an env file is copied between environments.
 *
 * The validator only READS configuration and returns a verdict; the caller
 * decides whether to abort. That keeps it directly testable and keeps the
 * process-exit decision at the top level where it belongs.
 *
 * Razorpay is the only payment provider, so this checks one key pair. If a
 * second provider is ever added, give it its own #validate<Provider> method and
 * call it alongside — a mixed-provider deployment must not be able to pass by
 * satisfying only one of them.
 */
class PaymentEnvironmentValidator
{
    // The only environment that moves real money. Every other name (local,
    // development, testing) must be running against test credentials.
    static LIVE_MONEY_ENVIRONMENT = "production";

    static RAZORPAY_TEST_KEY_PREFIX = "rzp_test_";
    static RAZORPAY_LIVE_KEY_PREFIX = "rzp_live_";

    static SEVERITY_FATAL = "FATAL";
    static SEVERITY_WARNING = "WARNING";

    /**
     * Whether this process is running on a real deployed node rather than a
     * developer machine.
     *
     * The distinction matters because `npm run production` is documented as the
     * LOCAL equivalent of the deployed server: it resolves the environment name
     * "production" while deliberately running against test payment keys. Keying
     * the strictest rule on the environment name alone would refuse to start
     * that perfectly legitimate workflow.
     *
     * A base node points COGNIUMLEARN_SECRETS_DIRECTORY at its tmpfs secret
     * mount; nothing sets it locally, so its presence is the signal that real
     * rendered secrets — and therefore real money — are in play.
     */
    static #isDeployedNode(environmentVariables)
    {
        return Boolean(environmentVariables.COGNIUMLEARN_SECRETS_DIRECTORY);
    }

    /**
     * @param {string} environmentName — the resolved environment name (index.js)
     * @param {object} [environmentVariables] — defaults to process.env; injectable for tests
     * @returns {{ok: boolean, problems: Array<{severity: string, message: string}>}}
     */
    static validate(environmentName, environmentVariables = process.env)
    {
        const problems = [];
        const bIsLiveMoneyEnvironment = String(environmentName || "").toLowerCase() === PaymentEnvironmentValidator.LIVE_MONEY_ENVIRONMENT
            && PaymentEnvironmentValidator.#isDeployedNode(environmentVariables);

        // Make the relaxation visible. A local `npm run production` is expected
        // to run on test keys, but the operator should never be left guessing
        // whether the strict gate ran.
        if (String(environmentName || "").toLowerCase() === PaymentEnvironmentValidator.LIVE_MONEY_ENVIRONMENT
            && !PaymentEnvironmentValidator.#isDeployedNode(environmentVariables))
        {
            problems.push
            ({
                severity: PaymentEnvironmentValidator.SEVERITY_WARNING,
                message: "Environment is \"production\" but COGNIUMLEARN_SECRETS_DIRECTORY is unset, so this is a LOCAL production-mode run. Test payment keys are permitted; the strict live-key requirement is not enforced."
            });
        }

        PaymentEnvironmentValidator.#validateRazorpay(bIsLiveMoneyEnvironment, environmentName, environmentVariables, problems);

        const bHasFatalProblem = problems.some(problem => problem.severity === PaymentEnvironmentValidator.SEVERITY_FATAL);
        return { ok: !bHasFatalProblem, problems: problems };
    }

    static #validateRazorpay(bIsLiveMoneyEnvironment, environmentName, environmentVariables, problems)
    {
        const keyId = String(environmentVariables.RAZORPAY_KEY_ID || "");

        // An unset key is not a misconfiguration — an environment that never
        // touches Razorpay is entitled to leave it blank, and the provider
        // already fails closed at call time (isConfigured()).
        if (keyId.length === 0)
        {
            return;
        }

        const bIsTestKey = keyId.startsWith(PaymentEnvironmentValidator.RAZORPAY_TEST_KEY_PREFIX);
        const bIsLiveKey = keyId.startsWith(PaymentEnvironmentValidator.RAZORPAY_LIVE_KEY_PREFIX);

        if (bIsLiveMoneyEnvironment && bIsTestKey)
        {
            problems.push
            ({
                severity: PaymentEnvironmentValidator.SEVERITY_FATAL,
                message: "RAZORPAY_KEY_ID is a TEST key but the environment is production. Customers would see a success screen while no money is captured or settled."
            });
            return;
        }

        if (!bIsLiveMoneyEnvironment && bIsLiveKey)
        {
            problems.push
            ({
                severity: PaymentEnvironmentValidator.SEVERITY_FATAL,
                message: `RAZORPAY_KEY_ID is a LIVE key but the environment is "${environmentName}". This would charge real cards outside production.`
            });
            return;
        }

        // Neither prefix matched. Razorpay may introduce further prefixes, so
        // this is reported rather than fatal — an unrecognised key still needs
        // a human to look at it.
        if (!bIsTestKey && !bIsLiveKey)
        {
            problems.push
            ({
                severity: PaymentEnvironmentValidator.SEVERITY_WARNING,
                message: "RAZORPAY_KEY_ID matches neither the test nor the live prefix; its mode could not be verified."
            });
        }
    }

    /**
     * Validates and, on a fatal problem, prints every finding and terminates
     * the process. Called once during boot, before any endpoint is registered.
     * @param {string} environmentName
     */
    static enforceOrExit(environmentName)
    {
        const result = PaymentEnvironmentValidator.validate(environmentName);

        for (const problem of result.problems)
        {
            const prefix = problem.severity === PaymentEnvironmentValidator.SEVERITY_FATAL
                ? "[PaymentEnvironmentValidator] FATAL:"
                : "[PaymentEnvironmentValidator] WARNING:";
            console.error(`${prefix} ${problem.message}`);
        }

        if (!result.ok)
        {
            console.error("[PaymentEnvironmentValidator] Refusing to start with a payment key/environment mismatch. Fix the env file and restart.");
            process.exit(1);
        }
    }
}

module.exports = PaymentEnvironmentValidator;
