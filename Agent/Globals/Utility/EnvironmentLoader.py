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
        2. the COGNIUMLEARN_ENVIRONMENT variable (set by the base node's systemd unit,
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

        if os.getenv("COGNIUMLEARN_ENVIRONMENT"):
            return os.getenv("COGNIUMLEARN_ENVIRONMENT")

        if "--debug" in sys.argv:
            return "local"

        return EnvironmentLoader.PRODUCTION_ENVIRONMENT_NAME

    @staticmethod
    def resolve_secrets_directory(agent_root_directory):
        # When COGNIUMLEARN_SECRETS_DIRECTORY is set — the base node points it at a RAM-backed
        # tmpfs mount so no plaintext secret ever lands on persistent disk (keeping snapshots
        # and backups clean) — the rendered Agent env file lives at
        # <COGNIUMLEARN_SECRETS_DIRECTORY>/Agent. Otherwise it sits at the Agent root, as it always
        # has for local development.
        secrets_directory = os.getenv("COGNIUMLEARN_SECRETS_DIRECTORY")
        if secrets_directory:
            return os.path.join(secrets_directory, "Agent")
        return agent_root_directory

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

        secrets_directory = EnvironmentLoader.resolve_secrets_directory(agent_root_directory)
        selected_file_path = os.path.join(secrets_directory, candidate_file_names[0])
        for candidate_file_name in candidate_file_names:
            candidate_file_path = os.path.join(secrets_directory, candidate_file_name)
            if os.path.exists(candidate_file_path):
                selected_file_path = candidate_file_path
                break

        load_dotenv(selected_file_path)
