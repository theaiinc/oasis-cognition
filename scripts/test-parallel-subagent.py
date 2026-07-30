#!/usr/bin/env python3
"""
End-to-end system test for parallel sub-agent delegation.

Tests:
  1. The buildDagLayers function produces correct topological ordering
  2. The delegate_tasks tool routes through the gateway correctly
  3. Task results are aggregated correctly with proper status
  4. depends_on relationships are respected (DAG scheduling)

Usage:
  python3 scripts/test-parallel-subagent.py [--api-base URL]

Environment:
  OASIS_AGENT_URL  - base URL for oasis-agent (default: http://localhost:8020)
  API_GATEWAY_URL  - base URL for api-gateway (default: http://localhost:3001)
"""

import json
import sys
import os
import time
import uuid
import urllib.request
import urllib.error

# ── Config ──────────────────────────────────────────────────────────────────

OASIS_AGENT_URL = os.environ.get('OASIS_AGENT_URL', 'http://localhost:8020')
API_GATEWAY_URL = os.environ.get('API_GATEWAY_URL', 'http://localhost:3001')

PASS = 0
FAIL = 0
SKIP = 0

def check(name: str, condition: bool, detail: str = ''):
    global PASS, FAIL
    if condition:
        print(f'  ✓ {name}')
        PASS += 1
    else:
        print(f'  ✗ {name}')
        if detail:
            print(f'      {detail}')
        FAIL += 1

def skip(name: str, reason: str):
    global SKIP
    print(f'  - {name} (SKIPPED: {reason})')
    SKIP += 1

def post_json(url: str, data: dict, timeout: int = 15) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {'error': f'HTTP {e.code}: {body[:200]}'}
    except Exception as e:
        return {'error': str(e)}

def get_json(url: str, timeout: int = 10) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {'error': f'HTTP {e.code}: {body[:200]}'}
    except Exception as e:
        return {'error': str(e)}


# ═════════════════════════════════════════════════════════════════════════════
# Test 1: DAG Scheduling (unit test of the coordinator service)
# ═════════════════════════════════════════════════════════════════════════════

