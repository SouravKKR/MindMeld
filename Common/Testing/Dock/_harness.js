// Tiny dependency-free test harness shared by the Node suites (Dock). Mirrors
// the Python _harness: collects cases tagged with the catalogued function they
// exercise (for structural coverage) and writes the uniform per-suite JSON that
// .claude/skills/run-tests/run_tests.py aggregates. Process exit stays 0 even
// on failures so the orchestrator can read the JSON.

const fs = require("fs");
const path = require("path");

class Harness
{
    constructor(service, category, cataloguedTargets)
    {
        this.service = service;
        this.category = category;
        this.cataloguedTargets = cataloguedTargets.slice();
        this.cases = [];
    }

    test(name, target, testFunction)
    {
        this.cases.push({ name, target, testFunction });
    }

    runAndWrite(resultFile)
    {
        const results = [];
        for (const testCase of this.cases)
        {
            const entry = { name: testCase.name, target: testCase.target };
            try
            {
                testCase.testFunction();
                entry.status = "PASS";
                entry.detail = "";
            }
            catch (error)
            {
                entry.status = "FAIL";
                entry.detail = (error && error.message) ? error.message : String(error);
            }
            results.push(entry);
        }

        const passed = results.filter(entry => entry.status === "PASS").length;
        const failed = results.filter(entry => entry.status === "FAIL").length;
        const coveredTargets = new Set(
            results.filter(entry => entry.status === "PASS" && this.cataloguedTargets.includes(entry.target))
                   .map(entry => entry.target));
        const totalTargets = this.cataloguedTargets.length || 1;
        const percent = Math.round(1000 * coveredTargets.size / totalTargets) / 10;

        const payload = {
            service: this.service,
            category: this.category,
            status: failed === 0 ? "PASS" : "FAIL",
            passed,
            failed,
            skipped: 0,
            total: results.length,
            coverage: {
                kind: "structural",
                label: "Functions",
                percent,
                covered: coveredTargets.size,
                total: this.cataloguedTargets.length,
                detail: `${coveredTargets.size}/${this.cataloguedTargets.length} catalogued functions have a passing test`
            },
            cases: results
        };

        writeResult(resultFile, payload);
        console.log(`${this.service} ${this.category}: ${passed} passed, ${failed} failed, coverage ${percent}%`);
        for (const entry of results)
        {
            if (entry.status === "FAIL")
            {
                console.error(`  FAIL ${entry.name}: ${entry.detail}`);
            }
        }
        return payload;
    }
}

function writeResult(resultFile, payload)
{
    const target = resultFile || process.env.RESULT_FILE;
    if (!target)
    {
        return;
    }
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf-8");
}

function writeSkipped(service, category, note, resultFile)
{
    const payload = {
        service, category, status: "SKIPPED",
        passed: 0, failed: 0, skipped: 0, total: 0,
        coverage: { kind: "structural", label: "Functions", percent: null, detail: note },
        cases: [], notes: note
    };
    writeResult(resultFile, payload);
    console.log(`${service} ${category}: SKIPPED - ${note}`);
    return payload;
}

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message || "assertion failed");
    }
}

function assertEqual(actual, expected, message)
{
    if (actual !== expected)
    {
        throw new Error((message ? message + " - " : "") + `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

module.exports = { Harness, writeResult, writeSkipped, assert, assertEqual };
