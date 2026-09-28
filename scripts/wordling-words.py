#!/usr/bin/env python3
"""Regenerate Wordling's word lists in src/data/wordling/.

guesses.txt: every 5-letter word in ENABLE (public domain), used to accept guesses.
answers.txt: common 5-letter words from SCOWL sizes 10-35, minus most plurals,
  past tenses, and offensive words. Answers are always valid guesses.

Run: python3 scripts/wordling-words.py
"""

import io
import re
import tarfile
import urllib.request
from pathlib import Path

ENABLE_URL = "https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt"
SCOWL_URL = "https://downloads.sourceforge.net/project/wordlist/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz"
SCOWL_LISTS = [f"{v}-words.{n}" for v in ("english", "american") for n in (10, 20, 35)]
OUT = Path(__file__).resolve().parent.parent / "src" / "data" / "wordling"

# Words that are valid guesses but make poor or unkind answers.
BLOCKED = set("""
bitch boner boobs booty butts dildo dyked dykes faggy fagot gipsy gypsy homos
horny hussy kinky lesbo negro nazis pansy penis porno porns prick pubes pussy
queer rapes raped rapey sluts slutty spics titty turds whore wench wimpy
chink lynch semen sexed sexes midget squaw
""".split())

def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as r:
        return r.read()

def five(words):
    return {w for w in words if re.fullmatch(r"[a-z]{5}", w)}

def main() -> None:
    enable_all = set(fetch(ENABLE_URL).decode().split())
    guesses = five(enable_all)

    common = set()
    with tarfile.open(fileobj=io.BytesIO(fetch(SCOWL_URL))) as tar:
        for name in SCOWL_LISTS:
            data = tar.extractfile(f"scowl-2020.12.07/final/{name}").read()
            common |= five(data.decode("latin-1").split())

    def inflected(w: str) -> bool:
        if w.endswith("s") and not w.endswith(("ss", "us", "is")) and w[:-1] in enable_all:
            return True  # plural or third person: "boats", "makes"
        if w.endswith("ed") and (w[:-1] in enable_all or w[:-2] in enable_all):
            return True  # past tense: "baked", "wanted"
        return False

    answers = sorted(w for w in common & guesses if not inflected(w) and w not in BLOCKED)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "answers.txt").write_text("\n".join(answers) + "\n")
    (OUT / "guesses.txt").write_text("\n".join(sorted(guesses)) + "\n")
    print(f"{len(answers)} answers, {len(guesses)} guesses")

if __name__ == "__main__":
    main()
