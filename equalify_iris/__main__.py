from __future__ import annotations

import argparse
import os

from .config import Config
from .server import run_server


def main() -> None:
    parser = argparse.ArgumentParser(prog="equalify-iris")
    parser.add_argument("--host", default=os.getenv("IRIS_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("IRIS_PORT", "8000")))
    args = parser.parse_args()

    config = Config.from_env(host=args.host, port=args.port)
    run_server(config)


if __name__ == "__main__":
    main()
