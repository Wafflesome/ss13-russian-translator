"""
Builds data/wiki_offline.json from saved pages of the SS220 wiki (https://wiki.ss220.space, "Save page as..."
-> "Web page, complete" in a browser).

  python tools/build_wiki_offline.py <folder with the saved .html pages> [output file]

Needs: pip install beautifulsoup4 lxml wordfreq

Name pairs are taken from item tables (a Russian name next to its English one), headings with an English
anchor, and "Русское (English)" in the text. Ordinary Russian words (frequent outside the game, per wordfreq)
are left out, because the translation service handles them better than a game name would.
"""
import sys, re, os, json, glob, urllib.parse
from collections import defaultdict
from bs4 import BeautifulSoup
from wordfreq import zipf_frequency as zf

D = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'wiki_offline.json')
CYR=re.compile('[А-Яа-яЁё]'); LAT=re.compile('[A-Za-z]')
pairs={}
def add(ru,en,src,page):
    ru=re.sub(r'\s+',' ',ru).strip(' .,:;!?«»"\'()-–—•*'); en=re.sub(r'\s+',' ',en).strip(' .,:;!?«»"\'()-–—•*')
    if not ru or not en or not CYR.search(ru) or CYR.search(en) or not LAT.search(en): return
    if LAT.search(ru) and not re.search(r'NanoTrasen|Nanotrasen|EMP|ЕМР|ПДА|PDA',ru): return
    if len(ru)>50 or len(en)>50 or len(ru.split())>5 or len(en.split())>6: return
    if re.search(r'\d{2,}|\.png|http',en): return
    k=(ru.lower(),en.lower())
    e=pairs.setdefault(k,{'ru':ru,'en':en,'src':set(),'pages':set()})
    e['src'].add(src); e['pages'].add(page)
SPLIT=re.compile(r'^([^A-Za-z]*[А-Яа-яЁё][^A-Za-z]*?)\s+([A-Za-z][A-Za-z0-9 \'.&/-]*)$')
for f in sorted(glob.glob(os.path.join(D,'*.html'))):
    page=os.path.basename(f).split(' — ')[0].split(' - ')[0]
    s=BeautifulSoup(open(f,encoding='utf-8').read(),'lxml')
    c=s.find(id='mw-content-text')
    if not c: continue
    for t in c.find_all(['script','style']): t.decompose()
    # A: cells "Русское English"
    for cell in c.find_all(['th','td','b','dt']):
        tx=cell.get_text(' ',strip=True)
        if len(tx)>90: continue
        m=SPLIT.match(tx)
        if m: add(m.group(1),m.group(2),'cell',page)
    # B: th/heading with english anchor id + russian text
    for sp in c.find_all('span',id=True):
        aid=urllib.parse.unquote(sp['id'].replace('.','%')) if '.' in sp['id'] else sp['id']
        if not re.fullmatch(r"[A-Za-z0-9_'\-]+",aid) or not LAT.search(aid): continue
        par=sp.parent
        tx=''
        for node in sp.next_siblings:
            if getattr(node,'name',None)=='br': break
            tx+=node.get_text(' ') if hasattr(node,'get_text') else str(node)
        tx=tx.strip()
        if CYR.search(tx) and not LAT.search(tx): add(tx,aid.replace('_',' '),'anchor',page)
    # C: parentheticals
    txt=c.get_text(' ',strip=True)
    for m in re.finditer(r"((?:[А-ЯЁа-яё][А-ЯЁа-яё-]*\s+){0,3}[А-ЯЁа-яё][А-ЯЁа-яё-]*)\s*\(\s*(?:англ\.?\s*)?[«\"]?([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3})[»\"]?\s*\)",txt):
        en=m.group(2); n=len(en.split())
        ru=m.group(1).split(); ru=ru[max(0,len(ru)-n):]
        while ru and ru[0].lower() in {'и','в','на','с','к','по','из','от','до','для','а','но','или','не','это','как','что','при','под','за','о','у'}: ru=ru[1:]
        if ru: add(' '.join(ru),en,'paren',page)
    # D: first-cell russian + image filename (low confidence)
    for tr in c.find_all('tr'):
        cells=tr.find_all(['th','td'])
        if not cells: continue
        tx=cells[0].get_text(' ',strip=True)
        img=tr.find('img')
        if img and tx and CYR.search(tx) and not LAT.search(tx) and len(tx)<40:
            fn=os.path.splitext(img.get('alt') or '')[0]
            fn=re.sub(r'([a-z])([A-Z])',r'\1 \2',fn).replace('_',' ')
            add(tx,fn,'img',page)

