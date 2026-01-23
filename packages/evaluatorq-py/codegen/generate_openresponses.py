#!/usr/bin/env python
"""Generate OpenResponses Pydantic models from OpenAPI spec."""
import subprocess
import sys
from pathlib import Path


OPENAPI_URL = "https://raw.githubusercontent.com/openresponses/openresponses/main/public/openapi/openapi.json"
OUTPUT_PATH = Path(__file__).parent.parent / "src" / "evaluatorq" / "generated" / "openresponses" / "models.py"


def main() -> None:
    """Generate Pydantic models from OpenAPI specification."""
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [
            sys.executable,
            "-m",
            "datamodel_code_generator",
            "--url",
            OPENAPI_URL,
            "--input-file-type",
            "openapi",
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--output",
            str(OUTPUT_PATH),
            "--use-annotated",
            "--field-constraints",
            "--use-union-operator",
            "--target-python-version",
            "3.10",
        ],
        check=True,
    )
    print(f"Generated models at {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
