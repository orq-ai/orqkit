import json, sys, typing, types
from importlib.metadata import version

if version('evaluatorq') != '1.85.0':
    raise SystemExit('Use evaluatorq v1.85.0, commit a59c3a862dcb6a991ba660fe1bd13f56838b73ed')

from pydantic import AliasChoices, AliasPath, BaseModel
from evaluatorq.redteam.run_config import RedTeamCliConfig
from evaluatorq.simulation.run_config import GenerateAndSimulateCliConfig, SimulateCliConfig
ROOTS = [RedTeamCliConfig, SimulateCliConfig, GenerateAndSimulateCliConfig]
models = {}
def refs(t):
    o = typing.get_origin(t); a = typing.get_args(t)
    if isinstance(t, type) and issubclass(t, BaseModel):
        visit(t); return [t.__name__]
    if o is typing.Annotated: return refs(a[0])
    if o in (dict, typing.Mapping) or t is dict:
        return [['r', n] for n in refs(a[-1])] if a else []
    if o is not None:
        return [n for x in a if x is not Ellipsis for n in refs(x)]
    return []
def names(name, f):
    out = [name]
    for alias in (f.alias, f.validation_alias):
        if isinstance(alias, str): out.append(alias)
        elif isinstance(alias, AliasChoices):
            out += [c for c in alias.choices if isinstance(c, str)]
    return list(dict.fromkeys(out))
def visit(c):
    n = c.__name__
    if n in models: return
    models[n] = {}
    fields = {}
    for name, f in c.model_fields.items():
        r = refs(f.annotation)
        for key in names(name, f): fields[key] = r
    models[n] = fields
for r in ROOTS: visit(r)
json.dump({'roots': [r.__name__ for r in ROOTS], 'models': models}, sys.stdout, indent=None)
