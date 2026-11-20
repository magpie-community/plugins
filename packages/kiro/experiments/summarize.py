import json
import random
import statistics
import sys
from pathlib import Path


def interval(values):
    rng = random.Random(104729)
    medians = sorted(statistics.median(rng.choices(values, k=len(values))) for _ in range(10000))
    return [medians[249], medians[9749]]


summaries = []
for filename in sys.argv[1:]:
    rows = [json.loads(line) for line in Path(filename).read_text().splitlines()]
    continuations = [row for row in rows if row["stage"] == "continuation"]
    pairs = {}
    for row in continuations:
        pairs.setdefault(row["pair"], {})[row["mode"]] = row
    assert all(set(pair) == {"replay", "drop"} for pair in pairs.values())
    assert all(pair["replay"]["inputHashWithoutReasoning"] == pair["drop"]["inputHashWithoutReasoning"] for pair in pairs.values())
    result = {"model": rows[0]["model"], "pairs": len(pairs), "modes": {}}
    for mode in ["replay", "drop"]:
        selected = [row for row in continuations if row["mode"] == mode]
        result["modes"][mode] = {
            "first_event_median_ms": statistics.median(row["firstEventMs"] for row in selected),
            "first_text_median_ms": statistics.median(row["firstTextMs"] for row in selected),
            "completion_median_ms": statistics.median(row["totalMs"] for row in selected),
            "mean_credits": statistics.mean(row["credits"] for row in selected),
            "correct": sum(row["correct"] for row in selected),
        }
    differences = [pair["replay"]["firstTextMs"] - pair["drop"]["firstTextMs"] for pair in pairs.values()]
    result["paired_first_text_difference_ms"] = statistics.median(differences)
    result["paired_first_text_bootstrap_95_interval_ms"] = interval(differences)
    result["replay_faster_pairs"] = sum(value < 0 for value in differences)
    result["replay_lower_credit_pairs"] = sum(pair["replay"]["credits"] < pair["drop"]["credits"] for pair in pairs.values())
    summaries.append(result)

print(json.dumps({
    "endpoint": "/v1/responses",
    "region": "us-east-1",
    "effort": "high",
    "account": "one fixed saved account",
    "design": "same native first response per pair; replay/drop alternate order; only reasoning items differ",
    "task": "minimum cost directed path on a 16-vertex, 54-edge DAG, followed by an empty confirm tool call and approved result",
    "seeds": "104729 + pair index",
    "timing": "measured from continuation fetch start; first text is the first response.output_text.delta; total is stream completion",
    "ground_truth": "computed independently with DAG shortest-path dynamic programming",
    "results": summaries,
}, indent=2))
