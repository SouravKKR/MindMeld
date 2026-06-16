import os
import sys

from dotenv import load_dotenv


class EnvironmentLoader:
    """
    Loads the Agent service's environment file, choosing between the local and
    production configurations the same way the rest of the service distinguishes
    run modes — by the presence of `--debug` in the command-line arguments.

    With `--debug` the local `.env` (development database) is loaded; without it
    `.production.env` (the live database) is loaded instead. This mirrors the
    identical switch in Dock/index.js so a debug launch can never accidentally
    talk to the production database, and a production launch can never talk to
    the development one.

    The chosen file is anchored to the Agent root directory rather than the
    current working directory, so the loader behaves identically no matter where
    the process is launched from.
    """

    DEBUG_ENVIRONMENT_FILE_NAME = ".env"
    PRODUCTION_ENVIRONMENT_FILE_NAME = ".production.env"

    @staticmethod
    def load():
        agent_root_directory = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..")
        )

        is_debug = "--debug" in sys.argv
        environment_file_name = (
            EnvironmentLoader.DEBUG_ENVIRONMENT_FILE_NAME
            if is_debug
            else EnvironmentLoader.PRODUCTION_ENVIRONMENT_FILE_NAME
        )

        load_dotenv(os.path.join(agent_root_directory, environment_file_name))
