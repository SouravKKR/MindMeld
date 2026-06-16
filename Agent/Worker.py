import asyncio
import contextlib
import json
import os
import signal
import sys

from Globals.Utility.AgentLogger import initialize as initialize_agent_logger
from Globals.Utility.EnvironmentLoader import EnvironmentLoader

# Must run before any other module prints — installs the no-op `print` in
# production and the flushing `print` in debug mode (same contract as Main.py).
initialize_agent_logger()

from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.Task.TaskRunner import TaskRunner

EnvironmentLoader.load()


def _resolve_positive_integer_setting(environment_variable_name: str, fallback_value: int) -> int:
    """
    Reads a strictly-positive integer from the environment, returning the
    fallback when the value is missing or invalid. Mirrors the Dock-side env
    helper so both services parse tunables the same way.
    """
    raw_value = os.getenv(environment_variable_name)

    if raw_value is None or str(raw_value).strip() == "":
        return fallback_value

    try:
        parsed_value = int(float(raw_value))
    except (TypeError, ValueError):
        return fallback_value

    if parsed_value <= 0:
        return fallback_value

    return parsed_value


class AgentWorker:
    """
    Long-lived task poller. Runs identically on the strong base VM (launched by
    Dock's LocalWorkerSupervisor) and on burst VMs (launched by the baked image's
    container). It claims one task at a time from the shared Redis queue, runs it
    through the same TaskRunner the one-shot Main.py uses, then acknowledges and
    loops. One in-flight task per process — workflows are heavyweight and spawn
    their own subprocess/LLM parallelism, so horizontal scale comes from more
    processes (AGENT_WORKERS_PER_VM) and more VMs, not in-process concurrency.
    """

    # Liveness lease: the worker refreshes this while a task runs so the reaper
    # can tell a live task from one orphaned by a crashed worker.
    __LEASE_SECONDS = _resolve_positive_integer_setting("AGENT_WORKER_LEASE_SECONDS", 1800)
    # Idle poll interval — how long to wait before polling again when the queue
    # is empty. Short so the graceful-stop flag is checked often.
    __CLAIM_BLOCK_SECONDS = _resolve_positive_integer_setting("AGENT_WORKER_CLAIM_BLOCK_SECONDS", 5)
    # How often the background reaper requeues leases that expired.
    __REAPER_INTERVAL_SECONDS = _resolve_positive_integer_setting("AGENT_WORKER_REAPER_INTERVAL_SECONDS", 60)

    def __init__(self):
        self.__should_stop = False

    @staticmethod
    def __log(message: str):
        """
        Writes a worker lifecycle line straight to the real stdout, bypassing the
        production no-op `print` shim so fleet operators always see worker
        start/stop/claim activity in container logs regardless of --debug.
        """
        try:
            sys.__stdout__.write(f"[AgentWorker] {message}\n")
            sys.__stdout__.flush()
        except Exception:
            pass

    def request_stop(self):
        self.__should_stop = True
        AgentWorker.__log("Stop requested; will exit after the current task finishes.")

    async def start(self):
        await TaskManager.initialize_connection_only()
        self.__install_signal_handlers()

        AgentWorker.__log(f"Started. lease={AgentWorker.__LEASE_SECONDS}s claimBlock={AgentWorker.__CLAIM_BLOCK_SECONDS}s")

        reaper_task = asyncio.create_task(self.__run_reaper_loop())

        try:
            await self.__run_claim_loop()
        finally:
            reaper_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper_task
            AgentWorker.__log("Exited.")

    def __install_signal_handlers(self):
        # Prefer the asyncio-native handler (clean on Unix / Debian containers);
        # fall back to signal.signal where add_signal_handler is unsupported
        # (Windows dev). Never fatal if neither is available.
        loop = asyncio.get_running_loop()
        for signal_name in ("SIGTERM", "SIGINT"):
            signal_number = getattr(signal, signal_name, None)
            if signal_number is None:
                continue
            try:
                loop.add_signal_handler(signal_number, self.request_stop)
            except (NotImplementedError, RuntimeError):
                try:
                    signal.signal(signal_number, lambda _signal, _frame: self.request_stop())
                except (ValueError, OSError):
                    pass

    async def __run_reaper_loop(self):
        while not self.__should_stop:
            try:
                requeued_count = await TaskManager.requeue_stale_tasks()
                if requeued_count > 0:
                    AgentWorker.__log(f"Reaper requeued {requeued_count} orphaned task(s).")
            except Exception as reaper_error:
                AgentWorker.__log(f"Reaper error (continuing): {reaper_error}")

            await asyncio.sleep(AgentWorker.__REAPER_INTERVAL_SECONDS)

    async def __run_claim_loop(self):
        while not self.__should_stop:
            try:
                task_envelope = await TaskManager.claim_next_task_id(AgentWorker.__LEASE_SECONDS)
            except Exception as claim_error:
                AgentWorker.__log(f"Claim error (retrying): {claim_error}")
                await asyncio.sleep(1)
                continue

            if task_envelope is None:
                # Queue empty — poll again after a short pause. The pause also
                # bounds how long shutdown takes to observe the graceful-stop flag.
                await asyncio.sleep(AgentWorker.__CLAIM_BLOCK_SECONDS)
                continue

            await self.__process(task_envelope)

    async def __process(self, task_envelope: str):
        try:
            envelope = json.loads(task_envelope)
        except (ValueError, TypeError):
            AgentWorker.__log(f"Discarding malformed envelope: {task_envelope!r}")
            await TaskManager.acknowledge_task(task_envelope, "")
            return

        task_id = envelope.get("taskId", "")
        main_task_id = envelope.get("mainTaskId", "") or task_id
        parent_task_id = envelope.get("parentTaskId", "") or main_task_id

        if not task_id:
            await TaskManager.acknowledge_task(task_envelope, "")
            return

        task_descriptor = await TaskManager.get_task(task_id)
        if task_descriptor is None:
            # The Task/<id> blob expired or never existed — nothing to run.
            AgentWorker.__log(f"Task {task_id} not found; acknowledging and skipping.")
            await TaskManager.acknowledge_task(task_envelope, task_id)
            return

        # Reconstruct the exact per-task context the one-shot Main.py path would
        # have set from CLI args, so workflows that read these env vars or
        # get_current_task() behave identically.
        os.environ["TASK_ID"] = task_id
        os.environ["MAIN_TASK_ID"] = main_task_id
        os.environ["PARENT_TASK_ID"] = parent_task_id
        os.environ["TOTAL_WEIGHT"] = "0"
        TaskManager.set_current_task(task_descriptor)

        await TaskManager.set_task_lease(task_id, AgentWorker.__LEASE_SECONDS)
        lease_refresh_task = asyncio.create_task(self.__refresh_lease_while_running(task_id))

        AgentWorker.__log(f"Running task {task_id} (type={task_descriptor.get_type()}).")

        try:
            await TaskRunner.run_task(task_descriptor)
        except Exception as run_error:
            # TaskRunner already records failure on the descriptor; this guard
            # only stops a freak error from killing the worker process.
            AgentWorker.__log(f"Unhandled error running task {task_id}: {run_error}")
        finally:
            lease_refresh_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await lease_refresh_task
            await TaskManager.acknowledge_task(task_envelope, task_id)
            AgentWorker.__log(f"Finished task {task_id}.")

    async def __refresh_lease_while_running(self, task_id: str):
        refresh_interval_seconds = max(1, AgentWorker.__LEASE_SECONDS // 3)
        while True:
            await asyncio.sleep(refresh_interval_seconds)
            try:
                await TaskManager.set_task_lease(task_id, AgentWorker.__LEASE_SECONDS)
            except Exception as refresh_error:
                AgentWorker.__log(f"Lease refresh error for {task_id} (continuing): {refresh_error}")


async def main():
    worker = AgentWorker()
    await worker.start()


if __name__ == "__main__":
    asyncio.run(main())
