#!/usr/bin/env python3
"""Smoke test for evaluatorq.redteam — calls the library directly for manual testing.

Usage:
    uv run python scripts/smoke_test_redteam.py --target agent:my-agent --mode dynamic --max-turns 3 --max-datapoints 5
    uv run python scripts/smoke_test_redteam.py --target agent:a --target agent:b --mode dynamic --max-datapoints 3
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Smoke test for evaluatorq.redteam')
    parser.add_argument('--target', action='append', required=True, help='Target identifier (repeatable for multi-target)')
    parser.add_argument('--mode', default='dynamic', choices=['dynamic', 'static', 'hybrid'])
    parser.add_argument('--max-turns', type=int, default=3)
    parser.add_argument('--categories', nargs='+', default=None)
    parser.add_argument('--parallelism', type=int, default=5)
    parser.add_argument('--max-datapoints', type=int, default=None)
    parser.add_argument('--attack-model', default='azure/gpt-5-mini')
    parser.add_argument('--evaluator-model', default='azure/gpt-5-mini')
    parser.add_argument('--dataset-path', default=None)
    return parser.parse_args()


async def main() -> None:
    args = parse_args()

    if len(args.target) == 1:
        from evaluatorq.redteam import red_team

        report = await red_team(
            args.target[0],
            mode=args.mode,
            max_turns=args.max_turns,
            categories=args.categories,
            parallelism=args.parallelism,
            max_datapoints=args.max_datapoints,
            attack_model=args.attack_model,
            evaluator_model=args.evaluator_model,
            dataset_path=args.dataset_path,
        )
        print(json.dumps(report.summary.model_dump(mode='json'), indent=2))
    else:
        from evaluatorq.redteam import red_team_multi

        result = await red_team_multi(
            args.target,
            mode=args.mode,
            max_turns=args.max_turns,
            categories=args.categories,
            parallelism=args.parallelism,
            max_datapoints=args.max_datapoints,
            attack_model=args.attack_model,
            evaluator_model=args.evaluator_model,
            dataset_path=args.dataset_path,
        )
        output = {
            'merged_summary': result.merged.summary.model_dump(mode='json'),
            'by_target': {
                t: r.summary.model_dump(mode='json')
                for t, r in result.by_target.items()
            },
        }
        print(json.dumps(output, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
