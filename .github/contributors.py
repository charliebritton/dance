"""Rewrites the Contributors list in README.md from git history: everyone who authored a commit, plus anyone credited
in a "Co-authored-by:" line, most commits first. Run by .github/workflows/contributors.yml on every push to main;
run it yourself with `python3 .github/contributors.py`. Bots are left out; .mailmap merges one person's addresses."""
import re
import subprocess
from collections import Counter
from pathlib import Path

README = Path(__file__).resolve().parent.parent / "README.md"
START, END = "<!-- contributors:start -->", "<!-- contributors:end -->"
BOT = re.compile(r"\[bot\]|noreply@github\.com$|^dependabot|^github-actions", re.I)


def people():
    log = subprocess.run(["git", "log", "--use-mailmap", "--format=%aN <%aE>%x00%B%x1e"], capture_output=True,
                         text=True, check=True, cwd=README.parent).stdout
    count, names = Counter(), {}
    for entry in filter(str.strip, log.split("\x1e")):
        author, _, body = entry.strip().partition("\x00")
        found = {author.strip()} | {m.strip() for m in re.findall(r"^co-authored-by:\s*(.+)$", body, re.I | re.M)}
        for who in found:
            m = re.match(r"(.+?)\s*<([^>]+)>", who)
            name, email = (m.group(1), m.group(2).lower()) if m else (who, who.lower())
            if BOT.search(name) or BOT.search(email):
                continue
            count[email] += 1
            names.setdefault(email, name)
    return [(names[e], n) for e, n in sorted(count.items(), key=lambda x: (-x[1], names[x[0]].lower()))]


def main():
    lines = [f"- {name} ({n} commit{'s' if n != 1 else ''})" for name, n in people()]
    text = README.read_text()
    if START not in text or END not in text:
        raise SystemExit(f"README.md needs {START} and {END} around the list")
    head, rest = text.split(START, 1)
    _, tail = rest.split(END, 1)
    README.write_text(head + START + "\n" + "\n".join(lines) + "\n" + END + tail)


if __name__ == "__main__":
    main()
