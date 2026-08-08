import asyncio
import json
import re

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Generation.FigureLocator import FigureLocator
from Globals.Classes.Generation.PaidDeckActionLog import PaidDeckActionLog
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.WebFetchReasons import WebFetchReasons
from Globals.Utility.JoinPath import join_path
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Workflows.PaidDeckSourceVerification.AdminSourceCorpus import AdminSourceCorpus
from Workflows.Workflow import Workflow


class PaidDeckSourceVerification(Workflow):
    """
    Checks a paid deck's already-generated content AGAINST documents an
    administrator has cleared and declared a licence for, and raises flags where
    the two disagree.

    THIS IS NOT THE EXISTING VERIFICATION STAGE, AND MUST NOT BECOME IT.
    Phase 6 (PaidDeckVerification) checks generated content against a curated
    constant table and against a model's own knowledge. It runs first and is
    untouched by this. This pass runs afterwards, reads third-party document
    text, and therefore runs on SOURCE_GROUNDED_VERIFICATION_MODEL — an entry
    deliberately outside the PAID_DECK_* boundary. Read the ROUTE BOUNDARY note
    in ModelPool before changing any model reference in this file. The sentence
    it protects is that nothing reaching a PAID_DECK_* entry has ever seen a
    third-party document, and this workflow is the reason that sentence needs
    protecting.

    THE SOURCES NEVER REACH GENERATION. They are read here and nowhere else. The
    content was already written, by models that never saw them, and this pass can
    only RAISE FLAGS — it rewrites nothing. That is what lets the audit trail keep
    saying the deck was independently created while also saying it was
    independently checked.

    Three passes, all advisory in the sense that a human decides:

      - FACTUAL: study material and flashcards against retrieved source passages.
      - VISUAL: each generated diagram, re-rendered, against source passages. The
        in-pipeline vision review already dropped diagrams it could not accept;
        this one raises a flag rather than removing anything, because by now the
        content has shipped into the deck and silently deleting a figure a
        reviewer has seen is worse than telling them about it.
      - COVERAGE: the deck's topic list against what the sources cover. Advisory
        only, and it adds nothing, removes nothing and alters nothing — the same
        rule the existing coverage reconciler states about itself.

    The stage never fails the run. An unreachable verifier records itself as an
    unverified gap, exactly as Phase 6 does, because a check that can destroy
    completed work creates pressure to switch the check off.
    """

    # Items per LLM call. Small, because the model is being asked to compare each
    # item against its own retrieved passages and hold both in view.
    ITEMS_PER_REQUEST = 3

    MAXIMUM_CONCURRENT_REQUESTS = 4

    # Ceilings. Anything beyond them is REPORTED as unchecked rather than quietly
    # skipped — a stated gap is credible, a hidden one is not.
    MAXIMUM_VERIFIED_ITEMS = 400
    MAXIMUM_VERIFIED_VISUALS = 60
    MAXIMUM_TOPICS_IN_COVERAGE_PASS = 250

    # The phase name every action-log entry from this workflow carries.
    PHASE_NAME = "SOURCE_VERIFICATION"

    # Stamped on every flag this workflow raises, so the review dialog, the
    # publish gate and the audit trail can all tell a source-grounded finding
    # from a model's own opinion — which is the difference between "a cleared
    # document disagrees" and "another model thinks otherwise".
    FLAG_SOURCE = "ADMIN_SOURCE"

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__deck_id = (payload.get("deckId") or "").strip()
        self.__main_task_id = (payload.get("mainTaskId") or "").strip()
        self.__pass_id = (payload.get("passId") or "").strip()
        self.__subject_name = (payload.get("subjectName") or "").strip() or "the subject"

    async def __update_progress(self, completion: float):
        current_task = await TaskManager.get_current_task()
        if current_task is None:
            return
        current_task.set_completion(completion)
        await TaskManager.set_task(current_task)

    async def run(self, args = {}):
        if not self.__deck_id or not self.__main_task_id or not self.__pass_id:
            print("[PaidDeckSourceVerification] Missing deckId, mainTaskId or passId in payload — exiting.")
            return

        report_path = self.__build_report_path()

        if await Persistence.exists(report_path):
            print("[PaidDeckSourceVerification] This pass already produced a report — reusing it (resume).")
            await self.__update_progress(1.0)
            return

        database = await DatabaseConnector.get_database()

        if database is None:
            print("[PaidDeckSourceVerification] No database connection — exiting.")
            await self.__write_report(report_path, [self.__build_unchecked_flag("the database was unreachable")], 0, [])
            return

        action_log = PaidDeckActionLog(self.__main_task_id, "PaidDeckSourceVerification")

        verification_sources = await self.__load_verification_sources(database)

        if not verification_sources:
            print("[PaidDeckSourceVerification] No verification sources attached to this deck — nothing to check against.")
            await self.__write_report(report_path, [], 0, [])
            await self.__update_progress(1.0)
            return

        # Recorded as notes rather than as SOURCE_DECLARATION entries. That
        # action type means "this is what entered the pipeline", and the audit
        # trail's source-declaration section says so — putting a verification
        # source there would state that a third-party document was an input to
        # generation, which is the opposite of what happened. The declarations
        # themselves are rendered from their own permanent log.
        for verification_source in verification_sources:
            await action_log.record_note(
                phase_name = PaidDeckSourceVerification.PHASE_NAME,
                outcome = (
                    f"Checked against \"{verification_source.get('name') or '(unnamed)'}\" "
                    f"(licence type {verification_source.get('licenceType')}, "
                    f"declared by {verification_source.get('declaredByUserId') or 'unknown'}). "
                    "Read for verification only; not an input to generation."
                ),
            )

        corpus = AdminSourceCorpus()
        await corpus.load(verification_sources)
        await self.__update_progress(0.10)

        flags = []

        for problem in corpus.get_problems():
            flags.append(self.__build_stage_flag(problem, "Re-attach or replace the source, then run this check again."))

        source_urls = [
            (verification_source.get("sourceUrl") or "").strip()
            for verification_source in verification_sources
            if (verification_source.get("sourceUrl") or "").strip()
        ]

        if corpus.is_empty() and not source_urls:
            print("[PaidDeckSourceVerification] No readable source text — reporting the gap.")
            await self.__write_report(report_path, flags, 0, corpus.get_loaded_source_names())
            await self.__update_progress(1.0)
            return

        items = await self.__load_generated_items(database)
        checked_items = items[: PaidDeckSourceVerification.MAXIMUM_VERIFIED_ITEMS]

        if len(items) > len(checked_items):
            flags.append(self.__build_stage_flag(
                f"{len(items) - len(checked_items)} generated item(s) were not checked against the attached sources — "
                f"this deck exceeds the {PaidDeckSourceVerification.MAXIMUM_VERIFIED_ITEMS}-item ceiling for one pass.",
                "Check the remainder before publishing, or split the deck.",
            ))

        print(f"[PaidDeckSourceVerification] Checking {len(checked_items)} item(s) against {len(verification_sources)} source(s)...")

        flags.extend(await self.__run_factual_pass(checked_items, corpus, source_urls, action_log))
        await self.__update_progress(0.65)

        flags.extend(await self.__run_visual_pass(checked_items, corpus, action_log))
        await self.__update_progress(0.85)

        flags.extend(await self.__run_coverage_pass(checked_items, corpus, source_urls, action_log))
        await self.__update_progress(0.95)

        for flag in flags:
            await action_log.record_verification_flag(
                flag_category = flag["category"],
                subject = " > ".join(flag.get("topicChain") or []) or flag.get("quotedText", "")[:80],
                detail = flag["problem"],
                b_blocking = flag["severity"] == "blocking",
            )

        await self.__write_report(report_path, flags, len(checked_items), corpus.get_loaded_source_names())
        await self.__update_progress(1.0)

        blocking_count = sum(1 for flag in flags if flag["severity"] == "blocking")
        print(f"[PaidDeckSourceVerification] Done. {blocking_count} blocking, {len(flags) - blocking_count} advisory.")

    # ── Report ────────────────────────────────────────────────────────────────

    def __build_report_path(self) -> str:
        return join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self.__main_task_id,
            PersistenceConstants.PAID_DECK_SOURCE_VERIFICATION_DIRECTORY,
            f"{self.__pass_id}.json",
        )

    async def __write_report(self, report_path: str, flags: list, checked_item_count: int, source_names: list) -> None:
        """
        The pass's output, read by Dock and appended to the run's provenance
        record.

        Written even when nothing was found and even when nothing could be
        checked. A missing report is indistinguishable from a pass that never
        ran, and this one has to be able to say "I ran and found nothing" as
        distinctly as it says "I could not run".
        """
        report = {
            "version": 1,
            "passId": self.__pass_id,
            "deckId": self.__deck_id,
            "checkedItemCount": checked_item_count,
            "sourceNames": source_names,
            "blockingFlagCount": sum(1 for flag in flags if flag["severity"] == "blocking"),
            "advisoryFlagCount": sum(1 for flag in flags if flag["severity"] == "advisory"),
            "flags": flags,
        }
        await Persistence.write(report_path, json.dumps(report, ensure_ascii = False))

    # ── Loading ───────────────────────────────────────────────────────────────

    async def __load_verification_sources(self, database) -> list:
        collection = database[DatabaseConstants.PAID_DECK_VERIFICATION_SOURCES_COLLECTION]

        return await asyncio.to_thread(
            lambda: list(collection.find({"deckId": self.__deck_id, "active": True}, {"_id": 0}).sort("attachedAt", 1))
        )

    async def __load_generated_items(self, database) -> list:
        """
        The deck's study materials and flashcards, read from the SYNC
        COLLECTIONS rather than from the generation task bucket.

        Phase 6 reads the bucket because it runs mid-pipeline while the staged
        files still exist. This pass also runs on demand, months later, after the
        staging retention window has swept the bucket away — so Mongo, where the
        content actually lives, is the only source that answers both cases with
        one code path.

        Sync docs wrap the entity under `data`, so every selector and field
        access goes through `data.*`.
        """
        deck_collection = database[DatabaseConstants.DECKS_COLLECTION]

        root_deck = await asyncio.to_thread(deck_collection.find_one, {"data.id": self.__deck_id}, {"_id": 0})

        if root_deck is None:
            print(f"[PaidDeckSourceVerification] Deck {self.__deck_id} not found.")
            return []

        user_id = root_deck.get("userId") or ""
        deck_ids_in_scope = await self.__collect_deck_ids_in_scope(deck_collection, user_id)
        deck_names_by_id = await self.__collect_deck_names(deck_collection, user_id, deck_ids_in_scope)

        items = []

        study_material_documents = await asyncio.to_thread(
            lambda: list(database[DatabaseConstants.STUDY_MATERIALS_COLLECTION]
                .find({"userId": user_id, "data.deckId": {"$in": deck_ids_in_scope}}, {"_id": 0}))
        )

        for study_material_document in study_material_documents:
            study_material = study_material_document.get("data") or {}
            content = study_material.get("content") or ""

            if not isinstance(content, str) or not content.strip():
                # A non-string content field is an encrypted envelope on a
                # buyer's copy. Not ours to read, and not what this pass is for.
                continue

            items.append({
                "kind": "studyMaterial",
                "entityId": study_material.get("id") or "",
                "topicChain": self.__build_topic_chain(deck_names_by_id, study_material.get("deckId") or ""),
                "text": self.__strip_markup(content),
                "html": content,
            })

        card_documents = await asyncio.to_thread(
            lambda: list(database[DatabaseConstants.CARDS_COLLECTION]
                .find({"userId": user_id, "data.deckId": {"$in": deck_ids_in_scope}}, {"_id": 0}))
        )

        for card_document in card_documents:
            card = card_document.get("data") or {}
            question = card.get("question")
            answer = card.get("answer")

            if not isinstance(question, str) or not isinstance(answer, str):
                continue

            combined = f"{question}\n{answer}".strip()

            if not combined:
                continue

            items.append({
                "kind": "flashcard",
                "entityId": card.get("id") or "",
                "topicChain": self.__build_topic_chain(deck_names_by_id, card.get("deckId") or ""),
                "text": self.__strip_markup(combined),
                "html": "",
            })

        return items

    async def __collect_deck_ids_in_scope(self, deck_collection, user_id: str) -> list:
        """
        The deck and everything beneath it.

        Iterative rather than recursive, and bounded by the number of decks the
        user has, so a parent cycle written by a bad sync cannot spin forever.
        """
        all_decks = await asyncio.to_thread(
            lambda: list(deck_collection.find({"userId": user_id}, {"_id": 0, "data.id": 1, "data.parentId": 1}))
        )

        child_ids_by_parent_id = {}

        for deck_document in all_decks:
            deck = deck_document.get("data") or {}
            child_ids_by_parent_id.setdefault(deck.get("parentId") or "", []).append(deck.get("id") or "")

        deck_ids_in_scope = []
        pending_deck_ids = [self.__deck_id]
        seen_deck_ids = set()

        while pending_deck_ids:
            deck_id = pending_deck_ids.pop()

            if not deck_id or deck_id in seen_deck_ids:
                continue

            seen_deck_ids.add(deck_id)
            deck_ids_in_scope.append(deck_id)
            pending_deck_ids.extend(child_ids_by_parent_id.get(deck_id, []))

        return deck_ids_in_scope

    async def __collect_deck_names(self, deck_collection, user_id: str, deck_ids_in_scope: list) -> dict:
        deck_documents = await asyncio.to_thread(
            lambda: list(deck_collection.find(
                {"userId": user_id, "data.id": {"$in": deck_ids_in_scope}},
                {"_id": 0, "data.id": 1, "data.name": 1, "data.parentId": 1},
            ))
        )

        return {
            (deck_document.get("data") or {}).get("id") or "": deck_document.get("data") or {}
            for deck_document in deck_documents
        }

    def __build_topic_chain(self, deck_names_by_id: dict, deck_id: str) -> list:
        chain = []
        current_deck_id = deck_id
        visited_deck_ids = set()

        while current_deck_id and current_deck_id in deck_names_by_id and current_deck_id not in visited_deck_ids:
            visited_deck_ids.add(current_deck_id)
            deck = deck_names_by_id[current_deck_id]
            name = deck.get("name") or ""

            if name:
                chain.insert(0, name)

            current_deck_id = deck.get("parentId") or ""

        return chain

    def __strip_markup(self, html_content: str) -> str:
        """
        The readable text of a passage, with figure markup removed.

        Figures are checked separately, as rendered images. Leaving their SVG
        source in the text would spend most of the item's prompt budget on path
        coordinates the model cannot use.
        """
        without_figures = re.sub(r"<figure\b.*?</figure>", " ", html_content or "", flags = re.IGNORECASE | re.DOTALL)
        without_tags = re.sub(r"<[^>]+>", " ", without_figures)
        return " ".join(without_tags.split())

    # ── Factual pass ──────────────────────────────────────────────────────────

    async def __run_factual_pass(self, items: list, corpus, source_urls: list, action_log) -> list:
        batches = []
        current_batch = []

        for item in items:
            passages = corpus.select_passages(item["text"], item["topicChain"])

            if not passages and not source_urls:
                # No passage in any attached source has anything to do with this
                # item. Sending it anyway would ask the model to compare
                # unrelated text, and the honest answer to "does the source
                # contradict this" is that the source does not discuss it.
                continue

            current_batch.append({"item": item, "passages": passages})

            if len(current_batch) >= PaidDeckSourceVerification.ITEMS_PER_REQUEST:
                batches.append(current_batch)
                current_batch = []

        if current_batch:
            batches.append(current_batch)

        if not batches:
            await action_log.record_note(
                phase_name = PaidDeckSourceVerification.PHASE_NAME,
                outcome = "No generated item overlapped the attached sources, so the factual check had nothing to compare.",
            )
            return []

        semaphore = asyncio.Semaphore(PaidDeckSourceVerification.MAXIMUM_CONCURRENT_REQUESTS)

        async def verify_batch(batch):
            async with semaphore:
                return await self.__verify_factual_batch(batch, source_urls, action_log)

        batch_results = await asyncio.gather(*[verify_batch(batch) for batch in batches])

        flags = []
        for batch_flags in batch_results:
            flags.extend(batch_flags)
        return flags

    async def __verify_factual_batch(self, batch: list, source_urls: list, action_log) -> list:
        content_block = "\n\n".join(
            f"[item {batch_index}] {entry['item']['kind']} ({' > '.join(entry['item']['topicChain'])})\n{entry['item']['text']}"
            for batch_index, entry in enumerate(batch)
        )

        reference_block = self.__build_reference_block(
            [passage for entry in batch for passage in entry["passages"]]
        )

        user_prompt = (
            PromptPool.PAID_DECK_SOURCE_VERIFICATION_USER
                .replace("{subject_name}", self.__subject_name)
                .replace("{topic_chain}", " > ".join(batch[0]["item"]["topicChain"]) if batch else "(not recorded)")
                .replace("{reference_block}", reference_block)
                .replace("{content_block}", content_block)
        )

        response, model_string = await self.__call_verifier(
            PromptPool.PAID_DECK_SOURCE_VERIFICATION_SYSTEM,
            user_prompt,
            source_urls,
            None,
        )

        if response is None:
            await self.__record_call(action_log, model_string, None, "PAID_DECK_SOURCE_VERIFICATION_SYSTEM",
                                     "Batch could not be checked.", False)
            return [self.__build_unchecked_flag(f"{len(batch)} item(s) could not be checked against the attached sources")]

        parsed = strip_json_markdown(response.get_output(0).get_data())

        if not isinstance(parsed, dict) or not isinstance(parsed.get("flags"), list):
            await self.__record_call(action_log, model_string, response, "PAID_DECK_SOURCE_VERIFICATION_SYSTEM",
                                     "Unusable response shape.", False)
            return [self.__build_unchecked_flag(f"{len(batch)} item(s) could not be checked (unusable response)")]

        await self.__record_consulted_urls(parsed, action_log)

        flags = []

        for raw_flag in parsed["flags"]:
            flag = self.__normalise_flag(raw_flag, batch)

            if flag is not None:
                flags.append(flag)

        await self.__record_call(action_log, model_string, response, "PAID_DECK_SOURCE_VERIFICATION_SYSTEM",
                                 f"{len(flags)} flag(s) across {len(batch)} item(s).", True)

        return flags

    def __normalise_flag(self, raw_flag, batch: list):
        """
        Turns one model-reported flag into the stored shape, or drops it.

        A flag with no problem, or with no passage quoted from the source, is
        DROPPED rather than stored with a blank field. The whole claim of this
        pass is "a cleared document disagrees, and here is where it says so" — a
        flag that cannot point at the document is the model's own opinion
        wearing the source's authority, which is precisely what the separate
        FLAG_SOURCE value exists to keep apart.
        """
        if not isinstance(raw_flag, dict):
            return None

        problem = str(raw_flag.get("problem") or "").strip()
        cited_passage = str(raw_flag.get("citedPassage") or "").strip()

        if not problem or not cited_passage:
            return None

        item_index = raw_flag.get("itemIndex")
        entry = batch[item_index] if isinstance(item_index, int) and 0 <= item_index < len(batch) else batch[0]

        severity = str(raw_flag.get("severity") or "advisory").strip().lower()

        return {
            "category": str(raw_flag.get("category") or "CONTRADICTION").strip().upper(),
            "severity": "blocking" if severity == "blocking" else "advisory",
            "source": PaidDeckSourceVerification.FLAG_SOURCE,
            "topicChain": entry["item"]["topicChain"],
            "entityId": entry["item"]["entityId"],
            "quotedText": str(raw_flag.get("quotedText") or "").strip()[:400],
            "citedPassage": cited_passage[:1000],
            "sourceName": str(raw_flag.get("sourceName") or "").strip()[:256],
            "problem": problem,
            "correctStatement": str(raw_flag.get("correctStatement") or "").strip(),
        }

    # ── Visual pass ───────────────────────────────────────────────────────────

    async def __run_visual_pass(self, items: list, corpus, action_log) -> list:
        """
        Each generated diagram, re-rendered and checked against source passages.

        The in-pipeline vision review already ran and already dropped whatever it
        could not accept. This one exists because that review had nothing to
        compare against except the specification the diagram was generated from,
        so it could confirm a diagram matched its brief but not that the brief
        was right.
        """
        figures = []

        for item in items:
            if not item["html"]:
                continue

            for figure in FigureLocator.list_figures(item["html"]):
                svg_markup = self.__extract_svg_markup(figure["markup"])

                if svg_markup is None:
                    # Not an SVG diagram — a raster image or an embedded
                    # renderer. Nothing to re-render, so nothing to check here.
                    continue

                figures.append({"item": item, "figure": figure, "svgMarkup": svg_markup})

        if not figures:
            return []

        checked_figures = figures[: PaidDeckSourceVerification.MAXIMUM_VERIFIED_VISUALS]
        flags = []

        if len(figures) > len(checked_figures):
            flags.append(self.__build_stage_flag(
                f"{len(figures) - len(checked_figures)} diagram(s) were not checked against the attached sources — "
                f"this deck exceeds the {PaidDeckSourceVerification.MAXIMUM_VERIFIED_VISUALS}-diagram ceiling for one pass.",
                "Check the remainder before publishing.",
            ))

        semaphore = asyncio.Semaphore(PaidDeckSourceVerification.MAXIMUM_CONCURRENT_REQUESTS)

        async def verify_figure(entry):
            async with semaphore:
                return await self.__verify_one_visual(entry, corpus, action_log)

        figure_results = await asyncio.gather(*[verify_figure(entry) for entry in checked_figures])

        for figure_flags in figure_results:
            flags.extend(figure_flags)

        return flags

    async def __verify_one_visual(self, entry: dict, corpus, action_log) -> list:
        caption_text = entry["figure"].get("captionText") or ""
        passages = corpus.select_passages(caption_text, entry["item"]["topicChain"])

        if not passages:
            return []

        image_bytes = self.__rasterize(entry["svgMarkup"])

        if image_bytes is None:
            # A diagram that will not render is not a diagram the source
            # disagrees with — it is a rendering problem, and reporting it as a
            # factual flag would send a reviewer looking for an error that is
            # not there.
            await action_log.record_note(
                phase_name = PaidDeckSourceVerification.PHASE_NAME,
                outcome = f"A diagram in \"{caption_text[:80]}\" could not be re-rendered, so it was not checked.",
                b_succeeded = False,
            )
            return []

        user_prompt = (
            PromptPool.PAID_DECK_SOURCE_VISUAL_USER
                .replace("{subject_name}", self.__subject_name)
                .replace("{topic_chain}", " > ".join(entry["item"]["topicChain"]))
                .replace("{visual_description}", caption_text or "(no caption recorded)")
                .replace("{reference_block}", self.__build_reference_block(passages))
        )

        response, model_string = await self.__call_verifier(
            PromptPool.PAID_DECK_SOURCE_VISUAL_SYSTEM,
            user_prompt,
            [],
            image_bytes,
        )

        if response is None:
            await self.__record_call(action_log, model_string, None, "PAID_DECK_SOURCE_VISUAL_SYSTEM",
                                     "A diagram could not be checked.", False)
            return [self.__build_unchecked_flag("a diagram could not be checked against the attached sources")]

        parsed = strip_json_markdown(response.get_output(0).get_data())

        if not isinstance(parsed, dict) or not isinstance(parsed.get("flags"), list):
            await self.__record_call(action_log, model_string, response, "PAID_DECK_SOURCE_VISUAL_SYSTEM",
                                     "Unusable response shape.", False)
            return [self.__build_unchecked_flag("a diagram could not be checked (unusable response)")]

        flags = []

        for raw_flag in parsed["flags"]:
            if not isinstance(raw_flag, dict):
                continue

            problem = str(raw_flag.get("problem") or "").strip()
            cited_passage = str(raw_flag.get("citedPassage") or "").strip()

            if not problem or not cited_passage:
                continue

            severity = str(raw_flag.get("severity") or "advisory").strip().lower()

            flags.append({
                "category": "DIAGRAM",
                "severity": "blocking" if severity == "blocking" else "advisory",
                "source": PaidDeckSourceVerification.FLAG_SOURCE,
                "topicChain": entry["item"]["topicChain"],
                "entityId": entry["item"]["entityId"],
                "quotedText": str(raw_flag.get("quotedText") or "").strip()[:400],
                "citedPassage": cited_passage[:1000],
                "sourceName": str(raw_flag.get("sourceName") or "").strip()[:256],
                "problem": problem,
                "correctStatement": str(raw_flag.get("correctStatement") or "").strip(),
            })

        await self.__record_call(action_log, model_string, response, "PAID_DECK_SOURCE_VISUAL_SYSTEM",
                                 f"{len(flags)} flag(s) on one diagram.", True)

        return flags

    def __extract_svg_markup(self, figure_markup: str):
        match = re.search(r"<svg\b.*?</svg>", figure_markup or "", flags = re.IGNORECASE | re.DOTALL)
        return match.group(0) if match is not None else None

    def __rasterize(self, svg_markup: str):
        try:
            # Imported lazily for the same reason the PDF reader is: the
            # rasteriser pulls in a native rendering stack, and a deck with no
            # SVG diagrams should not pay for it.
            from Globals.Classes.Pdf.SvgRasterizer import SvgRasterizer
            return SvgRasterizer(110).rasterize_to_png_bytes(svg_markup)
        except Exception as rasterize_error:
            print(f"[PaidDeckSourceVerification] Could not rasterise a diagram: {rasterize_error}")
            return None

    # ── Coverage pass ─────────────────────────────────────────────────────────

    async def __run_coverage_pass(self, items: list, corpus, source_urls: list, action_log) -> list:
        topic_chains = []

        for item in items:
            chain_text = " > ".join(item["topicChain"])

            if chain_text and chain_text not in topic_chains:
                topic_chains.append(chain_text)

        if not topic_chains:
            return []

        checked_chains = topic_chains[: PaidDeckSourceVerification.MAXIMUM_TOPICS_IN_COVERAGE_PASS]

        # Sampled across the corpus rather than retrieved against one item: the
        # question here is what the SOURCE covers, so a retrieval keyed on the
        # deck's own topics would only ever return passages about topics the deck
        # already has — and could not, by construction, find a gap.
        passages = corpus.select_passages(" ".join(checked_chains), [])

        if not passages and not source_urls:
            return []

        user_prompt = (
            PromptPool.PAID_DECK_SOURCE_COVERAGE_USER
                .replace("{subject_name}", self.__subject_name)
                .replace("{reference_block}", self.__build_reference_block(passages))
                .replace("{topic_block}", "\n".join(checked_chains))
        )

        response, model_string = await self.__call_verifier(
            PromptPool.PAID_DECK_SOURCE_COVERAGE_SYSTEM,
            user_prompt,
            source_urls,
            None,
        )

        if response is None:
            await self.__record_call(action_log, model_string, None, "PAID_DECK_SOURCE_COVERAGE_SYSTEM",
                                     "Coverage comparison could not be completed.", False)
            return [self.__build_unchecked_flag("the deck's coverage could not be compared against the attached sources")]

        parsed = strip_json_markdown(response.get_output(0).get_data())

        if not isinstance(parsed, dict) or not isinstance(parsed.get("gaps"), list):
            await self.__record_call(action_log, model_string, response, "PAID_DECK_SOURCE_COVERAGE_SYSTEM",
                                     "Unusable response shape.", False)
            return [self.__build_unchecked_flag("the deck's coverage could not be compared (unusable response)")]

        await self.__record_consulted_urls(parsed, action_log)

        flags = []

        for raw_gap in parsed["gaps"]:
            if not isinstance(raw_gap, dict):
                continue

            topic = str(raw_gap.get("topic") or "").strip()
            cited_passage = str(raw_gap.get("citedPassage") or "").strip()

            if not topic or not cited_passage:
                continue

            flags.append({
                "category": "COVERAGE",
                # Always advisory. A source covering something the deck does not
                # is a judgement about scope, and scope is the seller's to set —
                # blocking publication over it would let an attached textbook
                # silently redefine what the deck is for.
                "severity": "advisory",
                "source": PaidDeckSourceVerification.FLAG_SOURCE,
                "topicChain": [],
                "entityId": "",
                "quotedText": topic[:400],
                "citedPassage": cited_passage[:1000],
                "sourceName": str(raw_gap.get("sourceName") or "").strip()[:256],
                "problem": str(raw_gap.get("problem") or f"The attached source covers \"{topic}\"; this deck does not.").strip(),
                "correctStatement": "",
            })

        await self.__record_call(action_log, model_string, response, "PAID_DECK_SOURCE_COVERAGE_SYSTEM",
                                 f"{len(flags)} coverage gap(s) against the attached sources.", True)

        return flags

    # ── Shared ────────────────────────────────────────────────────────────────

    def __build_reference_block(self, passages: list) -> str:
        if not passages:
            return "(No passage from the attached sources was retrieved for this item.)"

        seen_texts = set()
        blocks = []

        for passage in passages:
            if passage["text"] in seen_texts:
                continue

            seen_texts.add(passage["text"])
            blocks.append(f"[from \"{passage['sourceName']}\"]\n{passage['text']}")

        return "\n\n".join(blocks)

    async def __call_verifier(self, system_prompt: str, user_prompt: str, source_urls: list, image_bytes):
        """
        One call to the outside-boundary verification model.

        The model reference is read from SOURCE_GROUNDED_VERIFICATION_MODEL and
        nowhere else in this file, so there is exactly one line to check when
        auditing that no admin-supplied document reaches a PAID_DECK_* entry.
        """
        model_string, provider_class = ModelPool.SOURCE_GROUNDED_VERIFICATION_MODEL
        caller = AutomationCaller(provider_class())

        request_metadata = {}

        if source_urls:
            # A URL-only source contributes no bytes of ours, so it reaches the
            # model as provider grounding instead. Every URL the provider reports
            # having retrieved is logged with its reason, the same rule the two
            # existing search-enabled call sites follow.
            request_metadata["enable_search"] = True
            request_metadata["search_results"] = source_urls[:16]

        contents = [AutomationContent(AutomationContentTypes.SYSTEM, system_prompt)]

        if image_bytes is not None:
            contents.append(AutomationContent(AutomationContentTypes.IMAGE, image_bytes))

        contents.append(AutomationContent(AutomationContentTypes.TEXT, user_prompt, request_metadata))

        try:
            response = await caller.call(AutomationRequest(model_string, contents), validator = None)
        except Exception as call_error:
            print(f"[PaidDeckSourceVerification] Verifier call failed: {call_error}")
            return None, model_string

        return response, model_string

    async def __record_consulted_urls(self, parsed: dict, action_log) -> None:
        for url in (parsed.get("consultedUrls") or []):
            if isinstance(url, str) and url.strip():
                await action_log.record_web_fetch(
                    phase_name = PaidDeckSourceVerification.PHASE_NAME,
                    url = url.strip(),
                    reason_name = WebFetchReasons.ADMIN_SOURCE_VERIFICATION.name,
                    outcome = "Consulted as a verification source an administrator declared for this deck.",
                )

    async def __record_call(self, action_log, model_string, response, prompt_identifier, outcome, b_succeeded) -> None:
        await action_log.record_llm_call(
            phase_name = PaidDeckSourceVerification.PHASE_NAME,
            model_identifier = model_string,
            prompt_identifier = prompt_identifier,
            reasoning_effort = None,
            usage_metadata = response.get_usage_metadata() if response is not None else None,
            outcome = outcome,
            b_succeeded = b_succeeded,
        )

    def __build_unchecked_flag(self, reason: str) -> dict:
        return self.__build_stage_flag(
            f"Not checked against the attached sources: {reason}.",
            "Run the source check again before publishing.",
        )

    def __build_stage_flag(self, problem: str, correct_statement: str) -> dict:
        """
        A flag about the PASS rather than about the content.

        Source "STAGE", not ADMIN_SOURCE — nothing in a cleared document is being
        reported here, and labelling a stage failure as a source disagreement
        would put words in the document's mouth. Advisory, because a pass that
        could not run is a reason to look again, not evidence that anything is
        wrong.
        """
        return {
            "category": "COVERAGE",
            "severity": "advisory",
            "source": "STAGE",
            "topicChain": [],
            "entityId": "",
            "quotedText": "",
            "citedPassage": "",
            "sourceName": "",
            "problem": problem,
            "correctStatement": correct_statement,
        }
