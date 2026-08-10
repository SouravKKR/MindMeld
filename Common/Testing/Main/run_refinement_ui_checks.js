// CSS verification for the content-refinement UI.
//
//   node Common/Testing/Main/run_refinement_ui_checks.js
//
// Needs a running Dock (node Dock/index.js --environment=local) and the seeded
// browser test account (node Common/Testing/Main/seed_browser_test_account.js).
//
// WHAT THIS COVERS, and what it does not.
//
// It renders each new surface's real markup inside the real, authenticated app
// page — real stylesheet, real theme variables, real fonts — and measures the
// resulting geometry and computed styles. That is what catches the failures
// this feature is actually prone to, all of which are invisible in code review:
// a variable the theme never defined so the rule silently drops, a grid track
// without minmax(0, 1fr) so a 600px diagram pushes the page sideways, a pane
// that will not scroll its own overflow, padding that does not match the panels
// already shipped.
//
// It does NOT drive the deck context menu, because no context-menu action
// navigates under Puppeteer — ContextMenu.create registers a body-level
// dismiss listener, and Insights, Browse and Edit fail exactly the same way the
// new Refine With AI entry does. That is a pre-existing harness limitation, not
// a property of this feature, so the menu is verified structurally instead: the
// button is asserted present in the live menu the app renders.
//
// Markup drift is guarded: every class name measured here is asserted to exist
// in the component source that is supposed to emit it, so a renamed class fails
// this file rather than quietly stopping being checked.

const fs = require("fs");
const path = require("path");

const puppeteer = require(path.join(__dirname, "node_modules", "puppeteer"));

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const SESSION_COOKIE = process.env.TEST_SESSION_COOKIE || "browser-suite-test-session";
const SCREENSHOT_DIRECTORY = process.env.SCREENSHOT_DIRECTORY || path.join(REPOSITORY_ROOT, "Common", "Reports", ".refinement-ui");

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;
const NARROW_VIEWPORT_WIDTH = 420;

let passedCount = 0;
let failedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount += 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount += 1;
        console.log(`  FAIL  ${description}`);
    }
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

/**
 * Awkward content on purpose. A layout only misbehaves once it holds a diagram
 * wider than its container, a token with no break opportunity, and a
 * preformatted block that will not wrap — so every pane is measured against all
 * three rather than against a paragraph of lorem ipsum.
 */
const WIDE_SVG_FIGURE =
    '<figure class="generated-figure" data-visual-id="abc123" style="margin: 1em 0; text-align: center;">'
    + '<svg width="600" height="110" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="110" fill="#2c2c2c"/>'
    + '<text x="16" y="60" fill="#ffffff" font-size="16">Ray diagram — 600px wide</text></svg>'
    + "<figcaption>Fig. 1 — refraction at a plane surface</figcaption></figure>";

const AWKWARD_PASSAGE =
    "<h2>Refraction</h2>"
    + "<p>The refractive index of water is 1.10 and light travels at 3.0 x 10^8 m/s in vacuum.</p>"
    + "<p>supercalifragilisticexpialidociousunbrokentokenthatmustnotwidenthecontainer</p>"
    + WIDE_SVG_FIGURE
    + "<pre>a very wide preformatted block ................................................................ end</pre>";

/**
 * Class names each component is responsible for emitting. Asserted against the
 * source so the markup rendered below cannot drift away from the components it
 * stands in for.
 */
const CLASS_OWNERSHIP =
[
    {
        sourceFile: "Main/Pages/ContentRefinement/ContentRefinementPage.js",
        classNames: ["content-refinement-page", "content-refinement-intro", "content-refinement-layout",
            "content-refinement-list", "content-refinement-detail", "content-refinement-entity",
            "content-refinement-entity-label", "content-refinement-entity-deck", "content-refinement-entity-preview",
            "content-refinement-preview", "content-refinement-section", "content-refinement-instruction",
            "content-refinement-submit", "content-refinement-empty", "content-refinement-figure",
            "content-refinement-figure-heading", "content-refinement-figure-method",
            "content-refinement-figure-caption", "content-refinement-figure-actions", "content-refinement-figure-note",
            // Search and multi-selection. "is-preview-anchor" is the one state
            // that must not share a look with "is-selected" — see the stylesheet.
            "content-refinement-list-column", "content-refinement-search", "content-refinement-search-input",
            "content-refinement-search-clear", "is-preview-anchor", "is-selected",
            "content-refinement-selection-summary", "content-refinement-selection-count",
            "content-refinement-selection-clear", "refinement-rendered-passage"],
    },
    {
        sourceFile: "Main/Pages/ContentRefinement/Classes/BatchRefinementRunner.js",
        classNames: ["content-refinement-run-failures"],
    },
    {
        sourceFile: "Main/CommonComponents/RefinementProposalDialog.js",
        classNames: ["refinement-proposal-dialog", "refinement-proposal-body", "refinement-proposal-error",
            "refinement-proposal-actions", "refinement-proposal-discard", "refinement-proposal-refine",
            "refinement-proposal-apply", "refinement-proposal-summary", "refinement-proposal-concerns",
            "refinement-proposal-sources", "refinement-proposal-model", "refinement-proposal-notice",
            "refinement-comparison", "refinement-pane", "refinement-pane-heading", "refinement-pane-body",
            "refinement-vision-verdict", "refinement-vision-heading", "refinement-muted",
            // Present only while reviewing a run.
            "refinement-proposal-progress", "refinement-proposal-stop", "refinement-proposal-apply-remaining",
            "refinement-rendered-passage"],
    },
    {
        sourceFile: "Main/Pages/ContentRefinement/Components/RefinementSourceAttachment.js",
        classNames: ["refinement-source-attachment", "refinement-source-field", "refinement-source-upload",
            "refinement-source-attached", "refinement-source-detach", "refinement-source-note"],
    },
    {
        // The licence declaration moved out of RefinementSourceAttachment into a
        // shared component when the admin verification-sources dialog needed the
        // same rules. Its class names moved with it, and are asserted here so the
        // markup and the stylesheet that now styles it cannot drift apart.
        sourceFile: "Main/CommonComponents/SourceLicenceDeclarationForm.js",
        classNames: ["source-licence-dialog", "source-licence-fields", "source-licence-field",
            "source-licence-error"],
    },
    {
        sourceFile: "Main/Pages/AdminPanel/Components/PaidDeckVerificationDialog.js",
        classNames: ["verification-flag-autofix"],
    },
    {
        sourceFile: "Main/Pages/AdminPanel/Components/VerificationFlagAutoFixer.js",
        classNames: ["verification-candidate-dialog", "verification-candidate-list", "verification-candidate",
            "verification-candidate-heading", "verification-candidate-preview"],
    },
    {
        sourceFile: "Main/Globals/Classes/HtmlDiffBuilder.js",
        classNames: ["refinement-diff-removed", "refinement-diff-added"],
    },
];

