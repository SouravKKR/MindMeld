import os


def setup_environment(command_line_args: dict):
    os.environ["REDIS_URL"] = command_line_args.get("--redis-url", "redis://127.0.0.1:6379")
    os.environ["TASK_ID"] = command_line_args.get("--task-id", "")
    os.environ["MAIN_TASK_ID"] = command_line_args.get("--main-task-id", "")
    os.environ["PARENT_TASK_ID"] = command_line_args.get("--parent-task-id") or os.getenv("MAIN_TASK_ID", "")
    os.environ["TOTAL_WEIGHT"] = command_line_args.get("--total-weight", "0")