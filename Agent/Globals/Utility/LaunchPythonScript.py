import asyncio
import os


async def launch_python_script(python_path: str, script_path: str, args: list[str], wait: bool = True, on_line=None) -> dict | None:
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

    # Default path (production): buffer everything and return once the child
    # exits. Kept byte-for-byte identical to the original behaviour so callers
    # that don't opt into streaming are unaffected.
    if on_line is None:
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

    # Streaming path (debug): pump stdout and stderr concurrently so the
    # child's output is visible line-by-line as it is produced, instead of
    # appearing all at once after the child exits. We still accumulate the
    # full text so the returned result dict is unchanged. Mirrors the Node
    # launcher's per-line `onLine` behaviour.
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    async def pump(stream, stream_name: str, chunks: list[str]):
        while True:
            line_bytes = await stream.readline()
            if not line_bytes:
                break
            text = line_bytes.decode("utf-8", errors="replace")
            chunks.append(text)
            on_line(stream_name, text.rstrip("\r\n"))

    await asyncio.gather(
        pump(process.stdout, "stdout", stdout_chunks),
        pump(process.stderr, "stderr", stderr_chunks),
    )
    await process.wait()

    stdout_str = "".join(stdout_chunks)
    stderr_str = "".join(stderr_chunks)

    if process.returncode != 0:
        raise Exception(f"Exit code {process.returncode}\n{stderr_str}")

    return {
        "stdout": stdout_str,
        "stderr": stderr_str,
        "exitCode": process.returncode
    }