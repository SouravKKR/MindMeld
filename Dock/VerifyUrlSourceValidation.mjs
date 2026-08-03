/**
 * End-to-end verification harness for the SPECIFIC_URL_ON_THE_INTERNET
 * front-door validation (PublicUrlValidator + its wiring into
 * validateGenerationSettings).
 *
 * Run from the Dock directory:
 *     node VerifyUrlSourceValidation.mjs
 *
 * Pure, in-process checks — no DB, no network, no Redis, so this always runs.
 *
 * NOTE ON SCOPE: this harness verifies the FRONT DOOR only. The authoritative
 * SSRF gate is the Agent's SafeUrlValidator (resolves every redirect hop and
 * pins the connection to the validated IP); it is covered by
 * Agent/Verification/VerifyWebFetchSafety.py. A URL passing here is not a claim that it is
 * fetchable — only that it is not obviously refusable.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

const PublicUrlValidator = require("./Globals/Classes/Security/PublicUrlValidator");
const ExtractableInformationSource = require("./Globals/Classes/Decorators/ExtractableInformationSource");
const GeneralGenerationSettings = require("./Globals/Classes/Task/AutoGeneration/GeneralGenerationSettings");
const FlashcardGenerationSettings = require("./Globals/Classes/Task/AutoGeneration/FlashcardGenerationSettings");
const StudyMaterialGenerationSettings = require("./Globals/Classes/Task/AutoGeneration/StudyMaterialGenerationSettings");
const MockTestGenerationSettings = require("./Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings");
const InformationSource = require("./Globals/Model/InformationSource");
const { informationSourceTypes } = require("./Globals/Enumerations/InformationSourceTypes");
const { validateGenerationSettings } = require("./Endpoints/Helpers/ValidateGenerationSettings");

let passedCount = 0;
let failedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  ${description}`);
    }
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

function assertAccepted(urlText)
{
    try
    {
        const normalized = PublicUrlValidator.validate(urlText, "Information source #1");
        assert(typeof normalized === "string" && normalized.length > 0, `accepts ${urlText}`);
    }
    catch (validationError)
    {
        assert(false, `accepts ${urlText} (rejected: ${validationError.message})`);
    }
}

function assertRejected(urlText, reasonLabel)
{
    try
    {
        PublicUrlValidator.validate(urlText, "Information source #1");
        assert(false, `rejects ${urlText} — ${reasonLabel}`);
    }
    catch (validationError)
    {
        const mentionsSource = (validationError.message || "").includes("Information source #1");
        assert(mentionsSource, `rejects ${urlText} — ${reasonLabel}`);
    }
}

function buildUrlSource(urlText)
{
    return new ExtractableInformationSource({
        informationSource: new InformationSource({
            sourceType: informationSourceTypes.SPECIFIC_URL_ON_THE_INTERNET,
            name: urlText,
        }),
        pageRanges: [],
    });
}

function buildUploadSource()
{
    return new ExtractableInformationSource({
        informationSource: new InformationSource({
            sourceType: informationSourceTypes.PROVIDED_DOCUMENTS,
            name: "syllabus.pdf",
            hash: "abc123",
        }),
        pageRanges: [],
    });
}

function runSettingsValidation(informationSources, imageSources)
{
    const generalSettings = new GeneralGenerationSettings({
        description: "Generate a mock test",
        informationSources: informationSources,
        imageSources: imageSources || [],
    });

    return validateGenerationSettings(generalSettings, new FlashcardGenerationSettings({}), null, null);
}

function verifyLegitimateUrlsStillWork()
{
    section("Legitimate public URLs are accepted (the feature must keep working)");

    assertAccepted("https://www.geeksforgeeks.org/gate-previous-year-questions/");
    assertAccepted("https://arxiv.org/abs/2401.00001");
    assertAccepted("https://nature.com/articles/s41586-024-00001-1");
    assertAccepted("http://example.edu/papers/2023-paper.pdf");
    assertAccepted("https://example.com:443/paper.pdf");
    assertAccepted("http://example.com:80/paper.pdf");
    assertAccepted("https://example.com/search?year=2024&subject=maths#section-2");
    assertAccepted("https://192.0.2.10/paper.pdf");
    assertAccepted("https://8.8.8.8/paper.pdf");
    assertAccepted("  https://example.com/padded.pdf  ");
}

function verifyInternalTargetsAreRejected()
{
    section("Internal / non-web targets are rejected");

    assertRejected("http://localhost:3000/Admin", "localhost by name");
    assertRejected("http://LOCALHOST/x", "localhost is case-insensitive");
    assertRejected("http://api.localhost/x", "*.localhost suffix");
    assertRejected("http://mongo.internal/x", ".internal suffix");
    assertRejected("http://printer.local/x", ".local suffix");
    assertRejected("http://metadata.google.internal/computeMetadata/v1/", "cloud metadata by name");

    assertRejected("http://127.0.0.1:3000/Admin", "IPv4 loopback");
    assertRejected("http://127.1.2.3/x", "the whole 127/8 loopback range");
    assertRejected("http://10.0.0.3:27017/", "VPC private range 10/8");
    assertRejected("http://192.168.1.1/", "private range 192.168/16");
    assertRejected("http://172.16.0.5/", "private range 172.16/12 lower bound");
    assertRejected("http://172.31.255.254/", "private range 172.16/12 upper bound");
    assertRejected("http://169.254.169.254/latest/meta-data/", "link-local cloud metadata");
    assertRejected("http://100.100.100.200/", "Alibaba metadata inside carrier-NAT range");
    assertRejected("http://0.0.0.0/", "unspecified address");
    assertRejected("http://255.255.255.255/", "broadcast address");
    assertRejected("http://239.1.1.1/", "multicast range");

    assertRejected("http://[::1]/", "IPv6 loopback");
    assertRejected("http://[fd00:ec2::254]/", "IPv6 cloud metadata");
    assertRejected("http://[fc00::1]/", "IPv6 unique-local fc00::/7");
    assertRejected("http://[fe80::1]/", "IPv6 link-local fe80::/10");
    assertRejected("http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback smuggled in IPv6");
    assertRejected("http://[::ffff:7f00:1]/", "IPv4-mapped loopback in its compressed hex spelling");
    assertRejected("http://[::ffff:10.0.0.3]/", "IPv4-mapped VPC address");
    assertRejected("http://[::ffff:a9fe:a9fe]/", "IPv4-mapped cloud metadata in hex");

    section("Non-web schemes, odd ports and malformed input are rejected");

    assertRejected("file:///etc/passwd", "file scheme");
    assertRejected("gopher://example.com/x", "gopher scheme");
    assertRejected("ftp://example.com/paper.pdf", "ftp scheme");
    assertRejected("javascript:alert(1)", "javascript scheme");
    assertRejected("http://example.com:6379/", "non-standard port (Redis)");
    assertRejected("http://example.com:27017/", "non-standard port (Mongo)");
    assertRejected("http://expected.com@evil.example/x", "userinfo credential smuggling");
    assertRejected("not a url at all", "unparseable text");
    assertRejected("", "empty string");
    assertRejected("https://example.com/" + "a".repeat(3000), "absurdly long URL");
}

function verifyBoundaryHostsAreNotOverBlocked()
{
    section("Neighbouring public addresses are NOT over-blocked");

    assertAccepted("https://172.15.0.1/x");
    assertAccepted("https://172.32.0.1/x");
    assertAccepted("https://11.0.0.1/x");
    assertAccepted("https://100.63.0.1/x");
    assertAccepted("https://128.0.0.1/x");
    assertAccepted("https://169.253.0.1/x");
    assertAccepted("https://192.167.0.1/x");
    assertAccepted("https://localhost.example.com/x");
    assertAccepted("https://internal.example.com/x");
    assertAccepted("https://[::ffff:8.8.8.8]/x");
    assertAccepted("https://[2606:4700:4700::1111]/x");
}

function verifyEndpointWiring()
{
    section("Wiring: validateGenerationSettings enforces it on both source lists");

    let acceptedGoodUrl = false;
    try
    {
        acceptedGoodUrl = runSettingsValidation([buildUrlSource("https://www.geeksforgeeks.org/gate-pyq/")], []);
    }
    catch (validationError)
    {
        acceptedGoodUrl = false;
    }
    assert(acceptedGoodUrl === true, "a public URL source passes validateGenerationSettings");

    let informationSourceError = null;
    try
    {
        runSettingsValidation([buildUrlSource("http://127.0.0.1:3000/Admin")], []);
    }
    catch (validationError)
    {
        informationSourceError = validationError;
    }
    assert(informationSourceError !== null, "an internal URL in informationSources is refused");
    assert(
        informationSourceError !== null && informationSourceError.message.includes("Information source #1"),
        "the refusal names the offending information source",
    );

    let imageSourceError = null;
    try
    {
        runSettingsValidation([buildUploadSource()], [buildUrlSource("http://169.254.169.254/latest/meta-data/")]);
    }
    catch (validationError)
    {
        imageSourceError = validationError;
    }
    assert(imageSourceError !== null, "an internal URL in imageSources is refused too");
    assert(
        imageSourceError !== null && imageSourceError.message.includes("Image source #1"),
        "the refusal names the offending image source",
    );

    let secondSourceError = null;
    try
    {
        runSettingsValidation([buildUploadSource(), buildUrlSource("http://10.0.0.3:27017/")], []);
    }
    catch (validationError)
    {
        secondSourceError = validationError;
    }
    assert(
        secondSourceError !== null && secondSourceError.message.includes("Information source #2"),
        "the index in the message points at the right source in a mixed list",
    );

    let nonUrlSourceError = null;
    try
    {
        runSettingsValidation([buildUploadSource()], []);
    }
    catch (validationError)
    {
        nonUrlSourceError = validationError;
    }
    assert(nonUrlSourceError === null, "an uploaded-document source is untouched by the URL check");
}

function verifyPerTypeSettingsCannotBypassTheCheck()
{
    section("Per-type settings carry their own sources — they must be checked too");

    // This is the bypass the end-to-end pass caught: /Generate hands the RAW
    // mockTestGeneration JSON to the Agent as the task payload, and
    // MockTestGenerationSettings carries its own informationSources. A client
    // can leave general.informationSources clean and hide the URL there.
    const cleanGeneralSettings = new GeneralGenerationSettings({
        description: "Generate a mock test",
        informationSources: [],
        imageSources: [],
    });

    const hostileMockTestSettings = new MockTestGenerationSettings({
        informationSources: [buildUrlSource("http://127.0.0.1:3000/Admin")],
    });

    let mockTestBypassError = null;
    try
    {
        validateGenerationSettings(cleanGeneralSettings, null, null, hostileMockTestSettings);
    }
    catch (validationError)
    {
        mockTestBypassError = validationError;
    }
    assert(mockTestBypassError !== null, "an internal URL hidden in mockTestGeneration.informationSources is refused");
    assert(
        mockTestBypassError !== null && mockTestBypassError.message.includes("Mock test generation"),
        "the refusal names the mock-test settings so the user can find it",
    );

    const hostileFlashcardSettings = new FlashcardGenerationSettings({
        informationSources: [buildUrlSource("http://169.254.169.254/latest/meta-data/")],
    });

    let flashcardBypassError = null;
    try
    {
        validateGenerationSettings(cleanGeneralSettings, hostileFlashcardSettings, null, null);
    }
    catch (validationError)
    {
        flashcardBypassError = validationError;
    }
    assert(flashcardBypassError !== null, "an internal URL hidden in flashcardGeneration.informationSources is refused");

    const hostileStudyMaterialSettings = new StudyMaterialGenerationSettings({
        imageSources: [buildUrlSource("http://10.0.0.3:27017/")],
    });

    let studyMaterialBypassError = null;
    try
    {
        validateGenerationSettings(cleanGeneralSettings, null, hostileStudyMaterialSettings, null);
    }
    catch (validationError)
    {
        studyMaterialBypassError = validationError;
    }
    assert(studyMaterialBypassError !== null, "an internal URL hidden in studyMaterialGeneration.imageSources is refused");

    const legitimateMockTestSettings = new MockTestGenerationSettings({
        informationSources: [buildUrlSource("https://www.geeksforgeeks.org/gate-pyq/")],
    });

    let legitimateAccepted = false;
    try
    {
        legitimateAccepted = validateGenerationSettings(cleanGeneralSettings, null, null, legitimateMockTestSettings);
    }
    catch (validationError)
    {
        legitimateAccepted = false;
    }
    assert(legitimateAccepted === true, "a public URL pinned on the mock-test settings still passes");

    const floodedMockTestSettings = new MockTestGenerationSettings({
        informationSources: Array.from({length: 40}, () => buildUrlSource("https://example.com/paper.pdf")),
    });

    let floodError = null;
    try
    {
        validateGenerationSettings(cleanGeneralSettings, null, null, floodedMockTestSettings);
    }
    catch (validationError)
    {
        floodError = validationError;
    }
    assert(floodError !== null, "a flood of URL sources on the mock-test settings is capped");
}

async function main()
{
    console.log(`Verifying URL source validation (Dock at ${currentDirectory})`);

    verifyLegitimateUrlsStillWork();
    verifyInternalTargetsAreRejected();
    verifyBoundaryHostsAreNotOverBlocked();
    verifyEndpointWiring();
    verifyPerTypeSettingsCannotBypassTheCheck();

    console.log(`\n=== Summary ===`);
    console.log(`  passed:  ${passedCount}`);
    console.log(`  failed:  ${failedCount}`);

    process.exit(failedCount === 0 ? 0 : 1);
}

main();
