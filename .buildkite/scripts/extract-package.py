"""Extract only bounded regular package files into a new disposable directory."""
import pathlib
import re
import sys
import tarfile


def extract(archive, destination):
    target = pathlib.Path(destination)
    if target.exists():
        raise ValueError("Destination must be new")
    with tarfile.open(archive, "r:gz") as source:
        files = []
        seen = set()
        total = 0
        for member in source:
            path = member.name
            if path.startswith("./"):
                path = path[2:]
            if member.isdir() and path in ("", "."):
                continue
            path = path.rstrip("/") if member.isdir() else path
            if not re.fullmatch(r"[A-Za-z0-9_./-]+", path) or any(part in ("", ".", "..") for part in path.split("/")):
                raise ValueError("Unsafe package path")
            if path in seen or not (member.isdir() or member.isfile()):
                raise ValueError("Duplicate or nonregular package entry")
            seen.add(path)
            if len(seen) > 512:
                raise ValueError("Too many package entries")
            if member.isfile():
                total += member.size
                if len(files) >= 257 or total > 64 * 1024 * 1024 or member.size < 0:
                    raise ValueError("Package size limit")
                files.append((path, member))
        # Validate the whole archive before writing anything.
        for path, _ in files:
            if any(path.startswith(other + "/") for other, _ in files):
                raise ValueError("File is a parent path")
        target.mkdir(mode=0o700)
        for path, member in files:
            output = target / path
            output.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as contents, output.open("xb") as handle:
                handle.write(contents.read())


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract-package.py ARCHIVE NEW_DIRECTORY")
    extract(sys.argv[1], sys.argv[2])
