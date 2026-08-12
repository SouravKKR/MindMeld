from typing import List
from Globals.Classes.Task.AutoGeneration.GeneralGenerationSettings import GeneralGenerationSettings
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Enumerations.AutomaticGenerationModes import AutomaticGenerationModes
from Workflows.Workflow import Workflow


class PrepareForGeneration(Workflow):
    """
    Root task of the generation pipeline.

    It generates nothing itself — it exists so a run has a single node to hang
    credits, progress and the staging namespace off. Its one job is to refuse a
    payload the rest of the pipeline cannot survive, before any child task
    spends a model call on it.

    Dock's ValidateGenerationSettings already applies the user-facing rules
    (source caps, page ranges, URL safety, section arithmetic), and those are
    deliberately NOT repeated here — duplicating them would give two sets of
    limits that drift apart, and those messages belong on the request that can
    still show them to the user.

    What is checked here is structural: the settings JSON crosses a service
    boundary through Redis before this runs, so what arrives is a round-tripped
    copy rather than the object Dock validated. These checks catch the shapes
    that would otherwise surface as an AttributeError deep inside a child task,
    or as a run that quietly generates nothing at all — both of which are only
    discovered after the credits are gone.

    Raising is the halt. TaskRunner records the message on the task and marks it
    FAILED, and Dock's TaskManager.execute throws on a FAILED task before it
    dispatches that task's successors.
    """

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__general_generation_settings: GeneralGenerationSettings = GeneralGenerationSettings.from_json(payload)

    async def run(self, args = {}):
        self.__validate_general_generation_settings()

        print("Preparing for generation...")

    def __validate_general_generation_settings(self) -> None:
        """
        Raises ValueError on the first structural problem in the settings this
        task was handed.
        """
        settings = self.__general_generation_settings

        if settings is None:
            raise ValueError("PrepareForGeneration: the task payload did not deserialise into generation settings.")

        generation_mode = settings.get_generation_mode()

        # from_json leaves this None when the key is absent, and every later
        # branch in the pipeline picks its path from it. A None reaches those
        # branches as "matches nothing" rather than as an error, so the run
        # proceeds and silently takes no branch at all.
        if not isinstance(generation_mode, AutomaticGenerationModes):
            raise ValueError(f"PrepareForGeneration: generationMode is missing or not a recognised mode (got {generation_mode!r}).")

        self.__validate_extractable_sources(settings.get_information_sources(), "informationSources")
        self.__validate_extractable_sources(settings.get_image_sources(), "imageSources")

        # Something has to be generated FROM. Dock fills an empty source list
        # with virtual web sources for description-driven runs, so both being
        # empty here means the payload never went through that path — and a run
        # with neither a source nor a description produces an empty deck after
        # paying for every task in the tree.
        information_sources = settings.get_information_sources() or []
        description = (settings.get_description() or "").strip()

        if len(information_sources) == 0 and len(description) == 0:
            raise ValueError("PrepareForGeneration: the run has neither an information source nor a description, so there is nothing to generate from.")

    def __validate_extractable_sources(self, extractable_sources: List[ExtractableInformationSource], field_name: str) -> None:
        """
        Confirms a source list is a list of usable sources.

        The pipeline dereferences these without checking — the common shape is
        `extractable_source.get_information_source().get_source_type()` — so a
        null source, or one carrying no type, does not fail here. It fails
        inside whichever child task touches it first.
        """
        if extractable_sources is None:
            return

        if not isinstance(extractable_sources, list):
            raise ValueError(f"PrepareForGeneration: {field_name} must be a list (got {type(extractable_sources).__name__}).")

        for source_index, extractable_source in enumerate(extractable_sources):
            source_label = f"{field_name} #{source_index + 1}"

            if not isinstance(extractable_source, ExtractableInformationSource):
                raise ValueError(f"PrepareForGeneration: {source_label} did not deserialise into an extractable source.")

            information_source = extractable_source.get_information_source()

            if information_source is None:
                raise ValueError(f"PrepareForGeneration: {source_label} carries no information source.")

            if information_source.get_source_type() is None:
                raise ValueError(f"PrepareForGeneration: {source_label} has no source type.")
