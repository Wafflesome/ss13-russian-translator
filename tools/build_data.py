#!/usr/bin/env python3
"""
Builds the mod's static data from the SS1984 (ss220 Paradise) source tree.

Outputs (into ../data):
  names.json   - exact Russian name forms (all 6 grammatical cases) -> original English object name
  warmup.json  - Russian UI strings found in the source, pre-translated by the bridge on first run

Usage: python build_data.py <path-to-Paradise-master220>
"""
import json, os, re, sys, collections

if len(sys.argv) < 2:
    sys.exit("Usage: python tools/build_data.py <folder with the server source (Paradise)>")
ROOT = sys.argv[1]
OUT = os.environ.get("SS13TR_OUT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
CYR = re.compile("[А-Яа-яЁё]")
WARM_LIMIT = 8000
LAT = re.compile("[A-Za-z]")

def read(p):
    try:
        with open(p, encoding="utf-8", errors="ignore") as f:
            return f.read()
    except OSError:
        return ""

def walk(sub, exts):
    base = os.path.join(ROOT, sub)
    for r, dirs, fs in os.walk(base):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "tests")]
        for f in fs:
            if f.endswith(exts):
                yield os.path.join(r, f)

# ---------------------------------------------------------------- DM parsing
TYPE_LINE = re.compile(r"^(\t*)(/?[A-Za-z0-9_][A-Za-z0-9_/]*)\s*(//.*)?$")
NAME_LINE = re.compile(r'^\t+name\s*=\s*"((?:[^"\\]|\\.)*)"')
RU_PROC = re.compile(r"^(/[A-Za-z0-9_/]+?)/(?:proc/)?get_ru_names\(\)")
CASE_LINE = re.compile(r'(NOMINATIVE|GENITIVE|DATIVE|ACCUSATIVE|INSTRUMENTAL|PREPOSITIONAL)\s*=\s*"((?:[^"\\]|\\.)*)"')
STR_LIT = re.compile(r'"((?:[^"\\\n]|\\.)*)"')

def clean_dm(s):
    s = re.sub(r"\\(improper|proper|the|The|a|A|an|An|he|she|his|her|him|himself|herself|hers|th|s|icon|ref|roman|Roman)\b ?", "", s)
    s = s.replace('\\"', '"').replace("\\n", " ").replace("\\t", " ").replace("\\\\", "\\")
    return re.sub(r"\s+", " ", s).strip()

type_names = {}      # path -> english name
ru_forms = {}        # path -> list of forms
nom_form = {}        # path -> NOMINATIVE form
fixed_strings = collections.Counter()

for path in walk("code", (".dm",)):
    text = read(path)
    stack = []  # (indent, path)
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].rstrip("\r")
        m = RU_PROC.match(line)
        if m:
            tpath = m.group(1)
            forms = []
            j = i + 1
            while j < len(lines) and j < i + 14:
                for cm in CASE_LINE.finditer(lines[j]):
                    forms.append(clean_dm(cm.group(2)))
                    if cm.group(1) == "NOMINATIVE":
                        nom_form[tpath] = clean_dm(cm.group(2))
                if lines[j].strip().startswith(")"):
                    break
                j += 1
            if forms:
                ru_forms[tpath] = forms
            i = j + 1
            continue
        tm = TYPE_LINE.match(line)
        if tm and "(" not in line and "=" not in line:
            indent = len(tm.group(1))
            seg = tm.group(2)
            while stack and stack[-1][0] >= indent:
                stack.pop()
            if seg.startswith("/") or not stack:
                full = seg if seg.startswith("/") else "/" + seg
            else:
                full = stack[-1][1].rstrip("/") + "/" + seg
            full = full.replace("/proc/", "/").replace("/verb/", "/")
            stack.append((indent, full))
        else:
            nm = NAME_LINE.match(line)
            if nm and stack:
                ind = len(line) - len(line.lstrip("\t"))
                owner = [s for s in stack if s[0] < ind]
                if owner:
                    type_names.setdefault(owner[-1][1], clean_dm(nm.group(1)))
        # fixed strings (no interpolation) that contain Cyrillic
        if '"' in line and CYR.search(line) and not line.lstrip().startswith("//"):
            for sm in STR_LIT.finditer(line):
                raw = sm.group(1)
                if "[" in raw or not CYR.search(raw):
                    continue
                s = clean_dm(re.sub(r"<[^>]+>", " ", raw))
                if s and len(s) < 300:
                    fixed_strings[s] += 1
        i += 1

