import json, os, shutil, sys
from pathlib import Path
from typer.testing import CliRunner
from evaluatorq import fetch_data
from evaluatorq.simulation import cli
from evaluatorq.simulation.contracts import SimulationResult, SimulationRun

out_path, work = Path(sys.argv[1]), Path(sys.argv[2])
if work.exists(): shutil.rmtree(work)
work.mkdir(parents=True)
for key in ('ORQ_API_KEY', 'OPENAI_API_KEY', 'ORQ_BASE_URL'):
    os.environ.pop(key, None)
runner = CliRunner()
usage = {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}
def result(name, ok):
    return SimulationResult.model_validate({
        'messages': [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': 'hello'}],
        'terminated_by': 'judge', 'reason': 'done', 'goal_achieved': ok, 'goal_completion_score': 1.0 if ok else 0.2,
        'rules_broken': [] if ok else ['leaked'], 'turn_count': 1, 'token_usage': usage, 'turn_metrics': [],
        'metadata': {'persona': name, 'scenario': 'S', 'datapoint_id': f'dp-{name}'}})
results = [result('P', True), result('Q', False)]
(work / 'results.jsonl').write_text('\n'.join(r.model_dump_json() for r in results) + '\n')
run = SimulationRun(run_name='r', created_at='2026-01-02T03:04:05Z', mode='simulate', target_kind='callback', target='bot',
                    evaluator_names=[], total_results=2, scorer_averages={}, results=results,
                    recommendations=[{'result_index': 1, 'persona': 'Q', 'scenario': 'S', 'triggers': ['rule_broken: leaked'], 'suggestions': ['fix it']}])
(work / 'run.json').write_text(run.model_dump_json(indent=2))
(work / 'bad.jsonl').write_text('{"messages": 3}\n')
(work / 'dp.jsonl').write_text(json.dumps({'id': 'dp-1', 'persona': {'name': 'P', 'patience': 0.5, 'assertiveness': 0.5, 'politeness': 0.5,
    'technical_level': 0.5, 'communication_style': 'casual', 'background': 'b'}, 'scenario': {'name': 'S', 'goal': 'g'},
    'user_system_prompt': 'u', 'first_message': 'hi'}) + '\n')
(work / 'empty.jsonl').write_text('\n')

calls = []
class Created:
    id = 'ds_new'
class Datasets:
    def create(self, request):
        calls.append({'create': request}); return Created()
    def create_datapoint(self, dataset_id, request_body):
        calls.append({'create_datapoint': {'dataset_id': dataset_id, 'rows': request_body}})
class Client:
    datasets = Datasets()
fetch_data.setup_orq_client = lambda key: Client()

def inv(args, env=None):
    r = runner.invoke(cli.app, args, env=env)
    return {'exit_code': r.exit_code, 'stdout': r.stdout, 'stderr': r.stderr}
W = str(work)
KEY = {'ORQ_API_KEY': 'test-key'}
cases = {
    'export_missing': inv(['export', '-i', f'{W}/nope.jsonl', '-o', f'{W}/o.json']),
    'export_bad_format': inv(['export', '-i', f'{W}/results.jsonl', '-o', f'{W}/o.json', '--format', 'pdf']),
    'export_bad_line': inv(['export', '-i', f'{W}/bad.jsonl', '-o', f'{W}/o.json']),
    'export_openresponses': inv(['export', '-i', f'{W}/results.jsonl', '-o', f'{W}/out/or.json']),
    'export_run_openresponses': inv(['export', '-i', f'{W}/run.json', '-o', f'{W}/out/run-or.json']),
    'export_md_plain': inv(['export', '-i', f'{W}/results.jsonl', '-o', f'{W}/out/r.md', '--format', 'md']),
    'export_md_stored': inv(['export', '-i', f'{W}/run.json', '-o', f'{W}/out/run.md', '--format', 'md', '--target-label', 'bot']),
    'export_html_run': inv(['export', '-i', f'{W}/run.json', '-o', f'{W}/out/run.html', '--format', 'html']),
    'upload_missing': inv(['upload-dataset', '-i', f'{W}/nope.jsonl', '-n', 'x'], KEY),
    'upload_no_name': inv(['upload-dataset', '-i', f'{W}/dp.jsonl'], KEY),
    'upload_no_key': inv(['upload-dataset', '-i', f'{W}/dp.jsonl', '-n', 'x']),
    'upload_empty': inv(['upload-dataset', '-i', f'{W}/empty.jsonl', '-n', 'x'], KEY),
    'upload_create': inv(['upload-dataset', '-i', f'{W}/dp.jsonl', '-n', 'my set', '--path', 'proj/sims'], KEY),
    'upload_extend': inv(['upload-dataset', '-i', f'{W}/dp.jsonl', '--dataset-id', 'ds_old'], {**KEY, 'ORQ_BASE_URL': 'https://staging.orq.ai/'}),
}
or_payload = json.loads((work / 'out' / 'or.json').read_text())
files = {
    'inputs': {n: (work / n).read_text() for n in ('results.jsonl', 'run.json', 'bad.jsonl', 'dp.jsonl', 'empty.jsonl')},
    'or_count': len(or_payload),
    'or_keys': sorted(or_payload[0].keys()),
    'md_has_rec': 'fix it' in (work / 'out' / 'run.md').read_text(),
    'md_plain_has_rec': 'fix it' in (work / 'out' / 'r.md').read_text(),
    'html_has_rec': 'fix it' in (work / 'out' / 'run.html').read_text(),
}
text = json.dumps({'cases': cases, 'calls': calls, 'files': files}, indent=1)
out_path.write_text(text.replace(W, '/python-work'))
