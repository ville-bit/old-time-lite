#!/usr/bin/env python3
"""Builds catalog/ for the app.

Step 1 (only if tools/sources.json is missing): ask the oldtime.radio API which
archive.org items back each show, and which stations each show belongs to.
Step 2: read the full file list for each item from archive.org and write
  catalog/index.json      stations + shows (small, loaded at startup)
  catalog/<show-id>.json  [[title, "item/file.mp3", seconds], ...]  (loaded on demand)

Run from the project root:  python3 tools/build_catalog.py
"""
import json, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = os.path.join(ROOT, "tools", "sources.json")
OUT = os.path.join(ROOT, "catalog")
SITE = "https://oldtime.radio"
UA = {"User-Agent": "otr-lite-catalog-builder/1.0 (personal use)"}


def get(url, retries=3):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return json.load(r)
        except Exception as e:
            if i == retries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def discover():
    shows = [s for s in get(f"{SITE}/api/shows") if not s["isCommercial"]]
    out = {"shows": []}
    for s in sorted(shows, key=lambda s: s["index"]):
        code = get(f"{SITE}/api/channel/generate/{s['index']}")
        time.sleep(0.25)
        sched = get(f"{SITE}/api/channel/{code}?length=86400")
        time.sleep(0.25)
        items = []
        for e in sched["list"]:
            item = urllib.parse.unquote(e["url"]).split("/")[4]
            if item not in items:
                items.append(item)
        out["shows"].append({"id": s["id"], "name": s["name"], "expected": s["episodeCount"],
                             "channels": s["channels"], "items": items})
        print(f"  discovered {s['id']}: {items}", file=sys.stderr)
    out["stations"] = get(f"{SITE}/api/channels")
    json.dump(out, open(SOURCES, "w"), indent=1)
    return out


def norm(t):
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def parse_title(raw, show_name, fname):
    """-> (episode title, year or 0). Best effort: archive titles are wildly inconsistent."""
    t = (raw or "").strip() or re.sub(r"\.mp3$", "", fname, flags=re.I)
    t = t.replace("_", " ")
    year = 0
    m = re.search(r"\b(19[2-7]\d)[-./ ](?:\d\d|xx)[-./ ](?:\d\d|xx)\b", t, re.I)
    if m:
        year = int(m.group(1)); t = t.replace(m.group(0), " ")
    else:
        m = re.search(r"\b(\d\d)[-./](\d\d|xx)[-./](\d\d|xx)\b", t, re.I)
        if m and 20 <= int(m.group(1)) <= 99:
            year = 1900 + int(m.group(1)); t = t.replace(m.group(0), " ")
        else:
            m = re.search(r"(?<!\d)(\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)", t)
            if m and 20 <= int(m.group(1)) <= 99:
                year = 1900 + int(m.group(1)); t = t.replace(m.group(0), " ")
            else:
                m = re.search(r"\b(19[2-7]\d)\b", t)
                if m:
                    year = int(m.group(1)); t = t.replace(m.group(0), " ")
    t = re.sub(r"(?<!\d)(\d\d)-(\d\d)-(\d\d)(?!\d)", lambda m: " ", t) if not year else t
    t = re.sub(r"\(\s*(?:ep\.?\s*)?\d{1,4}\s*\)", " ", t)          # (001)
    t = re.sub(r"(?<!\w)[A-Za-z&']{0,12}\s?#\d{1,4}\b", " ", t)           # "FKB #152"
    t = re.sub(r"^\W*(?:ep(?:isode)?\.?\s*)?#?\d{1,4}\b(?=\W)", " ", t, flags=re.I)  # leading number
    words = norm(show_name).split()
    low = t.lower()
    for k in range(len(words), 0, -1):
        rx = r"\W*" + r"\W*".join(map(re.escape, words[:k])) + r"(?![a-z])"
        m = re.match(rx, low)
        if m and (k == len(words) or k >= 2):
            t = t[m.end():]; break
    # leading initials such as "FKB", "JB", "O&H", "DF"
    initials = "".join(w[0] for w in words)
    initials_no_the = "".join(w[0] for w in words if w != "the")
    m = re.match(r"\W*([A-Z][A-Z&']{1,4})(?=[\s\d#]|[A-Z][a-z])", t)
    if m:
        tok = re.sub(r"[^a-z]", "", m.group(1).lower())
        def subseq(a, b):
            it = iter(b)
            return all(c in it for c in a)
        if tok and (subseq(tok, initials) or subseq(tok, initials_no_the)):
            t = t[m.end():]
    t = re.sub(r"^\W*(?:ep(?:isode)?\.?\s*)?#?\d{1,4}\b(?=\W|[A-Z])", " ", t, flags=re.I)
    t = re.sub(r"\.mp3$", "", t, flags=re.I)
    t = re.sub(r"\b(?:ep(?:isode)?\.?\s*)?#?\d{1,4}\b(?=\s*[-:.]\s)", " ", t, count=1, flags=re.I)
    t = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", t)                       # RunTogetherWords
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"^[\s\-–:.,]+|[\s\-–:.,]+$", "", t)
    if not t or not re.search(r"[A-Za-z]", t):
        t = "Untitled episode"
    if t.islower():
        t = t.title()
    return t, year


