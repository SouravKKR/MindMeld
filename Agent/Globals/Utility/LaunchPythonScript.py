import asyncio
import os


async def launch_python_script(python_path: str, script_path: str, args: list[str], wait: bool = True) -> dict | None:
    working_directory = os.path.dirname(script_path)

    process = await asyncio.create_subprocess_exec(
        python_path,
        script_path,
        *args,
        cwd=working_directory,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    if not wait:
        return None

    stdout, stderr = await process.communicate()

    stdout_str = stdout.decode("utf-8", errors="replace")
    stderr_str = stderr.decode("utf-8", errors="replace")

    if process.returncode != 0:
        raise Exception(f"Exit code {process.returncode}\n{stderr_str}")

    return {
        "stdout": stdout_str,
        "stderr": stderr_str,
        "exitCode": process.returncode
    }