import json, sys, typing, types
import typing_extensions
from pydantic import BaseModel
from evaluatorq.pairwise_run import PairwiseRun
from evaluatorq.trace_finder.settings import DashboardSettings
from evaluatorq.redteam.contracts import AttackStrategy, RedTeamReport
from evaluatorq.insights.models import InsightsRun
from evaluatorq.simulation.contracts import SimulationRun
from evaluatorq.types import DataPointResult
ROOTS = {'PairwiseRun': PairwiseRun, 'DashboardSettings': DashboardSettings,
         'RedTeamReport': RedTeamReport, 'InsightsRun': InsightsRun, 'DataPointResult': DataPointResult,
         'AttackStrategy': AttackStrategy, 'SimulationRun': SimulationRun}
models = {}
def camel(n):
    p = n.split('_'); return p[0] + ''.join(x[:1].upper() + x[1:] for x in p[1:])
def ref(t):
    o = typing.get_origin(t); a = typing.get_args(t)
    if isinstance(t, type) and issubclass(t, BaseModel):
        visit(t); return t.__name__
    if o is typing.Annotated: return ref(a[0])
    if typing_extensions.is_typeddict(t):
        if t.__name__ not in models:
            models[t.__name__] = {}
            models[t.__name__] = {camel(k): [k, ref(v)] for k, v in typing.get_type_hints(t).items()}
        return t.__name__
    if o in (dict, typing.Mapping) or t is dict:
        inner = ref(a[-1]) if a else None
        return ['r', inner] if inner is not None else None
    if o in (list, tuple, set, frozenset, typing.Sequence) or o is not None and str(o) in ('collections.abc.Sequence',):
        rs = [ref(x) for x in a if x is not Ellipsis]
        rs = [r for r in rs if r is not None]
        return rs[0] if len(rs) == 1 else merge(rs)
    if o in (typing.Union, types.UnionType):
        rs = [r for r in (ref(x) for x in a) if r is not None]
        return merge(rs)
    return None
def merge(rs):
    names = sorted({r for r in rs if isinstance(r, str)})
    if not names: return rs[0] if rs else None
    if len(names) == 1: return names[0]
    key = '|'.join(names)
    if key not in models:
        fields = {}
        for n in names: fields.update(models[n])
        models[key] = fields
    return key
def visit(c):
    n = c.__name__
    if n in models: return
    models[n] = {}
    fields = {}
    for name, f in c.model_fields.items():
        key = f.serialization_alias or f.alias or name
        if not isinstance(key, str): key = name
        fields[camel(name)] = [key, ref(f.annotation)]
    models[n] = fields
for r in ROOTS.values(): visit(r)
# Python stores these as plain dicts; TS parses them into typed objects.
BT = ['p_a_beats_b', 'skill_gap', 'judge_sigmas', 'repetition_consistency', 'repetition_consistency_raw',
      'winners', 'a_win_rate', 'b_win_rate', 'tie_rate', 'inconclusive_rate', 'converged', 'fit_warnings']
models['BTSigmaAggregation'] = {camel(k): [k, None] for k in BT}
models['PairwiseReport']['btSigma'] = ['bt_sigma', 'BTSigmaAggregation']
json.dump({'roots': list(ROOTS), 'models': models}, sys.stdout, indent=None, sort_keys=True)
