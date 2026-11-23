import json
import math
import random
import sys
from importlib.metadata import version

if version('evaluatorq') != '1.85.0':
    raise SystemExit('Use evaluatorq v1.85.0, commit a59c3a862dcb6a991ba660fe1bd13f56838b73ed')

from evaluatorq.ranking import JudgedComparison, fit_bt


def build_case(size, mode, rng, seed):
    pairs = {(i, i + 1) for i in range(size - 1)}
    for _ in range(size * 2):
        pairs.add(tuple(sorted(rng.sample(range(size), 2))))
    rows = [
        {'judge': judge, 'item_a': f'i{a:02}', 'item_b': f'i{b:02}',
         'p_a': rng.choice([.001, .01, .05, .2, .49, .5, .51, .8, .95, .99, .999]),
         'weight': rng.choice([1, 3, 17, 100])}
        for judge in ['sharp', 'noisy'] for a, b in sorted(pairs)
    ]
    judge_sigma, hard = mode >= 2, mode % 2 == 1
    fit = fit_bt([JudgedComparison(**row) for row in rows], judge_sigma=judge_sigma, hard=hard)
    return {
        'seed': seed, 'items': size, 'judgeSigma': judge_sigma, 'hard': hard,
        'rows': [{'judge': row['judge'], 'itemA': row['item_a'], 'itemB': row['item_b'],
                  'pA': row['p_a'], 'weight': row['weight']} for row in rows],
        'ranking': fit.ranking, 'converged': fit.converged,
        'probabilities': [1 / (1 + math.exp(-(fit.skills[row['item_a']] - fit.skills[row['item_b']]) /
                                           fit.sigmas.get(row['judge'], 1))) for row in rows],
    }


rng = random.Random(5992026)
cases = [build_case(size, mode, rng, 5992026) for size in [3, 10, 50] for mode in range(4)]
cases.extend(build_case(50, 2, random.Random(seed), seed) for seed in [5991, 5992, 5993])
json.dump({'source': 'a59c3a862dcb6a991ba660fe1bd13f56838b73ed', 'pythonVersion': '1.85.0',
           'probabilityTolerance': .0003, 'cases': cases}, sys.stdout, separators=(',', ':'))
