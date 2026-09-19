import argparse
import os
from pathlib import Path
from .server import load_project, serve, cache_project_ui, open_project_ui


def main():
    parser = argparse.ArgumentParser(description="Run a project's agent_ui.py / create_ui()")
    parser.add_argument("project", nargs="?", default=".")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--ready-file")
    parser.add_argument("--desktop", action="store_true", help="Allow the Toolkits desktop frame")
    parser.add_argument("--prepare", action="store_true", help="Prepare project resources and exit")
    parser.add_argument("--ui-cache", help="Cache the UI definition during installation")
    args = parser.parse_args()
    ready_file = str(Path(args.ready_file).resolve()) if args.ready_file else None
    cache = str(Path(args.ui_cache).resolve()) if args.ui_cache else None
    os.chdir(args.project)
    if args.prepare:
        if cache:
            cache_project_ui(".", cache, prepare=True)
        else:
            load_project(".", prepare=True)
        return
    ui = open_project_ui(".", cache) if cache else load_project(".")
    serve(ui, args.port, not args.no_browser, ready_file, desktop=args.desktop)


if __name__ == "__main__":
    main()
