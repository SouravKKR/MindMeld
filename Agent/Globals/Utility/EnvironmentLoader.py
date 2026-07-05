import os
import sys

from dotenv import load_dotenv


class EnvironmentLoader:
    """
    Loads the Agent service's environment file, choosing the environment the same
    way Dock does (Dock/index.js) so the two services can never load one against the
    development database and the other against production.

    The environment name is resolved in priority order:
        1. an explicit --environment=<name> command-line flag
        2. the MINDMELD_ENVIRONMENT variable (set by the base node's systemd unit,
           and inherited by every Agent subprocess Dock spawns)
        3. legacy --debug  -> local
        4. otherwise       -> production

    Each name maps to Agent/.<name>.env; "local" also falls back to the historical
    Agent/.env so existing local setups keep working. The chosen file is anchored to
    the Agent root directory, so the loader behaves identically no matter where the
    process is launched from.
    """

    LEGACY_LOCAL_ENVIRONMENT_FILE_NAME = ".env"
    PRODUCTION_ENVIRONMENT_NAME = "production"

    @staticmethod
    def resolve_environment_name():
        for argument in sys.argv:
            if argument.startswith("--environment="):
                return argument.split("=", 1)[1]

        if os.getenv("MINDMELD_ENVIRONMENT"):
            return os.getenv("MINDMELD_ENVIRONMENT")

        if "--debug" in sys.argv:
            return "local"

        return EnvironmentLoader.PRODUCTION_ENVIRONMENT_NAME

    @staticmethod
    def load():
        agent_root_directory = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..")
        )

        environment_name = EnvironmentLoader.resolve_environment_name()

        if environment_name == "local":
            candidate_file_names = [".local.env", EnvironmentLoader.LEGACY_LOCAL_ENVIRONMENT_FILE_NAME]
        else:
            candidate_file_names = [f".{environment_name}.env"]

        selected_file_path = os.path.join(agent_root_directory, candidate_file_names[0])
        for candidate_file_name in candidate_file_names:
            candidate_file_path = os.path.join(agent_root_directory, candidate_file_name)
            if os.path.exists(candidate_file_path):
                selected_file_path = candidate_file_path
                break

        load_dotenv(selected_file_path)