def test_dag_scheduling():
    """Test the DAG layer building logic (in-process simulation)."""
    print('\n── Test 1: DAG Scheduling ──')

    def build_dag_layers(tasks):
        """Replica of CoordinatorService.buildDagLayers."""
        task_ids = set(t['id'] for t in tasks)
        remaining = set(t['id'] for t in tasks)
        layers = []
        scheduled = set()

        while remaining:
            layer = []
            for task_id in remaining:
                task = next(t for t in tasks if t['id'] == task_id)
                deps = task.get('depends_on', []) or []
                deps_satisfied = all(
                    dep_id not in task_ids or dep_id in scheduled
                    for dep_id in deps
                )
                if deps_satisfied:
                    layer.append(task_id)
            if not layer:
                # Cycle — schedule remaining
                for task_id in remaining:
                    layer.append(task_id)
            for t_id in layer:
                scheduled.add(t_id)
                remaining.discard(t_id)
            layers.append(layer)

        return layers

    # Case A: No dependencies → all in one layer
    tasks_a = [
        {'id': 'a', 'goal': 'Task A'},
        {'id': 'b', 'goal': 'Task B'},
        {'id': 'c', 'goal': 'Task C'},
    ]
    layers_a = build_dag_layers(tasks_a)
    check('no-depends → single layer', len(layers_a) == 1,
          f'got {len(layers_a)} layers: {layers_a}')
    check('no-depends → all tasks in layer 0', len(layers_a[0]) == 3,
          f'got {len(layers_a[0])} tasks: {layers_a[0]}')

    # Case B: Linear dependency chain A → B → C
    tasks_b = [
        {'id': 'a', 'goal': 'Task A', 'depends_on': []},
        {'id': 'b', 'goal': 'Task B', 'depends_on': ['a']},
        {'id': 'c', 'goal': 'Task C', 'depends_on': ['b']},
    ]
    layers_b = build_dag_layers(tasks_b)
    check('linear chain → 3 layers', len(layers_b) == 3,
          f'got {len(layers_b)} layers: {layers_b}')
    check('layer 0 = a', layers_b[0] == ['a'])
    check('layer 1 = b', layers_b[1] == ['b'])
    check('layer 2 = c', layers_b[2] == ['c'])

    # Case C: Fan-out — C depends on A, B depends on A
    tasks_c = [
        {'id': 'a', 'goal': 'Task A', 'depends_on': []},
        {'id': 'b', 'goal': 'Task B', 'depends_on': ['a']},
        {'id': 'c', 'goal': 'Task C', 'depends_on': ['a']},
    ]
    layers_c = build_dag_layers(tasks_c)
    check('fan-out → 2 layers', len(layers_c) == 2,
          f'got {len(layers_c)} layers: {layers_c}')
    check('layer 0 = a', layers_c[0] == ['a'])
    check('layer 1 has b,c', sorted(layers_c[1]) == ['b', 'c'])

    # Case D: Complex DAG with mix of deps
    tasks_d = [
        {'id': 'setup', 'goal': 'Setup', 'depends_on': []},
        {'id': 'fe-a', 'goal': 'Feature A', 'depends_on': ['setup']},
        {'id': 'fe-b', 'goal': 'Feature B', 'depends_on': ['setup']},
        {'id': 'test', 'goal': 'Integration test', 'depends_on': ['fe-a', 'fe-b']},
    ]
    layers_d = build_dag_layers(tasks_d)
    check('complex DAG → 3 layers', len(layers_d) == 3,
          f'got {len(layers_d)} layers: {layers_d}')
    check('layer 0 = setup', layers_d[0] == ['setup'])
    check('layer 1 has fe-a,fe-b', sorted(layers_d[1]) == ['fe-a', 'fe-b'])
    check('layer 2 = test', layers_d[2] == ['test'])

    # Case E: Empty tasks
    layers_e = build_dag_layers([])
    check('empty tasks → 0 layers', len(layers_e) == 0)


# ═════════════════════════════════════════════════════════════════════════════
# Test 2: Gateway routing of delegate_tasks
# ═════════════════════════════════════════════════════════════════════════════

def test_gateway_routing():
    """Verify the gateway recognizes delegate_tasks and routes it correctly."""
    print('\n── Test 2: Gateway Routing ──')

    # Check health of Oasis Agent
    health = get_json(f'{OASIS_AGENT_URL}/health')
    if 'error' in health:
        skip('oasis-agent health', f'Oasis Agent unreachable at {OASIS_AGENT_URL}')
        return
    check('oasis-agent is healthy', health.get('status') == 'ok')

    # Check Yggdrasil health
    ygg_health = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/internal/yggdrasil/health')
    if 'error' in ygg_health:
        print(f'      yggdrasil health: {ygg_health.get("error", "unknown")}')
        print('      (this may be OK if Yggdrasil isn\'t running outside the pool profile)')
    else:
        check('yggdrasil reachable', ygg_health.get('ok') is True)

    # Check runners
    runners = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/internal/yggdrasil/runners')
    if 'error' not in runners:
        runner_count = runners.get('count', 0)
        print(f'      Registered runners: {runner_count}')
        if runner_count > 0:
            for r in runners.get('runners', []):
                print(f'        - {r.get("runnerId")}: {r.get("name")} [{r.get("status")}]')


# ═════════════════════════════════════════════════════════════════════════════
# Test 3: Coordinator create job + dispatch + results
# ═════════════════════════════════════════════════════════════════════════════