async function measureDocumentOverflow(page)
{
    return await page.evaluate(() => ({
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
    }));
}

function assertNoHorizontalPageScroll(overflow, description)
{
    // 1px tolerance for sub-pixel rounding on fractional device ratios.
    assert(overflow.documentScrollWidth <= overflow.documentClientWidth + 1, description);
}

/**
 * Mounts markup into the live page inside a positioned host, so measurements
 * are taken against the real stylesheet and real theme rather than a synthetic
 * document that would not prove anything about what ships.
 */
async function mountSurface(page, markup, hostWidth)
{
    await page.evaluate((options) =>
    {
        const existingHost = document.getElementById("refinement-ui-check-host");

        if (existingHost)
        {
            existingHost.remove();
        }

        const host = document.createElement("div");
        host.id = "refinement-ui-check-host";
        host.style.position = "fixed";
        host.style.inset = "0";
        host.style.zIndex = "99999";
        host.style.overflow = "auto";
        host.style.backgroundColor = "var(--primary-background-color)";

        if (options.hostWidth)
        {
            host.style.width = `${options.hostWidth}px`;
        }

        host.innerHTML = options.markup;
        document.body.appendChild(host);
    }, { markup: markup, hostWidth: hostWidth || 0 });

    await new Promise(resolve => setTimeout(resolve, 300));
}

/**
 * Mounts dialog markup inside a REAL dialog-box, reproducing the wrapper
 * DialogBox.modal builds.
 *
 * Measuring a dialog outside its own chrome would miss the constraint that
 * actually governs it: dialog-box carries max-width: 60%, so a dialog is
 * whatever the app allows and not whatever its own rule asks for. On a phone
 * that cap is the difference between a readable comparison and two columns of
 * one word each.
 */
async function mountDialog(page, markup)
{
    await page.evaluate((dialogMarkup) =>
    {
        document.querySelectorAll("dialog-box").forEach(existing => existing.remove());

        const dialog = document.createElement("dialog-box");
        dialog.innerHTML = `<div class="modal-content-section">${dialogMarkup}</div>`
            + `<button class="close-button"></button>`;
        document.body.appendChild(dialog);
    }, markup);

    await new Promise(resolve => setTimeout(resolve, 300));
}

async function unmountDialog(page)
{
    await page.evaluate(() => document.querySelectorAll("dialog-box").forEach(dialog => dialog.remove()));
}

async function unmountSurface(page)
{
    await page.evaluate(() =>
    {
        const host = document.getElementById("refinement-ui-check-host");

        if (host)
        {
            host.remove();
        }
    });
}

async function captureScreenshot(page, fileName)
{
    fs.mkdirSync(SCREENSHOT_DIRECTORY, { recursive: true });
    const screenshotPath = path.join(SCREENSHOT_DIRECTORY, fileName);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    return path.relative(REPOSITORY_ROOT, screenshotPath);
}

