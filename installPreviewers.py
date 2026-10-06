#!/usr/bin/env python3

import argparse
import subprocess
from pathlib import Path


BETA_MARKER = "## Beta Versions:"


def find_curl_blocks(path, version):
    blocks = []
    in_beta_section = False
    in_code_block = False
    current = []

    for line in Path(path).read_text().splitlines(keepends=True):
        stripped = line.strip()

        # Everything after this marker is considered beta-only.
        if stripped.startswith(BETA_MARKER):
            in_beta_section = True
            continue

        # Select either the content before or after the beta marker.
        include_section = (
            in_beta_section if version == "beta" else not in_beta_section
        )

        if not in_code_block:
            if include_section and stripped == "```bash":
                in_code_block = True
                current = []
        else:
            if stripped == "```":
                command = "".join(current)

                first_line = next(
                    (
                        line.strip()
                        for line in command.splitlines()
                        if line.strip()
                    ),
                    "",
                )

                if first_line == "curl" or first_line.startswith("curl "):
                    blocks.append(command)

                in_code_block = False
            else:
                current.append(line)

    return blocks


def main():
    parser = argparse.ArgumentParser(
        description="Find and execute curl commands in fenced bash blocks."
    )
    parser.add_argument(
        "file",
        help="Input file containing the curl commands",
    )
    parser.add_argument(
        "version",
        choices=("standard", "beta"),
        help=(
            "Select standard previewers before '## Beta Versions:' "
            "or beta-only previewers after it"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print commands without executing them",
    )
    args = parser.parse_args()

    blocks = find_curl_blocks(args.file, args.version)

    print(
        f"Found {len(blocks)} {args.version} curl command block(s)."
    )

    for index, command in enumerate(blocks, start=1):
        print(f"\n--- Command {index} ---")
        print(command.rstrip())

        if args.dry_run:
            continue

        print("--- Executing ---")
        subprocess.run(
            command,
            shell=True,
            executable="/bin/bash",
            check=True,
        )


if __name__ == "__main__":
    main()