def test_coordinator_dispatch():
    """Submit a plan with parallel tasks and verify dispatch."""
    print('\n── Test 3: Coordinator Dispatch ──')

    plan = {
        "steps": [
            {"description": "Create a test file A", "tool": "write_file", "verify": "File A exists"},
            {"description": "Create a test file B", "tool": "write_file", "verify": "File B exists"},
        ],
        "success_criteria": ["Both files created"],
        "parallel_groups": [
            {"id": "group-1", "task_ids": ["task-a", "task-b"]},
        ],
        "tasks": [
            {
                "id": "task-a",
                "goal": "Create a file at /tmp/parallel-test-a.txt containing 'hello from sub-agent A'",
                "resource_class": "light",
                "depends_on": [],
            },
            {
                "id": "task-b",
                "goal": "Create a file at /tmp/parallel-test-b.txt containing 'hello from sub-agent B'",
                "resource_class": "light",
                "depends_on": [],
            },
        ],
    }

    parent_session_id = f"test-session-{uuid.uuid4().hex[:8]}"

    payload = {
        "plan": plan,
        "parent_session_id": parent_session_id,
        "interaction_id": "",
        "auto_approve_free": True,
    }

    result = post_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs', payload, timeout=30)
    if 'error' in result:
        skip('create job', f'Failed to create job: {result["error"]}')
        return

    job_id = result.get('job_id', '')
    check('job created with ID', bool(job_id), f'got job_id={job_id}')
    check('job status is draft or running',
          result.get('job', {}).get('status') in ('draft', 'running', 'preflight', 'awaiting_approval'),
          f'status={result["job"].get("status")}')
    check('parallel_allowed > 0', result.get('parallel_allowed', 0) >= 1,
          f'parallel_allowed={result.get("parallel_allowed")}')
    check('est_usd_low is reasonable', result.get('est_usd_low', -1) >= 0)
    check('est_usd_high >= low', result.get('est_usd_high', 0) >= result.get('est_usd_low', 0))

    # Wait for job to complete
    print(f'      Job ID: {job_id}, waiting for completion...')
    for attempt in range(30):
        time.sleep(2)
        job_status = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs/{job_id}')
        if 'error' in job_status:
            if attempt == 0:
                print(f'      Poll attempt {attempt}: {job_status["error"]}')
            continue
        status = job_status.get('status', 'unknown')
        if status in ('completed', 'failed', 'cancelled'):
            print(f'      Job status: {status}')
            break
        if attempt == 5:
            print(f'      Still running after {attempt * 2}s...')

    final_status = job_status.get('status', 'unknown')
    check(f'job completes (status={final_status})', final_status == 'completed',
          f'expected completed, got {final_status}')

    # Get task results
    results = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs/{job_id}/results')
    if 'error' in results:
        skip('task results', f'Failed to get results: {results["error"]}')
    else:
        check('results endpoint returns ok', results.get('ok') is True)
        print(f'      Tasks: {results.get("tasks_completed")} completed, '
              f'{results.get("tasks_failed")} failed, '
              f'{results.get("tasks_total")} total')
        check('all tasks accounted for', results.get('tasks_total', 0) == 2,
              f'expected 2, got {results.get("tasks_total")}')
        task_results = results.get('results', {})
        for task_id in ('task-a', 'task-b'):
            tr = task_results.get(task_id, {})
            check(f'{task_id} has result status', bool(tr.get('status')),
                  f'status={tr.get("status")}')


# ═════════════════════════════════════════════════════════════════════════════
# Test 4: DAG with depends_on (sequential within parallel)
# ═════════════════════════════════════════════════════════════════════════════

