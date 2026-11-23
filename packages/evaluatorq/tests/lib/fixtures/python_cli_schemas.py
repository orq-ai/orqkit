import json, sys
from importlib.metadata import version

if version('evaluatorq') != '1.85.0':
    raise SystemExit('Use evaluatorq v1.85.0, commit a59c3a862dcb6a991ba660fe1bd13f56838b73ed')

from evaluatorq.redteam.run_config import RedTeamCliConfig
from evaluatorq.redteam.contracts import RedTeamReport
from evaluatorq.simulation.run_config import SimulateCliConfig, GenerateAndSimulateCliConfig
from evaluatorq.simulation.contracts import SimulationRun
out = {
  'RedTeamCliConfig': RedTeamCliConfig.model_json_schema(mode='validation'),
  'RedTeamReport': RedTeamReport.model_json_schema(mode='serialization'),
  'SimulateCliConfig': SimulateCliConfig.model_json_schema(mode='validation'),
  'GenerateAndSimulateCliConfig': GenerateAndSimulateCliConfig.model_json_schema(mode='validation'),
  'SimulationRun': SimulationRun.model_json_schema(mode='serialization'),
}
json.dump(out, sys.stdout)