function buildRefinementPageMarkup()
{
    const entityRow = (label, deckName, previewText, bSelected) => `
        <button type="button" class="content-refinement-entity${bSelected ? " is-selected" : ""}">
            <span class="content-refinement-entity-label">${label}</span>
            <span class="content-refinement-entity-deck">${deckName}</span>
            <span class="content-refinement-entity-preview">${previewText}</span>
        </button>`;

    return `
        <div class="content-refinement-page">
            <div class="content-refinement-intro">
                Correct or extend the content in <strong>Optics</strong>. Every change is shown to you before it is applied.
            </div>
            <div class="content-refinement-layout">
                <div class="content-refinement-list">
                    ${entityRow("Study material", "Refraction", "The refractive index of water is 1.10 and light travels at 3.0 x 10^8 m/s in vacuum, which makes this preview long enough to need clamping.", true)}
                    ${entityRow("Card — question", "Refraction", "State Snell's law.", false)}
                    ${entityRow("Card — answer", "Refraction", "n1 sin θ1 = n2 sin θ2", false)}
                </div>
                <div class="content-refinement-detail">
                    <div class="content-refinement-preview">${AWKWARD_PASSAGE}</div>
                    <div class="content-refinement-section">
                        <h3>What should change?</h3>
                        <textarea class="content-refinement-instruction" rows="4" placeholder="e.g. the stated value is wrong"></textarea>
                        <div>
                            <div class="refinement-source-attachment">
                                <label class="refinement-source-field">
                                    <span>Reference URL (optional)</span>
                                    <input type="url" placeholder="https://…">
                                </label>
                                <div class="refinement-source-upload">
                                    <button type="button">Attach a reference document</button>
                                    <span class="refinement-source-attached">NIST-800-145.pdf</span>
                                    <button type="button" class="refinement-source-detach">Remove</button>
                                </div>
                                <div class="refinement-source-note">
                                    A reference is optional. If you attach a document you will be asked to declare the basis
                                    on which it may be used.
                                </div>
                            </div>
                        </div>
                        <button type="button" class="content-refinement-submit">Suggest a change</button>
                    </div>
                    <div class="content-refinement-section">
                        <h3>Diagrams in this passage</h3>
                        <div class="content-refinement-figure-note">
                            A redrawn diagram is checked by a vision model against the description it was drawn from.
                        </div>
                        <div class="content-refinement-figure">
                            <div class="content-refinement-figure-heading">
                                Figure 1
                                <span class="content-refinement-figure-method">INLINE_SVG</span>
                            </div>
                            <div class="content-refinement-figure-caption">Fig. 1 — refraction at a plane surface</div>
                            <div class="content-refinement-figure-actions">
                                <button type="button" data-figure-action="REFINE">Refine</button>
                                <button type="button" data-figure-action="REPLACE">Replace</button>
                                <button type="button" data-figure-action="REMOVE">Remove</button>
                            </div>
                        </div>
                        <div class="content-refinement-figure">
                            <div class="content-refinement-figure-heading">
                                Figure 2 (4-panel plate)
                                <span class="content-refinement-figure-method">MERMAID</span>
                            </div>
                            <div class="content-refinement-figure-caption">Fig. 2 — deployment models</div>
                            <div class="content-refinement-figure-actions">
                                <button type="button" data-figure-action="REFINE">Refine</button>
                                <button type="button" data-figure-action="REPLACE">Replace</button>
                                <button type="button" data-figure-action="REMOVE">Remove</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
}

/**
 * A text pane the way one now actually arrives: real block markup with the
 * changed words marked INSIDE it.
 *
 * The stand-in used to be a bare text run with a <mark> in it, which was an
 * accurate model of a diff that flattened everything to text — and stopped being
 * one the moment the diff started preserving markup. A stand-in that no longer
 * resembles what ships is the exact drift this file's header claims to guard
 * against, so it carries every element the new typography styles: a heading, a
 * paragraph, a list, a table, a figure, and the unbreakable token that is here
 * to try to widen the container.
 */
function buildTextPaneBody(markClassName, changedValue)
{
    return `<h2>Refraction</h2>`
        + `<p>The refractive index of water is <mark class="${markClassName}">${changedValue}</mark> and light travels at 3.0 x 10^8 m/s in vacuum.</p>`
        + `<ul><li>Denser medium, slower light</li><li>supercalifragilisticexpialidociousunbrokentokenthatmustnotwidenthecontainer</li></ul>`
        + `<table><tr><th>Medium</th><th>Index</th></tr><tr><td>Water</td><td>${changedValue}</td></tr></table>`
        + `<pre>a very wide preformatted block ................................................................ end</pre>`
        + WIDE_SVG_FIGURE;
}

function buildProposalDialogMarkup(bVisualComparison)
{
    const beforeBody = bVisualComparison
        ? WIDE_SVG_FIGURE
        : buildTextPaneBody("refinement-diff-removed", "1.10");

    const afterBody = bVisualComparison
        ? WIDE_SVG_FIGURE
        : buildTextPaneBody("refinement-diff-added", "1.33");

    const visionVerdict = bVisualComparison
        ? `<div class="refinement-vision-verdict">
               <div class="refinement-vision-heading">Visual review</div>
               <div>Acceptable: both media are labelled, the normal is drawn, and the angles are legible at 600px.</div>
           </div>`
        : "";

    return `
        <div class="refinement-proposal-dialog">
            <div class="title-section">Before and after</div>
            <div class="refinement-proposal-body">
                <div class="refinement-proposal-summary">Corrected the refractive index of water from 1.10 to 1.33.</div>
                <div class="refinement-proposal-concerns"><strong>Check this:</strong> the worked example below still uses the old value.</div>
                <div class="refinement-proposal-sources">
                    <span>Consulted:</span>
                    <a href="https://example.org/a" target="_blank" rel="noopener noreferrer">example.org/refractive-index</a>
                    <a href="https://example.org/b" target="_blank" rel="noopener noreferrer">example.org/another-source</a>
                </div>
                <div class="refinement-proposal-model refinement-muted">Produced by gemini-3.1-flash-lite</div>
                ${visionVerdict}
                <div class="refinement-comparison">
                    <div class="refinement-pane">
                        <div class="refinement-pane-heading">Now</div>
                        <div class="refinement-pane-body refinement-rendered-passage">${beforeBody}</div>
                    </div>
                    <div class="refinement-pane">
                        <div class="refinement-pane-heading">Proposed</div>
                        <div class="refinement-pane-body refinement-rendered-passage">${afterBody}</div>
                    </div>
                </div>
            </div>
            <div class="refinement-proposal-error">This passage changed after the suggestion was prepared.</div>
            <div class="refinement-proposal-actions">
                <button type="button" class="refinement-proposal-discard">Discard</button>
                <button type="button" class="refinement-proposal-refine">Refine further</button>
                <button type="button" class="refinement-proposal-apply">Apply this change</button>
            </div>
        </div>`;
}

function buildCandidatePickerMarkup()
{
    return `
        <div class="verification-candidate-dialog">
            <div class="title-section">Which passage is this flag about?</div>
            <div class="message-section">The quoted text appears in more than one place.</div>
            <div class="verification-candidate-list">
                <button type="button" class="verification-candidate">
                    <span class="verification-candidate-heading">STUDY_MATERIAL — Refraction</span>
                    <span class="verification-candidate-preview">the refractive index of water is 1.10 and light travels at 3.0 x 10^8 m/s in a vacuum, which is long enough to clamp</span>
                </button>
                <button type="button" class="verification-candidate">
                    <span class="verification-candidate-heading">CARD — Refraction</span>
                    <span class="verification-candidate-preview">(answer) the refractive index of water is 1.10</span>
                </button>
            </div>
            <div class="button-section"><button type="button" class="cancel-button">Cancel</button></div>
        </div>`;
}

function buildVerificationFlagMarkup()
{
    return `
        <div class="verification-flags">
            <div class="verification-flag verification-flag-blocking">
                <div class="verification-flag-header">
                    <span class="verification-flag-severity">Blocking</span>
                    <span class="verification-flag-category">DEFINITION</span>
                    <span class="verification-muted">MODEL</span>
                </div>
                <div class="verification-flag-problem">That describes SaaS, not IaaS.</div>
                <blockquote>IaaS provides applications</blockquote>
                <div class="verification-flag-correction">Expected: IaaS provides virtualised compute, storage and networking.</div>
                <div class="verification-flag-autofix">
                    <button type="button">Auto fix with AI</button>
                    <span class="verification-muted">Shows you the change before anything is written.</span>
                </div>
                <div class="verification-flag-actions">
                    <input type="text" placeholder="Note (optional)">
                    <button type="button">Mark fixed</button>
                    <button type="button">Not a problem</button>
                </div>
            </div>
        </div>`;
}

async function main()
{
    console.log(`Verifying refinement UI against ${BASE_URL}\n`);

    section("Markup measured here matches the components that emit it");

    for (const ownership of CLASS_OWNERSHIP)
    {
        const sourceText = fs.readFileSync(path.join(REPOSITORY_ROOT, ownership.sourceFile), "utf8");
        const missingClassNames = ownership.classNames.filter(className => !sourceText.includes(className));

        assert(
            missingClassNames.length === 0,
            `${path.basename(ownership.sourceFile)} emits all ${ownership.classNames.length} measured classes`
                + `${missingClassNames.length > 0 ? ` — missing: ${missingClassNames.join(", ")}` : ""}`,
        );
    }

    // Both sheets, because the licence-declaration form is shared with the admin
    // paid-deck surfaces and its rules therefore live in CommonStyles rather
    // than beside this one page. Reading only the page stylesheet would report
    // every shared class as unstyled.
    const stylesheetText = [
        path.join(REPOSITORY_ROOT, "Main", "Pages", "ContentRefinement", "Styles", "ContentRefinementPage.css"),
        path.join(REPOSITORY_ROOT, "Main", "CommonStyles", "SourceLicenceDeclarationForm.css"),
    ]
        .map(stylesheetPath => fs.readFileSync(stylesheetPath, "utf8"))
        .join("\n");

    const unstyledClassNames = CLASS_OWNERSHIP
        .flatMap(ownership => ownership.classNames)
        .filter(className => !stylesheetText.includes(`.${className}`)
            && !className.startsWith("verification-flag-severity")
            && !["refinement-proposal-body", "verification-flag-actions"].includes(className));

    assert(
        unstyledClassNames.length === 0,
        `Every emitted class has a rule${unstyledClassNames.length > 0 ? ` — unstyled: ${unstyledClassNames.join(", ")}` : ""}`,
    );

    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();

    const consoleErrors = [];
    page.on("pageerror", (pageError) => consoleErrors.push(String(pageError.message)));

    try
    {
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
        await page.setCookie({ name: "sessionId", value: SESSION_COOKIE, url: BASE_URL });
        await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 3000));

        // The first-launch tutorial paints over everything. Geometry
        // measurements are unaffected (they read the measured element directly),
        // but the screenshots are the part a person reviews, and a screenshot of
        // the welcome dialog proves nothing about this feature.
        await page.evaluate(() =>
        {
            document.querySelectorAll("tutorial-overlay, initialization-overlay, sync-blocking-overlay")
                .forEach(overlay => overlay.remove());
        });
        await new Promise(resolve => setTimeout(resolve, 300));

        section("Theme variables the stylesheet depends on");

        const themeVariables = await page.evaluate(() =>
        {
            const rootStyle = window.getComputedStyle(document.documentElement);
            const names =
            [
                "--outline-color", "--outline-color-strong", "--outline-color-subtle",
                "--secondary-background-color", "--tertiary-background-color",
                "--primary-text-color", "--secondary-text-color", "--accent-color",
                "--accent-background-color", "--danger-text-color", "--danger-background-color",
                "--highlight-background-soft", "--primary-background-gradient",
            ];
            const resolved = {};
            names.forEach(name => { resolved[name] = rootStyle.getPropertyValue(name).trim(); });
            return resolved;
        });

        for (const [variableName, variableValue] of Object.entries(themeVariables))
        {
            assert(variableValue.length > 0, `${variableName} resolves to "${variableValue}"`);
        }

        section("Panels look like the panels already shipped");

        // Compared against an existing app panel rather than to absolute
        // numbers: Chrome reports a device-scaled outline width, so an exact
        // assertion would fail on a panel that is in fact styled identically to
        // every other one in the app.
        const panelComparison = await page.evaluate(() =>
        {
            const buildProbe = (className) =>
            {
                const probe = document.createElement("div");
                probe.className = className;
                document.body.appendChild(probe);
                const computedStyle = window.getComputedStyle(probe);
                const measured =
                {
                    padding: computedStyle.padding,
                    borderRadius: computedStyle.borderRadius,
                    outlineWidth: computedStyle.outlineWidth,
                    outlineStyle: computedStyle.outlineStyle,
                    outlineColor: computedStyle.outlineColor,
                    backgroundColor: computedStyle.backgroundColor,
                };
                probe.remove();
                return measured;
            };

            return { refinement: buildProbe("content-refinement-section"), existing: buildProbe("verification-flag") };
        });

        assert(panelComparison.refinement.padding === "16px", `Panel padding applied (${panelComparison.refinement.padding})`);
        assert(panelComparison.refinement.borderRadius === "8px", `Panel radius applied (${panelComparison.refinement.borderRadius})`);
        assert(panelComparison.refinement.outlineStyle === "solid", `Panel outline is drawn (${panelComparison.refinement.outlineStyle})`);
        assert(
            panelComparison.refinement.outlineWidth === panelComparison.existing.outlineWidth,
            `Outline width matches existing panels (${panelComparison.refinement.outlineWidth} vs ${panelComparison.existing.outlineWidth})`,
        );
        assert(
            panelComparison.refinement.outlineColor === panelComparison.existing.outlineColor,
            `Outline colour matches (${panelComparison.refinement.outlineColor})`,
        );
        assert(
            panelComparison.refinement.backgroundColor === panelComparison.existing.backgroundColor,
            `Background matches (${panelComparison.refinement.backgroundColor})`,
        );

        section("Refinement page — wide");

        await mountSurface(page, buildRefinementPageMarkup());

        const pageLayout = await page.evaluate(() =>
        {
            const readBox = (selector) =>
            {
                const element = document.querySelector(selector);
                if (!element)
                {
                    return null;
                }
                const boundingBox = element.getBoundingClientRect();
                const computedStyle = window.getComputedStyle(element);
                return {
                    width: Math.round(boundingBox.width),
                    top: Math.round(boundingBox.top),
                    left: Math.round(boundingBox.left),
                    right: Math.round(boundingBox.right),
                    padding: computedStyle.padding,
                    gap: computedStyle.gap,
                    marginBottom: computedStyle.marginBottom,
                    scrollWidth: element.scrollWidth,
                    clientWidth: element.clientWidth,
                    outlineWidth: computedStyle.outlineWidth,
                };
            };

            const figureButtons = Array.from(document.querySelectorAll(".content-refinement-figure-actions button"));
            const entityRows = Array.from(document.querySelectorAll(".content-refinement-entity"));

            return {
                pageBox: readBox(".content-refinement-page"),
                intro: readBox(".content-refinement-intro"),
                layout: readBox(".content-refinement-layout"),
                list: readBox(".content-refinement-list"),
                detail: readBox(".content-refinement-detail"),
                preview: readBox(".content-refinement-preview"),
                instruction: readBox(".content-refinement-instruction"),
                submit: readBox(".content-refinement-submit"),
                sectionBox: readBox(".content-refinement-section"),
                selectedOutline: window.getComputedStyle(document.querySelector(".content-refinement-entity.is-selected")).outlineWidth,
                unselectedOutline: window.getComputedStyle(entityRows[1]).outlineWidth,
                entityLefts: entityRows.map(row => Math.round(row.getBoundingClientRect().left)),
                entityWidths: entityRows.map(row => Math.round(row.getBoundingClientRect().width)),
                figureButtonTops: figureButtons.slice(0, 3).map(button => Math.round(button.getBoundingClientRect().top)),
                figureButtonHeights: figureButtons.slice(0, 3).map(button => Math.round(button.getBoundingClientRect().height)),
                figureButtonPadding: figureButtons.length > 0 ? window.getComputedStyle(figureButtons[0]).padding : "",
                removeButtonColor: window.getComputedStyle(document.querySelector('[data-figure-action="REMOVE"]')).color,
                refineButtonColor: window.getComputedStyle(document.querySelector('[data-figure-action="REFINE"]')).color,
                submitBackground: window.getComputedStyle(document.querySelector(".content-refinement-submit")).backgroundImage,
                figureRowCount: document.querySelectorAll(".content-refinement-figure").length,
                figureSeparator: window.getComputedStyle(document.querySelectorAll(".content-refinement-figure")[1]).borderTopWidth,
            };
        });

        assert(pageLayout.pageBox.padding === "16px", `Page padding (${pageLayout.pageBox.padding})`);
        assert(pageLayout.intro.marginBottom === "16px", `Intro spacing (${pageLayout.intro.marginBottom})`);
        assert(pageLayout.layout.gap === "16px", `Column gap (${pageLayout.layout.gap})`);
        assert(pageLayout.list.top === pageLayout.detail.top, "List and detail columns are top-aligned");
        assert(
            pageLayout.detail.left - pageLayout.list.right === 16,
            `Columns separated by exactly the declared gap (${pageLayout.detail.left - pageLayout.list.right}px)`,
        );
        assert(pageLayout.detail.width > pageLayout.list.width, `Detail column is wider (${pageLayout.detail.width} vs ${pageLayout.list.width})`);
        assert(
            pageLayout.entityLefts.every(left => left === pageLayout.entityLefts[0]),
            "Entity rows are left-aligned with each other",
        );
        assert(
            pageLayout.entityWidths.every(width => width === pageLayout.entityWidths[0]),
            `Entity rows are equal width (${pageLayout.entityWidths.join(", ")})`,
        );
        assert(
            pageLayout.selectedOutline !== pageLayout.unselectedOutline,
            `The selected row is visibly distinguished (${pageLayout.selectedOutline} vs ${pageLayout.unselectedOutline})`,
        );
        assert(pageLayout.preview.padding === "16px", `Preview padding (${pageLayout.preview.padding})`);
        assert(
            pageLayout.preview.scrollWidth <= pageLayout.preview.clientWidth + 1,
            `A 600px diagram and an unbreakable token stay inside the preview (${pageLayout.preview.scrollWidth}/${pageLayout.preview.clientWidth})`,
        );
        assert(pageLayout.instruction.padding === "8px 10px", `Instruction box uses the app's input padding (${pageLayout.instruction.padding})`);
        assert(
            pageLayout.instruction.width <= pageLayout.sectionBox.width
                && pageLayout.instruction.width >= pageLayout.sectionBox.width - 34,
            `Instruction fills its panel without overflowing (${pageLayout.instruction.width} in ${pageLayout.sectionBox.width})`,
        );
        assert(pageLayout.submit.padding === "10px 18px", `Submit uses the app's button padding (${pageLayout.submit.padding})`);
        assert(pageLayout.submitBackground.includes("gradient"), "Submit uses the app's primary gradient");
        assert(
            pageLayout.figureButtonTops.every(top => top === pageLayout.figureButtonTops[0]),
            "Figure actions sit on one row",
        );
        assert(
            pageLayout.figureButtonHeights.every(height => height === pageLayout.figureButtonHeights[0]),
            `Figure actions are equal height (${pageLayout.figureButtonHeights.join(", ")})`,
        );
        assert(pageLayout.figureButtonPadding === "6px 14px", `Figure actions padded (${pageLayout.figureButtonPadding})`);
        assert(
            pageLayout.removeButtonColor !== pageLayout.refineButtonColor,
            `Remove is visually distinguished from the non-destructive actions (${pageLayout.removeButtonColor})`,
        );
        assert(pageLayout.figureSeparator !== "0px", `Consecutive figures are separated (${pageLayout.figureSeparator})`);

        assertNoHorizontalPageScroll(await measureDocumentOverflow(page), "No horizontal page scroll");
        console.log(`  ....  ${await captureScreenshot(page, "01-refinement-page-wide.png")}`);

        section("Refinement page — narrow (420px)");

        await page.setViewport({ width: NARROW_VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
        await new Promise(resolve => setTimeout(resolve, 400));

        const narrowPageLayout = await page.evaluate(() =>
        {
            const listBox = document.querySelector(".content-refinement-list").getBoundingClientRect();
            const detailBox = document.querySelector(".content-refinement-detail").getBoundingClientRect();
            const preview = document.querySelector(".content-refinement-preview");
            return {
                listTop: Math.round(listBox.top),
                detailTop: Math.round(detailBox.top),
                previewScrollWidth: preview.scrollWidth,
                previewClientWidth: preview.clientWidth,
                figureActionsWrapped: document.querySelectorAll(".content-refinement-figure-actions button").length,
            };
        });

        assert(narrowPageLayout.detailTop > narrowPageLayout.listTop, "The page stacks to one column");
        assert(
            narrowPageLayout.previewScrollWidth <= narrowPageLayout.previewClientWidth + 1,
            `The preview still contains its 600px diagram at 420px (${narrowPageLayout.previewScrollWidth}/${narrowPageLayout.previewClientWidth})`,
        );
        assertNoHorizontalPageScroll(await measureDocumentOverflow(page), "No horizontal page scroll at 420px");
        console.log(`  ....  ${await captureScreenshot(page, "02-refinement-page-narrow.png")}`);

        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
        await unmountSurface(page);

        section("Before / after dialog — text comparison");

        await mountDialog(page, buildProposalDialogMarkup(false));

        const dialogLayout = await page.evaluate(() =>
        {
            const panes = Array.from(document.querySelectorAll(".refinement-pane"));
            const actionButtons = Array.from(document.querySelectorAll(".refinement-proposal-actions button"));
            const dialogBox = document.querySelector(".refinement-proposal-dialog").getBoundingClientRect();

            return {
                dialogWidth: Math.round(dialogBox.width),
                // dialog-box clips its overflow, so content wider than the
                // wrapper is not merely untidy — it is invisible. Measured as
                // "does the right pane's right edge sit inside the wrapper",
                // because that pane is the half being approved.
                wrapperRight: Math.round(document.querySelector("dialog-box").getBoundingClientRect().right),
                rightPaneRight: Math.round(panes[panes.length - 1].getBoundingClientRect().right),
                wrapperOverflow: window.getComputedStyle(document.querySelector("dialog-box")).overflow,
                paneWidths: panes.map(pane => Math.round(pane.getBoundingClientRect().width)),
                paneTops: panes.map(pane => Math.round(pane.getBoundingClientRect().top)),
                paneBodyPaddings: panes.map(pane => window.getComputedStyle(pane.querySelector(".refinement-pane-body")).padding),
                paneHeadingPaddings: panes.map(pane => window.getComputedStyle(pane.querySelector(".refinement-pane-heading")).padding),
                paneBodyOverflow: panes.map(pane =>
                {
                    const body = pane.querySelector(".refinement-pane-body");
                    return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth };
                }),
                comparisonGap: window.getComputedStyle(document.querySelector(".refinement-comparison")).gap,
                actionLabels: actionButtons.map(button => button.textContent.trim()),
                actionTops: actionButtons.map(button => Math.round(button.getBoundingClientRect().top)),
                actionHeights: actionButtons.map(button => Math.round(button.getBoundingClientRect().height)),
                actionPaddings: actionButtons.map(button => window.getComputedStyle(button).padding),
                applyBackground: window.getComputedStyle(document.querySelector(".refinement-proposal-apply")).backgroundImage,
                discardBackground: window.getComputedStyle(document.querySelector(".refinement-proposal-discard")).backgroundColor,
                removedBackground: window.getComputedStyle(document.querySelector(".refinement-diff-removed")).backgroundColor,
                addedBackground: window.getComputedStyle(document.querySelector(".refinement-diff-added")).backgroundColor,
                removedDecoration: window.getComputedStyle(document.querySelector(".refinement-diff-removed")).textDecorationLine,
                concernsBackground: window.getComputedStyle(document.querySelector(".refinement-proposal-concerns")).backgroundColor,
                errorBackground: window.getComputedStyle(document.querySelector(".refinement-proposal-error")).backgroundColor,
                sourceLinkColor: window.getComputedStyle(document.querySelector(".refinement-proposal-sources a")).color,
            };
        });

        // THE defect this pane was reported for: it used to render as one
        // continuous text run, because the diff flattened both sides to
        // textContent before the dialog ever saw them. Measured as geometry
        // rather than as markup — a heading, a paragraph and a list that all
        // start at the same vertical position are a wall of text whatever tags
        // are nominally present.
        const passageLayout = await page.evaluate(() =>
        {
            const pane = document.querySelector(".refinement-pane-body");
            const blocks = Array.from(pane.querySelectorAll("h2, p, ul, table, pre"));

            return {
                blockCount: blocks.length,
                distinctTops: new Set(blocks.map(block => Math.round(block.getBoundingClientRect().top))).size,
                headingWeight: window.getComputedStyle(pane.querySelector("h2")).fontWeight,
                headingSize: parseFloat(window.getComputedStyle(pane.querySelector("h2")).fontSize),
                paragraphSize: parseFloat(window.getComputedStyle(pane.querySelector("p")).fontSize),
                listIndent: parseFloat(window.getComputedStyle(pane.querySelector("ul")).marginLeft),
                bFigureRendered: pane.querySelector("figure svg") !== null,
                markCount: pane.querySelectorAll("mark").length,
            };
        });

        assert(passageLayout.blockCount >= 5, `The pane holds real block markup (${passageLayout.blockCount} blocks)`);
        assert(
            passageLayout.distinctTops === passageLayout.blockCount,
            `...laid out as separate blocks rather than one text run (${passageLayout.distinctTops} distinct tops for ${passageLayout.blockCount} blocks)`,
        );
        assert(Number(passageLayout.headingWeight) >= 700, `...with headings actually bold (${passageLayout.headingWeight})`);
        assert(
            passageLayout.headingSize > passageLayout.paragraphSize,
            `...and larger than body text (${passageLayout.headingSize}px vs ${passageLayout.paragraphSize}px)`,
        );
        assert(passageLayout.listIndent > 0, `...lists indented (${passageLayout.listIndent}px)`);
        assert(passageLayout.bFigureRendered, "...and the figure survives into the pane instead of being deleted");
        assert(passageLayout.markCount > 0, "The changed words are still marked inside that markup");

        assert(dialogLayout.dialogWidth <= VIEWPORT_WIDTH, `Dialog fits the viewport (${dialogLayout.dialogWidth}px)`);
        assert(
            dialogLayout.rightPaneRight <= dialogLayout.wrapperRight,
            `The PROPOSED pane is fully inside the modal, not clipped by it `
                + `(pane ends ${dialogLayout.rightPaneRight}, modal ends ${dialogLayout.wrapperRight}, overflow: ${dialogLayout.wrapperOverflow})`,
        );
        assert(dialogLayout.paneWidths.length === 2, "Two panes render");
        assert(
            Math.abs(dialogLayout.paneWidths[0] - dialogLayout.paneWidths[1]) <= 1,
            `Panes are equal width (${dialogLayout.paneWidths.join(" vs ")})`,
        );
        assert(dialogLayout.paneTops[0] === dialogLayout.paneTops[1], "Panes are top-aligned");
        assert(dialogLayout.comparisonGap === "12px", `Comparison gap (${dialogLayout.comparisonGap})`);
        assert(
            dialogLayout.paneBodyPaddings.every(padding => padding === "14px"),
            `Pane bodies padded (${dialogLayout.paneBodyPaddings.join(", ")})`,
        );
        assert(
            dialogLayout.paneHeadingPaddings.every(padding => padding === "8px 14px"),
            `Pane headings padded (${dialogLayout.paneHeadingPaddings.join(", ")})`,
        );
        assert(
            dialogLayout.paneBodyOverflow.every(overflow => overflow.scrollWidth <= overflow.clientWidth + 1),
            `An unbreakable token stays inside its pane (${dialogLayout.paneBodyOverflow.map(o => `${o.scrollWidth}/${o.clientWidth}`).join(", ")})`,
        );
        assert(dialogLayout.actionLabels.join(",") === "Discard,Refine further,Apply this change", `Three actions (${dialogLayout.actionLabels.join(", ")})`);
        assert(
            dialogLayout.actionTops.every(top => top === dialogLayout.actionTops[0]),
            "Action buttons are aligned on one row",
        );
        assert(
            dialogLayout.actionHeights.every(height => height === dialogLayout.actionHeights[0]),
            `Action buttons are equal height (${dialogLayout.actionHeights.join(", ")})`,
        );
        assert(
            dialogLayout.actionPaddings.every(padding => padding === "10px 18px"),
            `Action buttons use the app's button padding (${dialogLayout.actionPaddings[0]})`,
        );
        assert(dialogLayout.applyBackground.includes("gradient"), "Apply is the primary action");
        assert(dialogLayout.discardBackground === "rgba(0, 0, 0, 0)", "Discard is a muted action");
        assert(
            dialogLayout.removedBackground !== dialogLayout.addedBackground,
            `Removed and added are visually distinct (${dialogLayout.removedBackground} vs ${dialogLayout.addedBackground})`,
        );
        assert(dialogLayout.removedBackground !== "rgba(0, 0, 0, 0)", "Removed marking has a visible fill");
        assert(dialogLayout.removedDecoration.includes("line-through"), `Removed text is struck through (${dialogLayout.removedDecoration})`);
        assert(dialogLayout.concernsBackground !== "rgba(0, 0, 0, 0)", `Concerns are visually flagged (${dialogLayout.concernsBackground})`);
        assert(dialogLayout.errorBackground !== "rgba(0, 0, 0, 0)", `Errors are visually flagged (${dialogLayout.errorBackground})`);
        assert(dialogLayout.sourceLinkColor !== "rgb(255, 255, 255)", `Consulted links read as links (${dialogLayout.sourceLinkColor})`);

        assertNoHorizontalPageScroll(await measureDocumentOverflow(page), "No horizontal page scroll with the dialog open");
        console.log(`  ....  ${await captureScreenshot(page, "03-proposal-dialog-text.png")}`);

        section("Before / after dialog — narrow (420px)");

        await page.setViewport({ width: NARROW_VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
        await new Promise(resolve => setTimeout(resolve, 400));

        const narrowDialog = await page.evaluate(() =>
        {
            const panes = Array.from(document.querySelectorAll(".refinement-pane"));
            const actionButtons = Array.from(document.querySelectorAll(".refinement-proposal-actions button"));
            return {
                paneTops: panes.map(pane => Math.round(pane.getBoundingClientRect().top)),
                dialogWidth: Math.round(document.querySelector(".refinement-proposal-dialog").getBoundingClientRect().width),
                actionsFit: actionButtons.every(button => Math.round(button.getBoundingClientRect().right) <= window.innerWidth),
            };
        });

        assert(narrowDialog.paneTops[0] !== narrowDialog.paneTops[1], "Panes stack vertically instead of squeezing");
        assert(narrowDialog.dialogWidth <= NARROW_VIEWPORT_WIDTH, `Dialog fits 420px (${narrowDialog.dialogWidth}px)`);
        assert(narrowDialog.actionsFit, "Action buttons stay inside the viewport");
        assertNoHorizontalPageScroll(await measureDocumentOverflow(page), "No horizontal page scroll at 420px");
        console.log(`  ....  ${await captureScreenshot(page, "04-proposal-dialog-narrow.png")}`);

        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
        await unmountSurface(page);

        section("Before / after dialog — diagram comparison");

        await mountDialog(page, buildProposalDialogMarkup(true));

        const visualDialog = await page.evaluate(() => ({
            verdictPresent: Boolean(document.querySelector(".refinement-vision-verdict")),
            verdictPadding: window.getComputedStyle(document.querySelector(".refinement-vision-verdict")).padding,
            verdictHeadingColor: window.getComputedStyle(document.querySelector(".refinement-vision-heading")).color,
            svgCount: document.querySelectorAll(".refinement-pane-body svg").length,
            widestSvg: Math.max(0, ...Array.from(document.querySelectorAll(".refinement-pane-body svg"))
                .map(svg => Math.round(svg.getBoundingClientRect().width))),
            narrowestPaneBody: Math.min(...Array.from(document.querySelectorAll(".refinement-pane-body"))
                .map(body => Math.round(body.clientWidth))),
        }));

        assert(visualDialog.verdictPresent, "The vision-review verdict is shown");
        assert(visualDialog.verdictPadding === "10px 14px", `Verdict panel padded (${visualDialog.verdictPadding})`);
        assert(visualDialog.svgCount === 2, `Both diagrams render (${visualDialog.svgCount})`);
        assert(
            visualDialog.widestSvg <= visualDialog.narrowestPaneBody,
            `A 600px diagram is constrained to its pane (${visualDialog.widestSvg}px in ${visualDialog.narrowestPaneBody}px)`,
        );

        assertNoHorizontalPageScroll(await measureDocumentOverflow(page), "No horizontal page scroll on the diagram comparison");
        console.log(`  ....  ${await captureScreenshot(page, "05-proposal-dialog-diagram.png")}`);

        await unmountDialog(page);

        section("Verification dialog — auto-fix control and candidate picker");

        await mountDialog(page, buildVerificationFlagMarkup() + buildCandidatePickerMarkup());

        const verificationLayout = await page.evaluate(() =>
        {
            const autoFixButton = document.querySelector(".verification-flag-autofix button");
            const candidateRows = Array.from(document.querySelectorAll(".verification-candidate"));
            const flagBox = document.querySelector(".verification-flag").getBoundingClientRect();
            return {
                autoFixPadding: window.getComputedStyle(autoFixButton).padding,
                autoFixOutline: window.getComputedStyle(autoFixButton).outlineColor,
                autoFixBackground: window.getComputedStyle(autoFixButton).backgroundColor,
                autoFixRowGap: window.getComputedStyle(document.querySelector(".verification-flag-autofix")).gap,
                autoFixInsideFlag: Math.round(autoFixButton.getBoundingClientRect().right) <= Math.round(flagBox.right),
                candidateLefts: candidateRows.map(row => Math.round(row.getBoundingClientRect().left)),
                candidateWidths: candidateRows.map(row => Math.round(row.getBoundingClientRect().width)),
                candidatePadding: window.getComputedStyle(candidateRows[0]).padding,
                candidateListGap: window.getComputedStyle(document.querySelector(".verification-candidate-list")).gap,
            };
        });

        assert(verificationLayout.autoFixPadding === "6px 14px", `Auto-fix button padded (${verificationLayout.autoFixPadding})`);
        assert(verificationLayout.autoFixBackground !== "rgba(0, 0, 0, 0)", `Auto-fix button is filled (${verificationLayout.autoFixBackground})`);
        assert(verificationLayout.autoFixRowGap === "10px", `Auto-fix row gap (${verificationLayout.autoFixRowGap})`);
        assert(verificationLayout.autoFixInsideFlag, "The auto-fix control stays inside its flag card");
        assert(
            verificationLayout.candidateLefts.every(left => left === verificationLayout.candidateLefts[0]),
            "Candidate rows are left-aligned",
        );
        assert(
            verificationLayout.candidateWidths.every(width => width === verificationLayout.candidateWidths[0]),
            `Candidate rows are equal width (${verificationLayout.candidateWidths.join(", ")})`,
        );
        assert(verificationLayout.candidatePadding === "10px 12px", `Candidate rows padded (${verificationLayout.candidatePadding})`);
        assert(verificationLayout.candidateListGap === "8px", `Candidate list gap (${verificationLayout.candidateListGap})`);

        assertNoHorizontalPageScroll(await measureDocumentOverflow(page), "No horizontal page scroll on the verification surfaces");
        console.log(`  ....  ${await captureScreenshot(page, "06-verification-autofix.png")}`);

        await unmountDialog(page);

        section("Deck menu entry point, in the live app");

        const menuCheck = await page.evaluate(async () =>
        {
            const deckTile = Array.from(document.querySelectorAll("deck-tile"))
                .find(candidate => (candidate.textContent || "").includes("Optics"))
                || document.querySelector("deck-tile");

            if (!deckTile)
            {
                return { bTileFound: false, buttonClasses: [] };
            }

            deckTile.querySelector(".deck-options-button").click();
            await new Promise(resolve => setTimeout(resolve, 500));

            const menu = document.querySelector("deck-options-context-menu");
            const buttonClasses = menu ? Array.from(menu.querySelectorAll("button")).map(button => button.className) : [];
            const refineIndex = buttonClasses.findIndex(className => className.includes("refine-with-ai-button"));
            const generateIndex = buttonClasses.findIndex(className => className.includes("generate-with-ai-button"));

            return { bTileFound: true, buttonClasses: buttonClasses, refineIndex: refineIndex, generateIndex: generateIndex };
        });

        assert(menuCheck.bTileFound, "A deck tile is on the home page");
        assert(
            menuCheck.buttonClasses.some(className => className.includes("refine-with-ai-button")),
            `Refine With AI is in the live deck menu (${menuCheck.buttonClasses.length} actions)`,
        );
        assert(
            menuCheck.refineIndex === menuCheck.generateIndex + 1,
            "It sits directly after Generate With AI, where a user looks for it",
        );

        const paidBranchSource = fs.readFileSync(
            path.join(REPOSITORY_ROOT, "Main", "Pages", "Home", "Components", "DeckOptionsContextMenu.js"), "utf8");
        const paidBranchMarkup = paidBranchSource.split("isPaidDeck\n            ? `")[1] || "";

        assert(
            !paidBranchMarkup.split("`")[0].includes("refine-with-ai-button"),
            "…and not in the paid-deck branch — a buyer's copy is not theirs to rewrite",
        );

        section("No JavaScript errors while rendering any of it");

        const meaningfulErrors = consoleErrors.filter(errorText =>
            !errorText.includes("favicon") && !errorText.includes("net::ERR_"));

        assert(meaningfulErrors.length === 0, `No page errors (${meaningfulErrors.length})`);
        meaningfulErrors.slice(0, 5).forEach(errorText => console.log(`        ${errorText}`));
    }
    finally
    {
        await browser.close();
    }

    console.log(`\nPassed: ${passedCount}   Failed: ${failedCount}`);
    console.log(`Screenshots: ${path.relative(REPOSITORY_ROOT, SCREENSHOT_DIRECTORY)}`);
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("FATAL", fatalError);
    process.exit(1);
});
