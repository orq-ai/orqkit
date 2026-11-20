import json, os, shutil, sys
from pathlib import Path
from typer.testing import CliRunner
from evaluatorq.simulation import api, cli, traces
from evaluatorq.simulation.contracts import SimulationDatapoint

out_path, work = Path(sys.argv[1]), Path(sys.argv[2])
if work.exists(): shutil.rmtree(work)
work.mkdir(parents=True)
for key in ('ORQ_API_KEY', 'OPENAI_API_KEY'):
    os.environ.pop(key, None)
runner = CliRunner()
dp = {'id': 'dp-1', 'persona': {'name': 'P', 'patience': 0.5, 'assertiveness': 0.5, 'politeness': 0.5,
      'technical_level': 0.5, 'communication_style': 'casual', 'background': 'b'},
      'scenario': {'name': 'S', 'goal': 'g'}, 'user_system_prompt': 'u', 'first_message': 'hi'}
dps = [SimulationDatapoint.model_validate(dp), SimulationDatapoint.model_validate({**dp, 'id': 'dp-2', 'persona': {**dp['persona'], 'name': 'Q'}})]
gen_calls, trace_calls = [], []
async def fake_generate(**kwargs):
    gen_calls.append({k: kwargs[k] for k in ('agent_description', 'num_personas', 'num_scenarios')})
    return list(dps)
api.generate = fake_generate
state = {'conversations': ['c1', 'c2'], 'direct': list(dps[:1])}
async def fake_fetch(**kwargs):
    trace_calls.append({'fetch': {k: v for k, v in kwargs.items() if k != 'start_date_ms'}, 'has_start': kwargs.get('start_date_ms') is not None})
    return state['conversations']
async def fake_summarize(conversations, **kwargs):
    trace_calls.append({'summarize': kwargs['config'].model_dump()})
    return {}
async def fake_from(conversations, **kwargs):
    return list(state['direct'])
async def fake_extend(conversations, **kwargs):
    trace_calls.append({'extend': kwargs['num_datapoints'], 'agent_description': kwargs.get('agent_description')})
    return list(dps[1:]) * kwargs['num_datapoints']
traces.fetch_trace_conversations = fake_fetch
traces.summarize_conversations = fake_summarize
traces.datapoints_from_traces = fake_from
traces.extend_from_traces = fake_extend

def inv(args):
    r = runner.invoke(cli.app, args)
    return {'exit_code': r.exit_code, 'stdout': r.stdout, 'stderr': r.stderr}
cases = {
    'generate_quiet': inv(['generate', '-d', str(work / 'gen' / 'dp.jsonl'), '--agent-description', 'desc', '-q']),
    'generate_dataset_format': inv(['generate', '-d', str(work / 'ds.jsonl'), '--agent-description', 'desc', '--dataset-format', '-q', '--num-personas', '2']),
    'generate_loud': inv(['generate', '-d', str(work / 'loud.jsonl'), '--agent-description', 'desc', '--target', 'agent:bot']),
    'generate_no_description': inv(['generate', '-d', str(work / 'x.jsonl'), '-q']),
    'traces_basic': inv(['from-traces', '-o', str(work / 'tr.jsonl'), '-q']),
    'traces_extend': inv(['from-traces', '-o', str(work / 'tr2.jsonl'), '--extend', '2', '--agent-description', 'bot',
                          '--limit', '5', '--search', 'refund', '--lookback-hours', '2', '--replay-first-message',
                          '--no-redact-pii', '--max-summaries', '7', '-q']),
}
state['conversations'] = []
cases['traces_none'] = inv(['from-traces', '-o', str(work / 'tr3.jsonl'), '-q'])
state['conversations'] = ['c1']; state['direct'] = []
cases['traces_empty'] = inv(['from-traces', '-o', str(work / 'tr4.jsonl'), '-q'])
files = {str(p.relative_to(work)): p.read_text() for p in sorted(work.rglob('*.jsonl'))}
text = json.dumps({'cases': cases, 'gen_calls': gen_calls, 'trace_calls': trace_calls, 'files': files, 'datapoints': [d.model_dump(mode='json') for d in dps]}, indent=1)
out_path.write_text(text.replace(str(work), '/python-work'))