def english_name(tpath):
    # Only trust a name declared on the type itself: inherited names are often wrong
    # for subtypes whose name is set at runtime.
    return type_names.get(tpath)

names = {}
for tpath, forms in ru_forms.items():
    en = english_name(tpath)
    if not en or CYR.search(en) or not LAT.search(en) or "[" in en:
        continue
    for f in forms:
        if f and CYR.search(f) and "[" not in f:
            names.setdefault(f.lower(), en)

# --------------------------------------------------------------- web sources
web_strings = collections.Counter()
JSX_TEXT = re.compile(r">([^<>{}]*[А-Яа-яЁё][^<>{}]*)<")
JS_STR = re.compile(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"|`((?:[^`\\$]|\\.)*)`")
for sub, exts in (("tgui/packages", (".tsx", ".ts", ".jsx", ".js")), ("html", (".html", ".js", ".htm")), ("interface", (".dmf",))):
    for path in walk(sub, exts):
        if ".test." in path:
            continue
        text = read(path)
        for m in JSX_TEXT.finditer(text):
            s = re.sub(r"\s+", " ", m.group(1)).strip()
            if CYR.search(s) and len(s) < 300:
                web_strings[s] += 3
        for m in JS_STR.finditer(text):
            s = m.group(1) or m.group(2) or m.group(3) or ""
            s = re.sub(r"<[^>]+>", " ", s)
            s = re.sub(r"\s+", " ", s.replace("\\n", " ").replace("\\'", "'").replace('\\"', '"')).strip()
            if CYR.search(s) and len(s) < 300:
                web_strings[s] += 3

# ------------------------------------------------------------ strings folder
for path in walk("strings", (".txt", ".json")):
    for line in read(path).split("\n"):
        s = line.strip().strip('",')
        if CYR.search(s) and len(s) < 200:
            fixed_strings[s] += 1

def useful(s):
    letters = CYR.findall(s)
    return len(letters) >= 3 and not (s[0].islower() and len(s) < 5)

warm = []
seen = set()
for s, _ in web_strings.most_common():
    if useful(s) and s not in seen and s.lower() not in names:
        seen.add(s); warm.append(s)
# Short fixed DM strings are mostly UI labels, buttons and common messages.
dm = [s for s, c in fixed_strings.most_common() if useful(s) and len(s) <= 80]
for s in dm:
    if len(warm) >= WARM_LIMIT:
        break
    if s not in seen and s.lower() not in names:
        seen.add(s); warm.append(s)

# English object name -> Russian NOMINATIVE (for translating what you type: "health analyzer" -> "анализатор здоровья")
nominative = {}
for tpath, forms in ru_forms.items():
    en = english_name(tpath)
    if not en or CYR.search(en) or not LAT.search(en) or "[" in en or not forms:
        continue
    f = nom_form.get(tpath) or forms[0]
    if f and CYR.search(f) and "[" not in f:
        nominative.setdefault(en.lower(), f)

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "names_en_ru.json"), "w", encoding="utf-8") as f:
    json.dump(nominative, f, ensure_ascii=False, indent=0, sort_keys=True)
with open(os.path.join(OUT, "names.json"), "w", encoding="utf-8") as f:
    json.dump(names, f, ensure_ascii=False, indent=0, sort_keys=True)
with open(os.path.join(OUT, "warmup.json"), "w", encoding="utf-8") as f:
    json.dump(warm, f, ensure_ascii=False, indent=0)
print("types with names:", len(type_names), "ru_names types:", len(ru_forms))
print("name forms:", len(names), "web strings:", len(web_strings), "dm fixed:", len(fixed_strings), "warmup:", len(warm))
