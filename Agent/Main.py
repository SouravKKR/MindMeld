import asyncio
import sys

from Globals.Utility.AgentLogger import initialize as initialize_agent_logger
from Globals.Utility.EnvironmentLoader import EnvironmentLoader

# Must run before any other module prints — installs the no-op `print` in production
# and the flushing `print` in debug mode.
initialize_agent_logger()

# PDF reading goes through Globals/Classes/Pdf/PdfDocumentReader, which each
# PDF-touching workflow imports function-locally. That keeps the PDFium
# native-binding load off agent subprocess launches for tasks that never
# touch a PDF (analysis, embedding-only, curated-study, etc.).


from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.Task.TaskRunner import TaskRunner

from Globals.Utility.ArgumentParser import argument_parser
from Globals.Utility.NetworkAddressPreference import NetworkAddressPreference
from Globals.Utility.SetupEnvironment import setup_environment

EnvironmentLoader.load()

# Must run before the first outbound connection — on networks whose IPv6 egress is
# broken, an unpreferred resolver order costs ~20s per AAAA record on every storage
# and API call. See NetworkAddressPreference for the full reasoning.
NetworkAddressPreference.prefer_ipv4_addresses()


async def main():
    command_line_args: dict = argument_parser(sys.argv)
    setup_environment(command_line_args)
    await TaskManager.initialize()

    # One-shot path: the descriptor is the ambient task identified by TASK_ID.
    # All execution logic lives in TaskRunner, shared with the long-lived worker
    # (Agent/Worker.py).
    task_descriptor: TaskDescriptor = await TaskManager.get_current_task()

    await TaskRunner.run_task(task_descriptor)


if __name__ == "__main__":
    asyncio.run(main())