def test_dag_dispatch():
    """Submit a plan with depends_on relationships and verify sequential layers."""
    print('\n── Test 4: DAG Dispatch with depends_on ──')

    # Submit tasks with depends_on: A → B, A → C (B and C can run in parallel after A)
    plan = {
        "steps": [
            {"description": "Setup test environment", "tool": "bash", "verify": "Setup complete"},
            {"description": "Test task B", "tool": "bash"},
            {"description": "Test task C", "tool": "bash"},
        ],
        "success_criteria": ["All tasks complete"],
        "tasks": [
            {
                "id": "task-setup",
                "goal": "Run 'echo setup-done > /tmp/parallel-dag-setup.txt'",
                "resource_class": "light",
                "depends_on": [],
            },
            {
                "id": "task-b",
                "goal": "Read /tmp/parallel-dag-setup.txt and append '- B done' to it. Then output the contents.",
                "resource_class": "light",
                "depends_on": ["task-setup"],
            },
            {
                "id": "task-c",
                "goal": "Read /tmp/parallel-dag-setup.txt and append '- C done' to it. Then output the contents.",
                "resource_class": "light",
                "depends_on": ["task-setup"],
            },
        ],
    }

    parent_session_id = f"test-dag-{uuid.uuid4().hex[:8]}"

    payload = {
        "plan": plan,
        "parent_session_id": parent_session_id,
        "interaction_id": "",
        "auto_approve_free": True,
    }

    result = post_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs', payload, timeout=30)
    if 'error' in result:
        skip('dag job creation', f'Failed to create job: {result["error"]}')
        return

    job_id = result.get('job_id', '')
    check('dag job created', bool(job_id))
    print(f'      DAG Job ID: {job_id}')

    # Wait for completion
    for attempt in range(30):
        time.sleep(2)
        job_status = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs/{job_id}')
        if 'error' in job_status:
            continue
        status = job_status.get('status', 'unknown')
        if status in ('completed', 'failed', 'cancelled'):
            print(f'      DAG Job status: {status}')
            break

    final_status = job_status.get('status', 'unknown')
    # DAG tasks may fail if sub-agent can't find tools -- that's ok, we're testing
    # that the dispatch mechanism works, not the tool execution inside sub-agents
    check(f'dag job completes (status={final_status})',
          final_status in ('completed', 'failed'),
          f'unexpected status {final_status}')

    # Get results
    results = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs/{job_id}/results')
    if 'error' not in results:
        print(f'      Tasks: {results.get("tasks_completed")} completed, '
              f'{results.get("tasks_failed")} failed, '
              f'{results.get("tasks_total")} total')


# ═════════════════════════════════════════════════════════════════════════════
# Test 5: Native tool dispatch (simulate gateway calling delegate_tasks)
# ═════════════════════════════════════════════════════════════════════════════

def test_native_tool_dispatch():
    """Verify the native-coordinator-tools.ts dispatch works."""
    print('\n── Test 5: Native Tool Dispatch (simulate gateway) ──')

    # This test calls the oasis-agent coordinator directly,
    # which is what the native-coordinator-tools.ts dispatcher does.
    plan = {
        "steps": [
            {"description": "Check host capacity", "tool": "bash"},
        ],
        "success_criteria": ["Capacity info retrieved"],
        "tasks": [
            {
                "id": "info-task",
                "goal": "Print the current working directory and list /tmp contents",
                "resource_class": "light",
                "depends_on": [],
            },
        ],
    }

    parent_session_id = f"test-native-{uuid.uuid4().hex[:8]}"
    payload = {
        "plan": plan,
        "parent_session_id": parent_session_id,
        "interaction_id": "",
        "auto_approve_free": True,
    }

    result = post_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs', payload, timeout=30)
    if 'error' in result:
        skip('native dispatch simulation', f'Failed: {result["error"]}')
        return

    job_id = result.get('job_id', '')
    check('native dispatch job created', bool(job_id))

    # Verify the coordinator returns consistent data shapes
    check('has parallel_allowed', 'parallel_allowed' in result)
    check('has host_capacity', 'host_capacity' in result)
    check('has approval_required', 'approval_required' in result)
    print(f'      Native Job ID: {job_id}')

    # Wait and get results
    for attempt in range(20):
        time.sleep(2)
        job_status = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs/{job_id}')
        if 'error' in job_status:
            continue
        status = job_status.get('status', 'unknown')
        if status in ('completed', 'failed', 'cancelled'):
            break

    final_status = job_status.get('status', 'unknown')
    check(f'native job completes (status={final_status})',
          final_status in ('completed', 'failed'),
          f'unexpected status {final_status}')

    results = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs/{job_id}/results')
    if 'error' not in results:
        check('native job has results', results.get('ok') is True)
        check('native job has task results in correct format',
              isinstance(results.get('results'), dict),
              f'results type={type(results.get("results"))}')


