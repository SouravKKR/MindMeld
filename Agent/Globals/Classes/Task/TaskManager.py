import os
import sys
import redis.asyncio as redis
import bson
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Enumerations.TaskStatus import TaskStatus
from Globals.Enumerations.TaskExecutionTargets import TaskExecutionTargets


class TaskManager:

    __redis_client = None
    __current_task: TaskDescriptor = None
    __TASK_PREFIX = "Task/"
    __TASK_TTL_SECONDS = 5 * 60 * 60
    __TASK_COMPLETION_SUFFIX = ":completion"


    @staticmethod
    async def initialize():
        TaskManager.__redis_client = redis.from_url(os.getenv("REDIS_URL", "redis://127.0.0.1:6379"), decode_responses=False)

        await TaskManager.__redis_client.ping()

        TaskManager.__current_task = await TaskManager.get_task(os.getenv("TASK_ID"))

        print("TaskManager initialized.")


    @staticmethod
    async def get_current_task() -> TaskDescriptor:
        return TaskManager.__current_task


    @staticmethod
    def get_redis_client():
        """
        Returns the shared async Redis client used by the Agent process.
        Other components (e.g. the cross-process Gemini rate limiter) reuse
        this single connection instead of opening their own — Redis caps
        max-connections-per-client low by default and double-opening for
        every helper class would burn that budget fast.
        """
        return TaskManager.__redis_client


    @staticmethod
    async def get_task(task_id: str) -> TaskDescriptor:
        buffer = await TaskManager.__redis_client.get(TaskManager.__TASK_PREFIX + task_id)

        if buffer is None:
            return None

        deserialized = bson.decode(buffer)
        task = TaskDescriptor.from_json(deserialized)

        # Merge atomic completion value if a separate key exists.
        # Take the max of the BSON value and the atomic key — the BSON captures
        # __update_progress() calls while the atomic key captures increment_completion()
        # from workers. Early in worker execution the atomic key may be lower.
        completion_value = await TaskManager.__redis_client.get(TaskManager.__TASK_PREFIX + task_id + TaskManager.__TASK_COMPLETION_SUFFIX)
        if completion_value is not None:
            task.set_completion(max(task.get_completion(), float(completion_value)))

        return task


    @staticmethod
    async def set_task(task: TaskDescriptor, atomic: bool = False):
        task_id = task.get_id()
        serialized = bson.encode(task.to_json())
        task_key = TaskManager.__TASK_PREFIX + task_id

        if atomic:
            lua_script = """
                local ttl = redis.call('TTL', KEYS[1])
                if ttl < 0 then ttl = tonumber(ARGV[2]) end
                redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
                return ttl
            """
            await TaskManager.__redis_client.eval(lua_script, 1, task_key, serialized, TaskManager.__TASK_TTL_SECONDS)
        else:
            created = await TaskManager.__redis_client.set(task_key, serialized, ex=TaskManager.__TASK_TTL_SECONDS, nx=True)

            if not created:
                await TaskManager.__redis_client.set(task_key, serialized, keepttl=True, xx=True)


    @staticmethod
    async def increment_completion(task_id: str, delta: float) -> float:
        """
        Atomically increments the completion of a task by delta.
        When completion reaches or exceeds 1.0, marks the task as COMPLETED.
        Defensively clamps stored value to [0.0, 1.0] so a buggy delta upstream
        cannot produce nonsensical UI percentages (e.g. 6900%).
        """
        completion_key = TaskManager.__TASK_PREFIX + task_id + TaskManager.__TASK_COMPLETION_SUFFIX

        new_value = float(await TaskManager.__redis_client.incrbyfloat(completion_key, delta))

        if new_value > 1.0:
            await TaskManager.__redis_client.set(completion_key, "1.0", keepttl=True)
            new_value = 1.0
        elif new_value < 0.0:
            await TaskManager.__redis_client.set(completion_key, "0.0", keepttl=True)
            new_value = 0.0

        await TaskManager.__redis_client.expire(completion_key, TaskManager.__TASK_TTL_SECONDS)

        if new_value >= 1.0:
            task = await TaskManager.get_task(task_id)
            if task is not None:
                task.set_status(TaskStatus.COMPLETED)
                task.set_completion(1.0)
                await TaskManager.set_task(task, atomic=True)

        return new_value


    @staticmethod
    async def execute(task_descriptor: TaskDescriptor, main_task: TaskDescriptor = None, parent_task_id: str = None, total_weight: float = 0.0, wait: bool = True) -> dict | None:
        from Globals.Utility.LaunchPythonScript import launch_python_script

        match task_descriptor.get_execution_target():
            case TaskExecutionTargets.LOCAL:
                if main_task is None:
                    main_task = task_descriptor

                agent_service_path = os.getenv("AGENT_SERVICE_PATH") or os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "Agent")
                agent_service_path = os.path.normpath(agent_service_path)
                
                python_path = sys.executable
                script_path = os.path.join(agent_service_path, "Main.py")
                print(script_path)
                
                args = [
                    f"--redis-url={os.getenv('REDIS_URL', 'redis://127.0.0.1:6379')}",
                    f"--task-id={task_descriptor.get_id()}",
                    f"--main-task-id={main_task.get_id()}",
                    f"--parent-task-id={parent_task_id or main_task.get_id()}",
                    f"--total-weight={total_weight}",
                ]

                if "--debug" in sys.argv:
                    args.append("--debug")

                result = await launch_python_script(python_path, script_path, args, wait=wait)

                if result:
                    print(result["stdout"])
                    print(result["stderr"])

                return result
            
            case TaskExecutionTargets.GOOGLE_CLOUD_RUN:
                raise NotImplementedError