P = [{'ru': e['ru'], 'en': e['en'], 'src': sorted(e['src']), 'pages': sorted(e['pages'])} for e in pairs.values()]
ABIL={'Вампир','Генокрад','Ревенант','Тенеморф','Маг','Праведники Ратвара','Мозговой Червь','Демон резни','Теневой демон','Космический ниндзя','Блоб','Морф','Космический дракон','Паук Ужаса','Ксеноморф','Еретик','Навыки','Хоткеи','Руководство по боевой системе','Cultist','Вор','Контрактник','ИИ','Абдуктор'}
def clean(t): return re.sub(r'\s+',' ',t.replace('«','').replace('»','').replace('"','').replace('“','').replace('”','')).strip()
ru2en=defaultdict(list); en2ru=defaultdict(list); drop=defaultdict(list)
for e in P:
    ru=clean(e['ru']); en=clean(e['en']); src=set(e['src']); pages=set(e['pages'])
    if '(' in ru or ')' in ru or '(' in en or len(ru)<3: drop['paren-junk'].append((ru,en)); continue
    structured=bool(src&{'anchor','cell'})
    rw=ru.split(); ew=en.split()
    if not structured:
        if 'paren' not in src: drop['img'].append((ru,en)); continue
        if len(rw)!=len(ew) or not ru[0].isupper(): drop['paren-shape'].append((ru,en)); continue
    if re.search(r'\bCrate$',en,re.I) and 'ящик' not in ru.lower(): drop['crate'].append((ru,en)); continue
    if rw[-1].lower() in {'с','в','и','для','на','по','к','от','из','о','а','или','со'} or re.match(r'^(Secrete|Activate|Toggle) ',en):
        drop['tail'].append((ru,en)); continue
    if rw[0].lower()=='нет' or re.search(r'\s-\s|\+',ru+' '+en) or (re.search(r'\d',en) and not re.search(r'\d',ru)) or len(rw)>=len(ew)+2 or len(en)<3:
        drop['shape2'].append((ru,en)); continue
    if len(set(w.lower() for w in rw))<len(rw): drop['dup-words'].append((ru,en)); continue
    abil=pages<=ABIL
    freqs=[zf(w.lower(),'ru') for w in rw]
    score=len(src)+(2 if structured else 0)
    if len(rw)==1:
        if freqs[0]<2.5: ru2en[ru.lower()].append((score,en,ru))
        else: drop['common-single'].append((ru,en))
    else:
        if abil and min(freqs)>=3.0: drop['abil-common'].append((ru,en))
        elif min(freqs)>=4.3: drop['all-common'].append((ru,en))
        else: ru2en[ru.lower()].append((score,en,ru))
    if structured and not abil and len(ew)>=2 and not re.search(r'[0-9]',en):
        en2ru[en.lower()].append((score,ru,en))
out_r={}; conf=[]
for k,L in ru2en.items():
    L.sort(key=lambda x:(-x[0],len(x[1]))); out_r[L[0][2]]=L[0][1]
    if len({x[1].lower() for x in L})>1: conf.append((k,[x[1] for x in L]))
out_e={}
for k,L in en2ru.items():
    L.sort(key=lambda x:(-x[0],len(x[1]))); ru=L[0][1]
    if len(ru)>1 and ru[1:2].islower(): ru=ru[0].lower()+ru[1:]
    out_e[L[0][2]]=ru
BLOCK_RU={'верховный суд','комната казни','космические грибы','любая батарея','обучение искусству','пьяный идиот','старая мода','ядерные агенты','личное оружие самообороны 9','приборы и инструменты','предел мощности','системы вооружения','силовой меч','полное стекло','легкий шлем','гуманоидная форма','чёрная медицина','черная медицина','раскрытие','стук подмена сознания','фальсификатор','транквилизаторы','огнестрел','наркотики','телекристалл'}
BLOCK_EN={'pure love','nuclear emergency','space mountain','space suit','power cell','fish water','loadout'}
out_r={k:v for k,v in out_r.items() if k.lower() not in BLOCK_RU and not re.search(r'\s\d+$',k)}
out_e={k:v for k,v in out_e.items() if k.lower() not in BLOCK_EN and v.lower() not in BLOCK_RU}


for k, v in list(out_r.items()):
    if v.endswith("'s"): out_r[k] = v[:-2] + 's'
    if ' ' not in k and re.search(r'(?:ать|ять|ить|уть|ыть|ться)$', k): del out_r[k]
out_e = {(k[:-2] + 's' if k.endswith("'s") else k): v for k, v in out_e.items()}
doc = {
    '_help': 'Game names taken from the SS220 wiki pages (items, chemicals, drinks, roles). Russian -> English is used to read the game, English -> Russian when you type. lexicon_game.json and the names from the source code take priority over this file. You can edit it: the translator reloads it on start.',
    'ru2en': dict(sorted(out_r.items(), key=lambda x: x[0].lower())),
    'en2ru': dict(sorted(out_e.items(), key=lambda x: x[0].lower())),
}
json.dump(doc, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('ru2en', len(out_r), 'en2ru', len(out_e), '->', OUT)