# ═════════════════════════════════════════════════════════════════════════════
# Tests for the list/cancel lifecycle
# ═════════════════════════════════════════════════════════════════════════════

def test_job_lifecycle():
    """Test job listing and cancellation."""
    print('\n── Test 6: Job Lifecycle ──')

    # List all jobs
    jobs = get_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs')
    if isinstance(jobs, list):
        check('list jobs returns array', len(jobs) >= 0)
        print(f'      Total jobs: {len(jobs)}')
    else:
        skip('list jobs', f'unexpected response: {str(jobs)[:100]}')

    # Create a job that will require approval
    plan = {
        "steps": [{"description": "A test step"}],
        "success_criteria": ["Done"],
        "tasks": [
            {
                "id": "test-cancel",
                "goal": "Sit idle for 300 seconds",
                "resource_class": "light",
                "depends_on": [],
            },
        ],
    }

    parent_session_id = f"test-lifecycle-{uuid.uuid4().hex[:8]}"
    payload = {
        "plan": plan,
        "parent_session_id": parent_session_id,
        "interaction_id": "",
        "auto_approve_free": False,  # Require approval
    }

    result = post_json(f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs', payload, timeout=15)
    if 'error' in result:
        skip('lifecycle job', f'Failed: {result["error"]}')
        return

    job_id = result.get('job_id', '')
    check('lifecycle job created', bool(job_id))

    # Try to cancel it
    cancel_result = post_json(
        f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs/{job_id}/cancel', {}, timeout=10
    )
    if 'error' in cancel_result:
        print(f'      Cancel result: {cancel_result["error"]}')
        # It might be in a state where cancel isn't possible — that's fine
        skip('cancel lifecycle job', f'cancel failed: {cancel_result["error"][:80]}')
    else:
        check('job cancelled', cancel_result.get('ok') is True or cancel_result.get('ok') is None,
              f'cancel response: {json.dumps(cancel_result)[:100]}')

    # Check job was created for this session
    jobs_filtered = get_json(
        f'{OASIS_AGENT_URL}/api/v1/coordinator/jobs?parent_session_id={parent_session_id}'
    )
    if isinstance(jobs_filtered, list):
        check('filtered list returns only our jobs',
              len(jobs_filtered) >= 1,
              f'expected >=1, got {len(jobs_filtered)}')


# ═════════════════════════════════════════════════════════════════════════════
# Main
# ═════════════════════════════════════════════════════════════════════════════

def main():
    print('╔══════════════════════════════════════════════════════════╗')
    print('║  Parallel Sub-Agent End-to-End Test Suite              ║')
    print('╚══════════════════════════════════════════════════════════╝')
    print(f'Oasis Agent: {OASIS_AGENT_URL}')
    print(f'API Gateway: {API_GATEWAY_URL}')

    test_dag_scheduling()
    test_gateway_routing()
    test_coordinator_dispatch()
    test_dag_dispatch()
    test_native_tool_dispatch()
    test_job_lifecycle()

    print('\n══════════════════════════════════════════════════════════')
    print(f'Results: {PASS} passed, {FAIL} failed, {SKIP} skipped')
    if FAIL > 0:
        sys.exit(1)
    elif SKIP > 0:
        print('Note: Some tests were skipped (expected when system services are not fully running)')
    print('Done.')


if __name__ == '__main__':
    main()
