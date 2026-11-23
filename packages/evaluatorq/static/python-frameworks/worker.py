import asyncio
import importlib
import importlib.util
import inspect
import json
import os
import re
import sys
from pathlib import Path
from uuid import uuid4


MAX_LINE_BYTES = 16 * 1024 * 1024
MAX_ERROR_CHARS = 8192
wire = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr


class ProtocolError(Exception):
    pass


def write(payload):
    line = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
    if len(line.encode("utf-8")) > MAX_LINE_BYTES:
        raise ProtocolError("Python worker response exceeds the JSONL line limit")
    wire.write(line)
    wire.flush()


def load_factory(locator):
    module_name, attribute = locator.rsplit(":", 1)
    if not module_name or not attribute or not all(part.isidentifier() for part in attribute.split(".")):
        raise ValueError("factory must name a Python module or file and callable")
    if module_name.endswith(".py"):
        path = Path(module_name).resolve(strict=True)
        name = f"_evaluatorq_factory_{uuid4().hex}"
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ValueError(f"Cannot import factory file {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        sys.path.insert(0, str(path.parent))
        spec.loader.exec_module(module)
    else:
        module = importlib.import_module(module_name)
    value = module
    for part in attribute.split("."):
        value = getattr(value, part)
    if not callable(value):
        raise TypeError(f"Factory {locator} is not callable")
    return value


async def initialize(params):
    framework = params["framework"]
    integrations = {
        "crewai": ("crewai_integration", "CrewAITarget", "crew"),
        "pydantic_ai": ("pydantic_ai_integration", "PydanticAITarget", "agent"),
    }
    if framework not in integrations:
        raise ProtocolError(f"Unknown Python framework {framework}")
    try:
        importlib.import_module(framework)
        contracts = importlib.import_module("evaluatorq.contracts")
        package, class_name, argument = integrations[framework]
        target_type = getattr(importlib.import_module(f"evaluatorq.integrations.{package}"), class_name)
    except (ImportError, AttributeError) as error:
        raise RuntimeError(
            f"Python {sys.executable} must contain evaluatorq with its {framework} integration and the {framework} SDK: {error}"
        ) from error
    sys.path.insert(0, os.getcwd())
    instance = load_factory(params["factory"])()
    if inspect.isawaitable(instance):
        instance = await instance
    options = dict(params.get("target_options") or {})
    if options.get("agent_context") is not None:
        options["agent_context"] = contracts.AgentContext.model_validate(options["agent_context"])
    target = target_type(**{argument: instance}, **options)
    target.mint_memory_entity_id(params["memory_entity_id"])
    return target, contracts


def error_payload(error):
    message = str(error)
    if len(message) > MAX_ERROR_CHARS:
        message = message[:MAX_ERROR_CHARS] + " (truncated)"
    result = {"type": type(error).__name__, "message": message}
    current = error
    for _ in range(5):
        if current is None:
            break
        response = getattr(current, "response", None)
        values = [getattr(response, "status_code", None),
                  getattr(current, "status_code", None), getattr(current, "status", None)]
        status = next((value for value in values
                       if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599), None)
        if status is not None:
            result["status_code"] = status
            break
        current = current.__cause__ or current.__context__
    if "status_code" not in result:
        for pattern in (r'\bstatus(?:_code)?\s*[=:]\s*(\d{3})\b', r'\bHTTP\s*(\d{3})\b', r'\bcode\s*[=:]\s*(\d{3})\b'):
            match = re.search(pattern, str(error), flags=re.IGNORECASE)
            if match and 100 <= int(match.group(1)) <= 599:
                result["status_code"] = int(match.group(1))
                break
    usage = getattr(error, "usage", None)
    if usage is not None:
        result["usage"] = usage.model_dump(mode="json") if hasattr(usage, "model_dump") else usage
    return result


async def main():
    target = None
    contracts = None
    try:
        while True:
            raw = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_LINE_BYTES + 1)
            if not raw:
                return
            if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
                raise ProtocolError("Python worker request exceeds the JSONL line limit or is incomplete")
            request = json.loads(raw)
            identifier = request["id"]
            try:
                method = request["method"]
                params = request["params"]
                if method == "init":
                    if target is not None:
                        raise ProtocolError("Python worker is already initialized")
                    target, contracts = await initialize(params)
                    result = {
                        "history_mode": target.history_mode.value,
                        "memory_entity_id": target.memory_entity_id,
                    }
                elif target is None:
                    raise ProtocolError("Python worker is not initialized")
                elif method == "respond":
                    messages = [contracts.Message.model_validate(item) for item in params["messages"]]
                    result = (await target.respond(messages)).model_dump(mode="json")
                elif method == "get_agent_context":
                    result = (await target.get_agent_context()).model_dump(mode="json")
                else:
                    raise ProtocolError(f"Unknown Python worker method {method}")
                write({"id": identifier, "ok": True, "result": result})
            except Exception as error:
                write({"id": identifier, "ok": False, "error": error_payload(error)})
    finally:
        if target is not None:
            close = getattr(target, "close", None)
            if callable(close):
                result = close()
                if inspect.isawaitable(result):
                    await result


if __name__ == "__main__":
    asyncio.run(main())
