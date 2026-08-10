/**
 * GenerationSettingsInfoTopics
 *
 * The explanation text behind every info button on the generation page.
 *
 * It lives apart from SettingsInfoButton because it is content, not behaviour:
 * the button is a dozen lines of DOM plumbing that never changes, while this
 * grows every time a setting is added. Keeping them separate means a wording
 * fix never touches the component.
 *
 * Each topic answers the same three questions in the same order — what the
 * setting does, what happens if it is left alone, and a worked example — because
 * the previous help was a native `title=` tooltip, which says one short sentence
 * and is invisible on every touch device.
 */
class GenerationSettingsInfoTopics
{
    static TOPICS =
    {
        sectionStructure:
        {
            title: "Section structure",
            bodyHtml:
            `
                <p>Sections are the parts a paper is divided into — "Section A", "Unit III", "Numerical Answer Type". Each one decides three things: which kinds of question it holds, how many of them there are, and how they are marked.</p>
                <p><strong>If you add none</strong>, the paper is still generated: questions are grouped automatically by their type, and the whole paper uses the default marking rule.</p>
                <p><strong>Example.</strong> A physics paper with "Section A — 20 multiple choice, 4 marks each" and "Section B — 5 numerical, 4 marks each" is two sections. The questions that appear in each are drawn only from the types you ticked for it.</p>
                <p>Templates for known exams fill this in for you. You can change anything they set.</p>
            `
        },

        sectionQuestionTypes:
        {
            title: "Question types in a section",
            bodyHtml:
            `
                <p>Ticks the kinds of question this section is allowed to contain. Questions of other types go to other sections.</p>
                <p><strong>If you tick nothing</strong>, the section accepts any type. That is the right choice for a paper that is not divided by question format.</p>
                <p><strong>Example.</strong> A JEE-style paper's Section B ticks only <em>Objective Single Word Or Phrase</em>, so no multiple-choice question can land there.</p>
                <p>Sections are checked in order, and each one takes the questions it can before the next is filled — so put your most specific section first.</p>
            `
        },

        sectionQuestionCount:
        {
            title: "How many questions a section holds",
            bodyHtml:
            `
                <p><strong>Fixed</strong> — the section always has exactly this many questions.</p>
                <p><strong>Range</strong> — the section has somewhere between the smallest and largest number you set, chosen when the paper is built. Use it when you want papers that vary between attempts.</p>
                <p>When the marks mode is set to <em>a range per question</em>, you do not set the count at all: it is worked out from the marks budget, and shown here so you can see what it came to.</p>
                <p><strong>Example.</strong> Fixed 20 gives 20 questions every time. A range of 2–6 gives a different number in each generated paper.</p>
            `
        },

        sectionMarksMode:
        {
            title: "How a section's marks work",
            bodyHtml:
            `
                <p>A section describes three numbers — how many questions it has, what each is worth, and what the section totals. You only ever enter two of them; the third follows.</p>
                <p><strong>Same marks for every question.</strong> You set the question count and the marks per question. The section total is worked out for you.<br>
                <em>20 questions x 4 marks = 80 marks.</em></p>
                <p><strong>A range of marks per question.</strong> You set the smallest and largest a single question may be worth, plus the total the section must add up to. How many questions that takes is worked out for you.<br>
                <em>Questions worth 4–10 marks, totalling 20 marks, means the section will hold between 2 and 5 questions.</em></p>
                <p>The second mode is for papers where question length varies — a long derivation is worth more than a short definition, and only the section total is fixed.</p>
                <p>If a total cannot be reached with the range you gave, you will be told before generation starts rather than finding out from the finished paper.</p>
            `
        },

        sectionTotalMarks:
        {
            title: "Section total marks",
            bodyHtml:
            `
                <p>What the whole section is worth.</p>
                <p>When every question in the section carries the same marks, this is <strong>calculated</strong> from the count and the marks per question, so it is shown rather than typed.</p>
                <p>When questions carry a range of marks, this is the <strong>budget you set</strong> — the generated questions are chosen so their marks add up to it.</p>
                <p><strong>Example.</strong> A 20-mark unit made of 4–10 mark questions might come out as 10 + 6 + 4, or as 10 + 10.</p>
            `
        },

        sectionScoringOverride:
        {
            title: "Scoring override for a section",
            bodyHtml:
            `
                <p>Changes how answers in this section are scored, replacing the paper's default rule.</p>
                <p><strong>Leave a box empty</strong> and that part of the rule is inherited from the per-question-type override if there is one, and from the paper default otherwise. You never have to fill in all four.</p>
                <p><strong>Correct</strong> is the maximum a question can earn. <strong>Wrong</strong> is what a wrong answer scores — enter a negative number for a penalty. <strong>Unattempted</strong> is usually 0. <strong>Partial</strong> applies to multiple-correct questions where some but not all options were selected.</p>
                <p><strong>Example.</strong> A section with no negative marking sets Wrong to 0 while the rest of the paper keeps -1.</p>
            `
        },

        paperQuestionCount:
        {
            title: "Questions per test",
            bodyHtml:
            `
                <p>How many questions each generated paper contains.</p>
                <p><strong>On Automatic</strong>, this is decided for you — from the exam name if you gave one, and from your sections if you added any.</p>
                <p><strong>On Manual</strong>, you set it, and it must agree with your sections: if the sections hold 30 questions, the paper cannot be set to 40. You will be told before generation starts if the two disagree.</p>
                <p>More questions cost more to generate and take longer.</p>
            `
        },

        questionTypeWeightage:
        {
            title: "Question type weightage",
            bodyHtml:
            `
                <p>Sets the mix of question formats across the whole paper. A type with weight 2 appears about twice as often as one with weight 1; unticked types do not appear at all.</p>
                <p><strong>On Automatic</strong>, the mix is chosen from the exam you named, or from the material itself.</p>
                <p><strong>When you have added sections</strong>, this block is hidden — sections already say which types they hold, and having both would mean two answers to the same question.</p>
            `
        },

        difficultyWeightage:
        {
            title: "Difficulty weightage",
            bodyHtml:
            `
                <p>Sets how hard the paper is, as a mix rather than a single level. A difficulty with weight 3 appears about three times as often as one with weight 1; unticked levels do not appear.</p>
                <p><strong>On Automatic</strong>, the spread is chosen from the exam you named, or from the material itself.</p>
                <p><strong>Example.</strong> Weights of Easy 1, Medium 3, Hard 2 give a paper that is mostly medium with a solid hard tail — closer to a real board paper than an even spread.</p>
                <p>This is independent of sections: a section can hold questions of any difficulty.</p>
            `
        },

        numberOfTests:
        {
            title: "Number of tests",
            bodyHtml:
            `
                <p>How many separate papers to generate from the same material in one run.</p>
                <p>Each paper is built from a shared pool of questions, so later papers reuse some questions from earlier ones rather than every paper being wholly new — that keeps generation affordable while still giving you distinct attempts.</p>
                <p>Every paper costs credits, so this multiplies what the run costs.</p>
            `
        },

        testDuration:
        {
            title: "Duration",
            bodyHtml:
            `
                <p>How long the test runs, in minutes, when you take it.</p>
                <p><strong>Leave it at 0</strong> and a duration is worked out for you from the exam and the question count. Until you type here it tracks the questions-per-test setting, which is a reasonable rule of thumb for objective papers.</p>
                <p>You can change the duration on an individual test later without regenerating it.</p>
            `
        },

        informationSourcesForMockTests:
        {
            title: "Using a past paper",
            bodyHtml:
            `
                <p>Past papers are added like any other material — under <strong>Information Sources</strong>, with the type set to <em>Question Paper / Mock Test</em>.</p>
                <p>A source marked that way is treated differently from ordinary study material: its questions are read out and used as patterns for the ones that get generated, so the result matches the real paper's style, phrasing and spread.</p>
                <p>It also switches off the web search that would otherwise look for past papers — the paper you supplied is better than anything that search would find.</p>
                <p>Questions are always rewritten, never copied.</p>
            `
        },

        showSolvingSteps:
        {
            title: "Show solving steps",
            bodyHtml:
            `
                <p>Generates a worked solution alongside each question's answer, so you can see how the answer is reached rather than only what it is.</p>
                <p>Steps are shown after you finish a test, not while you are taking it.</p>
                <p>Turning this off makes generation slightly cheaper and faster.</p>
            `
        },

        recursiveGeneration:
        {
            title: "Generate for sub-decks",
            bodyHtml:
            `
                <p>Generates a separate set of tests for every deck beneath this one, not just this deck.</p>
                <p>Each question is filed against the sub-deck its topic belongs to, and also appears in the parent decks above it — so a chapter's test covers that chapter, and the subject's test covers all of them.</p>
                <p><strong>Skip this deck</strong> then leaves the top deck itself without its own test, which is what you want when the top deck is only a container.</p>
                <p>This multiplies the number of tests generated, and therefore the cost.</p>
            `
        }
    };

    static resolveTopic(topicKey)
    {
        return GenerationSettingsInfoTopics.TOPICS[topicKey] || null;
    }
}

export default GenerationSettingsInfoTopics;
