"""
Reads the detailed logs and prints what to improve next.

  python tools/analyze_logs.py [logs folder]      (default: the logs folder next to this one)

Uses logs/events.tsv (translations, bubbles, chat), logs/overlay/trace.tsv (every look at the map and
every label drawn) and logs/translations.log.
"""
import os
import sys
import statistics
from collections import defaultdict, Counter

LOGS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'logs')


def pct(a, p):
    if not a:
        return None
    s = sorted(a)
    return s[min(len(s) - 1, int(p * len(s)))]


def show(name, a, unit='ms'):
    if not a:
        print(f'  {name:<58} -')
        return
    print(f'  {name:<58} n={len(a):<6} median={pct(a, .5):<8.0f} 90%={pct(a, .9):<8.0f} max={max(a):.0f} {unit}')


def read_tsv(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8', errors='replace') as f:
        return [l.rstrip('\n').split('\t') for l in f if l.strip()]


def last_run(rows, is_start):
    """Only the last run of the translator (the files keep earlier runs too)."""
    idx = [i for i, r in enumerate(rows) if is_start(r)]
    return rows[idx[-1]:] if idx else rows


def events():
    rows = last_run(read_tsv(os.path.join(LOGS, 'events.tsv')), lambda r: len(r) > 2 and r[2] == 'start')
    out = []
    for r in rows:
        if len(r) < 3:
            continue
        d = {'clock': r[0], 't': int(r[1]) if r[1].isdigit() else 0, 'type': r[2]}
        for kv in r[3:]:
            if '=' in kv:
                k, v = kv.split('=', 1)
                if k in ('clock', 't', 'type'):
                    k = 'f_' + k
                try:
                    d[k] = float(v) if v.replace('.', '', 1).lstrip('-').isdigit() else v
                except ValueError:
                    d[k] = v
        out.append(d)
    return out


def main():
    ev = events()
    by = defaultdict(list)
    for e in ev:
        by[e['type']].append(e)
    print('== Events:', ', '.join(f'{k} {len(v)}' for k, v in sorted(by.items())))

    print('\n== Speech bubbles')
    chats = {e.get('key'): e for e in by['chat']}
    show('paired after chat', [e['ms'] for e in by['pair'] if 'ms' in e])
    show('first seen after chat', [e['seen'] for e in by['pair'] if isinstance(e.get('seen'), float)])
    show('read after chat', [e['read'] for e in by['pair'] if isinstance(e.get('read'), float)])
    show('English ready after chat', [e['ms'] for e in by['english'] if 'ms' in e])
    show('label shown after chat', [e['ms'] for e in by['label'] if 'ms' in e])
    show('label lost after chat', [e['ms'] for e in by['lost'] if 'ms' in e])
    far = [c for c in chats.values() if c.get('far')]
    if far:
        print(f'  heard as a ghost from people out of view (no bubble expected): {len(far)}')
    spoken = [c for c in chats.values() if not c.get('rd') and not c.get('far')]
    paired = {e.get('key') for e in by['pair']}
    print(f'  spoken lines {len(spoken)}, paired {len([c for c in spoken if c.get("key") in paired])}, missed (picture) {len(by["missed"])}, lost {len(by["lost"])}, relabel {len(by["relabel"])}, labels moved to their bubble's new place {len(by["repick"])}')
    small = [c for c in spoken if c.get('it')]
    print(f'  small-font lines {len(small)}, paired {len([c for c in small if c.get("key") in paired])}')

    print('\n== Translation')
    ways = defaultdict(list)
    for e in by['service']:
        ways[f"{e.get('dir')} via {e.get('way')}"].append(e['ms'])
    for k, a in sorted(ways.items()):
        show(k, a)
    show('waited in queue', [e['waited'] for e in by['service'] if 'waited' in e])
    show('what you type', [e['ms'] for e in by['typed'] if 'ms' in e])
    show('game window new texts', [e['ms'] for e in by['page-tr'] if 'ms' in e])
    warm = by['typing-warm']
    if warm:
        print(f'  typing warm-ups {len(warm)} (website / browser translator ready after, ms: ' + ', '.join(f"{e.get('web')}/{e.get('html')}" for e in warm[-6:]) + ')')
    print(f'  service errors {len(by["service-error"])}, Google ways switched off {len(by["google-off"])}, leftovers {len(by["leftover"])}')

    tr = last_run(read_tsv(os.path.join(LOGS, 'overlay', 'trace.tsv')), lambda r: len(r) > 1 and r[1] == 'start')
    if tr:
        print('\n== Map overlay (trace.tsv)')
        F = [r for r in tr if len(r) > 6 and r[1] == 'F']
        T = [r for r in tr if len(r) > 7 and r[1] == 'T']
        R = [r for r in tr if len(r) > 8 and r[1] == 'R']
        show('whole-map look: capture', [int(r[2]) for r in F])
        show('whole-map look: find lines', [int(r[3]) for r in F])
        show('whole-map look: read', [int(r[5]) for r in F])
        show('whole-map look: total', [int(r[6]) for r in F])
        if len(F) > 1:
            gaps = [int(b[0]) - int(a[0]) for a, b in zip(F, F[1:])]
            show('time between whole-map looks', gaps)
        show('close-up look: capture', [int(r[4]) for r in T])
        show('close-up look: total', [int(r[6]) for r in T])
        if len(T) > 1:
            gaps = [int(b[0]) - int(a[0]) for a, b in zip(T, T[1:]) if int(b[0]) - int(a[0]) < 1000]
            show('time between close-up looks', gaps)
        print(f'  close-up looks that lost a bubble: {sum(1 for r in T if r[8] != "0")} of {len(T)}')
        # labels: how far the bubble was from the label drawn before, split by how fast it moved
        errs, moving, still, ages = [], [], [], []
        last = {}
        for r in R:
            t, key = int(r[0]), r[2]
            bx, by_, age, err = float(r[3]), float(r[4]), float(r[5]), float(r[8])
            ages.append(age)
            if err >= 0:
                errs.append(err)
                p = last.get(key)
                if p and t > p[0]:
                    speed = ((bx - p[1]) ** 2 + (by_ - p[2]) ** 2) ** 0.5 / (t - p[0]) * 1000
                    (moving if speed > 20 else still).append(err)
                last[key] = (t, bx, by_)
        show('label vs bubble distance (all)', errs, 'px')
        show('label vs bubble distance, bubble moving', moving, 'px')
        show('label vs bubble distance, bubble still', still, 'px')
        show('label drawn from a measurement this old', ages)
        V = [r for r in tr if len(r) > 3 and r[1] == 'V']
        if V:
            show('view jumps caught on a whole-map look (px)', [((int(r[2]) ** 2 + int(r[3]) ** 2) ** 0.5) for r in V], 'px')
        S = [r for r in tr if len(r) > 2 and r[1] == 'S']
        if S:
            print('  capture: ' + ' | '.join(' '.join(x for x in r[2:]) for r in S[-3:]))
        if len(R) > 1:
            per = Counter(r[2] for r in R)
            print(f'  labels drawn {len(R)} for {len(per)} speakers')


if __name__ == '__main__':
    main()
