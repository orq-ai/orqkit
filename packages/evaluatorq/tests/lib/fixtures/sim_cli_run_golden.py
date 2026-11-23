import json, os, shutil, sys
from pathlib import Path
import typer.core
from typer.testing import CliRunner
typer.core.rich = None
from evaluatorq.simulation import api, cli
from evaluatorq.simulation.contracts import SimulationRun

out_path, work = Path(sys.argv[1]), Path(sys.argv[2])
if work.exists(): shutil.rmtree(work)
work.mkdir(parents=True)
for key in ('ORQ_API_KEY', 'OPENAI_API_KEY'):
    os.environ.pop(key, None)
runner = CliRunner()
dp = {'id': 'dp-1', 'persona': {'name': 'P', 'patience': 0.5, 'assertiveness': 0.5, 'politeness': 0.5,
      'technical_level': 0.5, 'communication_style': 'casual', 'background': 'b'},
      'scenario': {'name': 'S', 'goal': 'g'}, 'user_system_prompt': 'u', 'first_message': 'hi'}
good = work / 'good.jsonl'; good.write_text(json.dumps(dp) + '\n')
envelope = work / 'envelope.jsonl'
envelope.write_text(json.dumps({'inputs': {'persona': json.dumps(dp['persona']), 'scenario': json.dumps(dp['scenario']),
    'first_message': 'hi', 'user_system_prompt': 'u', 'category': 'P - S'}, 'expected_output': ''}) + '\n')
empty = work / 'empty.jsonl'; empty.write_text('\n')
run = SimulationRun(run_name='My Run', created_at='2026-01-02T03:04:05+00:00', mode='simulate', target_kind='orq_agent',
    target='x', evaluator_names=['goal_achieved'], total_results=0, scorer_averages={}, results=[], run_id=None)
(work / 'run.json').write_text(run.model_dump_json())
calls = []
async def fake_sim(**kwargs):
    calls.append(sorted(k for k, v in kwargs.items() if v is not None and k != 'hooks'))
    return run
api._simulate_run = fake_sim
api._generate_and_simulate_run = fake_sim

def inv(args):
    r = runner.invoke(cli.app, args)
    return {'exit_code': r.exit_code, 'stdout': r.stdout, 'stderr': r.stderr}
G, T, V = str(good), ['--target', 'agent:x'], ['--vercel-url', 'http://localhost:1']
cases = {
    'no_input': inv(['simulate', *T, '-q']),
    'two_inputs': inv(['simulate', '-i', G, '--from-run', 'latest', *T, '-q']),
    'run_id_without_exp': inv(['simulate', '--dataset-id', 'd', '--experiment-run-id', 'r', *T, '-q']),
    'dataset_no_key': inv(['simulate', '--dataset-id', 'd', *T, '-q']),
    'config_inline_and_flag': inv(['simulate', '--config', json.dumps({'personas': [dp['persona']], 'scenarios': [dp['scenario']], 'dataset_id': 'z'}), *T, '-q']),
    'no_target': inv(['simulate', '-i', G, '-q']),
    'two_targets': inv(['simulate', '-i', G, *T, '--vercel-url', 'http://localhost:1', '-q']),
    'blank_memory': inv(['simulate', '-i', G, *T, '--memory-entity', '  ', '-q']),
    'memory_no_target': inv(['simulate', '-i', G, '--vercel-url', 'http://localhost:1', '--memory-entity', 'm', '-q']),
    'memory_deployment': inv(['simulate', '-i', G, '--target', 'deployment:d', '--memory-entity', 'm', '-q']),
    'deployment_no_key': inv(['simulate', '-i', G, '--target', 'deployment:d', '-q']),
    'openai_no_key': inv(['simulate', '-i', G, '--openai-model', 'gpt-x', '-q']),
    'unknown_evaluator': inv(['simulate', '-i', G, *V, '--evaluator', 'nope', '-q']),
    'missing_input': inv(['simulate', '-i', str(work / 'nope.jsonl'), *T, '-q']),
    'empty_input': inv(['simulate', '-i', str(empty), *T, '-q']),
    'bad_config': inv(['simulate', '--config', '{"bogus": 1}', *T, '-q']),
    'alias_conflict': inv(['simulate', '--config', '{"run_name": "a", "evaluation_name": "b"}', '-i', G, *T, '-q']),
    'sim_model_line': inv(['simulate', *T, '--sim-model', 'my-model', '-q']),
    'run_no_description': inv(['run', '--vercel-url', 'http://localhost:1', '-q']),
    'run_deployment_description': inv(['run', '--target', 'deployment:d', '-q']),
    'success': inv(['simulate', '-i', G, *V, '--no-save', '--report', str(work / 'reports') + '/',
                    '--results', str(work / 'out' / 'res.jsonl'), '-q']),
    'success_envelope_json': inv(['simulate', '-i', str(envelope), *V, '--no-save', '--json', '-q']),
    'success_md': inv(['simulate', '-i', G, *V, '--no-save', '--report-md', str(work / 'md'), '-q']),
    'run_success': inv(['run', '--agent-description', 'desc', *V, '--no-save', '-q']),
}
files = sorted(str(p.relative_to(work)) for p in work.rglob('*') if p.is_file())
text = json.dumps({'cases': cases, 'calls': calls, 'files': files,
    'inputs': {n: (work / n).read_text() for n in ('good.jsonl', 'envelope.jsonl', 'empty.jsonl', 'run.json')}}, indent=1)
out_path.write_text(text.replace(str(work), '/python-work'))
