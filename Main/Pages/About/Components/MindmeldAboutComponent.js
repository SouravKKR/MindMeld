import DialogBox from "../../../CommonComponents/DialogBox.js";

class MindmeldAboutComponent extends HTMLElement
{
    #currentPhase = 0;
    #phaseInterval = null;

    static #lifecyclePhases =
    [
        {
            id: "acquire",
            label: "Acquire",
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`,
            tagline: "Ingest anything, effortlessly",
            description: "MindMeld turns any source — documents, URLs, raw notes, even images and audio — into structured study material. It removes the friction between encountering knowledge and capturing it.",
            tools:
            [
                {
                    name: "AI Auto-Generation",
                    detail: "Feed a PDF, a URL, or freeform notes. MindMeld extracts the knowledge and structures it into flashcards, study materials and mock tests automatically.",
                    purpose: "Eliminate the slowest part of studying — manually building cards. You bring the source, MindMeld builds the entire deck tree, splits topics into subdecks, tags each card, and prepares matching study materials and mock tests in one pass.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="14" y="20" width="44" height="60" rx="4"/><line x1="22" y1="32" x2="50" y2="32"/><line x1="22" y1="42" x2="50" y2="42"/><line x1="22" y1="52" x2="42" y2="52"/><path d="M70 50l16 -10v40l-16 -10z" fill="currentColor" opacity="0.15"/><rect x="62" y="40" width="44" height="30" rx="4"/><circle cx="84" cy="92" r="14"/><path d="M78 92h12M84 86v12"/></svg>`
                },
                {
                    name: "Rich Card Editor",
                    detail: "Full rich-text editing with bold, italic, code, highlight, inline images and audio for when you want to author cards by hand.",
                    purpose: "Give you the same authoring power as a real document editor for the cards you'd rather write yourself — code snippets stay formatted, formulas render, diagrams sit inline, and audio plays directly on the card.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="14" y="20" width="92" height="80" rx="6"/><line x1="14" y1="36" x2="106" y2="36"/><path d="M22 28h4M30 28h4M38 28h4" stroke-linecap="round"/><line x1="22" y1="50" x2="98" y2="50"/><line x1="22" y1="60" x2="86" y2="60"/><line x1="22" y1="70" x2="92" y2="70"/><rect x="22" y="80" width="32" height="14" rx="2" fill="currentColor" opacity="0.15"/></svg>`
                }
            ]
        },
        {
            id: "encode",
            label: "Encode",
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
            tagline: "Burn it into long-term memory",
            description: "Encoding is where passive familiarity becomes durable memory. MindMeld learns how your memory works on each card and reminds you exactly when you're about to forget — not a day too early, not a day too late.",
            tools:
            [
                {
                    name: "Smart Scheduling",
                    detail: "Every card is scheduled to fight the human forgetting curve — surfacing just before the moment your brain would otherwise drop it, so each review counts the most.",
                    purpose: "Hermann Ebbinghaus showed over a century ago that without active recall, memory of new material decays along a predictable forgetting curve — fast at first, then slower. MindMeld models that curve individually for every card you learn and schedules each review at the latest possible moment before you'd forget. Cards you know cold come back rarely; cards you're shaky on come back fast. Over weeks this compounds into durable, low-effort retention.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 90 Q30 70 50 78 T90 50 T110 30"/><circle cx="20" cy="84" r="3" fill="currentColor"/><circle cx="40" cy="76" r="3" fill="currentColor"/><circle cx="62" cy="64" r="3" fill="currentColor"/><circle cx="82" cy="52" r="3" fill="currentColor"/><circle cx="102" cy="36" r="3" fill="currentColor"/><line x1="10" y1="100" x2="110" y2="100"/><line x1="10" y1="100" x2="10" y2="20"/></svg>`
                },
                {
                    name: "Content Study",
                    detail: "A linear, immersive read-through mode for when you need to absorb new material before active recall begins.",
                    purpose: "Give brand-new material a real first read before drilling. You scroll a deck top-to-bottom like a textbook, building the mental scaffolding that active recall will later reinforce.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 24h44v76H14z" fill="currentColor" opacity="0.05"/><path d="M62 24h44v76H62z" fill="currentColor" opacity="0.05"/><line x1="22" y1="36" x2="50" y2="36"/><line x1="22" y1="46" x2="50" y2="46"/><line x1="22" y1="56" x2="46" y2="56"/><line x1="70" y1="36" x2="98" y2="36"/><line x1="70" y1="46" x2="98" y2="46"/><line x1="70" y1="56" x2="94" y2="56"/><path d="M60 22v80"/></svg>`
                }
            ]
        },
        {
            id: "consolidate",
            label: "Consolidate",
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>`,
            tagline: "Strengthen the pathways",
            description: "Consolidation deepens what you've learned through targeted re-exposure. MindMeld finds your weak spots and surfaces them with intelligent prioritisation — and now, generates tailored study material to patch them.",
            tools:
            [
                {
                    name: "Revise Mode",
                    detail: "Focused sessions that target the cards you're shakiest on, ranked by confidence-weighted performance.",
                    purpose: "Spend your study time where it matters most. Instead of grinding through a full deck, you get a short queue of exactly the cards your performance data says you're most at risk of forgetting.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="60" cy="60" r="38"/><circle cx="60" cy="60" r="26"/><circle cx="60" cy="60" r="14"/><circle cx="60" cy="60" r="4" fill="currentColor"/><path d="M60 14v8M60 98v8M14 60h8M98 60h8" stroke-linecap="round"/></svg>`
                },
                {
                    name: "Curated Study",
                    detail: "AI-curated sessions and on-demand study materials built around your real weak topics, grounded in your own documents.",
                    purpose: "Stop reading generic explanations of topics you already know. MindMeld identifies your true weak topics from your performance and generates a custom study material per topic, grounded in your own textbook and refreshed weekly.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 30l30 12 30 -12 -30 -12z" fill="currentColor" opacity="0.1"/><path d="M20 30v40l30 12 30 -12V30"/><path d="M50 42v40"/><circle cx="92" cy="76" r="14"/><path d="M82 76h20M92 66v20" stroke-linecap="round"/></svg>`
                }
            ]
        },
        {
            id: "validate",
            label: "Validate",
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
            tagline: "Prove what you know",
            description: "Validation surfaces gaps you didn't know you had. MindMeld stress-tests your knowledge under exam-like conditions before you ever sit in the real one.",
            tools:
            [
                {
                    name: "Mock Test",
                    detail: "Timed, exam-condition testing across an entire deck. Performance feeds back into card difficulty so weak ones don't slip through.",
                    purpose: "Reveal the difference between recognition (you've seen this before) and recall (you can produce the answer under pressure). Timed full-deck tests expose blind spots that spaced repetition alone can hide.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="18" y="22" width="60" height="76" rx="4"/><line x1="26" y1="36" x2="68" y2="36"/><line x1="26" y1="48" x2="68" y2="48"/><line x1="26" y1="60" x2="56" y2="60"/><line x1="26" y1="72" x2="60" y2="72"/><circle cx="92" cy="40" r="18"/><path d="M92 30v10l6 4" stroke-linecap="round"/></svg>`
                },
                {
                    name: "Card Browser",
                    detail: "A searchable, filterable view of every card with inline performance data, so you always know exactly what you've learned.",
                    purpose: "Audit your knowledge. Filter by tag, deck, difficulty or mastery to see exactly which cards are doing the work — and which ones need attention before your next exam.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="14" y="20" width="92" height="14" rx="3"/><circle cx="24" cy="27" r="3"/><line x1="34" y1="27" x2="96" y2="27"/><rect x="14" y="40" width="92" height="14" rx="3"/><rect x="14" y="60" width="92" height="14" rx="3"/><rect x="14" y="80" width="92" height="14" rx="3"/><line x1="24" y1="47" x2="84" y2="47"/><line x1="24" y1="67" x2="78" y2="67"/><line x1="24" y1="87" x2="90" y2="87"/></svg>`
                }
            ]
        },
        {
            id: "reflect",
            label: "Reflect",
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
            tagline: "Understand where you stand",
            description: "Reflection closes the loop. MindMeld gives you a single honest number for how well you actually know a deck, plus a clear picture of which topics are strong, weak or unstable.",
            tools:
            [
                {
                    name: "Deck Insights",
                    detail: "Visual mastery curves, retention graphs and per-card performance history rendered over time.",
                    purpose: "Turn raw study data into a story. See how your mastery has climbed week over week, which topics keep regressing, and where the next session should focus — all without crunching numbers yourself.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="14" y1="100" x2="110" y2="100"/><line x1="14" y1="100" x2="14" y2="14"/><rect x="22" y="70" width="14" height="30" fill="currentColor" opacity="0.2"/><rect x="42" y="58" width="14" height="42" fill="currentColor" opacity="0.3"/><rect x="62" y="42" width="14" height="58" fill="currentColor" opacity="0.45"/><rect x="82" y="28" width="14" height="72" fill="currentColor" opacity="0.6"/></svg>`
                },
                {
                    name: "Mastery Report",
                    detail: "A statistically grounded mastery score — confidence matters as much as correctness, so a deck full of guesses can't fake a high number.",
                    purpose: "Answer the only question that really matters before an exam: do I actually know this deck? Streaks and card counts can lie. The mastery score weighs each answer by how sure MindMeld is that you genuinely know the underlying skill.",
                    illustration: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="60" cy="60" r="42" stroke-dasharray="200 264" stroke-linecap="round"/><circle cx="60" cy="60" r="42" stroke-opacity="0.15"/><text x="60" y="68" text-anchor="middle" font-size="22" font-weight="bold" fill="currentColor" stroke="none">87%</text></svg>`
                }
            ]
        }
    ];

    static #featureCategories =
    [
        {
            title: "Generation & Content",
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
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
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 6.253v13"/><path d="M12 6.253a4.5 4.5 0 0 0-4.5-4.5H3v15.5h4.5a4.5 4.5 0 0 1 4.5 4.5"/><path d="M12 6.253a4.5 4.5 0 0 1 4.5-4.5H21v15.5h-4.5a4.5 4.5 0 0 0-4.5 4.5"/></svg>`,
            features:
            [
                {
                    label: "Spaced repetition reviews with smart scheduling",
                    purpose: "Spaced repetition fights the human forgetting curve described by Hermann Ebbinghaus in the 1880s: without active recall, memory of new material decays predictably over time. MindMeld learns the shape of that curve for every card you study and schedules each review just before you'd otherwise forget — so the same time spent studying produces dramatically better retention than re-reading or cramming."
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
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 6-6"/></svg>`,
            features:
            [
                {
                    label: "Deck Insights with mastery curves and retention graphs",
                    purpose: "Watch your mastery climb over weeks, see retention dip and recover, and spot the topics that consistently regress — all in one visual dashboard per deck."
                },
                {
                    label: "Topic analysis — weak, strong and unstable topics surfaced automatically",
                    purpose: "Stop guessing which areas need more work. MindMeld groups your cards into topics and tells you which ones you're strong on, weak on, or where your scores keep swinging unstably."
                },
                {
                    label: "Single-number mastery score per deck",
                    purpose: "Answer 'do I actually know this deck yet?' with one honest number. No streaks, no card counts — a score that weighs every answer by how sure MindMeld is in your skill."
                },
                {
                    label: "Auto Performance Analysis with weekly weak-and-strong topic reports",
                    purpose: "Opt-in weekly summary of your top weak and strong topics per deck, run automatically with no manual trigger. A quick read tells you what to focus on this week."
                },
                {
                    label: "Auto-generated curated study materials for your weakest topics",
                    purpose: "When weak topics are identified, MindMeld can automatically generate a tailored study material per topic — grounded in your own textbook plus fresh web context — to help patch the gap."
                },
                {
                    label: "Activity history across every study session, generation and purchase",
                    purpose: "A scrollable record of everything you've done in MindMeld — sessions, mock tests, generations, purchases — searchable and filterable so you can audit your study habits."
                }
            ]
        },
        {
            title: "Library & Sharing",
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
            features:
            [
                {
                    label: "Paid Decks marketplace — buy ready-made study packs",
                    purpose: "Skip the build step entirely on standardised topics. Browse and purchase decks created by other users or the MindMeld team — fully integrated with the same study modes as your own decks."
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
                    purpose: "Re-generating from an updated version of the same source no longer creates a duplicate deck. MindMeld detects the overlap, preserves your progress, and merges new content into the right places."
                }
            ]
        },
        {
            title: "Platform",
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
            features:
            [
                {
                    label: "Cross-platform — runs natively on desktop (Tauri) and any browser",
                    purpose: "Use MindMeld where it suits you — fast native desktop app or a browser tab on a borrowed machine — without losing data or breaking the experience."
                },
                {
                    label: "Multi-device sync of decks, cards and progress",
                    purpose: "Edit a card on your laptop, study it on your phone tonight, sit a mock test on your tablet tomorrow — every device sees the same up-to-date state."
                },
                {
                    label: "Physical-device-aware device management — one machine counts as one device across browsers",
                    purpose: "Open MindMeld in Chrome and Firefox on the same laptop, and it counts as one device — not two. The 4-device limit applies to actual machines, not browser profiles."
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
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>`,
            title: "Every phase covered",
            body: "Most apps only address one or two phases of the knowledge lifecycle. MindMeld is architected around all five — from first encounter to validated mastery."
        },
        {
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
            title: "Grounded in research",
            body: "MindMeld's scheduling and rating systems are grounded in cognitive-science research — not gamification heuristics, not streak gimmicks."
        },
        {
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
            title: "AI that understands study",
            body: "The AI generation layer is not a generic summariser. It understands flashcard structure, question types, difficulty gradients, and the difference between recognition and recall."
        },
        {
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
            title: "Cross-platform by design",
            body: "MindMeld runs natively on desktop via Tauri and in any browser. Your decks, progress and study sessions are consistent across every surface."
        },
        {
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
            title: "Honest mastery score",
            body: "Unlike apps that measure streaks or card counts, MindMeld weighs every answer by how confident it is in your skill — so a deck full of guesses can never fake a high number."
        },
        {
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>`,
            title: "Multi-provider AI",
            body: "MindMeld supports Gemini and OpenAI interchangeably through a unified provider abstraction — no lock-in, no compromise on generation quality."
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
                        MindMeld is an AI-powered study platform built around one idea: learning is not a single act,
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
        const phases = MindmeldAboutComponent.#lifecyclePhases;

        const stepsHtml = phases.map((phase, phaseIndex) =>
        {
            const isLast = phaseIndex === phases.length - 1;

            return `
                <div class="about-phase-step" data-phase="${phaseIndex}">
                    <div class="about-phase-node">
                        <div class="about-phase-node-icon">${phase.icon}</div>
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
                    five distinct phases — and most study tools only address one or two. MindMeld is designed
                    to serve all five, with a dedicated tool at each stage.
                </p>

                <div class="about-lifecycle-diagram-container">
                    <img
                        class="about-lifecycle-diagram"
                        src="./Globals/Assets/Images/Diagrams/MindMeldKnowledgeConsolidationLifecycle.png"
                        alt="MindMeld Knowledge Consolidation Lifecycle Diagram"
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
        const cardsHtml = MindmeldAboutComponent.#featureCategories.map((category, categoryIndex) =>
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
                        <div class="about-feature-card-icon">${category.icon}</div>
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
                    A grouped look at the capabilities MindMeld ships with today — every one of them tied
                    to a phase of the knowledge lifecycle above. Click any feature for a deeper explanation.
                </p>
                <div class="about-features-grid">${cardsHtml}</div>
            </section>
        `;
    }

    #renderDifferentiators()
    {
        const cardsHtml = MindmeldAboutComponent.#differentiators.map(differentiator =>
            `<div class="about-differentiator-card">
                <div class="about-differentiator-icon">${differentiator.icon}</div>
                <div class="about-differentiator-title">${differentiator.title}</div>
                <div class="about-differentiator-body">${differentiator.body}</div>
            </div>`
        ).join('');

        return `
            <section class="about-differentiators-section">
                <div class="about-section-label">What sets MindMeld apart</div>
                <h2 class="about-section-title">Differentiators</h2>
                <div class="about-differentiators-grid">${cardsHtml}</div>
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
                        Every day you study without MindMeld, you're leaving consolidation phases unserved —
                        relying on hope instead of design. Start the full lifecycle.
                    </p>
                    <button class="about-get-started-button">Get Started</button>
                </div>
            </div>
        `;
    }

    #showToolModal(phaseIndex, toolIndex)
    {
        const phase = MindmeldAboutComponent.#lifecyclePhases[phaseIndex];
        const tool = phase?.tools?.[toolIndex];

        if (!tool)
        {
            return;
        }

        const modalHtml = `
            <div class="about-info-modal">
                <div class="about-info-modal-illustration">${tool.illustration}</div>
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
        const category = MindmeldAboutComponent.#featureCategories[categoryIndex];
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
        const phases = MindmeldAboutComponent.#lifecyclePhases;

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
            const nextPhase = (this.#currentPhase + 1) % MindmeldAboutComponent.#lifecyclePhases.length;
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
                this.dispatchEvent(new CustomEvent('mindmeld-get-started', { bubbles: true }));
            });
        }
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <link rel="stylesheet" href="./MindmeldAboutComponent.css">
            <div class="about-root">
                ${this.#renderHero()}
                ${this.#renderLifecycle()}
                ${this.#renderFeatures()}
                ${this.#renderDifferentiators()}
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

customElements.define('mindmeld-about-component', MindmeldAboutComponent);
export default MindmeldAboutComponent;