def seconds(v):
    if v is None:
        return 0
    try:
        return int(float(v))
    except ValueError:
        parts = [float(p) for p in v.split(":")]
        sec = 0
        for p in parts:
            sec = sec * 60 + p
        return int(sec)


def episodes_for(show):
    eps, seen, files = [], set(), []
    for item in show["items"]:
        meta = get(f"https://archive.org/metadata/{item}")
        time.sleep(0.3)
        for f in meta.get("files", []):
            name = f["name"]
            if "MP3" in f.get("format", "").upper() and name.lower().endswith(".mp3") and "/" not in name:
                files.append((item, f))
    durs = sorted(seconds(f.get("length")) for _, f in files if seconds(f.get("length")))
    floor = min(240, 0.25 * durs[len(durs) // 2]) if durs else 0   # skip teasers/bumpers, keep genuinely short shows
    if True:
        for item, f in files:
            name = f["name"]
            dur = seconds(f.get("length"))
            if 0 < dur < floor:
                continue
            title, year = parse_title(f.get("title"), show["name"], name)
            key = f"{item}/{name}"
            if key in seen:
                continue
            seen.add(key)
            eps.append([title, key, dur, year])
    eps.sort(key=lambda e: (e[3], e[1]))
    return eps


def main():
    src = json.load(open(SOURCES)) if os.path.exists(SOURCES) else discover()
    os.makedirs(OUT, exist_ok=True)
    index = {"stations": [], "shows": []}
    for st in src["stations"]:
        index["stations"].append({"id": st, "shows": [s["id"] for s in src["shows"] if st in s["channels"]]})
    for show in src["shows"]:
        try:
            eps = episodes_for(show)
        except Exception as e:
            print(f"  ! {show['id']}: {e}", file=sys.stderr)
            continue
        if not eps:
            print(f"  ! {show['id']}: no episodes", file=sys.stderr)
            continue
        json.dump(eps, open(os.path.join(OUT, show["id"] + ".json"), "w"), separators=(",", ":"))
        index["shows"].append({"id": show["id"], "name": show["name"], "n": len(eps)})
        print(f"  {show['id']}: {len(eps)} episodes (site lists {show['expected']})", file=sys.stderr)
    keep = {s["id"] for s in index["shows"]}
    for st in index["stations"]:
        st["shows"] = [s for s in st["shows"] if s in keep]
    json.dump(index, open(os.path.join(OUT, "index.json"), "w"), separators=(",", ":"))
    print(f"done: {len(index['shows'])} shows, {sum(s['n'] for s in index['shows'])} episodes", file=sys.stderr)


if __name__ == "__main__":
    main()
