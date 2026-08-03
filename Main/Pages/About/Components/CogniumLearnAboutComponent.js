import DialogBox from "../../../CommonComponents/DialogBox.js";
import ReportIssueDialog from "../../../CommonComponents/ReportIssueDialog.js";

class CogniumLearnAboutComponent extends HTMLElement
{
    #currentPhase = 0;
    #phaseInterval = null;

    static #ICON_PATH = "./Globals/Assets/Images/Icons";
    static #ILLUSTRATION_PATH = "./Globals/Assets/Images/Illustrations";

    static #lifecyclePhases =
    [
        {
            id: "acquire",
            label: "Acquire",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutAcquirePhaseIcon.svg`,
            tagline: "Ingest anything, effortlessly",
            description: "CogniumLearn turns any source — documents, URLs, raw notes, even images and audio — into structured study material. It removes the friction between encountering knowledge and capturing it.",
            tools:
            [
                {
                    name: "AI Auto-Generation",
                    detail: "Feed a PDF, a URL, or freeform notes. CogniumLearn extracts the knowledge and structures it into flashcards, study materials and mock tests automatically.",
                    purpose: "Eliminate the slowest part of studying — manually building cards. You bring the source, CogniumLearn builds the entire deck tree, splits topics into subdecks, tags each card, and prepares matching study materials and mock tests in one pass.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/AutoGenerationIllustration.svg`
                },
                {
                    name: "Rich Card Editor",
                    detail: "Full rich-text editing with bold, italic, code, highlight, inline images and audio for when you want to author cards by hand.",
                    purpose: "Give you the same authoring power as a real document editor for the cards you'd rather write yourself — code snippets stay formatted, formulas render, diagrams sit inline, and audio plays directly on the card.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/RichEditorIllustration.svg`
                }
            ]
        },
        {
            id: "encode",
            label: "Encode",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutEncodePhaseIcon.svg`,
            tagline: "Burn it into long-term memory",
            description: "Encoding is where passive familiarity becomes durable memory. CogniumLearn learns how your memory works on each card and reminds you exactly when you're about to forget — not a day too early, not a day too late.",
            tools:
            [
                {
                    name: "Smart Scheduling",
                    detail: "Every card is scheduled to fight the human forgetting curve — surfacing just before the moment your brain would otherwise drop it, so each review counts the most.",
                    purpose: "Hermann Ebbinghaus showed over a century ago that without active recall, memory of new material decays along a predictable forgetting curve — fast at first, then slower. CogniumLearn models that curve individually for every card you learn and schedules each review at the latest possible moment before you'd forget. Cards you know cold come back rarely; cards you're shaky on come back fast. Over weeks this compounds into durable, low-effort retention.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/SmartSchedulingIllustration.svg`
                },
                {
                    name: "Content Study",
                    detail: "A linear, immersive read-through mode for when you need to absorb new material before active recall begins.",
                    purpose: "Give brand-new material a real first read before drilling. You scroll a deck top-to-bottom like a textbook, building the mental scaffolding that active recall will later reinforce.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/ContentStudyIllustration.svg`
                }
            ]
        },
        {
            id: "consolidate",
            label: "Consolidate",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutConsolidatePhaseIcon.svg`,
            tagline: "Strengthen the pathways",
            description: "Consolidation deepens what you've learned through targeted re-exposure. CogniumLearn finds your weak spots and surfaces them with intelligent prioritisation — and now, generates tailored study material to patch them.",
            tools:
            [
                {
                    name: "Revise Mode",
                    detail: "Focused sessions that target the cards you're shakiest on, ranked by confidence-weighted performance.",
                    purpose: "Spend your study time where it matters most. Instead of grinding through a full deck, you get a short queue of exactly the cards your performance data says you're most at risk of forgetting.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/ReviseModeIllustration.svg`
                },
                {
                    name: "Curated Study",
                    detail: "AI-curated sessions and on-demand study materials built around your real weak topics, grounded in your own documents.",
                    purpose: "Stop reading generic explanations of topics you already know. CogniumLearn identifies your true weak topics from your performance and generates a custom study material per topic, grounded in your own textbook and refreshed weekly.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/CuratedStudyIllustration.svg`
                }
            ]
        },
        {
            id: "validate",
            label: "Validate",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutValidatePhaseIcon.svg`,
            tagline: "Prove what you know",
            description: "Validation surfaces gaps you didn't know you had. CogniumLearn stress-tests your knowledge under exam-like conditions before you ever sit in the real one.",
            tools:
            [
                {
                    name: "Mock Test",
                    detail: "Timed, exam-condition testing across an entire deck. Performance feeds back into card difficulty so weak ones don't slip through.",
                    purpose: "Reveal the difference between recognition (you've seen this before) and recall (you can produce the answer under pressure). Timed full-deck tests expose blind spots that spaced repetition alone can hide.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/MockTestIllustration.svg`
                },
                {
                    name: "Card Browser",
                    detail: "A searchable, filterable view of every card with inline performance data, so you always know exactly what you've learned.",
                    purpose: "Audit your knowledge. Filter by tag, deck, difficulty or mastery to see exactly which cards are doing the work — and which ones need attention before your next exam.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/CardBrowserIllustration.svg`
                }
            ]
        },
        {
            id: "reflect",
            label: "Reflect",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutReflectPhaseIcon.svg`,
            tagline: "Understand where you stand",
            description: "Reflection closes the loop. CogniumLearn gives you a single honest number for how well you actually know a deck, plus a clear picture of which topics are strong, weak or unstable.",
            tools:
            [
                {
                    name: "Deck Insights",
                    detail: "Visual mastery curves, retention graphs and per-card performance history rendered over time.",
                    purpose: "Turn raw study data into a story. See how your mastery has climbed week over week, which topics keep regressing, and where the next session should focus — all without crunching numbers yourself.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/DeckInsightsIllustration.svg`
                },
                {
                    name: "Mastery Report",
                    detail: "A statistically grounded mastery score — confidence matters as much as correctness, so a deck full of guesses can't fake a high number.",
                    purpose: "Answer the only question that really matters before an exam: do I actually know this deck? Streaks and card counts can lie. The mastery score weighs each answer by how sure CogniumLearn is that you genuinely know the underlying skill.",
                    illustrationUrl: `${CogniumLearnAboutComponent.#ILLUSTRATION_PATH}/MasteryReportIllustration.svg`
                }
            ]
        }
    ];

    static #featureCategories =
    [
        {
            title: "Generation & Content",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutLightningIcon.svg`,
            features:
            [
                {
                    label: "AI-generated flashcards from PDFs, URLs, syllabi and freeform notes",
                    purpose: "Removes the single biggest barrier to using a spaced-repetition system: building the deck. Drop in a textbook chapter or paste a syllabus and you get a fully tagged, hierarchically organised deck back in minutes."
                },
                {
                    label: "AI-generated study materials at multiple detail levels",
                    purpose: "Generate readable explainer pages for any topic at the depth you want — from a one-page summary to an in-depth walkthrough. Ideal for first-pass reading or pre-exam revision."
                },
                {
                    label: "AI-generated mock tests with structured sections",
                    purpose: "Create full mock exams that mirror the structure of your real test — multiple choice, short answer, long answer — so practice feels like the real thing, not a quiz."
                },
                {
                    label: "Rich card editor with formatting, code blocks and highlights",
                    purpose: "Author your own cards with the same fidelity as a document editor — keep code formatted, formulas rendered and key terms highlighted instead of fighting plain text."
                },
                {
                    label: "Inline image and audio cards for visual and aural recall",
                    purpose: "Some material isn't text. Diagrams, anatomical illustrations, language audio and music excerpts can all live directly on the card so you study them in their natural form."
                },
                {
                    label: "Multi-provider AI — OpenAI and Gemini, no lock-in",
                    purpose: "Pick the AI provider that fits your budget and quality preferences. Switching is one setting; your decks and progress are untouched."
                }
            ]
        },
        {
            title: "Study Modes",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutStudyModesIcon.svg`,
            features:
            [
                {
                    label: "Spaced repetition reviews with smart scheduling",
                    purpose: "Spaced repetition fights the human forgetting curve described by Hermann Ebbinghaus in the 1880s: without active recall, memory of new material decays predictably over time. CogniumLearn learns the shape of that curve for every card you study and schedules each review just before you'd otherwise forget — so the same time spent studying produces dramatically better retention than re-reading or cramming."
                },
                {
                    label: "Content-study reading mode for new material",
                    purpose: "Read a deck like a book before drilling. Build a first-pass mental model so active recall can later anchor onto real understanding instead of guesswork."
                },
                {
                    label: "Focused revision sessions for your weakest cards",
                    purpose: "On-demand short sessions that pull just the cards your performance data flags as shaky — perfect for the morning before an exam."
                },
                {
                    label: "AI-curated study sessions that adapt to your performance",
                    purpose: "Sessions blended from a mix of difficulty, retention and time-since-review. Each session is built specifically for the user, not a one-size-fits-all queue."
                },
                {
                    label: "Timed mock tests under exam-like conditions",
                    purpose: "Practice under the same pressure you'll feel during the real exam. Catches the recognition-versus-recall gap that pure flashcard review can hide."
                }
            ]
        },
        {
            title: "Insights & Analytics",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutInsightsIcon.svg`,
            features:
            [
                {
                    label: "Deck Insights with mastery curves and retention graphs",
                    purpose: "Watch your mastery climb over weeks, see retention dip and recover, and spot the topics that consistently regress — all in one visual dashboard per deck."
                },
                {
                    label: "Topic analysis — weak, strong and unstable topics surfaced automatically",
                    purpose: "Stop guessing which areas need more work. CogniumLearn groups your cards into topics and tells you which ones you're strong on, weak on, or where your scores keep swinging unstably."
                },
                {
                    label: "Single-number mastery score per deck",
                    purpose: "Answer 'do I actually know this deck yet?' with one honest number. No streaks, no card counts — a score that weighs every answer by how sure CogniumLearn is in your skill."
                },
                {
                    label: "Auto Performance Analysis with weekly weak-and-strong topic reports",
                    purpose: "Opt-in weekly summary of your top weak and strong topics per deck, run automatically with no manual trigger. A quick read tells you what to focus on this week."
                },
                {
                    label: "Auto-generated curated study materials for your weakest topics",
                    purpose: "When weak topics are identified, CogniumLearn can automatically generate a tailored study material per topic — grounded in your own textbook plus fresh web context — to help patch the gap."
                },
                {
                    label: "Activity history across every study session, generation and purchase",
                    purpose: "A scrollable record of everything you've done in CogniumLearn — sessions, mock tests, generations, purchases — searchable and filterable so you can audit your study habits."
                }
            ]
        },
        {
            title: "Library & Sharing",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutBookIcon.svg`,
            features:
            [
                {
                    label: "Paid Decks marketplace — buy ready-made study packs",
                    purpose: "Skip the build step entirely on standardised topics. Browse and purchase decks created by other users or the CogniumLearn team — fully integrated with the same study modes as your own decks."
                },
                {
                    label: "Region-aware pricing in your local currency",
                    purpose: "See deck prices in the currency you actually use. No surprise conversions at checkout."
                },
                {
                    label: "Deck import / export with optional progress retention",
                    purpose: "Move decks between accounts or share them with collaborators. Choose whether to ship the embedded study progress or just the cards themselves."
                },
                {
                    label: "Smart regeneration — re-uploading the same syllabus merges into existing decks",
                    purpose: "Re-generating from an updated version of the same source no longer creates a duplicate deck. CogniumLearn detects the overlap, preserves your progress, and merges new content into the right places."
                }
            ]
        },
        {
            title: "Platform",
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutMonitorIcon.svg`,
            features:
            [
                {
                    label: "Cross-platform — runs natively on desktop (Tauri) and any browser",
                    purpose: "Use CogniumLearn where it suits you — fast native desktop app or a browser tab on a borrowed machine — without losing data or breaking the experience."
                },
                {
                    label: "Multi-device sync of decks, cards and progress",
                    purpose: "Edit a card on your laptop, study it on your phone tonight, sit a mock test on your tablet tomorrow — every device sees the same up-to-date state."
                },
                {
                    label: "Physical-device-aware device management — one machine counts as one device across browsers",
                    purpose: "Open CogniumLearn in Chrome and Firefox on the same laptop, and it counts as one device — not two. The 4-device limit applies to actual machines, not browser profiles."
                },
                {
                    label: "In-browser AI for topic analysis — no API key needed",
                    purpose: "Run the topic analyser entirely on-device using WebGPU or WASM. No internet, no quota, no key — the same intelligence works offline."
                },
                {
                    label: "Interactive tutorials for first-time users",
                    purpose: "Guided walkthroughs that show new users exactly how the lifecycle plays out — instead of dropping them onto an empty home screen."
                },
                {
                    label: "Admin panel for content publishing and revenue tracking",
                    purpose: "For paid-deck publishers — a dedicated panel to upload decks, manage pricing and bundles, and track revenue."
                }
            ]
        }
    ];

    static #differentiators =
    [
        {
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutLightbulbIcon.svg`,
            title: "Every phase covered",
            body: "Most apps only address one or two phases of the knowledge lifecycle. CogniumLearn is architected around all five — from first encounter to validated mastery."
        },
        {
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutBookIcon.svg`,
            title: "Grounded in research",
            body: "CogniumLearn's scheduling and rating systems are grounded in cognitive-science research — not gamification heuristics, not streak gimmicks."
        },
        {
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutLightningIcon.svg`,
            title: "AI that understands study",
            body: "The AI generation layer is not a generic summariser. It understands flashcard structure, question types, difficulty gradients, and the difference between recognition and recall."
        },
        {
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutMonitorIcon.svg`,
            title: "Cross-platform by design",
            body: "CogniumLearn runs natively on desktop via Tauri and in any browser. Your decks, progress and study sessions are consistent across every surface."
        },
        {
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutShieldIcon.svg`,
            title: "Honest mastery score",
            body: "Unlike apps that measure streaks or card counts, CogniumLearn weighs every answer by how confident it is in your skill — so a deck full of guesses can never fake a high number."
        },
        {
            iconUrl: `${CogniumLearnAboutComponent.#ICON_PATH}/AboutMultiProviderIcon.svg`,
            title: "Multi-provider AI",
            body: "CogniumLearn supports Gemini and OpenAI interchangeably through a unified provider abstraction — no lock-in, no compromise on generation quality."
        }
    ];

    #renderHero()
    {
        return `
            <div class="about-hero">
                <div class="about-hero-glow"></div>
                <div class="about-hero-content">
                    <div class="about-wordmark">
                        <span class="about-wordmark-mind">Mind</span><span class="about-wordmark-meld">Meld</span>
                    </div>
                    <p class="about-hero-tagline">The complete knowledge consolidation system</p>
                    <p class="about-hero-body">
                        CogniumLearn is an AI-powered study platform built around one idea: learning is not a single act,
                        but a five-phase lifecycle. Every feature exists to serve a specific phase of how human memory
                        actually works — from first contact with new material all the way through to validated, durable mastery.
                    </p>
                    <div class="about-hero-pills">
                        <span class="about-hero-pill">Smart Scheduling</span>
                        <span class="about-hero-pill">Honest Mastery Score</span>
                        <span class="about-hero-pill">AI-Powered Generation</span>
                        <span class="about-hero-pill">Cross-Platform</span>
                    </div>
                </div>
            </div>
        `;
    }

    #renderLifecycle()
    {
        const phases = CogniumLearnAboutComponent.#lifecyclePhases;

        const stepsHtml = phases.map((phase, phaseIndex) =>
        {
            const isLast = phaseIndex === phases.length - 1;

            return `
                <div class="about-phase-step" data-phase="${phaseIndex}">
                    <div class="about-phase-node">
                        <img class="about-phase-node-icon" src="${phase.iconUrl}" alt="">
                        <span class="about-phase-node-label">${phase.label}</span>
                    </div>
                    ${!isLast ? '<div class="about-phase-connector"><div class="about-phase-connector-line"><div class="about-phase-connector-arrowhead"></div></div></div>' : ''}
                </div>
            `;
        }).join('');

        const detailsHtml = phases.map((phase, phaseIndex) =>
        {
            const toolsHtml = phase.tools.map((tool, toolIndex) =>
                `<button class="about-tool-card" type="button" data-tool="${phaseIndex}-${toolIndex}">
                    <div class="about-tool-name">${tool.name}</div>
                    <div class="about-tool-detail">${tool.detail}</div>
                    <div class="about-tool-hint">Click to learn more</div>
                </button>`
            ).join('');

            return `
                <div class="about-phase-detail ${phaseIndex === 0 ? 'about-phase-detail--active' : ''}" data-detail="${phaseIndex}">
                    <div class="about-phase-detail-header">
                        <div class="about-phase-counter">Phase ${phaseIndex + 1} of ${phases.length}</div>
                        <h3 class="about-phase-name">${phase.label}</h3>
                        <p class="about-phase-tagline">${phase.tagline}</p>
                    </div>
                    <p class="about-phase-description">${phase.description}</p>
                    <div class="about-tools-grid">${toolsHtml}</div>
                </div>
            `;
        }).join('');

        const navDotsHtml = phases.map((phase, phaseIndex) =>
            `<button class="about-phase-nav-dot ${phaseIndex === 0 ? 'about-phase-nav-dot--active' : ''}" data-nav="${phaseIndex}" aria-label="${phase.label}"></button>`
        ).join('');

        return `
            <section class="about-lifecycle-section">
                <div class="about-section-label">The knowledge consolidation lifecycle</div>
                <h2 class="about-section-title">A tool for every phase</h2>
                <p class="about-section-body">
                    The brain does not consolidate knowledge in one step. Research in cognitive science identifies
                    five distinct phases — and most study tools only address one or two. CogniumLearn is designed
                    to serve all five, with a dedicated tool at each stage.
                </p>

                <div class="about-lifecycle-diagram-container">
                    <img
                        class="about-lifecycle-diagram"
                        src="./Globals/Assets/Images/Diagrams/CogniumLearnKnowledgeConsolidationLifecycleSimple.png"
                        alt="CogniumLearn Knowledge Consolidation Lifecycle Diagram"
                    >
                </div>

                <div class="about-lifecycle-track">
                    ${stepsHtml}
                </div>

                <div class="about-phase-details-container">
                    ${detailsHtml}
                </div>

                <div class="about-phase-nav">
                    ${navDotsHtml}
                </div>
            </section>
        `;
    }

    #renderFeatures()
    {
        const cardsHtml = CogniumLearnAboutComponent.#featureCategories.map((category, categoryIndex) =>
        {
            const itemsHtml = category.features.map((feature, featureIndex) =>
                `<li class="about-feature-item">
                    <button class="about-feature-item-button" type="button" data-feature="${categoryIndex}-${featureIndex}">
                        <span class="about-feature-item-label">${feature.label}</span>
                        <span class="about-feature-item-arrow">›</span>
                    </button>
                </li>`
            ).join('');

            return `
                <div class="about-feature-card">
                    <div class="about-feature-card-header">
                        <img class="about-feature-card-icon" src="${category.iconUrl}" alt="">
                        <div class="about-feature-card-title">${category.title}</div>
                    </div>
                    <ul class="about-feature-list">${itemsHtml}</ul>
                </div>
            `;
        }).join('');

        return `
            <section class="about-features-section">
                <div class="about-section-label">Everything that comes in the box</div>
                <h2 class="about-section-title">Features at a glance</h2>
                <p class="about-section-body">
                    A grouped look at the capabilities CogniumLearn ships with today — every one of them tied
                    to a phase of the knowledge lifecycle above. Click any feature for a deeper explanation.
                </p>
                <div class="about-features-grid">${cardsHtml}</div>
            </section>
        `;
    }

    #renderDifferentiators()
    {
        const cardsHtml = CogniumLearnAboutComponent.#differentiators.map(differentiator =>
            `<div class="about-differentiator-card">
                <img class="about-differentiator-icon" src="${differentiator.iconUrl}" alt="">
                <div class="about-differentiator-title">${differentiator.title}</div>
                <div class="about-differentiator-body">${differentiator.body}</div>
            </div>`
        ).join('');

        return `
            <section class="about-differentiators-section">
                <div class="about-section-label">What sets CogniumLearn apart</div>
                <h2 class="about-section-title">Differentiators</h2>
                <div class="about-differentiators-grid">${cardsHtml}</div>
            </section>
        `;
    }

    #renderContact()
    {
        // Replaced the support mailto: card. Reporting in-app means the report is
        // grouped with everyone else hitting the same problem, and the reporter can
        // follow its status — neither of which an email thread could offer.
        return `
            <section class="about-contact-section">
                <div class="about-section-label">We're here to help</div>
                <h2 class="about-section-title">Get in touch</h2>
                <p class="about-section-body">
                    Hit a bug, or something not working the way you expected? Report it here and we'll
                    look into it — you can track the outcome from inside the app.
                </p>
                <button type="button" class="about-contact-card about-contact-report-button">
                    <img class="about-contact-icon" src="${CogniumLearnAboutComponent.#ICON_PATH}/AboutMailIcon.svg" alt="">
                    <div class="about-contact-text">
                        <div class="about-contact-label">Support</div>
                        <div class="about-contact-email">Report an issue</div>
                    </div>
                    <span class="about-contact-arrow">›</span>
                </button>
            </section>
        `;
    }

    #renderCallToAction()
    {
        return `
            <div class="about-call-to-action">
                <div class="about-call-to-action-glow"></div>
                <div class="about-call-to-action-content">
                    <h2 class="about-call-to-action-title">Your knowledge deserves a complete system</h2>
                    <p class="about-call-to-action-body">
                        Every day you study without CogniumLearn, you're leaving consolidation phases unserved —
                        relying on hope instead of design. Start the full lifecycle.
                    </p>
                    <button class="about-get-started-button">Get Started</button>
                </div>
            </div>
        `;
    }

    #showToolModal(phaseIndex, toolIndex)
    {
        const phase = CogniumLearnAboutComponent.#lifecyclePhases[phaseIndex];
        const tool = phase?.tools?.[toolIndex];

        if (!tool)
        {
            return;
        }

        const modalHtml = `
            <div class="about-info-modal">
                <div class="about-info-modal-illustration"><img class="about-info-modal-illustration-image" src="${tool.illustrationUrl}" alt=""></div>
                <div class="about-info-modal-eyebrow">${phase.label} · Phase ${phaseIndex + 1}</div>
                <h2 class="about-info-modal-title">${tool.name}</h2>
                <p class="about-info-modal-description">${tool.detail}</p>
                <div class="about-info-modal-section-label">Why it exists</div>
                <p class="about-info-modal-purpose">${tool.purpose}</p>
            </div>
        `;

        DialogBox.modal(modalHtml);
    }

    #showFeatureModal(categoryIndex, featureIndex)
    {
        const category = CogniumLearnAboutComponent.#featureCategories[categoryIndex];
        const feature = category?.features?.[featureIndex];

        if (!feature)
        {
            return;
        }

        const modalHtml = `
            <div class="about-info-modal">
                <div class="about-info-modal-illustration">${category.icon}</div>
                <div class="about-info-modal-eyebrow">${category.title}</div>
                <h2 class="about-info-modal-title">${feature.label}</h2>
                <div class="about-info-modal-section-label">Why it exists</div>
                <p class="about-info-modal-purpose">${feature.purpose}</p>
            </div>
        `;

        DialogBox.modal(modalHtml);
    }

    #setActivePhase(phaseIndex)
    {
        const phases = CogniumLearnAboutComponent.#lifecyclePhases;

        if (phaseIndex < 0 || phaseIndex >= phases.length)
        {
            return;
        }

        this.#currentPhase = phaseIndex;

        const allDetails = this.querySelectorAll('.about-phase-detail');
        const allSteps = this.querySelectorAll('.about-phase-step');
        const allDots = this.querySelectorAll('.about-phase-nav-dot');

        allDetails.forEach(detail => detail.classList.remove('about-phase-detail--active'));
        allSteps.forEach(step => step.classList.remove('about-phase-step--active'));
        allDots.forEach(dot => dot.classList.remove('about-phase-nav-dot--active'));

        const targetDetail = this.querySelector(`.about-phase-detail[data-detail="${phaseIndex}"]`);
        const targetStep = this.querySelector(`.about-phase-step[data-phase="${phaseIndex}"]`);
        const targetDot = this.querySelector(`.about-phase-nav-dot[data-nav="${phaseIndex}"]`);

        if (targetDetail)
        {
            targetDetail.classList.add('about-phase-detail--active');
        }

        if (targetStep)
        {
            targetStep.classList.add('about-phase-step--active');
        }

        if (targetDot)
        {
            targetDot.classList.add('about-phase-nav-dot--active');
        }
    }

    #startAutoAdvance()
    {
        this.#phaseInterval = setInterval(() =>
        {
            const nextPhase = (this.#currentPhase + 1) % CogniumLearnAboutComponent.#lifecyclePhases.length;
            this.#setActivePhase(nextPhase);
        }, 4000);
    }

    #stopAutoAdvance()
    {
        if (this.#phaseInterval)
        {
            clearInterval(this.#phaseInterval);
            this.#phaseInterval = null;
        }
    }

    #handleEvents()
    {
        const phaseSteps = this.querySelectorAll('.about-phase-step');
        const navDots = this.querySelectorAll('.about-phase-nav-dot');
        const toolCards = this.querySelectorAll('.about-tool-card');
        const featureButtons = this.querySelectorAll('.about-feature-item-button');

        phaseSteps.forEach(step =>
        {
            step.addEventListener('click', () =>
            {
                this.#stopAutoAdvance();
                const phaseIndex = parseInt(step.getAttribute('data-phase'));
                this.#setActivePhase(phaseIndex);
            });
        });

        navDots.forEach(dot =>
        {
            dot.addEventListener('click', () =>
            {
                this.#stopAutoAdvance();
                const phaseIndex = parseInt(dot.getAttribute('data-nav'));
                this.#setActivePhase(phaseIndex);
            });
        });

        toolCards.forEach(toolCard =>
        {
            toolCard.addEventListener('click', () =>
            {
                this.#stopAutoAdvance();
                const [phaseIndex, toolIndex] = toolCard.getAttribute('data-tool').split('-').map(Number);
                this.#showToolModal(phaseIndex, toolIndex);
            });
        });

        featureButtons.forEach(featureButton =>
        {
            featureButton.addEventListener('click', () =>
            {
                const [categoryIndex, featureIndex] = featureButton.getAttribute('data-feature').split('-').map(Number);
                this.#showFeatureModal(categoryIndex, featureIndex);
            });
        });

        const getStartedButton = this.querySelector('.about-get-started-button');

        if (getStartedButton)
        {
            getStartedButton.addEventListener('click', () =>
            {
                this.dispatchEvent(new CustomEvent('cogniumlearn-get-started', { bubbles: true }));
            });
        }

        const reportIssueButton = this.querySelector('.about-contact-report-button');

        if (reportIssueButton)
        {
            reportIssueButton.addEventListener('click', () =>
            {
                ReportIssueDialog.show();
            });
        }
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <link rel="stylesheet" href="./CogniumLearnAboutComponent.css">
            <div class="about-root">
                ${this.#renderHero()}
                ${this.#renderLifecycle()}
                ${this.#renderFeatures()}
                ${this.#renderDifferentiators()}
                ${this.#renderContact()}
                ${this.#renderCallToAction()}
            </div>
        `;

        this.#setActivePhase(0);
        this.#handleEvents();
        this.#startAutoAdvance();
    }

    disconnectedCallback()
    {
        this.#stopAutoAdvance();
    }
}

customElements.define('cogniumlearn-about-component', CogniumLearnAboutComponent);
export default CogniumLearnAboutComponent;
