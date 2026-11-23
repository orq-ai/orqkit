import json, shutil, sys
from pathlib import Path
from typer.testing import CliRunner
from evaluatorq.simulation import cli
from evaluatorq.common.run_manifest import start_manifest

out_path, work = Path(sys.argv[1]), Path(sys.argv[2])
if work.exists(): shutil.rmtree(work)
work.mkdir(parents=True)
runner = CliRunner()
def inv(args):
    r = runner.invoke(cli.app, args)
    return {'exit_code': r.exit_code, 'stdout': r.stdout, 'stderr': r.stderr}

dp = {'id': 'dp-1', 'persona': {'name': 'P', 'patience': 0.5, 'assertiveness': 0.5, 'politeness': 0.5,
      'technical_level': 0.5, 'communication_style': 'casual', 'background': 'b'},
      'scenario': {'name': 'S', 'goal': 'g'}, 'user_system_prompt': 'u', 'first_message': 'hi'}
good = work / 'good.jsonl'; good.write_text(json.dumps(dp) + '\n\n' + json.dumps({**dp, 'id': 'dp-2'}) + '\n')
bad = work / 'bad.jsonl'; bad.write_text(json.dumps(dp) + '\n{"id": "x"}\nnot json\n')
cases = {
    'validate_good': inv(['validate', '-i', str(good)]),
    'validate_bad': inv(['validate', str(bad)]),
    'validate_both': inv(['validate', '-i', str(good), str(good)]),
    'validate_missing': inv(['validate', '-i', str(work / 'nope.jsonl')]),
    'validate_dataset': inv(['validate-dataset', str(good)]),
    'schema_simulate': inv(['schema']),
    'schema_run': inv(['schema', '--command', 'run']),
    'schema_output': inv(['schema', '--output']),
}
runs = work / 'runs'; runs.mkdir()
(runs / 'legacy-run.json').write_text(json.dumps({'run_name': 'legacy', 'created_at': '2026-01-01T10:00:00+00:00', 'mode': 'simulate',
    'target_kind': 'agent', 'total_results': 3, 'scorer_averages': {'goal': 0.5}}))
(runs / 'broken.json').write_text('{not json')
rp = runs / 'managed-run.json'; rp.write_text('{}')
w = start_manifest(run_id='run-1', surface='sim', run_name='managed', runs_dir=runs)
w.complete(report_path=rp, summary={'mode': 'run', 'target_kind': 'openai', 'total_results': 2, 'scorer_averages': {'a': 0.123, 'b': 1}})
start_manifest(run_id='run-2', surface='sim', run_name='still going', runs_dir=runs)
cases['runs_json'] = inv(['runs', str(runs), '--json'])
cases['runs_limit1'] = inv(['runs', str(runs), '-n', '1', '--json'])
cases['runs_missing'] = inv(['runs', str(work / 'none')])
cases['runs_missing_json'] = inv(['runs', str(work / 'none'), '--json'])
manifests = {p.name: json.loads(p.read_text()) for p in (runs / '.manifests').glob('*.json')}
helpers = {'fmt_date': [[v, cli._fmt_date(v)] for v in ['2026-01-01T10:00:00.123+00:00', None, 5, '']],
           'scores': [[v, cli._format_scorer_averages(v)] for v in [{}, {'a': 0.125, 'b': 2}]],
           'simulate_command': cli._simulate_command(Path('my dir/dp.jsonl'), None)}
text = json.dumps({'work': str(work), 'cases': cases, 'helpers': helpers, 'manifests': manifests,
    'files': {'good.jsonl': good.read_text(), 'bad.jsonl': bad.read_text(), 'legacy-run.json': (runs / 'legacy-run.json').read_text()}}, indent=1)
out_path.write_text(text.replace(str(work), '/python-work'))
