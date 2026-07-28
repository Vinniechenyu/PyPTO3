# Issues for hw-native-sys/simpler

Downloaded: 2026-07-16T16:43:26.3378318+08:00
Total issues: 212

## #31 Add `aicpu_build_graph` runtime (AICPU builds + AICPU schedules)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/31
- Created: 2026-02-02T18:34:13Z
- Updated: 2026-02-08T16:27:07Z
- Closed: 2026-02-08T16:27:06Z

### Body

Ask for advice on the following plan. Thanks in advance.

## Summary

Today, this repo builds the task graph on the **host** (via a host orchestration `.so` executed during `Runtime.initialize()`), then runs an AICPU scheduler with `N` AICPU instances to dispatch tasks to AICore workers.

Requested change: build the task graph on **AICPU** using **1** AICPU instance, then schedule/execute using **3** AICPU instances (total `4`).

This issue proposes a new runtime implementation named `aicpu_build_graph` under `src/runtime/`, plus a copied example, and documents the required design changes and risks.

## Goals

- Add a runtime `src/runtime/aicpu_build_graph/` discoverable by `RuntimeBuilder` (`python/runtime_builder.py:34`).
- Make graph building execute on AICPU via a programmable function.
- Support two build/schedule modes:
  - **Sequential** build→schedule.
  - **Concurrent** build∥schedule.
- Fixed thread split for this feature: `1` builder + `3` scheduler threads (total `4`), temporarily.

## Proposed approach (high level)

1. **New runtime**: `src/runtime/aicpu_build_graph/` with its own `runtime/runtime.h`.
2. **Programmable AICPU builder**: introduce a function like `extern "C" int build_graph_aicpu(Runtime* runtime)` that runs on AICPU and builds tasks/edges.
3. **Host orchestration becomes “prepare + marshal”**:
   - it allocates/copies tensors on host (unchanged),
   - it writes a **generic `uint64_t[]` payload** into `Runtime` (e.g. `orch_args[]`/`orch_argc`) for the AICPU builder to interpret,
   - it does *not* call `add_task()` / `add_successor()`.
4. **Kernel address binding**: host writes `func_id -> function_bin_addr` into a runtime-visible table so AICPU-built tasks can set `Task::function_bin_addr`.

## Challenges

### Challenge A — Kernel addresses for tasks created on AICPU

If tasks are created on AICPU, host cannot pre-fill `task->function_bin_addr` by iterating tasks (because tasks do not exist yet). Without this field, AICore will skip execution (`src/runtime/host_build_graph/aicore/aicore_executor.cpp:37`).

Proposed fix (runtime-local):

- Add `uint64_t kernel_addrs[MAX_FUNC_ID]` to `src/runtime/aicpu_build_graph/runtime/runtime.h`.
- Host already knows `func_id -> addr` via `DeviceRunner::register_kernel()` bookkeeping (`src/platform/a2a3/host/device_runner.cpp:543`, `src/platform/a2a3/host/device_runner.cpp:550`).
- In `DeviceRunner::run()`, before copying runtime to device / launching AICPU, write:
  - `runtime.kernel_addrs[func_id] = get_function_bin_addr(func_id)`.
- In `build_graph_aicpu()`, set `task->function_bin_addr = runtime->kernel_addrs[task->func_id]` at task creation time.

### Challenge B — Programmable graph building on AICPU (not host-only orchestration)

The existing orchestration function cannot be “moved to AICPU” as-is:

- It calls host-only hooks via `runtime->host_api.*` (`examples/host_build_graph_example/kernels/orchestration/example_orch.cpp:44`), which are initialized on host (`src/platform/a2a3/host/pto_runtime_c_api.cpp:64`).
- It receives host pointers in `args[]` (`examples/host_build_graph_example/kernels/orchestration/example_orch.cpp:29`).
- It is executed via host `dlopen()` (`src/runtime/host_build_graph/host/runtime_maker.cpp:96`), which has no device-side equivalent in this repo.

Proposed programming model:

- Keep host orchestration as a host `.so`, but restrict it to:
  - allocating/copying tensors (`runtime->host_api.*`),
  - recording output tensors (`runtime->record_tensor_pair()`),
  - writing a generic payload into `Runtime`:
    - `int orch_argc`
    - `uint64_t orch_args[MAX_ORCH_ARGS]`

This preserves flexibility: `orch_args[]` is just a word array; it can represent arbitrary builder inputs (device pointers, sizes, scalar values, flags, offsets, small tables).

Then implement the actual graph build logic as an AICPU function:

- `extern "C" int build_graph_aicpu(Runtime* runtime);`
- It interprets `runtime->orch_args[]` however it wants and calls `add_task()` / `add_successor()`.

Execution mechanism (important): **link-time inclusion into the AICPU binary**, not device-side `dlopen`.

- The AICPU binary is already built from source using `CUSTOM_SOURCE_DIRS` (`src/platform/a2a3/aicpu/CMakeLists.txt:20`).
- `aicpu_build_graph/build_config.py` can include a copied example directory containing the builder implementation as a `source_dir` for the AICPU target (developer experience similar to “host builds `.so` from example source”, but implemented as “AICPU binary includes example builder source”).

### Challenge C — Sequential vs concurrent build/schedule (and concrete algorithms)

Status: **there is no existing implementation of concurrent build∥schedule in the repo**. Current AICPU scheduling assumes the graph is fully built and immutable during scheduling.

We require concurrent build∥schedule, and we also support sequential build→schedule as a baseline.

#### Mode 1: Sequential build→schedule (supported baseline)

Design:

- Total AICPU instances launched is `aicpu_thread_num` (current C API).
- Runtime adds fields:
  - `int build_thread_num` (default 1)
  - `int schedule_thread_num` (default `aicpu_thread_num - build_thread_num`)
  - `std::atomic<int> build_done` (0/1)
  - `int build_mode` (0=sequential, 1=concurrent)
- Role assignment:
  - Each AICPU instance obtains `thread_idx` as today (`src/runtime/host_build_graph/aicpu/aicpu_executor.cpp:498`).
  - Builder threads are those with `thread_idx < build_thread_num`.
  - Scheduler threads are the remaining threads.
- Barrier:
  - Builder thread runs `build_graph_aicpu(runtime)` once, then sets `build_done=1`.
  - Scheduler threads spin-wait on `build_done` before starting scheduling.

Core assignment implication:

- Scheduler threads manage AICore workers; builder threads should manage **zero** worker cores.
- Any existing “even distribution across threads” logic must be parameterized on `schedule_thread_num` (not on total AICPU instances), otherwise builder threads “steal” cores they never use.

Termination:

- Use the existing termination assumptions from the scheduler loop: scheduling ends when all tasks complete and all cores are idle (current code has “double verification” when counters indicate done but cores are still busy: `src/runtime/host_build_graph/aicpu/aicpu_executor.cpp:333`).

#### Mode 2: Concurrent build∥schedule (required)

Correct-first strategy (recommended initial approach): **global graph mutex**.

New executor state:

- Add `std::mutex graph_mutex_` (similar to existing ready-queue mutexes: `src/runtime/host_build_graph/aicpu/aicpu_executor.cpp:40`).
- Add `std::atomic<int> published_task_count` and reuse `build_done`.

Publication rule:

- Builder must fully initialize a task (including setting `function_bin_addr`) and any edges it adds, while holding `graph_mutex_`, then increment `published_task_count` before releasing the lock.

Scheduler behavior changes:

- When a core completes a task, the scheduler thread:
  - acquires `graph_mutex_`,
  - reads the completed task’s `fanout[]`,
  - decrements successor `fanin`,
  - pushes newly-ready successors into the appropriate ready queue,
  - releases `graph_mutex_`.

Termination condition (must include build progress):

Schedulers may exit only when all of the following are true:

- `build_done == 1`
- `completed_tasks == published_task_count`
- ready queues are empty
- all managed cores are idle (retain the existing “core idle verification” idea; see `src/runtime/host_build_graph/aicpu/aicpu_executor.cpp:333`)

## References (most relevant files)

- Host orchestration example: `examples/host_build_graph_example/kernels/orchestration/example_orch.cpp:20`
- Orchestration compilation in runner: `examples/scripts/code_runner.py:481`
- Host `dlopen` orchestration: `src/runtime/host_build_graph/host/runtime_maker.cpp:96`
- Host runtime launch/param injection: `src/platform/a2a3/host/device_runner.cpp:241`
- Kernel registration mapping: `src/platform/a2a3/host/device_runner.cpp:499`
- AICPU scheduler entry: `src/runtime/host_build_graph/aicpu/aicpu_executor.cpp:633`
- AICore dispatch from `function_bin_addr`: `src/runtime/host_build_graph/aicore/aicore_executor.cpp:43`


---

## #84 rtStreamSynchronize (AICPU) fails with error 507018 in TensorMap and RingBuffer runtime

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/84
- Created: 2026-02-13T07:26:04Z
- Updated: 2026-02-14T03:09:13Z
- Closed: 2026-02-14T03:09:13Z

### Body

  ## Problem

  Running the BGEMM example with TensorMap and RingBuffer runtime fails during AICPU stream synchronization.

  ## Environment

  - Platform: a2a3
  - Runtime: tensormap_and_ringbuffer

  ## Steps to Reproduce

  ```bash
  python simpler/examples/scripts/run_example.py \
    -k simpler/examples/tensormap_and_ringbuffer/bgemm/kernels \
    -g simpler/examples/tensormap_and_ringbuffer/bgemm/golden.py \
    -p a2a3 \
    -d=7
  ```
  ## Error Output

  === rtStreamSynchronize stream_aicpu_===
  [ERROR] run: rtStreamSynchronize (AICPU) failed: 507018
  [ERROR] TEST FAILED: launch_runtime failed: 507018

  ## Expected Behavior

  The BGEMM example should complete successfully and pass the golden test validation.

---

## #110 Intermittent test failures in tensormap_and_ringbuffer test cases (bgemm)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/110
- Created: 2026-02-26T01:58:30Z
- Updated: 2026-02-26T11:09:01Z
- Closed: 2026-02-26T11:09:01Z

### Body

## Problem

The `bgemm` test case under `examples/tensormap_and_ringbuffer/bgemm` exhibits non-deterministic (intermittent) failures during both simulation and on-board execution. The failures manifest as precision mismatches between computed results and golden reference values. The failure rate varies across runs, typically in the range of 4%–11%.

Further investigation reveals that the `pagedattention` test case also shows intermittent failures under on-board execution, though it consistently passes in simulation with default parameters. When `pagedattention` parameters are changed (e.g., `head_dim` set to 64 or 128), it fails deterministically.

## Environment

- **Platform:** a2a3sim (simulation) / a2a3 (on-board hardware)
- **Runtime:** tensormap_and_ringbuffer
- **Architecture:** ARM64 (Linux aarch64)

## Steps to Reproduce

1. Use the following batch script to run the test case 100 times:

```bash
#!/bin/bash

TOTAL=100
PASS=0
FAIL=0

LOGFILE="batch_run_$(date '+%Y%m%d_%H%M%S').txt"

CMD="python examples/scripts/run_example.py \
    -k examples/tensormap_and_ringbuffer/bgemm/kernels \
    -g examples/tensormap_and_ringbuffer/bgemm/golden.py \
    -p a2a3sim"

echo "Log file: $LOGFILE"
echo "Batch run started at $(date)" | tee "$LOGFILE"
echo "" | tee -a "$LOGFILE"

for i in $(seq 1 $TOTAL); do
    echo "=== Run $i / $TOTAL ===" | tee -a "$LOGFILE"
    output=$($CMD 2>&1)
    echo "$output" >> "$LOGFILE"
    if echo "$output" | grep -q "TEST PASSED"; then
        PASS=$((PASS + 1))
        echo "[Run $i] PASSED" | tee -a "$LOGFILE"
    else
        FAIL=$((FAIL + 1))
        echo "[Run $i] FAILED" | tee -a "$LOGFILE"
    fi
    echo "" >> "$LOGFILE"
done

echo "" | tee -a "$LOGFILE"
echo "==============================" | tee -a "$LOGFILE"
echo "Results: $PASS / $TOTAL PASSED" | tee -a "$LOGFILE"
echo "Batch run finished at $(date)" | tee -a "$LOGFILE"
echo "==============================" | tee -a "$LOGFILE"
echo "Full log saved to: $LOGFILE"
```

2. Observe that a portion of the 100 runs fail non-deterministically.

## Batch Test Results

| Test Case | Mode | Config | Result | Notes |
|---|---|---|---|---|
| `bgemm` | Simulation | default | **92 / 100 PASSED** | Intermittent failure |
| `bgemm` | On-board | default | **96 / 100 PASSED** | Intermittent failure |
| `bgemm` | Simulation | batch=1 | **89 / 100 PASSED** | Intermittent failure |
| `bgemm` | On-board | batch=1 | **100 / 100 PASSED** | Stable |
| `bgemm` | Simulation | batch=1, Grid 2x2x2 | **100 / 100 PASSED** | Stable |
| `pagedattention` | Simulation | default | **100 / 100 PASSED** | Stable |
| `pagedattention` | On-board | default | **95 / 100 PASSED** | Intermittent failure |
| `pagedattention` | Simulation | batch=2 | **100 / 100 PASSED** | Stable |
| `pagedattention` | Simulation | batch=4 | **100 / 100 PASSED** | Stable |
| `pagedattention` | Simulation | num_heads=64, head_dim=128 | **0 / 100 PASSED** | All failed |
| `pagedattention` | Simulation | head_dim=64 | **0 / 100 PASSED** | All failed |

## Error Output

Failures present as **precision (accuracy) mismatches**. A representative sample of failed runs from the `bgemm` simulation test (100-run batch):

| Failed Run | Mismatched Elements | Total Elements | Mismatch Rate |
|---|---|---|---|
| Run 8 | 5,140 | 131,072 | 3.92% |
| Run 27 | 1,676 | 131,072 | 1.28% |
| Run 36 | 867 | 131,072 | 0.66% |
| Run 49 | 1,551 | 131,072 | 1.18% |
| Run 66 | 1,717 | 131,072 | 1.31% |
| Run 85 | 17,592 | 131,072 | 13.42% |
| Run 93 | 1,716 | 131,072 | 1.31% |
| Run 97 | 836 | 131,072 | 0.64% |

Key observations about failed runs:

- The number of mismatched elements varies significantly across runs (836–17,592), suggesting the issue is timing-dependent.
- The mismatch count is **not** an integer multiple of the tile size (4096 = 64x64), indicating sub-tile-level precision discrepancies.
- The first several elements in each failed run match correctly — the problem affects specific tile regions rather than the entire output.
- On-board `bgemm` failures occasionally also produce a hardware-related error: `rtStreamSynchronize (AICore) failed: 507015`.

## Expected Behavior

All test cases should pass deterministically across repeated runs (100/100 PASSED) under both simulation and on-board execution, regardless of grid configuration, batch size, or parameter settings (within valid ranges).

## Additional Context

- The issue correlates with the degree of parallelism: `bgemm` uses 32 parallel scopes (2x4x4 grid) with 3 compute cores, leading to high cross-core task scheduling frequency. In contrast, `pagedattention` with default parameters uses only 1 scope and executes tasks serially, which may explain why it passes consistently in simulation.
- Reducing the grid configuration (e.g., Grid 2x2x2 with batch=1) eliminates the failure in simulation, further suggesting a concurrency-related root cause.
- Preliminary analysis points to potential race conditions in the runtime scheduling layer (task dependency tracking and cross-core memory ordering), but further investigation is needed.


---

## #116 rtFree 507899 on profiling buffer during finalize

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/116
- Created: 2026-02-26T08:49:46Z
- Updated: 2026-02-27T02:10:22Z
- Closed: 2026-02-27T02:10:21Z

### Body

# Problem

When profiling is enabled (`--enable-profiling`), `DeviceRunner::finalize()` calls `perf_collector_.finalize()` with a `free_cb` that invokes `MemoryAllocator::free()` on the perf shared memory buffer. However, the `unregister_cb` (which calls `halHostUnregister`) runs first and may already release the underlying device memory on the CANN side. The subsequent `rtFree` on the same pointer then fails with error **507899**.

# Call sequence

```
DeviceRunner::finalize()
  └─ perf_collector_.finalize(unregister_cb, free_cb, &mem_alloc_)
       ├─ unregister_cb(host_ptr, device_id)  // halHostUnregister — CANN may free the device buffer
       └─ free_cb(dev_ptr)                    // allocator->free(dev_ptr) → rtFree → 507899
```

`halHostUnregister` releases CANN's internal reference to the device memory. When `rtFree` is called afterward on the same pointer, CANN returns 507899 because the resource is already gone.

# Fix

Add `MemoryAllocator::untrack(ptr)` that removes a pointer from the tracking set **without** calling `rtFree`. In the `free_cb` callback, call `untrack()` instead of `free()` — the memory is already released by `halHostUnregister`, we just need to stop tracking it so `mem_alloc_.finalize()` won't attempt a second `rtFree`.

```cpp
// Before (causes 507899)
auto free_cb = [](void* dev_ptr, void* user_data) -> int {
    auto* allocator = static_cast<MemoryAllocator*>(user_data);
    return allocator->free(dev_ptr);  // rtFree on already-freed pointer
};

// After
auto free_cb = [](void* dev_ptr, void* user_data) -> int {
    auto* allocator = static_cast<MemoryAllocator*>(user_data);
    allocator->untrack(dev_ptr);  // just remove from tracking, no rtFree
    return 0;
};
```

Also replace `std::cout` with `LOG_INFO` in `device_runner.cpp` for consistent logging.


---

## #126 Inconsistent atomic operation styles in aicpu_executor.cpp

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/126
- Created: 2026-02-27T02:11:36Z
- Updated: 2026-03-03T10:45:12Z
- Closed: 2026-03-03T10:45:12Z

### Body

# Problem

`aicpu_executor.cpp` mixes two different atomic operation styles for the same purpose:

- **C++ `std::atomic` API** (`.load()`, `.store()`, `.fetch_add()`) — used on class member `completed_tasks_`
- **GCC built-in `__atomic_*`** (`__atomic_load_n`, `__atomic_store_n`, `__atomic_fetch_add`) — used on static arrays `s_pto2_fanin_refcount` and `s_pto2_task_completed`

# Root cause

`completed_tasks_` is declared as `std::atomic<int>`, while the two arrays are plain/volatile types:

```cpp
std::atomic<int> completed_tasks_{0};              // C++ atomic
static int s_pto2_fanin_refcount[PTO2_MAX_SLOTS];  // plain int array
static volatile int32_t s_pto2_task_completed[PTO2_MAX_SLOTS]; // volatile array
```

The arrays were likely kept as plain types to avoid `std::atomic<int32_t>[65536]` element-wise construction overhead, but this forces all atomic access to go through GCC built-ins.

# Suggestion

Unify to one style. Two options:

1. **Wrap arrays as `std::atomic`** — cleaner, standard C++, but verify no measurable init overhead for the array sizes involved
2. **Use GCC built-ins everywhere** — consistent, avoids `std::atomic` array init, but less portable and less idiomatic

Either way, the `volatile` qualifier on `s_pto2_task_completed` is redundant when using atomic operations and should be removed.


---

## #139 Intermittent Test Failures in paged_attention Example under tensormap_and_ringbuffer

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/139
- Created: 2026-02-28T08:28:24Z
- Updated: 2026-02-28T11:26:45Z
- Closed: 2026-02-28T11:26:45Z

### Body

## Problem

The `examples/tensormap_and_ringbuffer/paged_attention` test case exhibits non-deterministic failures when executed on A2/A3 hardware. When running 100 iterations in batch mode, approximately 6% of executions fail with output tensor mismatches against the golden reference.

The failures exhibit the following characteristics:
- **Failure rate**: Approximately 6% (6 failures out of 100 runs)
- **Non-deterministic behavior**: Failures occur at random run numbers (e.g., 19, 36, 47, 63, 89, 93) with no discernible pattern
- **Variable mismatch count**: The number of mismatched elements varies per failure, ranging from 5 to 24 out of 256 total output elements
- **Hardware-specific**: The issue only reproduces on actual hardware and appears to be timing-related

## Environment

- **Platform**: A2/A3 hardware (non-simulation)
- **Runtime**: tensormap_and_ringbuffer
- **Architecture**: ARM64 (Linux aarch64)
- **Test case path**: `examples/tensormap_and_ringbuffer/paged_attention/`

## Steps to Reproduce

1. Navigate to the simpler working directory:

```bash
cd simpler
```

2. Run the test case once (single runs usually pass, failures are intermittent):

```bash
python examples/scripts/run_example.py \
    -k examples/tensormap_and_ringbuffer/paged_attention/kernels \
    -g examples/tensormap_and_ringbuffer/paged_attention/golden.py \
    -p a2a3 -d=12
```

3. Use the batch script to reproduce (recommended - 100 runs reliably expose the issue):

```bash
bash pa_a2a3.sh
```

pa_a2a3.sh:
```bash
#!/bin/bash

TOTAL=100
PASS=0
FAIL=0

LOGFILE="batch_run_$(date '+%Y%m%d_%H%M%S')-pa_a2a3.txt"

CMD="python examples/scripts/run_example.py \
    -k examples/tensormap_and_ringbuffer/paged_attention/kernels \
    -g examples/tensormap_and_ringbuffer/paged_attention/golden.py \
    -p a2a3 -d=12"

echo "Log file: $LOGFILE"
echo "Batch run started at $(date)" | tee "$LOGFILE"
echo "" | tee -a "$LOGFILE"

for i in $(seq 1 $TOTAL); do
    echo "=== Run $i / $TOTAL ===" | tee -a "$LOGFILE"
    output=$($CMD 2>&1)
    echo "$output" >> "$LOGFILE"
    if echo "$output" | grep -q "TEST PASSED"; then
        PASS=$((PASS + 1))
        echo "[Run $i] PASSED" | tee -a "$LOGFILE"
    else
        FAIL=$((FAIL + 1))
        echo "[Run $i] FAILED" | tee -a "$LOGFILE"
    fi
    echo "" >> "$LOGFILE"
done

echo "" | tee -a "$LOGFILE"
echo "==============================" | tee -a "$LOGFILE"
echo "Results: $PASS / $TOTAL PASSED" | tee -a "$LOGFILE"
echo "Batch run finished at $(date)" | tee -a "$LOGFILE"
echo "==============================" | tee -a "$LOGFILE"
echo "Full log saved to: $LOGFILE"
```

This script executes 100 consecutive runs and tracks PASS/FAIL statistics.

## Error Output

When failures occur, `run_example.py` raises the following exception:

```
[ERROR] TEST FAILED: Output 'out' does not match golden.
Mismatched elements: <N>/256
rtol=0.01, atol=0.01
```

Where `<N>` varies across different failure instances. Typical values include:

| Failed Run Number | Mismatched Elements (/256) |
|-------------------|---------------------------|
| Run 19           | 5                         |
| Run 36           | 6                         |
| Run 47           | 9                         |
| Run 63           | 11                        |
| Run 89           | 15                        |
| Run 93           | 24                        |

Batch test summary output:

```
==============================
Results: 94 / 100 PASSED
Batch run finished at <timestamp>
==============================
```

## Expected Behavior

The test case should pass with **100% reliability**, i.e., batch runs should result in `100 / 100 PASSED`, with output tensors matching golden reference within the tolerance of `rtol=0.01, atol=0.01`.

## Additional Context

- The issue involves the `TFILLPAD_INPLACE` operation in `aiv_softmax_prepare.cpp`, specifically the subsequent `SetValue` writes to padding regions with -inf values
- Additionally, line 185 in `golden.py` uses `torch.bfloat16` to truncate pij, while the device-side kernel uses `float16` (`TCVT` fp32→fp16). This precision mismatch may introduce additional comparison errors


---

## #180 Missing `pto/cpu/TPut.hpp` When Running Simulation Examples After Updating pto-isa

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/180
- Created: 2026-03-05T07:42:57Z
- Updated: 2026-03-06T02:13:02Z
- Closed: 2026-03-06T02:13:02Z

### Body

### Problem

After updating to the latest `pto-isa` (commit `dc272369`), all simulation examples under `examples/tensormap_and_ringbuffer/` fail to compile with a fatal error indicating that the header file `pto/cpu/TPut.hpp` cannot be found. The error originates from `pto/comm/pto_comm_instr_impl.hpp:35`, which attempts to include `pto/cpu/TPut.hpp`. This suggests the header was either removed, renamed, or relocated in the recent commit without updating the corresponding `#include` directive.

### Environment

- **pto-isa commit**: `dc272369`
- **Simulation platform**: `a2a3sim`

### Steps to Reproduce

1. Update `pto-isa` to commit `dc272369`.
2. Set the environment variable:
   ```bash
   export PTO_ISA_ROOT=$PTO_ISA_ROOT
   ```
3. Run any simulation example under `examples/tensormap_and_ringbuffer/`, e.g.:
   ```bash
   python examples/scripts/run_example.py \
       -k examples/tensormap_and_ringbuffer/paged_attention/kernels \
       -g examples/tensormap_and_ringbuffer/paged_attention/golden.py \
       -p a2a3sim
   ```

### Error Output

```
pto-isa-260305/pto-isa/include/pto/comm/pto_comm_instr_impl.hpp:35:10: fatal error: pto/cpu/TPut.hpp: No such file or directory
   35 | #include "pto/cpu/TPut.hpp"
      |          ^~~~~~~~~~~~~~~~~~
compilation terminated.
```

### Expected Behavior

All simulation examples under `examples/tensormap_and_ringbuffer/` should compile and run successfully without any missing header errors.

### Additional Notes

It runs successfully in pto-isa at commit 1b22fea.


---

## #230 A5 Platform Limitations

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/230
- Created: 2026-03-10T02:12:51Z
- Updated: 2026-04-08T07:59:12Z
- Closed: 2026-04-08T07:59:12Z

### Body

# A5 Platform Limitations

## Issue 1: pipe_barrier(PIPE_V) Not Supported in A5 AIV Kernels

### Symptom
Using `pipe_barrier(PIPE_V)` in AIV kernels fails to compile/run on A5 platform.

### Error Message
When compiling pipe_barrier(PIPE_V) targeting dav-c310-vec:

```
error: the range of 1st parameter must be [4, 6]
        pipe_barrier(PIPE_V);
                     ^
```
### Root Cause
A5 AIV (dav-c310-vec) restricts `pipe_barrier` parameter range to `[4, 6]`, while `PIPE_V = 1` is outside this range.

### Evidence
#### Declaration
pipe_barrier is declared in:

`/usr/local/Ascend/cann-9.0.0/tools/bisheng_compiler/lib/clang/15.0.5/include/cce_aicore_intrinsics_3101.h`

as a clang_builtin_alias mapping to the compiler builtin __builtin_cce_pipe_barrier:

`__attribute__((clang_builtin_alias(__builtin_cce_pipe_barrier))) void pipe_barrier(...);`


#### Compiler Diagnostic Template
The range constraint is enforced inside the compiler binary:

`/usr/local/Ascend/cann-9.0.0/tools/bisheng_compiler/bin/ccec`

Extracted via `strings ccec | grep "range of"`:

the range of %ordinal0 * %ordinal1 parameters must be %2

When targeting dav-c310-vec, the compiler applies `ImmRange(4, 6)` to the first parameter of `__builtin_cce_pipe_barrier`.

### Affected PIPE Types
| PIPE Type | Value | A2/A3 | A5 |
|-----------|-------|-------|-----|
| `PIPE_S` | 0 | ✅ | ❌ |
| `PIPE_V` | 1 | ✅ | ❌ |
| `PIPE_MTE1` | 2 | ✅ | ❌ |
| `PIPE_MTE2` | 3 | ✅ | ✅ |
| `PIPE_MTE3` | 4 | ✅ | ✅ |
| `PIPE_M` | 5 | ✅ | ✅ |
| `PIPE_ALL` | 6 | ✅ | ✅ |

### Solution
Remove `pipe_barrier(PIPE_V)` calls as A5 hardware provides ordering guarantees natively.

**Note**: `PIPE_V` remains valid in `set_flag/wait_flag`, only `pipe_barrier` is restricted.

### Related Commit
PR229(https://github.com/ChaoWao/simpler/pull/229) for all affected kernel code.

---

## Issue 2: --enable-profiling Not Supported on A5 Platform

### Symptom
Running with `--enable-profiling` flag fails on A5 platform:
```bash
[ERROR] initialize: Memory registration failed: 8
[ERROR] run: init_performance_profiling failed: 8
[ERROR] TEST FAILED: launch_runtime failed: 8
```

### Root Cause
A5 runs in **vAscend virtualization environment**, which does not support host-device shared virtual memory (SVM) mapping.

**Evidence**:
1. Kernel modules: `drv_vascend` + `vfio` indicate virtualization
2. CANN documentation states: `HOST_SVM_MAP_DEV don't support in virt machine`
3. `halHostRegister()` returns error code 8 (memory registration failed)

### Comparison
| Environment | A2/A3 | A5 |
|-------------|-------|-----|
| Deployment | Bare-metal servers | vAscend virtualization |
| SVM Support | ✅ | ❌ |
| Profiling | ✅ | ❌ |

### Impact
- PerformanceCollector initialization fails
- Performance data collection completely unavailable
- Basic runtime functionality unaffected (works without `--enable-profiling`)

### Workaround
Do not use `--enable-profiling` flag on A5 platform.

---

## #266 [sim] dcci lacks cache-line atomicity in simulation mode — handshake store reordering can cause deadlock

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/266
- Created: 2026-03-12T02:43:14Z
- Updated: 2026-03-12T08:11:00Z
- Closed: 2026-03-12T08:11:00Z

### Body

## Problem

On hardware, `dcci(addr, SINGLE_CACHE_LINE, CACHELINE_OUT)` atomically flushes an entire 64-byte cache line to HBM. Other processors (AICPU) reading from HBM see a complete cache-line snapshot — no partial visibility.

In simulation mode, `dcci` is implemented as `std::atomic_thread_fence(std::memory_order_seq_cst)` (`dmb ish` on aarch64). This provides fence semantics but **no cache-line atomicity**. Individual stores pass through the store buffer independently and can be reordered by the aarch64 weak memory model.

## Reproduced Failures

`multi-round-paged-attention` and `batch_paged_attention` hung on **a2a3sim + aarch64**. Root cause: during the AICore-AICPU handshake, `physical_core_id`/`core_type` stores were reordered after the `aicore_done` signal store. AICPU observed `aicore_done != 0` but read a stale `physical_core_id` (0), causing two cores to share the same register block — deadlock.

```
Core  0: AIC, physical_id=0, reg_addr=0xaaab24c20d40  <- correct
Core 27: AIV, physical_id=0, reg_addr=0xaaab24c20d40  <- wrong, should be 27
```

**Not affected:** hardware (a2a3) — `dcci` atomically flushes the cache line; x86 simulation — TSO memory model prevents store-store reordering.

## Fix Status

### Writer side (AICore) — applied to HBG and TMR

Insert `dcci` barrier between data fields and signal field:

```cpp
my_hank->physical_core_id = get_physical_core_id();
my_hank->core_type = core_type;
dcci(my_hank, SINGLE_CACHE_LINE, CACHELINE_OUT);  // <- added: ensure data visible first
my_hank->aicore_done = block_idx + 1;
dcci(my_hank, SINGLE_CACHE_LINE, CACHELINE_OUT);
```

Modified files:
- `src/a2a3/runtime/tensormap_and_ringbuffer/aicore/aicore_executor.cpp`
- `src/a2a3/runtime/host_build_graph/aicore/aicore_executor.cpp`

### Reader side (AICPU) — applied to HBG and ABG, **missing from TMR**

Insert `__sync_synchronize()` after `aicore_done` spin-wait exit:

```cpp
while (hank->aicore_done == 0) {}
__sync_synchronize();  // <- HBG/ABG: applied, TMR: missing
CoreType type = hank->core_type;
uint32_t physical_core_id = hank->physical_core_id;
```

Applied:
- `src/a2a3/runtime/host_build_graph/aicpu/aicpu_executor.cpp`
- `src/a2a3/runtime/aicpu_build_graph/aicpu/aicpu_executor.cpp`

Missing:
- `src/a2a3/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp`

## Note on TMR Reader Side

The missing `__sync_synchronize()` in TMR is unlikely to cause issues in practice:

1. The writer-side `dcci` (`dmb ish`) already guarantees global store ordering
2. All fields reside in the same 64-byte aligned `Handshake` struct (single cache line) — when the reader fetches `aicore_done`, the same cache-line fetch also brings the updated `physical_core_id`

However, adding it would ensure formal correctness and consistency across all three runtimes.

## Root Cause

The simulation `dcci` only provides fence semantics without modeling the hardware's cache-line atomic flush. For multi-field release-acquire protocols within the same cache line, developers must manually insert `dcci`/fence at the correct position, whereas the hardware's cache-line atomicity provides this guarantee implicitly.


---

## #269 2个orchestration 在申请ring buffer时， 多个ring buffer之间必须保序

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/269
- Created: 2026-03-12T03:18:49Z
- Updated: 2026-04-02T07:02:23Z
- Closed: 2026-04-02T07:02:23Z

### Body

当有2个orchestration同时申请task slot和heap时，2个ringbuffer是如何保序的。如果申请的时候分配成如下这样：
其中0-3是orch0,分配到的，4-5是orch1分配到的。
那么当执行advance_ring_pointer回收ring buffer时last_task_alive 从2->3， tail从1->2会不会导致 heap的4/5被错误的回收了？  

ring buffer都是按照task顺序来回收的。必须保证分配的时候多个bufer之间保序。


          last_task_alive 
                      last_task_alive		  
                    │     │                                
                    ▼     ▼                                
     ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐             
     │CONS    │CONS    │CONS   │ PEND   │PEND    │PEND    │PEND    │             
     └─────┴─────┴─────┴─────┴─────┴─────┴─────┘             
        0                  1             2             3              4*                5*

               tail                   tail               
                │                       │                     
                ▼                       ▼                     
     ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐             
     │0            │1           │2           │ 4*         │ 5*         │2           │3           │             
     └─────┴─────┴─────┴─────┴─────┴─────┴─────┘             


---

## #290 [TODO] 明确 heap ring 分配触发路径 & 统计/记录结构

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/290
- Created: 2026-03-16T01:12:08Z
- Updated: 2026-03-16T01:51:38Z
- Closed: 2026-03-16T01:51:38Z

### Body

## 背景

Heap ring (`PTO2HeapRing`) 用于 orchestrator 在 task submit 时为 OUTPUT 参数分配 packed buffer。当前结构只维护 `top_ptr` 和 `tail_ptr` 两个原子水位线指针，**不记录每次分配的 size**。每次分配的 size 信息隐式保存在 `PTO2TaskDescriptor` 的 `packed_buffer_base` / `packed_buffer_end` 字段差值中。

## 代码分析结论

### Q1: heap ring 分配是否只能由 task 触发？

**是。** 唯一调用链：

```
pto2_rt_submit_*task()  (用户 API)
  └─> pto2_submit_mixed_task / pto2_submit_task
        └─> orch->pto2_alloc_packed_buffer(total_output_size)   // 仅 total > 0
              └─> heap_ring.pto2_heap_ring_alloc(size)           // CAS bump-alloc
```

不存在非 task 的分配路径。

### Q2: AIV_HUB/AIC_HUB 的本质问题

AIV_HUB/AIC_HUB 的 kernel 实现是**空函数**，提交时参数全部是 `make_output_param`。它们的唯一目的是借 task submit 路径从 heap ring 分配内存（如 paged attention 中的 accumulator `oi`、`li_update`、`mi_update`），后续真正的计算 task 通过 TensorMap 依赖这些 buffer。

**核心问题：为了分配一块内存，必须创建一个完整的 task（占 task ring 槽位、走调度、空执行、走回收），开销不合理。**

### 提议：引入 `pto2_malloc()` API

提供一个不经过 task 的 heap ring 分配接口：

```cpp
void* pto2_malloc(PTO2RuntimeContext* rt, uint64_t size);
```

- Orchestrator 直接从 heap ring 分配，不创建 task descriptor、不占 task ring 槽位
- 返回的指针可以作为后续 task 的 input/output 参数使用
- 消除 AIV_HUB/AIC_HUB 这类空 task 的调度和执行开销

**需要解决的问题：**

1. **回收机制**：当前 heap ring 是 FIFO 隐式回收（`advance_ring_pointers` 顺序扫描连续 CONSUMED task 推进 `heap_tail`）。`pto2_malloc` 分配的内存没有绑定到 task，需要设计新的回收策略——显式 `pto2_free()`？scope 结束时自动回收？还是绑定到后续 task 的生命周期？
2. **size 记录**：脱离 task descriptor 后，`packed_buffer_end - packed_buffer_base` 的隐式记录方式不再适用，需要在 ring 中或独立结构中显式记录每次分配的 size。
3. **FIFO 约束**：当前回收依赖 task 的提交顺序（`last_task_alive` 顺序扫描）。`pto2_malloc` 分配穿插在 task 之间，可能打破这个假设，需要重新设计回收水位线推进逻辑。

### 回收机制现状（供参考）

```
AICore 完成执行 → on_task_complete → on_task_release
  → release_producer() → fanout_refcount++
    → 当 fanout_refcount == fanout_count:
        task_state = CONSUMED
        → advance_ring_pointers()
            → 顺序扫描连续 CONSUMED tasks
            → heap_tail = last_consumed.packed_buffer_end - heap_base
```

关键约束：FIFO 顺序回收，后完成的 task 必须等前面的 task 先被标记为 CONSUMED 才能推进 `heap_tail`（head-of-line blocking）。

## TODO

- [ ] 设计 `pto2_malloc` / `pto2_free` API 及其与现有 FIFO 回收机制的兼容方案
- [ ] 明确 `pto2_malloc` 分配的 size 记录方式（ring 内记录 or 独立 metadata）
- [ ] 迁移 paged_attention 中的 AIV_HUB 空 task 为 `pto2_malloc` 调用，验证正确性
- [ ] 补充文档：heap ring 分配路径设计约束
- [ ] 多 orchestrator 场景测试：验证 CAS bump-alloc 正确性和回收一致性

---

## #303 L1-L4分布式多卡支持

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/303
- Created: 2026-03-17T03:56:07Z
- Updated: 2026-04-22T01:35:06Z
- Closed: 2026-04-22T01:35:06Z
- Labels: enhancement

### Body

需求: 

基于HCCL 扩展分布式共享内存执行环境，把 simpler 在A2/A3 多卡上跑通 ，构建基础的分布式执行能力


以 2-Chip Tensor Parallelism（Linear → AllReduce → FFN）为例，展示从通信域建立到 kernel 执行完成的完整流程。


```
阶段            Host (Python/C)                 Chip 0 NPU                     Chip 1 NPU
────            ───────────────                 ──────────                      ──────────
                    │
 ① 通信域建立       ├─ HCCL init / shmem mmap
                    ├─ 分配本地 GM buffer
                    ├─ 地址交换 (AllGather)
                    ├─ 分配共享信号量区域
                    ├─ 构建 RemoteAddressTable
                    │
 ② Runtime 初始化   ├─ init_runtime(args=[                
                    │    local_buf, peer_buf,
                    │    sem_base, rank, ...])
                    │
 ③ Kernel 下发      ├─ launch_runtime() ──────→  AICPU 启动                     AICPU 启动
                    │                            Orchestrator 开始构图           Orchestrator 开始构图
                    │
 ④ 编排+执行        │                            ┌──────────────────────┐       ┌──────────────────────┐
                    │                            │ submit Linear task   │       │ submit Linear task   │
                    │                            │ submit AR_step tasks │       │ submit AR_step tasks │
                    │                            │   (pto-comm-isa)     │       │   (pto-comm-isa)     │
                    │                            │ submit FFN task      │       │ submit FFN task      │
                    │                            │   w/ WAIT param      │       │   w/ WAIT param      │
                    │                            └──────────────────────┘       └──────────────────────┘
                    │                                     │                              │
                    │                            Scheduler → AICore              Scheduler → AICore
                    │                            [Linear ████]                  [Linear ████]
                    │                            [AR step0] ←──── HCCS ────→   [AR step0]
                    │                            [AR step1] ←──── HCCS ────→   [AR step1]
                    │                            ... SIGNAL sem ...              ... SIGNAL sem ...
                    │                                     │                              │
                    │                            WaitPoller: sem ✓              WaitPoller: sem ✓
                    │                            [FFN ████]                     [FFN ████]
                    │
 ⑤ 同步+回收        ├─ rtStreamSynchronize()
                    ├─ 读回结果 / 下一轮
```


---

## #356 [Feature] Migrate AICPU launch to new rtsLaunchCpuKernel interface (BUILD_WITH_NEW_CANN)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/356
- Created: 2026-03-25T01:35:38Z
- Updated: 2026-05-27T01:46:03Z
- Closed: 2026-05-27T01:46:03Z
- Labels: enhancement

### Body

### Summary

Migrate the AICPU kernel launch path to use the new `rtsLaunchCpuKernel` / `rtsBinaryLoadFromFile` / `rtsFuncGetByName` API, with a two-layer dispatcher SO architecture that allows different runtimes to load different AICPU kernel SOs at runtime.

### Motivation / Use Case

**Current state (simpler):**

Both `a2a3` and `a5` platform backends launch AICPU kernels through CANN's built-in `libaicpu_extend_kernels.so`:

```cpp
rtAicpuKernelLaunchExWithArgs(
    rtKernelType_t::KERNEL_TYPE_AICPU_KFC, "AST_DYN_AICPU",
    aicpu_num, &rt_args, nullptr, stream, 0);
```

Problems:
- The SO name (`libaicpu_extend_kernels.so`) is hardcoded — only one fixed SO can be loaded
- Different runtimes cannot load different AICPU kernel implementations at runtime
- Manual `offsetof`-based struct packing for kernel/SO name strings
- Legacy API may be deprecated in future CANN versions

**Target architecture:**

Two-layer SO dispatch (matching pypto's `pypto_aicpu_interface` pattern) + new CANN launch API:

1. **Dispatcher SO (outer, fixed)** — runs on AICPU, exports:
   - `DynTileFwkDispatcherLoad` — receives inner SO binary, saves to AICPU filesystem, `dlopen` + `dlsym`
   - `DynTileFwkDispatcherInit` — delegates to inner SO's init
   - `DynTileFwkDispatcherRun` — delegates to inner SO's run

2. **Runtime SO (inner, replaceable)** — different runtimes load different SOs with different names

3. **Host-side `LoadAicpuOp`** — generates JSON descriptor → `rtsBinaryLoadFromFile` → `rtsFuncGetByName` → `rtsLaunchCpuKernel`

### Current Progress

**Done:**
- [x] Dispatcher SO implemented (`src/common/aicpu_dispatcher/`)
- [x] Host-side `LoadAicpuOp` wrapper implemented (`src/common/host/`)
- [x] Build system updated (dispatcher target, RuntimeBinaries, parallel build)
- [x] DeviceRunner integration (DispatcherLoad → Init → Run three-step launch)

**Blocker:**
- [ ] `rtsBinaryLoadFromFile` returns `ACL_ERROR_RT_PARAM_INVALID` (107000) on CANN 8.5.0 for **any** input (including CANN's own built-in `aicpu_kernel.json`). Need to investigate root cause — likely a missing initialization step, environment config, or CANN version requirement.

### Scope

| File | Change |
|------|--------|
| `src/common/aicpu_dispatcher/aicpu_dispatcher.{h,cpp,CMakeLists.txt}` | New: dispatcher SO |
| `src/common/host/load_aicpu_op.{h,cpp}` | New: host-side new API wrapper |
| `src/a2a3/platform/onboard/host/device_runner.{h,cpp}` | Replace `launch_aicpu_kernel` with new API path |
| `src/a5/platform/onboard/host/device_runner.{h,cpp}` | Same |
| `src/{a2a3,a5}/platform/onboard/host/pto_runtime_c_api.cpp` | Set dispatcher SO path |
| `src/{a2a3,a5}/platform/onboard/host/CMakeLists.txt` | Add load_aicpu_op source + rts include path |
| `python/simpler/runtime_compiler.py` | Add dispatcher build target |
| `simpler_setup/runtime_builder.py` | Build dispatcher in parallel, `dispatcher_path` in RuntimeBinaries |
| `examples/scripts/runtime_builder.py` | Same |

### Reference

- pypto dispatcher: `framework/src/machine/device/machine_interface/pypto_aicpu_interface.{h,cpp}`
- pypto host-side: `framework/src/machine/runtime/load_aicpu_op.{h,cpp}`

---

## #357 [Performance] Orchestration SO loading via file write + dlopen is costly on AICPU

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/357
- Created: 2026-03-25T01:52:28Z
- Updated: 2026-04-30T02:27:22Z
- Closed: 2026-04-30T02:27:21Z
- Labels: performance

### Body

### Platform

All / Unknown

### Runtime Variant

All / Unknown

### Summary

The orchestration function (.so) is sent to the AICPU via device global memory, but `dlopen` cannot load a shared library directly from memory. The current workaround writes the SO binary to a file on disk, then calls `dlopen` on that file. This file I/O path is costly and adds unnecessary latency to every execution.

**Current flow (per invocation):**

1. Host embeds the orch SO binary into the Runtime struct (up to 4MB inline buffer: `RUNTIME_MAX_ORCH_SO_SIZE`)
2. Entire Runtime struct (including the 4MB SO buffer) is DMA'd to device HBM
3. AICPU reads the SO bytes from device memory
4. AICPU writes the SO to disk via `open()`/`write()` — tries 5 candidate directories (`/usr/lib64/aicpu_kernels/...`, `/var/tmp`, `/tmp`)
5. AICPU calls `dlopen(so_path, RTLD_LAZY | RTLD_LOCAL)` on the file
6. `dlsym()` resolves function pointers (`aicpu_orchestration_entry`, etc.)
7. After execution: `dlclose()` + `unlink()` deletes the file

**Key costs:**
- File system I/O on AICPU for every single invocation (write + unlink)
- Fixed 4MB DMA transfer regardless of actual SO size
- No caching — the SO is written and deleted every run

**Locations:**
- Host SO embedding: `src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp` (lines 226-244)
- Runtime struct buffer: `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/runtime.h` (line 39, 189-192)
- AICPU file write + dlopen: `src/a2a3/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp` (lines 1596-1674)
- Cleanup (dlclose + unlink): same file (lines 2057-2062)
- Same pattern exists in `aicpu_build_graph` and `a5` variants

### Git Commit ID

78f0869e9fa4522266ccea481115900e8ee786f5

### Host Platform

Linux (aarch64)

### Reproduction

Any example that uses device orchestration (not `host_build_graph`):

```bash
python examples/scripts/run_example.py \
    -k tests/device_tests/a2a3/tensormap_and_ringbuffer/paged_attention_unroll/kernels \
    -g tests/device_tests/a2a3/tensormap_and_ringbuffer/paged_attention_unroll/golden.py \
    -p a2a3 -d 4
```

The file write + dlopen overhead is included in every invocation's orchestration setup time.

### Expected Performance

Orchestration SO loading should add near-zero overhead — the binary is already in device memory.

### Actual Performance

Each invocation pays filesystem I/O cost (write ~100-500KB SO to disk + dlopen + unlink). No exact timing is instrumented on AICPU side, but host-side `TIMING: orch_so_copy` shows the DMA portion. The AICPU file write + dlopen cost is hidden within the orchestration startup.

### Profiling Data (Optional)

Not yet measured in isolation. The host side logs `TIMING: orch_so_copy` but the AICPU file-write + dlopen latency has no instrumentation.

### Additional Context

**Possible alternatives to explore:**

1. **`memfd_create` + `dlopen("/proc/self/fd/N")`** — Create an anonymous in-memory file descriptor, write SO bytes to it, then `dlopen` via the `/proc/self/fd/` path. Avoids real filesystem I/O entirely. Requires Linux 3.17+ (available on AICPU's aarch64 kernel). This is the most promising approach.

2. **Cache across invocations** — Write the SO file once during initialization and reuse the `dlopen` handle across runs (pypto uses this approach with a `firstCreatSo_` flag). Only helps for repeated runs.

3. **Right-size the DMA** — Instead of always transferring the full 4MB `RUNTIME_MAX_ORCH_SO_SIZE` buffer, only DMA the actual SO size. This reduces the Runtime struct DMA cost.

4. **Separate DMA for SO binary** — Instead of embedding the SO in the Runtime struct, send it as a separate device memory allocation with its own pointer. Avoids bloating the Runtime struct.

**pypto comparison:** pypto writes the SO file once at init time and caches the handle, avoiding per-invocation file I/O. However it still relies on disk-backed dlopen. The `memfd_create` approach would be strictly better for both projects.

---

## #359 [Bug] Intermittent precision failure in paged_attention test

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/359
- Created: 2026-03-25T03:30:57Z
- Updated: 2026-04-08T08:00:35Z
- Closed: 2026-04-08T08:00:35Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

The `paged_attention` device test (`tests/device_tests/a2a3/tensormap_and_ringbuffer/paged_attention`) exhibits intermittent precision verification failures. The test passes most runs but occasionally produces output that does not match golden values.

### Steps to Reproduce

```markdown
1. Use the batch test script `batch_pa_test.sh` to run the paged_attention test repeatedly (100 iterations):


bash batch_pa_test.sh


The script runs the test in a loop and stops early on the first precision failure.

2. Alternatively, run the test manually in a loop:


for i in $(seq 1 100); do
  python examples/scripts/run_example.py \
    -k tests/device_tests/a2a3/tensormap_and_ringbuffer/paged_attention/kernels \
    -g tests/device_tests/a2a3/tensormap_and_ringbuffer/paged_attention/golden.py \
    -p a2a3
done


The failure typically occurs within ~85 runs but can happen at any point.
```

### Expected Behavior

All 100 runs should pass precision verification (100 PASSED, 0 PRECISION_FAILED).

### Actual Behavior

The test fails intermittently with a precision mismatch:

```
[INFO] Comparing out: shape=torch.Size([256, 16, 128]), dtype=torch.float32
[ERROR] TEST FAILED: Output 'out' does not match golden.
Mismatched elements: 478/524288
rtol=0.001, atol=0.001
```

### Git Commit ID

2757be693fff026a12b2db35078671f5724b4798

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (x86_64)

### Additional Context

_No response_

---

## #371 [Code Health] Add typed orchestration scalar helpers to hide uint64 ABI details

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/371
- Created: 2026-03-26T07:06:42Z
- Updated: 2026-04-08T01:38:02Z
- Closed: 2026-04-08T01:38:02Z

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Orchestration

### Description

The orchestration scalar API currently exposes low-level ABI details to callers. `PTOParam::add_scalar()` only accepts `uint64_t`, so orchestration code must manually encode non-integer scalar values into raw bit patterns before submission.

A concrete example is the AICPU vector example, where `kernel_add_scalar` expects a float scalar but the orchestration layer has to call `float_to_u64(1.0f)` / `float_to_u64(2.0f)` before passing the value. This makes orchestration code aware of the kernel argument binary representation instead of expressing the intended scalar type directly.

This is not a correctness bug today, but it is an abstraction leak that makes orchestration code harder to read, easier to misuse, and less uniform with the read side APIs that already provide typed helpers such as `OrchArg::value_as<T>()`.

### Location

- `src/a2a3/runtime/aicpu_build_graph/runtime/pto_types.h`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_types.h`
- `examples/a2a3/aicpu_build_graph/vector_example/kernels/orchestration/orchestration.cpp`
- `examples/a2a3/tensormap_and_ringbuffer/vector_example/kernels/orchestration/example_orchestration.cpp`
- `examples/a2a3/aicpu_build_graph/vector_example/kernels/aiv/kernel_add_scalar.cpp`

### Proposed Fix

Keep the underlying scalar ABI unchanged if desired, but add typed helper APIs at the orchestration layer, for example:

- `add_scalar_f32(float)` / `add_scalar_f64(double)`
- `add_scalar_i32(int32_t)` / `add_scalar_u32(uint32_t)`
- or a generic helper such as `add_scalar_as<T>(T value)` / `AddScalarBits<T>(T value)` that bit-casts into the existing `uint64_t` slot.

The goal is for orchestration code to express the semantic type directly and avoid hand-written helpers like `float_to_u64()` in examples and production orchestration code.

### Priority

Low (no impact today, good to fix eventually)

---

## #405 [Bug] Preserve core-specific sections in a2a3sim sim kernel compilation

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/405
- Created: 2026-03-30T11:48:38Z
- Updated: 2026-03-30T12:28:45Z
- Closed: 2026-03-30T12:28:45Z

### Body

### Platform

a2a3sim (Ascend 910B/C simulation)

### Runtime Variant

All / Unknown

### Description

The host g++-15 simulation path for InCore kernels does not preserve the requested core type when compiling PTOAS output. For AIC matmul kernels, the compile path drops the core-specific macros, so the cube section guarded by __DAV_CUBE__ is stripped during preprocessing and the generated sim kernel becomes effectively empty.

### Steps to Reproduce

1. Export PTO_ISA_ROOT to the workspace pto-isa checkout.
2. In the pypto workspace, run:
   pytest -sv tests/st/runtime/test_matmul.py --save-kernels --dump-passes --platform a2a3sim --forked -k matmulacc_pto_64x64x64
3. Inspect the generated PTOAS kernel under build_output/.../ptoas/matmul_acc.cpp.
4. Observe that the failing sim compile path does not preserve the cube section and the final output mismatches the golden result.

### Expected Behavior

The host simulation compile path should propagate the requested core type and define the matching core-specific macros so that PTOAS-emitted cube/vector sections are preserved during preprocessing.

### Actual Behavior

The host simulation compile path invokes g++-15 without the requested core type. For the failing matmul_acc case, preprocessing strips the __DAV_CUBE__ section and the test fails with output mismatch:



### Git Commit ID

ca2f44a5528d2df78a3efc519b58f712a4e88f4b

### Host Platform

Linux (x86_64)

### Additional Context

The local fix restores core_type propagation into _compile_incore_sim(), adds the matching __AIC__/__DAV_CUBE__ or __AIV__/__DAV_VEC__ macros for host sim builds, and adds regression tests covering both the flag selection and the forwarded core type.

---

## #406 [Bug] Preserve core-specific sections in a2a3sim sim kernel compilation

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/406
- Created: 2026-03-30T11:49:09Z
- Updated: 2026-03-30T12:29:03Z
- Closed: 2026-03-30T12:29:03Z

### Body

### Platform

a2a3sim (Ascend 910B/C simulation)

### Runtime Variant

All / Unknown

### Description

The host g++-15 simulation path for InCore kernels does not preserve the requested core type when compiling PTOAS output. For AIC matmul kernels, the compile path drops the core-specific macros, so the cube section guarded by __DAV_CUBE__ is stripped during preprocessing and the generated sim kernel becomes effectively empty.

### Steps to Reproduce

1. Export PTO_ISA_ROOT to the workspace pto-isa checkout.
2. In the pypto workspace, run:
   `pytest -sv tests/st/runtime/test_matmul.py --save-kernels --dump-passes --platform a2a3sim --forked -k matmulacc_pto_64x64x64`
3. Inspect the generated PTOAS kernel under `build_output/.../ptoas/matmul_acc.cpp`.
4. Observe that the failing sim compile path does not preserve the cube section and the final output mismatches the golden result.

### Expected Behavior

The host simulation compile path should propagate the requested core type and define the matching core-specific macros so that PTOAS-emitted cube/vector sections are preserved during preprocessing.

### Actual Behavior

The host simulation compile path invokes g++-15 without the requested core type. For the failing matmul_acc case, preprocessing strips the `__DAV_CUBE__` section and the test fails with output mismatch:

```
AssertionError: Output 'c' does not match golden.
Mismatched elements: 4096/4096
```

### Git Commit ID

ca2f44a5528d2df78a3efc519b58f712a4e88f4b

### Host Platform

Linux (x86_64)

### Additional Context

The local fix restores core_type propagation into `_compile_incore_sim()`, adds the matching `__AIC__/__DAV_CUBE__` or `__AIV__/__DAV_VEC__` macros for host sim builds, and adds regression tests covering both the flag selection and the forwarded core type.


---

## #409 [Bug] Known Issue: AICPU Task Timeout with Small Ring Buffers Due to Scheduler Hot-Path Overhead

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/409
- Created: 2026-03-30T12:17:21Z
- Updated: 2026-04-20T12:21:06Z
- Closed: 2026-04-20T12:21:06Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

## Summary

When the scheduler hot path carries non-trivial overhead (~10μs per iteration), AICPU stream synchronization fails with error code **507018** on test cases that use small ring buffer configurations (e.g., `paged_attention_ringbuffer` with window=128, heap=256KB). Two known triggers:

1. **CANN device log level 0 (DEBUG)**: Two `DEV_DEBUG` calls in the scheduler hot path each take ~10μs.
2. **`--enable-profiling`**: Per-task profiling operations (`perf_aicpu_complete_record()` with fanout list traversal, `perf_aicpu_record_phase()`) add comparable overhead.

Both pass with default ring sizes or when the overhead is removed.

**Recommendation:**
- Do not use CANN device log level 0 for testing with small ring buffer configurations. Use level 1 (INFO) or above instead.
- Profiling (`--enable-profiling`) is not supported with small ring buffer configurations. Use default ring sizes when profiling.

## Root Cause

The scheduler hot path in `aicpu_executor.cpp` (`check_running_cores_for_completion` and the dispatch loop) must process task completions fast enough to keep the ring drained. Any per-iteration overhead at the ~10μs level slows the scheduler loop. When ring buffer resources are tight, the slow scheduler causes the orchestrator to block repeatedly in `alloc()`, extending total AICPU execution time from milliseconds to seconds — **exceeding CANN's internal AICPU task timeout threshold**, resulting in termination (error 507018).

With large ring buffers, the orchestrator never blocks, execution completes in tens of milliseconds, well within the timeout.

**Trigger 1 — DEV_DEBUG (~10μs each):**
Controlled experiments confirmed this is purely an execution time issue, not related to dlog internals or CANN DEBUG log accumulation. Replacing `DEV_DEBUG` with a busy-wait of equal duration (no dlog calls, log level 1) produces the same failure.

**Trigger 2 — Profiling:**
Keeping `profiling_enabled = true` but commenting out the actual operations (`perf_aicpu_complete_record`, fanout traversal, `perf_aicpu_record_phase`) makes the test pass, confirming the same overhead-induced timeout pattern.

## Affected Configurations

| Configuration | Log Level 0 | Log Level 1+ | --enable-profiling |
|---|---|---|---|
| Default ring size (window=16384, heap=256MB) | Works | Works | Works |
| Small ring size (window=128, heap=256KB) | **Fails (507018)** | Works | **Fails (507018)** |

## Workaround

- Use CANN device log level 1 (INFO) or above when running tests with small ring buffer configurations.
- Do not use `--enable-profiling` with small ring buffer configurations. Use default ring sizes for profiling.

## Notes

- The exact mechanism by which dlog blocks a single thread internally is a CANN implementation detail and has not been determined.
- A future fix could move profiling operations off the scheduler hot path (deferred write or conditional compilation), similar to the `PTO2_HOT_PATH_LOGGING` fix for DEV_DEBUG.

### Steps to Reproduce

```markdown
# Trigger 1: CANN log level 0
export ASCEND_GLOBAL_LOG_LEVEL=0
export ASCEND_DEVICE_LOG_LEVEL=0
export GLOBAL_LOG_LEVEL=0
python examples/scripts/run_example.py \
    -k tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_ringbuffer/kernels \
    -g tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_ringbuffer/golden.py \
    -p a2a3

# Trigger 2: Profiling
python examples/scripts/run_example.py \
    -k tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_ringbuffer/kernels \
    -g tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_ringbuffer/golden.py \
    -p a2a3 --enable-profiling
```

### Expected Behavior

None

### Actual Behavior

None

### Git Commit ID

fe63325094dabed918eafa63edb1a2fc40c3be6f

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (aarch64)

### Additional Context

_No response_

---

## #412 [Bug] Fan-in >=16 causes silent dependency truncation and tensor arg overflow

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/412
- Created: 2026-03-31T02:04:51Z
- Updated: 2026-04-07T07:11:25Z
- Closed: 2026-04-07T07:11:25Z

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

The `Graph-fanin_N` test case produces incorrect results when `fanin_width > 16` (e.g., Fanin24, Fanin32), reporting:

```
[ERROR] TEST FAILED: Output 'result' does not match golden.
Mismatched elements: 1/1
rtol=1e-05, atol=1e-05
```

Root cause is a **dual overflow**:

**1. Silent dependency truncation (`PTO2_MAX_INPUTS=16`)**

In `pto_orchestrator.cpp`, the `fanin_states[]` array used to collect fan-in dependencies is sized to `PTO2_MAX_INPUTS (16)`. When a barrier task has more than 16 INPUT dependencies (producer tasks), the excess dependencies are **silently discarded with no error or log message**:

```cpp
// pto_orchestrator.cpp:471-475
if (!already_added) {
    if (fanin_count < PTO2_MAX_INPUTS) {   // hard limit of 16
        fanin_states[fanin_count++] = prod_state;
    }
    // exceeds 16 → silently dropped, no error reported
}
```

This causes the barrier task to only wait for the first 16 producers instead of all N.

**2. Tensor argument array out-of-bounds write (`MAX_TENSOR_ARGS=16`)**

The barrier task's arguments consist of 1 INOUT (result) + N INPUTs (producer outputs). When N=24, the total is 25 tensor args, exceeding `MAX_TENSOR_ARGS=16`. When `payload->init()` writes into `PTO2TaskPayload::tensors[MAX_TENSOR_ARGS]`, it causes an **out-of-bounds write** that corrupts the subsequent `dispatch_args` memory region, resulting in the barrier kernel receiving incorrect tensor pointers.

Relevant hardcoded constants (`pto_types.h`):
```c
#define MAX_TENSOR_ARGS 16   // Barrier needs 1+N args; overflows when N>15
#define PTO2_MAX_INPUTS 16   // Dependency tracking limit
```

Fixed-size arrays in `PTO2TaskPayload` (`pto_runtime2_types.h:378-380`):
```cpp
PTO2TaskSlotState* fanin_slot_states[PTO2_MAX_INPUTS];  // [16]
Tensor tensors[MAX_TENSOR_ARGS];                         // [16]
```

### Steps to Reproduce

```bash
# Fanin4 — passes
python examples/scripts/run_example.py \
  -k tests/st/a2a3/tensormap_and_ringbuffer/Graph-fanin_N/kernels \
  -g tests/st/a2a3/tensormap_and_ringbuffer/Graph-fanin_N/golden.py \
  -p onboard --case Fanin4

# Fanin24 — fails
python examples/scripts/run_example.py \
  -k tests/st/a2a3/tensormap_and_ringbuffer/Graph-fanin_N/kernels \
  -g tests/st/a2a3/tensormap_and_ringbuffer/Graph-fanin_N/golden.py \
  -p onboard --case Fanin24

# Fanin32 — fails
python examples/scripts/run_example.py \
  -k tests/st/a2a3/tensormap_and_ringbuffer/Graph-fanin_N/kernels \
  -g tests/st/a2a3/tensormap_and_ringbuffer/Graph-fanin_N/golden.py \
  -p onboard --case Fanin32
```

Trigger condition: any single task whose fan-in dependency count (number of INPUT tensor args) exceeds 16.

| Case | Producers | Actually tracked deps | Result |
|------|-----------|----------------------|--------|
| Fanin4 | 4 | 4 | PASS |
| Fanin16 | 16 | 16 | PASS |
| Fanin24 | 24 | 16 (truncated) | **FAIL** |
| Fanin32 | 32 | 16 (truncated) | **FAIL** |

### Expected Behavior

All fan-in cases (including Fanin24 and Fanin32) should pass correctly with output `result=1.0` matching the golden value. Alternatively, when the runtime's capacity limit is exceeded, a clear error message should be reported instead of silently truncating dependencies.

### Actual Behavior

```
[ERROR] TEST FAILED: Output 'result' does not match golden.
Mismatched elements: 1/1
rtol=1e-05, atol=1e-05
```

Silent dependency truncation combined with tensor arg array out-of-bounds write causes the barrier kernel to produce an incorrect result.

### Git Commit ID

1d97ac5f3ae59b51f1b1c6563a06c95eabeb4d62

### Host Platform

Linux (aarch64)

### Additional Context

**Affected files:**
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_types.h:43` — `PTO2_MAX_INPUTS` definition
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp:471-475` — dependency truncation logic
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2_types.h:378-380` — payload fixed-size arrays
- `tests/st/a2a3/tensormap_and_ringbuffer/Graph-fanin_N/` — triggering test case

**Possible fix directions:**
1. **Raise the limits**: increase `PTO2_MAX_INPUTS`, `MAX_TENSOR_ARGS`, etc. (increases per-task memory footprint)
2. **Multi-stage fan-in at orchestration layer**: split N-way fan-in into a multi-level tree (e.g., 24 → 6 groups × 4-way → 1 × 6-way), ensuring each task stays within the 16-input limit
3. **Add bounds checking**: emit an error in `Arg::add_input()` or during orchestrator submission when tensor arg count exceeds the limit, instead of silently truncating

---

## #429 [Bug] Two ring-buffer allocator defects in pto_ring_buffer.h: heap wrap-around off-by-one and DepListPool sentinel collision

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/429
- Created: 2026-04-01T10:43:53Z
- Updated: 2026-04-02T04:17:10Z
- Closed: 2026-04-02T04:17:10Z

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

Two related allocation logic defects in `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.h`:

**Bug 1 — Heap wrap-around: strict `>` should be `>=` in `try_bump_heap` (line ~270)**

`PTO2TaskAllocator::try_bump_heap` uses `tail > alloc_size` (strict greater-than) when checking whether to wrap the heap pointer to the beginning of the ring. When `tail == alloc_size` there is exactly enough space at `[0, alloc_size)`, but the condition incorrectly rejects it, so the allocator spins until deadlock.

Fix: change `tail > alloc_size` → `tail >= alloc_size`.

**Bug 2 — DepListPool: `top % capacity` returns the NULL sentinel slot (index 0)**

`PTO2DepListPool::alloc()` computes the physical index as `idx = top % capacity` (line ~444). When `top` is a multiple of `capacity` (e.g. `top=8`, `capacity=8`) the result is 0 — the same slot that `init()` reserved as the NULL sentinel. Handing out `&entries_[0]` overwrites the sentinel, breaking `pto2_dep_pool_get()` for callers that rely on a `nullptr` chain terminator at index 0.

Fix: offset the usable range so index 0 is never handed out (e.g. `idx = (top % capacity) + 1` with capacity reduced by 1, or start `top` at 1).

### Steps to Reproduce

1. Run the ring-buffer unit tests that exercise allocation wrap-around and dep-list pool full-cycle allocation (added in PR #427):
   ```
   ctest -R test_ring_buffer
   ```
2. The `HeapWrapAround` test case deadlocks (Bug 1).
3. The `DepListPoolSentinelCollision` test case fails with sentinel corruption (Bug 2).

### Expected Behavior

- `try_bump_heap` should wrap the heap pointer to the start of the ring when `tail == alloc_size`, allowing allocation to succeed.
- `PTO2DepListPool::alloc()` should never return `&entries_[0]` (the NULL sentinel slot); the sentinel must remain intact for the lifetime of the pool.

### Actual Behavior

- **Bug 1**: When `tail == alloc_size` the allocator fails to wrap, enters an infinite spin-wait, and the test times out / deadlocks.
- **Bug 2**: When the pool has been fully cycled (`top` reaches a multiple of `capacity`), `alloc()` returns `&entries_[0]`, overwriting the NULL sentinel and corrupting the dep-list chain termination logic.

### Git Commit ID

9aa96812b8acb8aa9e5a60dab80e9b5a8a2a5e6f

### Host Platform

Linux (aarch64)

### Additional Context

Both defects were discovered while writing unit tests for the ring buffer subsystem. Related PR: #427

---

## #438 Clean up: remove remaining multi-orchestrator scaffolding

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/438
- Created: 2026-04-02T07:00:52Z
- Updated: 2026-04-08T07:51:11Z
- Closed: 2026-04-08T07:51:11Z

### Body

## Context

PR #437 hardcoded `orchestrators[0]` and removed the `thread_local pto2_current_orch_idx` / `pto2_set_orch_thread_idx` mechanism. However, several pieces of multi-orchestrator scaffolding remain in the codebase:

## Remaining code to remove

- **`PTO2_MAX_ORCH_THREADS`** constant (currently 4) in all `pto_runtime2.h` headers
- **`PTO2Runtime::orchestrators[]` array** — can become a single `PTO2OrchestratorState orchestrators[1]` (or a plain member)
- **`PTO2Runtime::orch_count`** field and its validation logic in `pto2_runtime_create_from_sm`
- **`orch_idx` parameter** passed to `orch_func_(args, orch_thread_num_, orch_idx)` in executor — always 0 now
- **`orch_thread_num_` / `sched_thread_num_`** split logic in `aicpu_executor.cpp` (orchestrator vs scheduler thread roles)
- **Multi-orchestrator docs** references in `SUBMIT_BY_CLUSTER.md` mentioning `pto2_current_orch_idx`
- **`perf_aicpu_set_orch_thread_idx`** (`static __thread`) in `performance_collector_aicpu.cpp` — same pattern, also uses thread-local

## Files

- `src/a2a3/runtime/aicpu_build_graph/runtime/pto_runtime2.h`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2.h`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2.h`
- `src/a2a3/runtime/aicpu_build_graph/aicpu/aicpu_executor.cpp`
- `src/a2a3/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp`
- `src/a5/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp`
- `src/{a2a3,a5}/platform/src/aicpu/performance_collector_aicpu.cpp`
- `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/docs/SUBMIT_BY_CLUSTER.md`

---

## #440 [Feature] Add level-aware mode enforcement to DistWorker

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/440
- Created: 2026-04-02T09:29:29Z
- Updated: 2026-04-08T07:50:18Z
- Closed: 2026-04-08T07:50:18Z
- Labels: enhancement

### Body

### Summary

`DistWorker` currently accepts an `int level_` constructor parameter (3=L3, 4=L4, …) but stores it without enforcing any level-specific constraints or capabilities. Add level-aware mode that validates sub-worker types, enforces dispatch rules, and surfaces the level identity through the Python API.

### Motivation / Use Case

The distributed runtime is designed as a recursive hierarchy — L3 dispatches to `ChipWorker` (L2) and `SubWorker`; L4 dispatches to `DistWorker(level=3)` and `SubWorker`; and so on. Today the `level_` field is purely informational: nothing prevents an L4 node from being given a `ChipWorker` directly, or an L3 node from holding another L3 node as a CHIP sub-worker.

Concrete problems this causes:
1. **No validation at construction time** — incorrect wiring (wrong sub-worker type for the level) is silently accepted and only fails at runtime.
2. **No capability query** — Python code cannot ask "what worker types are valid at this level?" and must know the hierarchy out-of-band.
3. **Dispatch routing is type-agnostic** — `WorkerType::CHIP` is used for both L2 `ChipWorker` and lower-level `DistWorker` nodes; a level-aware routing table would make this unambiguous.

### Proposed API / Behavior

```cpp
// C++ — enforce valid sub-worker types per level
class DistWorker : public IWorker {
public:
    // level 3 → accepts ChipWorker (CHIP) + SubWorker (SUB)
    // level 4+ → accepts DistWorker (DIST) + SubWorker (SUB)
    void add_worker(WorkerType type, IWorker* worker);  // throws if invalid for level

    // Query what worker types are accepted at this level
    bool accepts_worker_type(WorkerType type) const;
};
```

```python
# Python
dw = DistWorker(level=3)
dw.accepts_worker_type(WorkerType.CHIP)   # True
dw.accepts_worker_type(WorkerType.DIST)   # False (L3 does not host L3 sub-nodes)

dw4 = DistWorker(level=4)
dw4.accepts_worker_type(WorkerType.CHIP)  # False
dw4.accepts_worker_type(WorkerType.DIST)  # True
```

Level rules (proposed defaults):
- **L3**: CHIP (ChipWorker / L2 device) + SUB (SubWorker fork/shm)
- **L4+**: DIST (lower-level DistWorker) + SUB (SubWorker fork/shm)

### Alternatives Considered

Leave validation entirely to the caller (current behaviour). Rejected because multi-level composition is error-prone and the misuse is only caught at dispatch time, not at construction time.

### Additional Context

- `DistWorker` introduced in PR for Phase 2 (feat/chip-worker branch)
- `src/common/distributed/dist_worker.{h,cpp}`, `python/bindings/dist_worker_bind.h`
- Related architectural context: `.docs/PHASE2_HOST_WORKER.md`, `.docs/UNIFIED_RUNTIME_PLAN.md`

---

## #441 [Feature] SPMD/group kernel support: require_sync_start, drain-mode scheduler, MIX reserve-then-release

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/441
- Created: 2026-04-02T09:39:26Z
- Updated: 2026-04-03T14:11:01Z
- Closed: 2026-04-03T14:11:01Z
- Labels: enhancement

### Body

[SPMD-plan.md](https://github.com/user-attachments/files/26434017/SPMD-plan.md)

### Summary

Add `require_sync_start` to the submit contract and implement the remaining SPMD/group scheduler pieces in the `tensormap_and_ringbuffer` runtime:

1. **`require_sync_start` field** in `PTO2LaunchSpec` / `PTO2TaskSlotState`
2. **MIX queue reserve-then-release**: atomically reserve a full 1C2V cluster, launch only `active_mask` workers, immediately release unused cores
3. **Drain-mode scheduler** (`require_sync_start = true`): single drain-worker pattern, two-phase CAS entry (`-1` sentinel → `block_num`), cross-thread greedy reserve, batch launch with unified doorbell trigger, anti-starvation by pausing all queues during drain
4. **Submit-time admission guard**: reject `require_sync_start = true && block_num >= cluster/AIV limit` at submit entry
5. **Tests**: synchronous launch, resource admission, anti-starvation (drain) correctness, regression

### Motivation / Use Case

SPMD kernels that communicate across blocks (barrier, ping-pong ring buffer, reduction tree) **must** have all blocks launched simultaneously. If the scheduler dispatches block 0 before block 1 is scheduled, block 0 stalls waiting for block 1 → deadlock.

Current partial state:
- `block_num`, `next_block_idx`, `completed_subtasks`, `LocalContext`/`GlobalContext` args-suffix injection, `get_block_idx(args)` / `get_block_num(args)` / `get_sub_block_id(args)` helpers — **done**
- `require_sync_start = false` independent-block dispatch path — **done**
- `require_sync_start = true` sync-start path, MIX reserve-then-release, drain mode — **not yet implemented**

Without `require_sync_start = true`, users writing cross-block SPMD kernels have no safe way to express the synchronous launch requirement.

### Proposed API / Behavior

```cpp
// pto_submit_types.h
class PTO2LaunchSpec {
public:
    int16_t block_num() const { return block_num_; }
    void set_block_num(int16_t n) { block_num_ = n; }
    bool require_sync_start() const { return require_sync_start_; }   // NEW
    void set_require_sync_start(bool v) { require_sync_start_ = v; }  // NEW
private:
    int16_t block_num_{1};
    bool require_sync_start_{false};   // NEW
};
```

Scheduler drain state (cache-line isolated to avoid false sharing with hot path):

```cpp
struct alignas(64) SyncStartDrainState {
    std::atomic<int32_t> sync_start_pending{0};   // 0=normal; -1=initializing; >0=active (=block_num)
    std::atomic<int32_t> drain_worker_elected{0}; // CAS flag
    PTO2TaskSlotState *pending_task{nullptr};
    int32_t _pad[12];
};
static_assert(sizeof(SyncStartDrainState) == 64);
```

Hot-path overhead when no sync-start task is waiting: one `sync_start_pending.load(relaxed)` read per scheduler loop iteration (branch-predicted not-taken).

Key files:
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_submit_types.h`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2_types.h`
- `src/a2a3/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp`

### Alternatives Considered

- **Split into multiple logical tasks**: rejected — breaks single-task dependency/profiling/error-attribution semantics.
- **Rely on `require_sync_start = false` with careful kernel design**: not safe for kernels with cross-block synchronization; deadlock risk cannot be eliminated at the user level.

### Additional Context

Design document: `docs/SPMD-plan.md` (local, not committed).

Todos remaining per the plan:
- `task-model`: add `require_sync_start` field
- `dispatch-refactor`: implement `require_sync_start = true` batch reserve + launch
- `scheduler-strategy`: drain mode, reserve phase, batch launch, anti-starvation
- `tests`: sync launch, admission, drain, regression


---

## #443 [Feature] Add async runtime support to PTO Runtime

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/443
- Created: 2026-04-02T14:33:25Z
- Updated: 2026-04-27T06:54:33Z
- Closed: 2026-04-27T06:54:33Z

### Body

### Summary
Add async runtime support to PTO Runtime.

### Motivation / Use Case
The current runtime execution model is primarily synchronous, which makes it hard to support asynchronous submission, waiting, and more flexible execution orchestration. This issue tracks the async runtime abstraction and implementation needed so follow-up PRs can land against a concrete, reviewable problem statement.

### Additional Context
This issue is being created first because an upcoming PR is intended to fix or implement this capability and should reference a tracked GitHub issue.

---

## #460 [Feature] Add BF16 (bfloat16) support in sim mode

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/460
- Created: 2026-04-07T06:20:50Z
- Updated: 2026-04-08T08:00:56Z
- Closed: 2026-04-08T08:00:56Z
- Labels: enhancement

### Body

### Summary

Adapt simpler's sim (simulation) platform backend to support `bfloat16` (BF16) data type. Currently, sim mode does not handle BF16 tensors, which blocks simulation of models that rely on BF16 (e.g., Qwen3-32B, DeepSeek V3).

This is the downstream counterpart of [hw-native-sys/pto-isa#35](https://github.com/hw-native-sys/pto-isa/issues/35), which added BF16 support to the ISA-level CPU simulator. simpler needs to propagate that support through its sim platform and runtime layers.

### Motivation / Use Case

- **BF16 is the dominant dtype for production LLM inference** (Qwen3, DeepSeek V3, LLaMA 3, etc.). Without sim-mode BF16 support, developers cannot iterate on BF16 kernels using simulation — they must deploy to hardware for every test.
- The upstream ISA simulator (pto-isa) has already landed BF16 support. simpler needs to wire it through so that `run_example.py -p a2a3sim` / `-p a5sim` works with BF16 tensors end-to-end.
- Enables CI simulation tests for BF16 examples without requiring NPU hardware.

### Proposed API / Behavior

No new user-facing API changes expected. BF16 should work transparently:

1. **Tensor allocation / loading**: sim platform's tensor load/store paths should handle BF16 dtype (cast to/from fp32 where needed).
2. **Matmul**: `bf16 × bf16 → fp32` accumulation, matching hardware semantics.
3. **Elementwise / reductions**: BF16 inputs should be promoted to fp32 for computation, then narrowed back to BF16 on store.
4. **Golden comparison**: `golden.py` should be able to generate BF16 inputs and compare outputs with appropriate tolerance.

### Additional Context

- Upstream issue: [hw-native-sys/pto-isa#35](https://github.com/hw-native-sys/pto-isa/issues/35) (closed, BF16 added to ISA sim)
- Sim platform code lives under `src/{arch}/platform/sim/`
- Runtime tensor handling in `src/{arch}/runtime/tensormap_and_ringbuffer/`

---

## #466 [Feature] Provide a direct memory allocation interface without empty task submission

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/466
- Created: 2026-04-07T11:18:20Z
- Updated: 2026-04-09T02:25:09Z
- Closed: 2026-04-09T02:25:09Z
- Labels: enhancement

### Body

### Summary

Memory allocation currently requires creating and submitting an empty task, which is redundant. A direct memory allocation interface should be provided so users can allocate device memory without going through the task submission pipeline.

### Motivation / Use Case

In many use cases, a user simply needs to allocate a block of device memory. However, the existing API requires constructing and submitting an empty task to trigger the allocation. This introduces unnecessary overhead and complexity:

1. **Redundant flow**: A pure memory allocation operation is coupled with the task scheduling pipeline, adding unnecessary task creation and submission overhead.
2. **Unclear interface semantics**: Allocating memory by submitting an empty task is unintuitive and unfriendly to users.
3. **Expected behavior**: Provide a standalone memory allocation interface (e.g., `AllocMemory` or similar API) that can directly allocate memory on the device without going through the task submission flow.


---

## #474 [Bug] pip install fails in conda environment due to CMAKE_C_COMPILER not being a full path

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/474
- Created: 2026-04-08T02:57:07Z
- Updated: 2026-04-15T01:47:22Z
- Closed: 2026-04-15T01:47:22Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

When running `pip install` inside a conda environment, CMake configuration fails because `CMAKE_C_COMPILER` is set to a non-full-path value (`gcc -pthread -B /data/.../.conda/envs/.../compiler_compat`) which CMake cannot resolve.

### Steps to Reproduce

1. Create and activate a conda environment (e.g., `conda create -n myenv python=3.x && conda activate myenv`)
2. Run `pip install` on the package (which triggers a CMake build internally)
3. Observe CMake configuration failure

### Expected Behavior

`pip install` completes successfully; CMake finds a valid C compiler and configures the project without errors.

### Actual Behavior

CMake configuration fails with the following error:

```
[ERROR] [HOST] CMake configuration stderr:
CMake Error at CMakeLists.txt:11 (project):
  The CMAKE_C_COMPILER:

    gcc -pthread -B /data/linyifan/.conda/envs/lyf/compiler_compat

  is not a full path and was not found in the PATH.
```

The root cause is that conda injects compiler flags (e.g., `-pthread -B <compat_dir>`) into the `CC` environment variable, causing CMake to receive a multi-token string instead of a plain compiler path. CMake cannot handle this as `CMAKE_C_COMPILER`.

### Git Commit ID

417acade269d963def37eea010f7aa0151050f07

### Host Platform

Linux (aarch64)


---

## #475 Swimlane chart: distinguish different InCore functions by color

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/475
- Created: 2026-04-08T03:33:07Z
- Updated: 2026-04-08T07:15:09Z
- Closed: 2026-04-08T07:15:09Z

### Body

## Summary

The current swimlane visualization does not distinguish between different InCore functions — all InCore events use the same color. When a program contains multiple InCore kernels (e.g., in a multi-scope decode attention model), it is difficult to visually identify which InCore function each event belongs to.

## Example

`merged_swimlane_*.json` generated from `DecodeAttentionProgram` (Qwen3-32B decode scope2). All `Func_*` events share the same color, making it hard to differentiate between distinct InCore functions in the trace viewer.

## Expected Behavior

Each distinct InCore function should be assigned a unique color (via the `cname` field in the trace event JSON), so users can visually distinguish different kernels at a glance in the swimlane chart.

## Suggested Approach

Assign a distinct `cname` (e.g., from Chrome trace's built-in color palette: `generic_work`, `good`, `bad`, `terrible`, `black`, `light_memory`, `rail_response`, `rail_animation`, etc.) to each unique InCore function when generating the swimlane JSON.

---

## #479 [Feature] Add PMU profiling for individual AIC/AIV tasks

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/479
- Created: 2026-04-08T09:19:12Z
- Updated: 2026-04-24T09:05:43Z
- Closed: 2026-04-24T09:05:43Z
- Labels: enhancement

### Body

### Summary

Add support for profiling each individual AIC or AIV task using hardware Performance Monitoring Units (PMU). This would allow fine-grained performance analysis at the task level, enabling developers to identify bottlenecks and optimize specific AIC/AIV workloads.

### Motivation / Use Case

Currently there is no per-task PMU profiling capability. When debugging performance issues or optimizing kernels, developers need to understand the hardware-level behavior (cycles, cache misses, stalls, etc.) of each AIC or AIV task individually. Without per-task PMU data, it is difficult to pinpoint which specific task is causing performance degradation in a multi-task pipeline.

Per-task PMU profiling would enable:
- Identifying which AIC/AIV tasks are the bottleneck in a pipeline
- Measuring hardware counter metrics (cycles, cache behavior, instruction counts) per task
- Comparing performance across different task implementations
- Guided optimization of individual tasks based on hardware-level insights

---

## #480 [Bug] Handshake failure on Ascend910B3 during core initialization

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/480
- Created: 2026-04-07T08:02:47Z
- Updated: 2026-04-15T03:55:04Z
- Closed: 2026-04-15T03:55:04Z
- Labels: bug

### Body

### Diagnosis

**simpler** — The handshake failure occurs during runtime execution after AICPU kernel initialization. The log shows successful kernel execution start and initialization, followed by "Handshaking with 72 cores", but then only periodic memory statistics continue with no further execution progress, indicating a runtime hang during the handshake phase.

### Description

When running on Ascend910B3 hardware, the process hangs during the core handshake phase. The log shows:
- Successful AICPU kernel execution start and initialization
- "Handshaking with 72 cores" message at timestamp 11:01:14.082.645
- Following this, only periodic memory statistics are logged (every ~10 seconds) with no further execution progress
- No explicit error messages, but the process appears to hang indefinitely after the handshake attempt

### Environment

| Component | Version |
|---|---|
| pypto-lib | 9a4a25f |
| pypto | 55a50150 (branch: ai_fa) |
| simpler | fe63325 (branch: stable) |
| ptoas | 0.22 |
| CANN | not detected (but device log shows socVersion: Ascend910B3) |

### Host Platform

Linux aarch64

### Attachments

---

## #481 a5sim: bgemm TPUSH/TPOP kernel crashes without explicit FIFO consumer tile storage

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/481
- Created: 2026-04-08T11:08:13Z
- Updated: 2026-04-09T12:56:51Z
- Closed: 2026-04-09T12:56:51Z

### Body

## Summary

`a5sim` BGEMM crashes in the mixed TPUSH/TPOP kernel because the FIFO consumer tile is used as a split `TPOP` destination without explicit CPU_SIM backing storage.

## Reproduction

```bash
CC=/opt/homebrew/bin/gcc-15 \
CXX=/opt/homebrew/bin/g++-15 \
PTO_ISA_ROOT=/Users/zhoubot/github/pto-isa \
/Users/zhoubot/github/pto-orgs/simpler/.venv313/bin/python \
examples/scripts/run_example.py --build \
  -k tests/st/a5/tensormap_and_ringbuffer/bgemm/kernels \
  -g tests/st/a5/tensormap_and_ringbuffer/bgemm/golden.py \
  -p a5sim --log-level warn
```

## Actual behavior

The orchestration stage succeeds, but the process segfaults once the AIV kernel starts executing.

## Root cause

The failing kernel is `tests/st/a5/tensormap_and_ringbuffer/bgemm/kernels/mix/kernel_bgemm.cpp`.

It declares:

```cpp
VecFifoTileT vecFifoTile;
```

and then uses it as the destination of split `TPOP`:

```cpp
TPOP<PipeT, VecFifoTileT, TileSplitAxis::TILE_UP_DOWN>(mPipe, vecFifoTile);
```

On `a5sim`, this path is compiled through the CPU_SIM implementation in `pto-isa`, where split `TPOP` copies data into `tile.data()[...]`. After the CPU_SIM tile/memory refactor upstream, a tile like `vecFifoTile` no longer has implicit fallback storage unless it is explicitly assigned.

So in `simpler`, `vecFifoTile.data()` is null during the split copy and the process crashes.

## Consumer-side fix

Explicitly assign CPU_SIM local storage before `TPOP`:

```cpp
VecFifoTileT vecFifoTile;
TASSIGN(vecFifoTile, 0x0);
```

With that change, the same `a5sim` BGEMM run completes successfully.

## Upstream correlation

This matches the upstream PTO-ISA regression tracked here:
- hw-native-sys/pto-isa#50

That issue describes the same behavior change in CPU_SIM tile default-storage semantics after the memory-manager refactor.

---

## #487 [Feature] Develop PagedAttention SPMD Example (Aligned with AscendC paged_attention_antiquantkv)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/487
- Created: 2026-04-09T01:11:55Z
- Updated: 2026-04-21T01:55:48Z
- Closed: 2026-04-21T01:55:48Z
- Labels: enhancement

### Body

## Background

Develop a **PagedAttention SPMD example** in the simpler framework, aligned with the AscendC native implementation `paged_attention_antiquantkv.h` (located at `ops-transformer/attention/incre_flash_attention/op_kernel/arch32/`).

The original AscendC implementation is approximately 1984 lines, targeting the Ascend V220 (arch32) architecture. It is a Flash Attention operator kernel for the incremental decoding phase, deeply optimized for INT8 quantized KV Cache scenarios.

## Key Features to Align With

Based on the analysis in `paged_attention_antiquantkv_analysis.md`, the following core features need to be implemented:

### 1. Paged KV Cache Management
- Block Table addressing: logical block index → physical page index mapping
- Non-contiguous physical memory page management for KV Cache
- Dynamic sequence length support

### 2. AIC/AIV Dual-Core Parallel Pipeline
- **AIC core (matrix computation)**: Q×K^T matmul + P×V matmul
- **AIV core (vector computation)**: Softmax computation + output reduction
- Memory hierarchy utilization: GM → L1 → L0A/L0B/L0C

### 3. Cross-Core Synchronization (FFTS)
- `QK_READY_FLAG`: AIC → AIV, score matrix computation complete
- `SOFTMAX_READY_D`: AIV → AIC, softmax probability matrix ready
- `UPDATE_READY_D`: AIV → AIC, output update complete
- `VEC_DEQ_K0/K1_READY`: AIV → AIC, K ping/pong buffer ready
- `VEC_DEQ_V0/V1_READY`: AIV → AIC, V ping/pong buffer ready

### 4. Online Softmax
- Streaming softmax computation without materializing the full attention matrix
- Temperature scaling, mask application, and numerical stability handling
- Output accumulation and final normalization

### 5. Memory Management & Optimization
- Ping-pong double buffering
- Fine-grained UB memory layout (score/probability matrices, accumulators, etc.)
- Buffer specifications: L0A/L0B 32KB each, L0C 16KB

## Task Breakdown

- [ ] Analyze the complete computation flow and data flow of the AscendC original implementation
- [ ] Design the SPMD version architecture, determining how to map AIC/AIV dual-core logic to the SPMD programming model
- [ ] Implement Paged KV Cache Block Table addressing logic
- [ ] Implement AIC-side matrix computation (Q×K^T, P×V)
- [ ] Implement AIV-side vector computation (Softmax, reduction)
- [ ] Implement cross-core synchronization mechanism
- [ ] Implement Online Softmax streaming computation
- [ ] End-to-end functional verification and correctness testing
- [ ] Performance benchmarking (compared against AscendC original implementation)

## References

- `paged_attention_antiquantkv_analysis.md`: Detailed analysis of the AscendC original implementation
- AscendC source: `ops-transformer/attention/incre_flash_attention/op_kernel/arch32/paged_attention_antiquantkv.h`

---

## #488 [Feature] Unit test development tracking

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/488
- Created: 2026-04-09T01:19:42Z
- Updated: 2026-05-11T11:52:51Z
- Closed: 2026-05-11T11:52:51Z
- Labels: enhancement

### Body

## Summary

Tracking issue for unit test (UT) development across the simpler project. The goal is to build comprehensive offline-runnable unit tests for C++ runtime modules and Python utilities, enabling faster development iteration without requiring hardware.

## Current Progress

Initial UT infrastructure and first batch of tests landed in PR #427 (`add-unit-tests-cpp-and-python` branch):

### C++ Unit Tests (`tests/ut/cpp/`) — GoogleTest-based

Covering the `a2a3/tensormap_and_ringbuffer` runtime:

| Test File | Module Under Test | Status |
|-----------|-------------------|--------|
| `test_ring_buffer.cpp` | `pto_ring_buffer.h/cpp` | 2 intentional failures (expose known heap wrap-around & dep-pool entry-0 bugs) |
| `test_scheduler_state.cpp` | `pto_scheduler.h/cpp` | Pass |
| `test_tensormap.cpp` | `pto_tensormap.h/cpp` | Pass |
| `test_shared_memory.cpp` | `pto_shared_memory.h/cpp` | Pass |
| `test_ready_queue.cpp` | ready queue logic | Pass |
| `test_core_types.cpp` | core type definitions | Pass |
| `test_submit_types.cpp` | `pto_submit_types.h` | Pass |
| `test_tensor.cpp` | `tensor.h` | Pass |
| `test_dispatch_payload.cpp` | `pto2_dispatch_payload.h` | Pass |
| `test_pto_types.cpp` | `pto_types.h` | Pass |

### Python Unit Tests (`tests/ut/`) — pytest-based

| Test File | Module Under Test | Status |
|-----------|-------------------|--------|
| `test_elf_parser.py` | `python/elf_parser.py` | 12 tests, all pass |
| `test_env_manager.py` | `python/env_manager.py` | 7 tests, all pass |
| `test_task_interface.py` | `python/task_interface.py` (nanobind bindings) | Pass |
| `test_runtime_builder.py` | `python/runtime_compiler.py` + `examples/scripts/runtime_builder.py` | Pass |
| `test_chip_worker.py` | `src/common/worker/chip_worker.h/cpp` | Pass |

### CI

- `ut-cpp` job added to `.github/workflows/ci.yml` — builds and runs C++ tests on `ubuntu-latest` (no hardware required)

## Remaining Coverage Gaps

### C++ — High Priority

- [ ] **`aicpu_build_graph` runtime** — `pto_runtime2`, `pto_orchestrator`, `pto_scheduler`, `pto_shared_memory`, `pto_ring_buffer` (shared source with tensormap_and_ringbuffer but different build config)
- [ ] **`host_build_graph` runtime** — `runtime.h/cpp`, aicore/aicpu executors
- [ ] **Platform modules** — `memory_allocator`, `function_cache`, `host_regs`, `raii_scope_guard`, `runtime_compile_info` (host-side, testable offline)
- [ ] **Common modules** — `task_interface/task_args.h`, `data_type.h`, `arg_direction.h` type correctness tests
- [ ] **`a5` architecture** — verify tests also compile against a5 headers (shared runtime source)

### Python — Medium Priority

- [ ] **`kernel_compiler.py`** — `KernelCompiler` class, toolchain selection, flag generation
- [ ] **`toolchain.py`** — `GxxToolchain`, `Aarch64GxxToolchain`, `CCECToolchain` flag/path logic
- [ ] **`examples/scripts/platform_info.py`** — architecture detection, platform discovery
- [ ] **`examples/scripts/run_example.py`** — argument parsing, config loading (unit-testable parts)
- [ ] **`examples/scripts/code_runner.py`** — execution flow logic

### Infrastructure

- [ ] Python UT CI job (pytest on `ubuntu-latest`)
- [ ] Coverage reporting (optional)
- [ ] Fix the 2 known bug-exposing failures in `test_ring_buffer` (tracked separately as bug fixes)

## Motivation / Use Case

Unit tests that run offline (no Ascend hardware) enable:
1. **Faster CI feedback** — catch regressions in seconds, not minutes
2. **Safer refactoring** — runtime internals (ring buffer, scheduler, shared memory) are complex and subtle
3. **Bug detection** — the initial batch already found 2 bugs in ring buffer logic
4. **Developer onboarding** — tests serve as executable documentation of module contracts

## Proposed Approach

- C++ tests use GoogleTest with lightweight stubs for platform headers (no hardware dependency)
- Python tests use pytest with mocking for external dependencies (compilers, file system)
- Tests target module-level contracts, not integration behavior
- Bug-exposing tests are kept with correct expected values; they fail until the bug is fixed

## Additional Context

- PR #427: https://github.com/hw-native-sys/simpler/pull/427
- Tests are under `tests/ut/` (Python) and `tests/ut/cpp/` (C++)
- C++ stubs live in `tests/ut/cpp/stubs/` to isolate platform dependencies

---

## #492 [Feature] Support dual-slot kernel dispatch in Simpler

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/492
- Created: 2026-04-09T03:07:23Z
- Updated: 2026-04-12T13:03:28Z
- Closed: 2026-04-12T13:03:28Z
- Labels: enhancement

### Body

### Summary

Implement dual-slot (pipeline) kernel dispatch for Simpler AICPU runtime to eliminate scheduling gaps and improve core utilization. Allow two tasks (running + pending) to coexist on a single core, with the pending task ready to execute immediately after the running task completes.

### Motivation / Use Case

Current single-slot dispatch creates gaps between kernel execution on AICore:
- AICPU dispatch task → AICore executes → completion → AICPU detects completion → dispatch next task
- AICore idle waiting for next payload during AICPU's dispatch latency

Dual-slot dispatch enables:
1. **Zero-gap pipelining**: pending task can start execution immediately after running task FIN, without waiting for AICPU's next dispatch cycle
2. **Improved core utilization**: reduce wasted core cycles due to dispatch overhead
3. **Better throughput**: enable tighter kernel-to-kernel scheduling on dependent task chains

### Proposed Design

The design spans three main areas:

#### 1. Register Protocol (no changes needed)
- AICPU↔AICore communication via `DATA_MAIN_BASE` (down) and `COND` (up) registers unchanged
- Extended interpretation: `COND` task_id can match either `running_reg_task_id` or `pending_reg_task_id`
- ACK signal semantics expanded: signals payload cache-line lock (dcci complete), enabling safe payload reuse

#### 2. AICPU Data Structure Changes
- `CoreExecState` expansion:
  - Split `executing_reg_task_id` → `running_reg_task_id` + `pending_reg_task_id`
  - Add `pending_slot_state` and `pending_subslot` pointers
  - Extend `CoreTracker` with `pending_states_` bitmap to track pending slot occupancy (one bit per core)
- Layout remains 64-byte cache-line aligned, no space waste

#### 3. Completion Detection State Machine (4 cases)
- **Case A**: `pending FIN` — both tasks complete in one poll cycle (task executed very fast, AICPU missed intermediate ACK/FIN)
- **Case B**: `pending ACK` — running completes, pending promoted to running (normal pipeline flow)
- **Case C**: `running ACK` — release pending slot reservation (enable second dispatch after ACK)
- **Case D**: `running FIN` — task complete, clear state (reached idle state)

#### 4. Dispatch Strategy
- **First Dispatch** (core idle): task enters running slot, pending slot reserved (prevents early second dispatch before ACK)
- **Second Dispatch** (pending slot free): task enters pending slot after observing first dispatch's ACK (payload reuse safe)
- **Payload Reuse**: single per-core payload buffer, safety guaranteed by ACK barrier (AICore must complete dcci before AICPU overwrites)

#### 5. AICore Side
- **No functionality changes required** — main loop naturally supports dual-slot:
  - Each poll cycle: `read DATA_MAIN_BASE` → `dcci(payload)` → `ACK` → `execute` → `FIN`
  - If new task written to DATA_MAIN_BASE during execution, next poll detects it immediately (zero gap)
  - `dispatch_seq` counter ensures monotonic `reg_task_id` per core (differentiates from task_id)

### Alternatives Considered

1. **Double-buffered payload**: allocate two payload slots per core
   - ✗ Wastes GM space (payload is 64B-aligned)
   - ✗ AICore must select which payload to read based on task_id parity
   - Single-buffer with ACK barrier is simpler and safer

2. **Implicit payload locking**: rely on kernel execution timing
   - ✗ Unsafe without explicit signal (dcci timing is not guaranteed)
   - Explicit ACK-based handshake is more robust

The implementation is a natural extension of the existing single-slot dispatch—AICore main loop requires no changes, complexity concentrated in AICPU completion detection and dispatch logic.

**Related prior art**: CANN PyPTO scheduler (Ascend training framework) implements a similar dual-slot scheduler; Simpler design is an architectural simplification optimizing for clarity and correctness.

---

## #495 [Bug] Rebased partial-manual manual scope deadlocks on paged_attention while AUTO mode remains healthy

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/495
- Created: 2026-04-09T07:09:12Z
- Updated: 2026-04-12T03:42:13Z
- Closed: 2026-04-12T03:42:13Z
- Labels: bug

### Body

### Platform

a2a3sim (Ascend 910B/C simulation)

### Runtime Variant

tensormap_and_ringbuffer

### Description

Draft PR [#482](https://github.com/hw-native-sys/simpler/pull/482) adds a hybrid manual-scope mode to `tensormap_and_ringbuffer`:

- `PTO2_SCOPE()` stays in default `AUTO` mode.
- `PTO2_SCOPE(PTO2ScopeMode::MANUAL)` enables scoped explicit same-scope dependency wiring.
- Same-manual-scope producer/consumer edges are expressed with `pto2_rt_add_dependency(...)`.
- Manual-local tensors skip TensorMap replay/discovery.
- Cross-scope boundary tensors still use `owner_task_id` retention and TensorMap frontier/discovery for correctness.

The feature works on the pre-rebase branch, and the `AUTO` path still works after rebasing to current `main`. The failure is specific to the rebased `partial_manual` path on paged-attention.

Current understanding is that the rebase exposed a scheduler/allocator bug in the deferred manual publish path:

- `AUTO` publishes/discovers tasks incrementally during submit.
- `partial_manual` accumulates unpublished tasks inside the manual scope and batch-publishes them at `scope_end()`.
- On rebased `main`, this bursty publish path can report deadlock even after downstream progress is already visible.

Rebase debugging found several concrete issues already:

1. Hidden `alloc_tensors()` tasks with `active_mask == 0` were being published from the manual path.
2. Some non-profiling ready paths could enqueue work without consistently transitioning `PENDING -> READY`.
3. After fixing both of the above locally for diagnosis, the remaining failure is still an allocator/scheduler false-deadlock: a task becomes `READY`, but the allocator aborts based on a narrow `last_alive` heuristic before that progress is fully retired.

This means the problem is not that manual scope is conceptually invalid; it is that the current rebased `partial_manual` integration path is still buggy.

Related: #409

### Steps to Reproduce

```markdown
git checkout 316bfb1c97c4141167e55481cb915d3a26c3c71e
python examples/scripts/run_example.py --build --silent \
  -k tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_partial_manual/kernels \
  -g tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_partial_manual/golden.py \
  -p a2a3sim --clone-protocol https -c 8830244b
```

### Expected Behavior

The rebased `partial_manual` paged-attention example should complete successfully, like the rebased `AUTO` runtime path.

More specifically:

- Manual scope should preserve the intended hybrid semantics from PR #482.
- Same-scope explicit dependencies should execute without TensorMap replay overhead.
- Cross-scope boundary tensors should still remain correct through owner/TensorMap handling.
- The deferred `scope_end()` publish should not deadlock or mis-detect lack of progress.

### Actual Behavior

The rebased `partial_manual` run deadlocks/fails in the runtime while `AUTO` remains healthy.

Observed pattern:

- tasks inside the manual scope are deferred until `scope_end()`
- batch publish starts and early tasks do make progress
- a downstream task becomes `READY`
- allocator still aborts on deadlock / task-ring-full before that ready progress is retired cleanly
- orchestration later fails because expected outputs are not produced

Representative trace excerpts:

```text
dispatch: thread=0 shape=0 task=0 block=0/1
dispatch: thread=2 shape=0 task=4 block=0/1
ready(local): task=5 shape=1 fanin=2/2
dispatch: thread=2 shape=1 task=5 block=0/1
ready(local): task=6 shape=0 fanin=2/2
ready(local): task=1 shape=1 fanin=2/2
dispatch: thread=1 shape=1 task=1 block=0/1
ready(local): task=2 shape=0 fanin=2/2
```

Deadlock snapshot at abort:

```text
task=1 state=3 fanin=2/2 fanout=1/2 active_mask=2 done=1/1 block_num=1 next_block=1
task=2 state=1 fanin=2/2 fanout=1/2 active_mask=1 done=0/1 block_num=1 next_block=0
task=3 state=0 fanin=2/3 fanout=1/2 active_mask=2 done=0/1 block_num=1 next_block=0
task=4 state=4 fanin=1/1 fanout=2/2 active_mask=1 done=1/1 block_num=1 next_block=1
```

State meanings:

- `0 = PENDING`
- `1 = READY`
- `2 = RUNNING`
- `3 = COMPLETED`
- `4 = CONSUMED`

The critical detail is that `task=2` is already `READY` with `fanin=2/2`, so useful progress exists, but the allocator still concludes deadlock.

### Git Commit ID

316bfb1c97c4141167e55481cb915d3a26c3c71e

### CANN Version

N/A

### Driver Version

N/A

### Host Platform

Linux (aarch64)

### Additional Context

Draft implementation reference: [#482](https://github.com/hw-native-sys/simpler/pull/482)

Visual timeline of where the rebased failure happens:

```text
AUTO on rebased main
--------------------
submit qk0 -> publish -> sf0 ready -> dispatch -> pv0 ready -> dispatch -> up0 ...
progress is discovered and drained incrementally during submit

PARTIAL_MANUAL on rebased main
------------------------------
manual scope open
submit qk0 sf0 pv0 up0 qk1 sf1 pv1 up1 ...
(all tasks stay unpublished behind the manual-scope barrier)
                    |
                    v
                scope_end()
                    |
                    +-> batch publish
                    +-> qk0 dispatches
                    +-> sf0 completes
                    +-> pv0 becomes READY
                    +-> allocator still aborts before that READY progress is retired

Observed head snapshot near abort
---------------------------------
task 1 = COMPLETED
task 2 = READY      <--- progress exists here
task 3 = PENDING    <--- still waiting on task 2
task 4 = CONSUMED

Result
------
The runtime treats the burst-published manual path as deadlocked even though
scheduler-visible progress has already advanced past the old head.
```

This report is intentionally focused on the remaining rebased failure, not on the earlier design iterations that have already been corrected. The main question now is how to make the allocator/scheduler treat manual-scope burst publish as first-class progress, so rebased `partial_manual` behaves as safely as `AUTO`.

---

## #502 TaskQueue: NPU shared lightweight task queue for machines

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/502
- Created: 2026-04-10T02:26:51Z
- Updated: 2026-04-24T02:14:09Z
- Closed: 2026-04-24T02:14:09Z
- Labels: enhancement

### Body

### Summary

Implement a lightweight task queue for shared Ascend NPU machines, enabling multi-user job scheduling with automatic device allocation, mutual exclusion, and privilege separation. Users submit commands via task-submit, a root-privileged daemon dispatches them with flock-based NPU locking and runuser de-escalation, ensuring no two tasks compete for the same device.

### Motivation / Use Case

Shared NPU machines with multiple users face a core conflict:

```
User A: python train.py -d 0    ← occupies NPU 0
User B: python train.py -d 0    ← same device, silent corruption or crash
User C: python train.py -d 0    ← unaware of A and B
```

Without coordination:
- Users manually check `npu-smi` and pick a card — error-prone, race-prone
- No mutual exclusion — two jobs on the same NPU cause silent data corruption or OOM kills
- No privilege separation — users need direct device access, can't enforce policies
- No queuing — if all cards are busy, users busy-wait or give up

TaskQueue solves this with:
- **Automatic device allocation**: daemon picks a free NPU from a whitelist, user code just uses logical device 0
- **flock-based mutual exclusion**: `npu-lock` holds a file lock per device, released on process exit (even crashes)
- **Privilege separation**: daemon runs as root, tasks run as the submitting user via `runuser`
- **Queueing**: tasks wait in pending/ until a device is free, FIFO order

### Proposed API / Behavior

Eliminate mandatory `--device auto` from every submission. Users submit commands; daemon handles all device allocation transparently.

Target interface:
```bash
# Simplest form — daemon auto-allocates NPU
task-submit --run "python train.py"

# Explicitly no NPU needed
task-submit --no-device --run "make build"

# Manual override (power user)
task-submit --device 9 --run "python train.py"
```

### Alternatives Considered

**Detect NPU usage from command content** (grep for `torch`, `mindspore`, `import` statements):
- Too fragile — wrapper scripts, compiled binaries, indirect imports all invisible
- On this machine, defaulting to NPU allocation is cheaper than trying to detect

**Keep `--device auto` as required, improve error messages**:
- Lowest effort but doesn't solve the UX problem — users forget the flag, get confusing behavior
- `warn_no_lock` interactive prompt is already a workaround for this

**Allocate all 16 cards via daemon (no free/protected split)**:
- Simpler model but breaks users who need interactive NPU access for debugging
- Current split (0-11 free, 12-15 protected) serves both interactive and queued workflows

### Additional Context

_No response_

---

## #505 [Bug] Fatal reporting is inconsistent across orchestration API and runtime paths

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/505
- Created: 2026-04-10T03:59:25Z
- Updated: 2026-04-13T08:48:31Z
- Closed: 2026-04-13T08:48:31Z
- Labels: bug

### Body

### Platform

All / Unknown

### Runtime Variant

tensormap_and_ringbuffer

### Description

The current fatal handling flow in `tensormap_and_ringbuffer` is inconsistent. As a result, "the orchestration has already entered fatal" and "the scheduler can observe the fatal condition and exit" are not guaranteed to stay in sync.

Confirmed problems include:

- Some runtime fatal paths only set local `orch->fatal` and do not publish a non-zero shared-memory `orch_error_code`
- Some orchestration helpers still forward calls into runtime after fatal instead of short-circuiting consistently
- Some `alloc_tensors(...)` paths still go through `always_assert` when already fatal or when arguments are invalid, instead of following the same fatal behavior as other paths

This leads to two observable classes of failures:

- The orchestration thread has already decided the run cannot continue, but scheduler threads never receive a fatal broadcast and therefore do not follow the unified exit path
- Repeated helper calls after fatal do not behave consistently: some become no-ops, some still proceed, and some assert immediately

Concrete gaps visible in the current code include:

- Timeout paths in `get_tensor_data(...)` / `set_tensor_data(...)`
- The deadlock-guaranteed submit path under `require_sync_start`
- Invalid-argument and already-fatal handling in `alloc_tensors(...)`

### Steps to Reproduce

```markdown
1. Run an orchestration using the `a5` `tensormap_and_ringbuffer` runtime.
2. Trigger any confirmed fatal path, for example:
   - Make `get_tensor_data(...)` or `set_tensor_data(...)` hit a timeout.
   - Trigger the invalid configuration branch of `require_sync_start`.
   - Call `alloc_tensors(...)` again after runtime is already fatal, or pass invalid arguments to it.
3. Observe the local orchestration fatal state, the shared-memory `orch_error_code`, and the behavior of subsequent helper calls.
```

### Expected Behavior

- Once fatal is entered, the runtime should follow one single and consistent exit semantic.
- Every fatal path that is supposed to trigger system-level termination should make the scheduler observe a non-zero `orch_error_code`.
- Repeated orchestration helper calls after fatal should behave consistently and predictably, without diverging into continued forwarding or immediate asserts.

### Actual Behavior

- Some paths only set local `orch->fatal` and do not publish a shared-memory error code.
- Some helpers still call into runtime after fatal instead of short-circuiting consistently.
- Some `alloc_tensors(...)` paths hit `always_assert` directly instead of converging onto the fatal semantics.
- In practice, fatal handling in runtime does not form a unified closed loop, and both scheduler exit visibility and API behavior can diverge.

### Git Commit ID

`5f5a74281519451414d2090aad483ad202437707`

### CANN Version

N/A

### Driver Version

N/A

### Host Platform

Other (issue identified by code inspection; not host-specific)

### Additional Context

- Relevant code areas include:
  - `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2.cpp`
  - `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp`
  - `src/a5/runtime/tensormap_and_ringbuffer/orchestration/pto_orchestration_api.h`
- The issue is described from the current implementation behavior only. It intentionally does not include a proposed fix.

---

## #506 [Feature] Tensor dump for runtime debugging and validation

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/506
- Created: 2026-04-10T04:00:05Z
- Updated: 2026-04-15T02:23:59Z
- Closed: 2026-04-15T02:23:59Z
- Labels: enhancement

### Body

### Summary

Add a tensor dump capability that captures intermediate tensor data (inputs before dispatch and outputs after completion) during runtime execution. This enables offline debugging, golden-value validation, and kernel correctness verification without modifying user kernels.

The feature spans three layers:
- **Platform layer**: common tensor dump interface, AICPU-side dump logic, and host-side collector for gathering dumped data
- **Runtime layer**: integration into `host_build_graph` runtime (with future support for `aicpu_build_graph` and `tensormap_and_ringbuffer`)
- **User interface**: `--dump-tensor` CLI flag in `run_example.py` and a dedicated example (`dump_tensor_example`) demonstrating usage

### Motivation / Use Case

When debugging kernel correctness issues or validating new orchestration flows, developers currently have no built-in way to inspect intermediate tensor values at each execution step. They must manually instrument kernel code or add ad-hoc print statements, which is error-prone and non-reproducible.

A first-class tensor dump feature allows:
- Capturing before-dispatch inputs and after-completion outputs per task, saved to disk as binary files
- Comparing dumped tensors against golden computations to pinpoint which kernel or step produces incorrect results
- Debugging without modifying kernel source — the dump is controlled entirely from the runtime/platform layer

### Proposed API / Behavior

- Enable via `--dump-tensor` flag on `run_example.py`
- Runtime sets `enable_dump` in kernel args; AICPU reads this flag and writes tensor data to a host-visible region
- Host-side `TensorDumpCollector` gathers and writes binary dump files organized by task ID and tensor index
- Output directory: `outputs/tensor_dump_<timestamp>/`

### Additional Context

Work in progress — currently implemented for `host_build_graph` runtime on the `a2a3` architecture.

---

## #507 [Bug] always_assert/debug_assert runs error

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/507
- Created: 2026-04-10T06:20:25Z
- Updated: 2026-04-13T08:18:36Z
- Closed: 2026-04-13T08:18:36Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

always_assert/debug_assert runs error

### Steps to Reproduce

```markdown
fix always_assert/debug_assert
```

### Expected Behavior

assert

### Actual Behavior

 don't assert right

### Git Commit ID

d18163cf7ca9b73eecf7728bfeb5760fd7904747

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (x86_64)

### Additional Context

_No response_

---

## #509 [Bug] Data race on `core_states_` in drain protocol — ack barrier has insufficient semantics

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/509
- Created: 2026-04-10T06:52:23Z
- Updated: 2026-04-13T08:57:00Z
- Closed: 2026-04-13T08:57:00Z
- Labels: bug

### Body

### Platform

a5sim (Ascend 950 simulation)

### Runtime Variant

tensormap_and_ringbuffer

### Description

During drain mode, `core_trackers_[t].core_states_` (a plain `uint64_t`, non-atomic, unprotected) is subject to two classes of data race: read-write conflict and write-write conflict.

The `drain_ack_mask` barrier only guarantees that a thread has stopped issuing new dispatches. It does **not** guarantee that the thread has stopped completion polling (`change_core_state`). As a result, a thread that acks but returns early (because `all_acked` has not yet been reached) immediately re-enters the main scheduling loop and can call `check_running_cores_for_completion`, which writes `core_states_`. Concurrently, another thread may have already been elected and entered `drain_worker_dispatch`, reading and writing the same `core_states_`.

### Race types

| Race type | Concurrent party A | Concurrent party B |
|-----------|--------------------|--------------------|
| Read-write conflict | Thread 1 writes `core_states_[1]` (`change_core_state`, L451) | Thread 2 (elected) reads `core_states_[1]` (`get_valid_cluster_offset_states`) |
| Write-write conflict | Thread 1 writes `core_states_[1]` (`change_core_state`, L451) | Thread 2 (elected) writes `core_states_[1]` (`change_core_state`, L631) |

### Interleaving that triggers the race

```
Thread 0: ack → ack_mask=0x1 ≠ 0x7 → return to main loop

Thread 1: ack → ack_mask=0x3 ≠ 0x7 → return to main loop
Thread 1: [back in main loop] → change_core_state(bit_pos)  ← writes core_trackers_[1].core_states_
                                                              ← Thread 1's ack bit is still set in mask

Thread 2: ack → ack_mask=0x7 == all_acked → elected → drain_worker_dispatch
Thread 2:     get_valid_cluster_offset_states()              ← reads  core_states_[1]
Thread 2:     change_core_state(...)                         ← writes core_states_[1]

↑ Thread 1 and Thread 2 concurrently access the same core_states_ (data race, UB)
```

### Steps to Reproduce

```markdown
Insert the following before `tracker.change_core_state(bit_pos)` at L451 of `aicpu_executor.cpp`:


if ((drain_state_.drain_ack_mask.load(std::memory_order_relaxed)) != 0) { usleep(1000); }
assert((drain_state_.drain_worker_elected.load(std::memory_order_relaxed)) == 0);


Then increase the parameters of the `examples/a5/tensormap_and_ringbuffer/spmd_sync_start_stress` example (and its corresponding golden file) and run. The assert will fail with low probability. An assert failure confirms that the race-prone interleaving was reached; actual memory corruption is undefined behavior and may not produce a visible wrong result on every run.
```

### Expected Behavior

正常运行，assert不失败

### Actual Behavior

assert失败

### Git Commit ID

8d5f25b38d6a09da9feecc847702ebaa58ffd883

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (aarch64)

### Additional Context

_No response_

---

## #510 [Feature] Introduce tiered profiling levels to reduce swimlane collection overhead and measurement distortion

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/510
- Created: 2026-04-10T06:59:32Z
- Updated: 2026-05-19T06:46:02Z
- Closed: 2026-05-19T06:46:02Z
- Labels: enhancement

### Body

### Summary

Current swimlane export (perf_swimlane_*.json) relies on extensive timestamping and profiling-related data read/write operations during runtime. These profiling activities introduce non-negligible overhead and can slightly distort the very performance data being measured.

To address this, replace the boolean --enable-profiling / enable_profiling switch with a tiered perf_level model so users can trade off profiling detail versus perturbation:

- 0: profiling off
- 1: AICore-only profiling (minimal overhead)
- 2: task + fanout profiling
- 3: full profiling with AICPU phase records

This change enables controllable profiling granularity and makes collected performance data more representative for different analysis needs.

### Motivation / Use Case

- Reduce observer effect: full tracing adds runtime overhead; lower tiers reduce instrumentation impact and improve fidelity of measured timings.
- Support different analysis goals: quick hotspot checks often need only lightweight AICore timing, while deep diagnosis may require full AICPU phase visibility.
- Improve usability: users can select profiling granularity from CLI (--enable-profiling [LEVEL]) instead of all-or-nothing behavior.
- Balance cost and detail: choose lower overhead in routine tuning/CI runs, and escalate to full mode only when deeper root-cause analysis is required.

### Proposed API / Behavior

_No response_

### Alternatives Considered

_No response_

### Additional Context

_No response_

---

## #512 [Feature] Add native swimlane preview in PyPTO-Toolkit VSCode extension for new PyPTO traces

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/512
- Created: 2026-04-10T07:28:36Z
- Updated: 2026-04-23T01:52:10Z
- Closed: 2026-04-23T01:52:10Z
- Labels: enhancement

### Body

### Summary

The current workflow converts perf_swimlane_*.json into Perfetto-compatible merged_swimlane_*.json via Python scripts, then requires users to download files and open them manually in the Perfetto web UI for inspection.

This flow is cumbersome and not IDE-native. In addition, dependency edge rendering in Perfetto is tightly constrained by task start/end timestamps, so forcing edge direction does not reliably produce the intended visualization.

This issue proposes adding native swimlane preview support for new PyPTO traces directly in the PyPTO-Toolkit VSCode extension, so users can inspect traces in-IDE without relying on the external Perfetto web workflow.

### Motivation / Use Case

Simplify developer workflow: preview swimlane traces directly in VSCode, removing manual export/download/open steps.
Improve productivity: reduce context switching between repo, local files, and browser Perfetto UI.
Provide PyPTO-specific visualization semantics: handle dependency direction and task relationships with rendering logic tailored to PyPTO data, not limited by Perfetto’s timestamp-driven edge behavior.
Lower adoption barrier: make swimlane analysis easier for daily debugging, performance tuning, and CI artifact inspection.

### Proposed API / Behavior

_No response_

### Alternatives Considered

_No response_

### Additional Context

_No response_

---

## #517 [Bug] Build fails with CANN 8.5.1: BLK macro collision in tensor.h

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/517
- Created: 2026-04-10T11:37:49Z
- Updated: 2026-04-13T08:12:43Z
- Closed: 2026-04-13T08:12:43Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

`pip install -v .` fails when building with CANN 8.5.1's device compiler (`ccec`). CANN 8.5.1 introduces a preprocessor macro `#define BLK BLK_Type()` in `__clang_cce_vector_intrinsics.h:555`, which collides with the local variable `constexpr uint64_t BLK = 64` in `tensor.h:300`.

The macro expands the variable declaration into invalid code, causing:

```
src/a5/runtime/tensormap_and_ringbuffer/runtime/tensor.h:300:28: error: illegal initializer (only variables can be initialized)
```

CI passes because it uses CANN 8.5.0, which does not define the `BLK` macro.

### Steps to Reproduce

1. Install CANN 8.5.1 and ensure `ccec` resolves to the 8.5.1 binary
2. Clone simpler on `stable` branch (commit d62341b)
3. Run `CC=/usr/bin/gcc CXX=/usr/bin/g++ pip install -v .`
4. Build fails on all a5 aicore compilation units that include `tensor.h`

### Expected Behavior

Build completes successfully regardless of CANN 8.5.0 or 8.5.1.

### Actual Behavior

All aicore compilation units fail with the same error:

```
FAILED: [code=1] common_aic.o
tensor.h:300:28: error: illegal initializer (only variables can be initialized)
  constexpr uint64_t BLK = 64;
                           ^
__clang_cce_vector_intrinsics.h:555:13: note: expanded from macro 'BLK'
#define BLK BLK_Type()
            ^
```

Affected targets: `common_aic.o`, `common_aiv.o`, `aicore_executor_aic.o`, `aicore_executor_aiv.o`

### Git Commit ID

d62341b385191c6592206e5a81049a93f5a47b8b

### CANN Version

8.5.1 (build 20251230_093648626)

### Host Platform

Linux (aarch64)

### Additional Context

The collision is between:
- **CANN 8.5.1** header: `/path/to/cann-8.5.1/tools/bisheng_compiler/lib/clang/15.0.5/include/npu_arch_3101/__clang_cce_vector_intrinsics.h:555` defines `#define BLK BLK_Type()`
- **simpler** source: `src/a5/runtime/tensormap_and_ringbuffer/runtime/tensor.h:300` declares `constexpr uint64_t BLK = 64`

CANN 8.5.0 does not define this macro, which is why CI is unaffected.

---

## #528 Refactor: migrate all golden.py + kernel_config.py to SceneTestCase

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/528
- Created: 2026-04-13T02:57:07Z
- Updated: 2026-04-20T12:21:56Z
- Closed: 2026-04-20T12:21:56Z
- Labels: enhancement

### Body

## Summary

Migrate all remaining `golden.py` + `kernel_config.py` examples to `@scene_test` (`test_*.py`), making pytest the sole test runner. After migration, `ci.py` and `run_example.py` can be fully retired.

PR #525 added `--rounds`, `--skip-golden`, `--enable-profiling`, `--build`, `--log-level` to SceneTestCase, so `test_*.py` now covers all use cases that `run_example.py` supported.

## Requirements

### 1. All examples rewritten as pytest SceneTestCase

Every `golden.py` + `kernel_config.py` pair must be replaced by a `test_*.py` using `@scene_test`. See `.docs/SCENE_TEST_MIGRATION_GUIDE.md` for the full conversion reference.

### 2. Directory reorganization

| Current location | Rule | New location |
|-----------------|------|-------------|
| `examples/{arch}/host_build_graph/*` | All HBG move to st | `tests/st/{arch}/host_build_graph/*` |
| `examples/{arch}/aicpu_build_graph/*` | All ABG move to st | `tests/st/{arch}/aicpu_build_graph/*` |
| `examples/{arch}/tensormap_and_ringbuffer/<meaningful>` | Meaningful kernels stay in examples | `examples/{arch}/tensormap_and_ringbuffer/<meaningful>` |
| `examples/{arch}/tensormap_and_ringbuffer/<synthetic>` | Synthetic/stress tests move to st | `tests/st/{arch}/tensormap_and_ringbuffer/<synthetic>` |

**"Meaningful"** = real-world algorithms (paged_attention, bgemm, matmul, etc.)
**"Synthetic"** = framework stress tests (spmd_*, mixed_example, multi-round-paged-attention, etc.)

### 3. Case parity with pre-#491 ci.py

The migrated `CASES` list must cover the same test configurations that `ci.py` ran before PR #491 introduced SceneTestCase. Specifically:

- `ci.py` discovered examples in **sorted directory order** within each runtime, scanning `examples/` first then `tests/st/`
- Each example ran its `DEFAULT_CASE` by default (or all `ALL_CASES` with `--all`)
- The case parameters (batch, M, N, block_dim, aicpu_thread_num, etc.) must be preserved exactly

**Verification**: after migration, the set of (example, case, params) that `pytest --platform a2a3 --all-cases` executes must be a **superset** of what `python ci.py -p a2a3 --all` previously ran. No case should be lost.

### 4. Delete legacy files after migration

Per example:
- Delete `golden.py`
- Delete `kernels/kernel_config.py`
- Keep `kernels/` C++ sources (referenced by `CALLABLE`)

### 5. examples/ vs tests/st/ dual-directory merge

When the same example exists in both `examples/` and `tests/st/` (e.g. `batch_paged_attention`):
- `examples/` has small-scale cases (sim-compatible)
- `tests/st/` has production-scale cases (hardware-only benchmark)

Merge into **one** `test_*.py`:
- Small cases: `"platforms": ["a2a3sim", "a2a3"]`
- Large/benchmark cases: `"platforms": ["a2a3"], "manual": True`

File location follows the rule in section 2 above.

## Inventory

### Already migrated (reference)
- `examples/a2a3/tmr/vector_example` — simplest L2
- `examples/a2a3/tmr/scalar_data_test` — Scalar params
- `examples/a2a3/tmr/paged_attention_ringbuffer` — paged attention variant
- `examples/a2a3/abg/paged_attention` — ABG runtime
- `examples/a2a3/hbg/paged_attention` — HBG runtime
- `tests/st/a2a3/tmr/alternating_matmul_add` — multi-case + manual benchmark
- `tests/st/a2a3/tmr/test_l3_dependency.py` — L3 test
- `tests/st/a2a3/tmr/test_l3_group.py` — L3 test

### To migrate

**examples/a2a3/tensormap_and_ringbuffer/** (keep meaningful, move synthetic to st):
- [ ] `batch_paged_attention` — merge with `tests/st/` version → examples (meaningful)
- [ ] `bgemm` — merge with `tests/st/benchmark_bgemm` → examples (meaningful)
- [ ] `paged_attention` — merge with `tests/st/` version → examples (meaningful)
- [ ] `mixed_example` → move to tests/st (synthetic)
- [ ] `multi-round-paged-attention` → move to tests/st (synthetic)
- [ ] `spmd_basic` → move to tests/st (synthetic)
- [ ] `spmd_multiblock_aiv` → move to tests/st (synthetic)
- [ ] `spmd_multiblock_mix` → move to tests/st (synthetic)
- [ ] `spmd_starvation` → move to tests/st (synthetic)
- [ ] `spmd_sync_start` → move to tests/st (synthetic)
- [ ] `spmd_sync_start_aiv` → move to tests/st (synthetic)
- [ ] `spmd_sync_start_edge` → move to tests/st (synthetic)
- [ ] `spmd_sync_start_stress` → move to tests/st (synthetic)

**examples/a2a3/host_build_graph/** (all move to st):
- [ ] `vector_example` → tests/st
- [ ] `matmul` → tests/st
- [ ] `bgemm` → tests/st

**examples/a2a3/aicpu_build_graph/** (all move to st):
- [ ] `vector_example` → tests/st
- [ ] `bgemm` → tests/st

**tests/st/ (already in st, just need test_*.py)**:
- [ ] `tests/st/a2a3/tmr/batch_paged_attention` (merge with examples/)
- [ ] `tests/st/a2a3/tmr/benchmark_bgemm` (merge with examples/bgemm)
- [ ] `tests/st/a2a3/tmr/paged_attention`
- [ ] `tests/st/a2a3/tmr/paged_attention_unroll`
- [ ] `tests/st/a2a3/abg/paged_attention_unroll`
- [ ] `tests/st/a2a3/hbg/paged_attention`

**a5 platform** (mirror a2a3 structure):
- [ ] `examples/a5/tmr/*` (11 directories)
- [ ] `examples/a5/hbg/paged_attention`
- [ ] `tests/st/a5/*` (3 directories)

## Migration guide

See `.docs/SCENE_TEST_MIGRATION_GUIDE.md` for step-by-step conversion instructions, code templates, and verification commands.

## Post-migration cleanup

After all examples are migrated:
- [ ] Mark `run_example.py` as fully deprecated (or delete)
- [ ] Mark `ci.py` as fully deprecated (or delete)
- [ ] Remove `golden/` shared module directory (inline into test classes)
- [ ] Update `docs/testing.md` to remove legacy references

---

## #531 [Bug] Stale _task_interface.so from cross-repo pip install causes ImportError

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/531
- Created: 2026-04-13T06:43:00Z
- Updated: 2026-04-13T09:49:45Z
- Closed: 2026-04-13T09:49:45Z
- Labels: bug

### Body

### Platform

All / Unknown

### Runtime Variant

All / Unknown

### Description

When multiple clones/worktrees of this repo coexist on the same machine, running `pip install .` (or `pip install -e .`) from one source tree overwrites the `_task_interface.so` in the shared `~/.local/lib/python3.10/site-packages/`. A subsequent run from a **different** source tree silently loads the stale `.so`, causing:

```
[ERROR] Import error: cannot import name 'ChipCallConfig' from '_task_interface'
```

The root cause is that the `_task_interface` native extension contains **no source-tree fingerprint** — Python cannot detect that the loaded `.so` was built from a different (possibly older) source tree.

The problem is amplified by scikit-build-core's editable install mechanism: `_simpler_editable.pth` injects a `MetaPathFinder` into `sys.meta_path[0]` on **every** Python startup, which takes priority over all `sys.path`-based lookups and forces the stale `.so`.

### Steps to Reproduce

1. Clone two copies of the repo (e.g., `repo-A` and `repo-B`) where `repo-A` has an older version of bindings (e.g., uses `CallConfig` instead of `ChipCallConfig`)
2. In `repo-A`, run `pip install .` **without** a project-local venv — this installs into `~/.local/`
3. In `repo-B` (which has the `ChipCallConfig` rename), run `pip install .` — this overwrites `~/.local/`
4. Run any example or test from `repo-B` — **succeeds** (fresh `.so` is correct)
5. In `repo-A`, run `pip install .` or `pip install -e .` again — overwrites `~/.local/` with the old `.so`
6. Run any example or test from `repo-B` again — **fails** with `ImportError: cannot import name 'ChipCallConfig'`

### Expected Behavior

Either:
- The import should succeed (each source tree uses its own `.so`), or
- A clear, actionable error message should be raised at import time indicating the loaded `.so` was built from a different source tree, with instructions to rebuild

### Actual Behavior

```
[ERROR] Import error: cannot import name 'ChipCallConfig' from '_task_interface'
```

No indication that the `.so` came from a different source tree. The user must manually investigate `sys.path`, `site-packages`, and `.pth` files to diagnose.

### Git Commit ID

d67895a664d429d3f6ea683e21c16125281397d4

### Host Platform

Linux (aarch64)

### Additional Context

**Proposed fix**: Embed `CMAKE_SOURCE_DIR` as `_task_interface._source_dir` in the C++ bindings at build time. At Python import time in `python/simpler/task_interface.py`, validate that `_source_dir` matches the current source tree path. If mismatched, raise a descriptive `ImportError` with both paths and a rebuild command.

**Files involved:**
- `python/bindings/CMakeLists.txt` — add `target_compile_definitions` with source dir
- `python/bindings/task_interface.cpp` — expose `_source_dir` attribute in module
- `python/simpler/task_interface.py` — add import-time validation guard

---

## #545 [Performance] Runtime performance optimization tracking

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/545
- Created: 2026-04-14T03:23:14Z
- Updated: 2026-06-04T11:07:49Z
- Labels: performance

### Body

This issue tracks runtime performance optimization work for the `tensormap_and_ringbuffer` runtime on a2a3 / a5. Findings, measurements, and proposed optimizations are added as comments.

**Orchestrator-specific tracking is split out to #984** — covers a2a3 per-phase baseline measurements, a5 platform pressures (cluster topology, frequency, AICore +50%), Host-on-UB deployment evaluation, and dedicated-hardware design sketches for the streaming orchestrator. This issue (#545) continues to track the rest of the runtime path: scheduler / dispatch, completion handling, runtime wrapping (Python / C bindings), inter-task synchronization, AICPU thread placement, etc.

## Landed optimizations

- **Dual-slot scheduling for mix subgraph tasks** ✅ — PRs #477, #553. AIC + AIV kernels inside a mixed task now dispatch into two hardware slots concurrently instead of serializing.

## Reproduction

```bash
python examples/scripts/run_example.py \
    -k tests/st/a2a3/tensormap_and_ringbuffer/paged_attention/kernels \
    -g tests/st/a2a3/tensormap_and_ringbuffer/paged_attention/golden.py \
    -p a2a3 -d 5 -n 10
```


---

## #549 [Code Health] Runtime hardcodes dlsym("aicpu_orchestration_entry") instead of using ChipCallable func_name

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/549
- Created: 2026-04-14T07:52:55Z
- Updated: 2026-04-15T00:37:54Z
- Closed: 2026-04-15T00:37:54Z
- Labels: code health

### Body

### Category

Naming / Consistency

### Component

AICPU Scheduler

### Description

The `tensormap_and_ringbuffer` runtime hardcodes the orchestration entry symbol name via `dlsym(handle, "aicpu_orchestration_entry")` in the AICPU executor, completely ignoring the `func_name` field stored in `ChipCallable`.

This causes a mismatch: `kernel_config.py` files specify a `function_name` (e.g., `"build_paged_attention_graph"`) that is compiled into the `ChipCallable` and passed to the runtime — but the runtime never reads it. The field is effectively dead data on this code path.

**Impact:**
- The `function_name` in kernel configs is misleading — it suggests user control over the entry point, but the runtime ignores it
- If orchestration C++ ever uses a different exported symbol name, it will silently fail with a NULL dlsym
- New contributors and tests copy stale/wrong function names (e.g., `build_paged_attention_graph`) without issue, hiding the inconsistency

### Location

- `src/a2a3/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp:2317-2321` — hardcoded `dlsym("aicpu_orchestration_config")` and `dlsym("aicpu_orchestration_entry")`
- `src/a5/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp` — same pattern

### Proposed Fix

Read the `func_name` from the `ChipCallable` (already available in the runtime args) and pass it to `dlsym()` instead of the hardcoded string. The config function name can follow a convention like appending `_config` to the entry function name.

Alternatively, if enforcing a single entry point name is intentional, document this as a requirement and validate that the `ChipCallable.func_name` matches `"aicpu_orchestration_entry"` at compile time, so mismatches are caught early.

### Priority

Low (no impact today, good to fix eventually)

---

## #565 Bug: dispatch batch loop OOB when SPMD task drains all idle clusters

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/565
- Created: 2026-04-15T06:36:14Z
- Updated: 2026-04-15T07:31:14Z
- Closed: 2026-04-15T07:31:13Z

### Body

## Summary

In `aicpu_executor.cpp`, the idle-dispatch batch loop can index `core_id_map_[-1]`, causing an out-of-bounds memory access that corrupts core state and stalls the scheduler.

## Root Cause

The idle-dispatch code (`Phase 4`) computes `want = valid_cluster_states.count()` (number of idle clusters) and uses it as `max_count` to `pop_ready_tasks_batch()`. This implicitly assumes **1 task = 1 cluster**, but an SPMD task with `logical_block_num >> cluster_count` (e.g. 256 blocks on 24 clusters) consumes **all** idle clusters in a single do-while pass.

When `got > 1` (multiple tasks in the batch), the first task's do-while exhausts all clusters. The `for (bi)` loop then advances to the next task and enters the do-while — which is a **do-while** (body executes unconditionally before the guard), so `pop_first()` is called on an empty bitmask, returning **-1**.

The -1 is then used as `cluster_offset` in:
- `core_id_map_[-1]` → array out-of-bounds read
- `1ULL << -1` in `change_core_state` → undefined behavior (negative shift)

This corrupts `core_states_`, causing subsequent scheduling decisions to be wrong, eventually leading to a scheduler stall.

## Trigger Condition

- `logical_block_num` >> `cluster_count` (e.g. paged-attention with block_num = batch × q_loop = 256, cluster_count = 24)
- Multiple tasks queued simultaneously in the ready queue (bn > 1, or any scenario where `pop_ready_tasks_batch` returns `got > 1`)
- The first task in the batch exhausts all idle clusters, leaving none for subsequent tasks

With bn=1 the bug is masked because only one task is in the ready queue at a time, so `got` is always 1.

## Affected Files

- `src/a2a3/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp` (idle dispatch do-while, ~L1831)
- `src/a5/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp` (same pattern, ~L1814)

## Proposed Fix

Convert the do-while to a guarded pattern: check `valid_cluster_states.has_value()` **before** entering the loop body. When clusters are exhausted mid-batch, re-enqueue the remaining tasks and break out of the for loop. Minimal, zero-overhead on the hot path (single branch check).

## Impact

- **Severity**: High — OOB memory write + UB on hardware
- **Scope**: Any SPMD workload with `logical_block_num > cluster_count` and concurrent task submission

---

## #573 [Feature] Add ring buffer memory usage profiling

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/573
- Created: 2026-04-16T00:58:00Z
- Updated: 2026-05-30T01:19:55Z
- Closed: 2026-05-30T01:19:55Z
- Labels: enhancement

### Body

### Summary

Add profiling support for ring buffer to observe and report memory usage. This would allow developers to monitor how much memory the ring buffer consumes at runtime, helping with capacity planning, debugging memory pressure, and optimizing buffer configurations.

### Motivation / Use Case

Currently there is no built-in way to inspect the memory footprint of ring buffers during execution. When tuning ring buffer sizes or diagnosing memory-related issues (e.g., OOM, excessive allocation), developers must resort to external tools or manual calculation. A first-class profiling mechanism would:

- Provide visibility into actual ring buffer memory consumption per task/block
- Help identify memory waste from over-provisioned buffers
- Aid in diagnosing memory pressure in multi-block orchestration scenarios
- Integrate with existing profiling infrastructure for a unified view

### Proposed API / Behavior

Expose ring buffer memory statistics (allocated size, peak usage, utilization ratio) through the existing profiling/metrics infrastructure. Could be reported as part of the profiling output or via a dedicated query API.

### Alternatives Considered

- Manual calculation based on buffer configuration parameters — error-prone and doesn't reflect actual runtime behavior
- External memory profiling tools (e.g., valgrind, npu-smi) — high overhead and not ring-buffer-specific

### Additional Context

Related: #409, #510

---

## #581 [Bug] a2a3sim tensormap_and_ringbuffer cannot replay hardware-passing cross-core kernels from PyPTO

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/581
- Created: 2026-04-16T06:09:38Z
- Updated: 2026-05-28T03:12:09Z
- Closed: 2026-04-21T01:25:06Z
- Labels: bug

### Body

### Platform

a2a3sim (Ascend 910B/C simulation)

### Runtime Variant

tensormap_and_ringbuffer

### Description

Cross-core PTO2 kernels that pass on `a2a3` hardware cannot be replayed with `simpler/examples/scripts/run_example.py` on `a2a3sim`.

I validated 6 PyPTO-generated cross-core cases on hardware first, saved their case roots, and then tried to replay the saved kernels directly through `simpler` simulation.

Hardware result:
- 6/6 pass on `a2a3` hardware

Simulation result on the exact saved case roots:
- `cross_core_v2c_updown` and `cross_core_v2c_leftright`: crash during runtime, exit code `139`
- `cross_core_c2v_leftright`, `cross_core_c2v_updown`, `cross_core_bidirect_updown`, `cross_core_bidirect_leftright`: hang in PTO2 dispatch; logs show repeated `STUCK-READY` / `STUCK-WAIT`, and `PTO2 timeout after 800001 idle iterations`

This looks like an `a2a3sim` runtime issue for cross-core tensormap/ringbuffer PTO2 execution, not a codegen failure:
- the same case roots pass on hardware
- `simpler` recompiles the case roots successfully for `a2a3sim`
- failures happen during simulated runtime execution

Related: #409

### Steps to Reproduce

I prepared a local reproduction bundle with:
- one V2C case that reproduces the crash
- one C2V case that reproduces the PTO2 stall
- full logs for all 6 cases

Bundle contents were produced from:
- `simpler` commit: `1d4c218456451fa99de3ace9601b01fd210a31dd`
- PyPTO commit used to generate the case roots: `717dfef924fc13780b068afedf8fa792f7d27876`
- PTO-ISA commit: `d96c8784`
- Host: `Linux (aarch64)`
- CANN: `8.5.0.alpha001`

Repro A, minimal crash case:

```bash
export PTO_ISA_ROOT=/tmp/pto-isa-d96c8784
cd simpler/simpler

python examples/scripts/run_example.py \
  -k /path/to/cross_core_v2c_updown \
  -g /path/to/cross_core_v2c_updown/golden.py \
  -p a2a3sim \
  -c d96c8784 \
  --clone-protocol https \
  --log-level info
```

Repro B, minimal stall case:

```bash
export PTO_ISA_ROOT=/tmp/pto-isa-d96c8784
cd simpler/simpler

python examples/scripts/run_example.py \
  -k /path/to/cross_core_c2v_leftright \
  -g /path/to/cross_core_c2v_leftright/golden.py \
  -p a2a3sim \
  -c d96c8784 \
  --clone-protocol https \
  --log-level info
```

The case roots are standard saved outputs from hardware validation, each containing:
- `kernel_config.py`
- `golden.py`
- `kernels/`
- `orchestration/`
- `data/`

### Expected Behavior

`a2a3sim` should be able to replay these saved cross-core case roots successfully, or at minimum fail with a deterministic and actionable unsupported-feature error.

It should not:
- segfault for V2C cases
- deadlock / stall in PTO2 dispatch for C2V / bidirectional cases

### Actual Behavior

V2C crash case:
- `cross_core_v2c_updown` exits with code `139`
- the minimal log ends during `resolve_and_dispatch_pto2`
- representative tail:

```text
[INFO] run: Thread 3: Config: expected_args=3
[INFO] run: Thread 3: Ring sizes: task_window=16384, heap=268435456, dep_pool=16384
[INFO] resolve_and_dispatch_pto2: [INFO] resolve_and_dispatch_pto2: Thread 1: resolve_and_dispatch_pto2 entry
[INFO] resolve_and_dispatch_pto2: Thread 1: sm_base=0xfffd7317e010
[INFO] resolve_and_dispatch_pto2: Thread 1: header=0xfffd7317e010, task_desc_offset[0]=320, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 1: hank=0timeout: the monitored command dumped core
```

C2V stall case:
- orchestrator reports `ring 2: total_tasks=4`
- runtime reports `PTO2 total submitted tasks = 4, already executed 2 tasks`
- then the log repeatedly reports `STUCK-READY` and `STUCK-WAIT`
- then `resolve_and_dispatch_pto2` reports `PTO2 timeout after 800001 idle iterations`
- representative lines:

```text
[INFO] pto2_orchestrator_done: [pto_orchestrator.cpp:872] === [Orchestrator] ring 2: total_tasks=4 ===
[ALWAYS] run: PTO2 total submitted tasks = 4, already executed 2 tasks
[ALWAYS] resolve_and_dispatch_pto2:   STUCK-READY  ring=2 task_id=8589934593 kernel_id=0 refcount=2 fanin=2 state=0
[ALWAYS] resolve_and_dispatch_pto2:   STUCK-WAIT   ring=2 task_id=8589934595 kernel_id=0 refcount=2 fanin=3 state=0
[ERROR] resolve_and_dispatch_pto2: Thread 2: PTO2 timeout after 800001 idle iterations
```

### Git Commit ID

1d4c218456451fa99de3ace9601b01fd210a31dd

### CANN Version

8.5.0.alpha001

### Driver Version

`npu-smi` banner reports `25.3.rc1`

### Host Platform

Linux (aarch64)

### Additional Context

Hardware validation command used to produce the saved case roots:

```bash
PTO_ISA_ROOT=/tmp/pto-isa-d96c8784 \
PYTHONPATH=$(pwd)/python:$PYTHONPATH \
python -m pytest tests/st/runtime/test_cross_core.py -vv -rA --forked \
  --platform=a2a3 --device=4 \
  --save-kernels \
  --kernels-dir=build_output/cross_core_hw_a2a3_d96c8784_20260416_112259 \
  --pto-isa-commit=d96c8784
```

Hardware result:
- `6 passed, 6 warnings in 16.78s`

All 6 hardware-passing case roots were checked with `simpler` on `a2a3sim`:
- `cross_core_v2c_updown`: SIGSEGV
- `cross_core_v2c_leftright`: SIGSEGV
- `cross_core_c2v_leftright`: PTO2 stall / timeout
- `cross_core_c2v_updown`: PTO2 stall / timeout
- `cross_core_bidirect_updown`: PTO2 stall / timeout
- `cross_core_bidirect_leftright`: PTO2 stall / timeout


---

## #588 [Bug]  pytest probabilistic crash

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/588
- Created: 2026-04-17T06:28:26Z
- Updated: 2026-04-21T07:00:58Z
- Closed: 2026-04-21T07:00:58Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

pytest probabilistic crash

https://github.com/hw-native-sys/simpler/actions/runs/24495158423/job/71588335481?pr=580
https://github.com/hw-native-sys/simpler/actions/runs/24553750130/job/71785162572

### Steps to Reproduce

```markdown
pytest probabilistic crash
```

### Expected Behavior

pass

### Actual Behavior

pytest probabilistic crash

### Git Commit ID

HEAD

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (x86_64)

### Additional Context

_No response_

---

## #599 [Bug] Swimlane profiling drops fanout edges for producers completing before consumer wiring

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/599
- Created: 2026-04-20T07:15:30Z
- Updated: 2026-05-11T12:00:34Z
- Closed: 2026-05-11T12:00:34Z
- Labels: bug

### Body

## Platform

All (a2a3, a5)

## Runtime Variant

tensormap_and_ringbuffer (also affects aicpu_build_graph)

## Description

When AICPU profiling is enabled, the swimlane trace's per-task `fanout` list
silently drops dependency edges for any producer that has already transitioned
to `PTO2_TASK_COMPLETED` by the time the scheduler wires its downstream
consumer. The dropped edges never appear in `perf_swimlane_*.json` (and
therefore not in the Perfetto-converted trace either), which makes the
captured dependency graph a lower bound — it is structurally incomplete.

This was discovered while inspecting a Qwen3-32B single-layer decode run from
PyPTO. The decoder's scope-2 QK pre-matmul task (`func_12`) has 64 structural
producers from scope-2's K/V/Q RoPE stage (`func_11`). Only 16 of the 64
appear in the swimlane JSON's `fanout` lists — the other 48 have
`"fanout": []` and `"fanout_count": 0`:

```
func_11 tasks (distinct) : 64
  ├─ 16 with non-empty fanout (list r2t3 = the func_12 consumer)
  └─ 48 with empty fanout (none of the 64 → func_12 edges captured here)
```

Consumers of the dropped producers see incorrect (under-reported) fanout in
the trace UI, and any downstream tooling that reasons about the graph
(critical path, edge counts, flow arrows) is wrong by construction.

## Root Cause

The scheduler's consumer-wiring path in
`src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/runtime/pto_scheduler.h:555-566`
only appends a consumer to the producer's `fanout_head` linked list when the
producer is **not yet** `>= PTO2_TASK_COMPLETED`. When the producer is
already completed, the wiring takes the `early_finished++` fast path and
**never** records the edge anywhere:

```cpp
pto2_for_each_fanin_slot_state(*wp, [&](PTO2TaskSlotState *producer) {
    pto2_fanout_lock(*producer);
    int32_t pstate = producer->task_state.load(std::memory_order_acquire);
    if (pstate >= PTO2_TASK_COMPLETED) {
        early_finished++;                              // ← edge not recorded
    } else {
        producer->fanout_head = rss.dep_pool.prepend(producer->fanout_head, ws);
    }
    pto2_fanout_unlock(*producer);
});
```

The AICPU profiler at
`src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp:539-545`
walks `slot_state.fanout_head` and emits its entries into both the `fanout`
array and its `fanout_count`:

```cpp
uint64_t fanout_arr[RUNTIME_MAX_FANOUT];
int32_t fanout_n = 0;
PTO2DepListEntry *cur = slot_state.fanout_head;        // ← subset only
while (cur != nullptr && fanout_n < RUNTIME_MAX_FANOUT) {
    fanout_arr[fanout_n++] = cur->slot_state->task->task_id.raw;
    cur = cur->next;
}
perf_aicpu_complete_record(..., fanout_arr, fanout_n);
```

Note that `slot_state.fanout_count` (the *true* consumer count maintained by
the orchestrator at
`src/.../runtime/pto_orchestrator.cpp:731-735`) is correct — but the profiler
does not use it, and the output JSON's `fanout_count` field is the walk
length, not that true count.

`aicpu_build_graph` has the same structure at
`src/a2a3/runtime/aicpu_build_graph/runtime/pto_orchestrator.cpp:497-499`.

## Steps to Reproduce

1. Check out current `main` (commit `1d4c218`).
2. Use the attached `repro_fanout_lost.py` (see Additional Context). It
   builds a small pypto program with 64 parallel producers (`func_id=0`)
   fanning into one consumer (`func_id=1`).
3. Build & run with profiling:
   ```bash
   export PYTHONPATH=$PWD/python:$PYTHONPATH
   python repro_fanout_lost.py --runtime-profiling -p a2a3
   ```
4. Inspect the latest `build_output/ReproFanoutLost_*/swimlane_data/perf_swimlane_*.json`:
   ```bash
   python repro_fanout_lost.py --analyze build_output/ReproFanoutLost_*/swimlane_data/perf_swimlane_*.json
   ```

Alternatively, the issue can be observed on the Qwen3 decode example in the
PyPTO repo (`qwen3_bak.py`) by running with `--runtime-profiling` and looking
at `func_11` producers whose `"fanout": []`.

## Expected Behavior

Each of the 64 `func_id=0` producers in the repro lists the single
`func_id=1` consumer task id in its `fanout` array, and `fanout_count == 1`.

Equivalently for Qwen3: all 64 `func_11` producers of `r2t3` list that task
in their fanout.

## Actual Behavior

Roughly half (timing-dependent) of the `func_id=0` producers in the repro —
and 48 of the 64 `func_11` producers in Qwen3 — have `"fanout": []` and
`"fanout_count": 0`, even though they are structural producers.

Excerpt from the analyzer on a real Qwen3 trace:

```
func_id=11: 64 tasks, 16 with non-empty fanout, 48 with empty fanout
```

## Suggested Fix

Record the fanout edge on the **consumer-wiring path**, not on the
producer-completion path. Two low-cost shapes:

1. In `pto_scheduler.h` (both runtimes), extend the `early_finished++`
   branch to also append the consumer to a parallel, profiling-only list on
   the producer — e.g. reuse a separate `fanout_profile_head` list that is
   unconditionally populated regardless of producer state, and walked by the
   profiler instead of `fanout_head`.

2. Alternatively, populate the fanout list eagerly in
   `pto_orchestrator.cpp` at the same site where `producer->fanout_count`
   is incremented (lines 731-735). This is the natural "fanout_count and
   fanout_ids stay in sync" invariant and removes the race entirely, at the
   cost of moving the `dep_pool` allocation from the scheduler's wiring
   queue back onto the orchestrator's hot path (mitigated by using a
   profiling-only pool).

Option (1) is preferable because it keeps the orchestrator hot path free of
lock acquisition and leaves the existing `fanout_head` readiness-notification
mechanism untouched. Whichever path is picked, the profiler should walk the
new list (not `fanout_head`) and report `slot_state.fanout_count` directly
for the `fanout_count` JSON field.

## Git Commit ID

1d4c218456451fa99de3ace9601b01fd210a31dd

## Host Platform

Linux (aarch64)

## Additional Context

Minimal reproducer script (save as `repro_fanout_lost.py` in a pypto
checkout and run as described above):

```python
"""Reproducer: runtime swimlane trace drops fanout edges when a producer
completes before its consumer is wired (the `early_finished` fast path in the
scheduler).
"""
import argparse
import json
import sys
from pathlib import Path

N_PRODUCERS = 64
ROW = 64


def build_program():
    import pypto.language as pl

    @pl.program
    class ReproFanoutLost:
        @pl.function(type=pl.FunctionType.Opaque)
        def repro(
            self,
            a: pl.Tensor[[N_PRODUCERS, ROW], pl.FP32],
            out: pl.Out[pl.Tensor[[1, ROW], pl.FP32]],
        ) -> pl.Tensor[[1, ROW], pl.FP32]:
            tmp = pl.create_tensor([N_PRODUCERS, ROW], dtype=pl.FP32)
            # Scope 1: N parallel fast producers (func id 0).
            for i in pl.parallel(N_PRODUCERS):
                with pl.at(level=pl.Level.CORE_GROUP):
                    row = pl.mul(pl.slice(a, [1, ROW], [i, 0]), 2.0)
                tmp = pl.assemble(tmp, row, [i, 0])

            # Scope 2: single consumer (func id 1) fans in from all N producers.
            with pl.at(level=pl.Level.CORE_GROUP):
                acc = pl.full([1, ROW], dtype=pl.FP32, value=0.0)
                for i in pl.range(N_PRODUCERS):
                    acc = pl.add(acc, pl.slice(tmp, [1, ROW], [i, 0]))
            out = pl.assemble(out, acc, [0, 0])
            return out

    return ReproFanoutLost


def run(platform, device, runtime_profiling):
    import torch
    from pypto import ir
    from pypto.backend import BackendType
    from pypto.runtime import RunConfig

    backend = BackendType.Ascend950 if platform.startswith("a5") else BackendType.Ascend910B
    compiled = ir.compile(build_program(), backend_type=backend, platform=platform)
    a = torch.randn(N_PRODUCERS, ROW, dtype=torch.float32)
    out = torch.zeros(1, ROW, dtype=torch.float32)
    compiled(a, out, config=RunConfig(platform=platform, device_id=device,
             backend_type=backend, runtime_profiling=runtime_profiling))


def analyze(json_path):
    data = json.load(open(json_path))
    tasks = data["tasks"]
    by_func = {}
    for t in tasks:
        by_func.setdefault(t["func_id"], []).append(t)
    for fid in sorted(by_func):
        g = by_func[fid]
        empty = sum(1 for t in g if not t.get("fanout"))
        print(f"func_id={fid}: {len(g)} tasks, {len(g) - empty} non-empty fanout, {empty} empty")
    producers, consumers = by_func.get(0, []), by_func.get(1, [])
    if len(consumers) == 1:
        cid = consumers[0]["task_id"]
        feeders = [p for p in producers if cid in (p.get("fanout") or [])]
        print(f"Producers listing consumer in fanout: {len(feeders)}/{len(producers)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--platform", default="a2a3")
    ap.add_argument("-d", "--device", type=int, default=0)
    ap.add_argument("--runtime-profiling", action="store_true")
    ap.add_argument("--analyze", type=Path)
    args = ap.parse_args()
    if args.analyze:
        analyze(args.analyze)
    else:
        run(args.platform, args.device, args.runtime_profiling)
```

### Empirical data points (Qwen3-32B decode, a2a3)

```
Distinct func_11 tasks : 64
  non-empty fanout     : 16  (tasks r3t866, r3t869, ... r3t911, stride 3)
  empty fanout (= [])  : 48  (tasks r3t722 ... r3t863)
```

All 64 are structural producers of `func_12_m(r2t3)` in the IR, but only
the 16 that were still running when `r2t3` was wired appear in its
inverse-fanout.

### Impact

The swimlane trace is the primary tool used when debugging compile / runtime
regressions involving parallelism and cross-scope dependencies. Silently
dropping edges causes misleading timelines (missing flow arrows), undercounts
in sched-overhead analysis, and wrong critical-path reasoning when dependency
structure is inferred from the trace.


---

## #604 [Code Health] Hardware pytest jobs can leak NPU device state when invoked without explicit --device, hanging subsequent CI jobs

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/604
- Created: 2026-04-20T09:14:12Z
- Updated: 2026-05-26T02:52:37Z
- Closed: 2026-05-26T02:44:04Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Tests

### Description

The self-hosted a2a3 runner runs `ut-a2a3` and `st-onboard-a2a3` sequentially on the same physical NPU machine. We observed (on PR #600) that when `ut-a2a3`'s pytest invocation was missing `--device ${DEVICE_RANGE}` — a latent CI YAML bug fixed in commit `20a077f` — the UT session left NPU device state (device locks, shm regions, and/or `aclrtStream` handles) unreleased on exit. The next job, `st-onboard-a2a3`, then hung in its L2 `tensormap_and_ringbuffer` phase: all 4 xdist workers went silent for ~8 minutes with no progress, hitting the 600 s `--pto-session-timeout`. Retry also timed out → job failed with `exit 124`.

**How we diagnosed it:**

- Before rebase (base `6c87797`, without the `--device` fix): `st-onboard-a2a3` hung at 93 % of L2 tensormap, 4-worker simultaneous silence, session timeout twice.
- After rebase (base `20a077f`, `--device ${DEVICE_RANGE}` restored on `ut-a2a3`): identical test suite, identical machine — L2 tensormap completed in **50.81 s**, job passed in 3m15s. Matches PR #597's baseline (49.89 s).

**Why this is a code-health concern (not just a CI config bug):**

The ci.yml-level bug has been fixed, but the underlying fragility remains:

1. A pytest scene-test session that exits without calling a device-teardown hook (test failure, `--device` typo, external kill signal, …) can silently poison the runner for every following job.
2. The failure mode — 4 xdist workers going silent in unison — is opaque. We only worked it out by diffing two otherwise-identical runs on the same machine. A future regression in the same area would be equally hard to diagnose.
3. Tests should clean up NPU resources on session teardown regardless of how pytest was invoked; we shouldn't rely on a `--device` CLI flag being spelled correctly by every caller.

### Location

- `conftest.py` (root, and `tests/ut/py/conftest.py`) — session-level teardown: no finalizer to force-release `aclrtStream`, device locks, or shm regions when a test exits without calling its own teardown path
- `src/common/worker/chip_worker.cpp` — `ChipWorker` C++ destructor path: worth auditing whether normal Python GC reliably triggers ACL resource release across parallel subprocesses
- `.github/workflows/ci.yml:294` — the fragile call site (now fixed with `--device ${DEVICE_RANGE}`, but represents a single point of failure)

### Proposed Fix

One or more of:

1. **Session-level forced cleanup**: add a pytest `session_finish` hook (in the root `conftest.py` or a dedicated `tests/conftest_hw.py`) that, on self-hosted runners, explicitly enumerates and releases any lingering NPU resources (stream destroy, `shm_unlink`, device reset) — regardless of test outcome.
2. **Per-test teardown audit**: verify every scene test / UT that uses `ChipWorker` releases its device on teardown even when the test body raises or hangs. Wrap `ChipWorker` lifecycle in a try/finally or a fixture with `yield`.
3. **CI-level runner reset**: add a post-job step on self-hosted runners that runs a small "NPU sanity + cleanup" script (e.g. verify no stray `aclrtStream`, unlink orphan `/dev/shm/*` entries belonging to the CI user) before handing the machine to the next job. Defensive belt-and-suspenders.
4. **Better symptom visibility**: when pytest session timeout fires, dump the current state of each xdist worker (stack trace, held device id) instead of just logging `TIMEOUT`. Future debugging would not need a log-diff against a known-good PR.

Priority order: 1 > 2 > 4 > 3. Option 1 is the minimal cut that closes the root cause; 2 is belt-and-suspenders per test; 3 would paper over future regressions of the same class; 4 speeds up diagnosis if a similar symptom reappears.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #612 [Bug] Crush in pypto-lib

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/612
- Created: 2026-04-21T02:34:43Z
- Updated: 2026-04-21T06:04:48Z
- Closed: 2026-04-21T06:04:48Z
- Labels: bug

### Body

### Platform

a2a3sim (Ascend 910B/C simulation)

### Runtime Variant

All / Unknown

### Description

Crash occurs when running the model with the "-p a2a3sim" parameter in pypto-lib.

### Steps to Reproduce

```markdown
Run:
python examples/beginner/matmul.py -p a2a3sim
in pypto-lib project.
```

### Expected Behavior

[RUN] compile ...
2026-04-21 10:28:09.178 W | /data/gufeng/project/pypto-lib/examples/beginner/matmul.py:53 — Nested chunked parallel loop found with intervening statements between it and its parent chunked parallel — the inner chunk will share the parent's InCore scope instead of getting its own. Consider removing the intervening statements or restructuring the loop nest so the chunked parallels are directly nested.
2026-04-21 10:28:09.258 W | No TileType variables found, skipping memory reuse
[RUN] compile done (0.44s)
[RUN] generate inputs ...
[RUN] generate inputs done (0.02s)
[RUN] runtime ...
[INFO] init_runtime_impl: [runtime_maker.cpp:119] Registering 1 kernel(s) in init_runtime_impl
[INFO] init_runtime_impl: [runtime_maker.cpp:152] RT2 init: 3 tensors + 0 scalars, device orchestration mode
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=0x59d5a010000 dev=0xaaaae1728630 size=262144
[INFO] init_runtime_impl: [runtime_maker.cpp:185]   Tensor 0: 262144 bytes at 0xaaaae1728630
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=0x59d5a060000 dev=0xaaaae1768640 size=262144
[INFO] init_runtime_impl: [runtime_maker.cpp:185]   Tensor 1: 262144 bytes at 0xaaaae1768640
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=0x59d5a0b0000 dev=0xaaaae17a8650 size=262144
[INFO] init_runtime_impl: [runtime_maker.cpp:185]   Tensor 2: 262144 bytes at 0xaaaae17a8650
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=(nil) dev=0xaaaae17e8660 size=550656
[INFO] init_runtime_impl: [runtime_maker.cpp:213] Orchestration SO: 550656 bytes copied to device
[INFO] init_runtime_impl: [runtime_maker.cpp:232] Ready queue shards: 3
[INFO] init_runtime_impl: [runtime_maker.cpp:241] Orchestrator-to-scheduler transition: disabled
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=(nil) dev=0xfffcebfff010 size=1073741824
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=(nil) dev=0xfffcdf17e010 size=216531264
[INFO] init_runtime_impl: [runtime_maker.cpp:292] Device orchestration ready: 3 tensors + 0 scalars
[INFO] init_runtime_impl: [runtime_maker.cpp:295] TIMING: args_malloc_copy = 1ms
[INFO] init_runtime_impl: [runtime_maker.cpp:296] TIMING: orch_so_copy = 0ms
[INFO] init_runtime_impl: [runtime_maker.cpp:297] TIMING: gm_heap_alloc(1GB) = 0ms
[INFO] init_runtime_impl: [runtime_maker.cpp:298] TIMING: shared_mem_alloc = 0ms
[INFO] init_runtime_impl: [runtime_maker.cpp:299] TIMING: total_init_runtime_impl = 1ms
[INFO] ensure_binaries_loaded: [device_runner.cpp:163] DeviceRunner(sim): Loaded aicpu_execute from /tmp/aicpu_sim_AHnDey
[INFO] ensure_binaries_loaded: [device_runner.cpp:188] DeviceRunner(sim): Loaded aicore_execute_wrapper from /tmp/aicore_sim_p7Sq7M
[INFO] run: [device_runner.cpp:383] Allocated simulated registers: 72 cores x 0x500 bytes
[INFO] run: [device_runner.cpp:398] Launching 6 AICPU threads (logical=3)
[INFO] aicpu_execute: aicpu_execute: Starting AICPU kernel execution
[INFO] init: AicpuExecutor: Initializing
[INFO] handshake_all_cores: Handshaking with 72 cores
[INFO] aicpu_execute: aicpu_execute: Starting AICPU kernel execution
[INFO] aicpu_execute: aicpu_execute: Starting AICPU kernel execution
[INFO] platform_aicpu_affinity_gate: [platform_aicpu_affinity.cpp:30] AICPU affinity gate (sim): thread idx=3 DROPPED (logical=3, launched=6)
[INFO] platform_aicpu_affinity_gate: [platform_aicpu_affinity.cpp:30] AICPU affinity gate (sim): thread idx=4 DROPPED (logical=3, launched=6)
[INFO] run: [device_runner.cpp:416] Launching 72 AICore thread(s)
[INFO] platform_aicpu_affinity_gate: [platform_aicpu_affinity.cpp:30] AICPU affinity gate (sim): thread idx=5 DROPPED (logical=3, launched=6)
[INFO] handshake_all_cores: Core 0: AIC, physical_id=0, reg_addr=0xaaaae190b1d0
[INFO] handshake_all_cores: Core 1: AIC, physical_id=1, reg_addr=0xaaaae190b6d0
[INFO] handshake_all_cores: Core 2: AIC, physical_id=2, reg_addr=0xaaaae190bbd0
[INFO] handshake_all_cores: Core 3: AIC, physical_id=3, reg_addr=0xaaaae190c0d0
[INFO] handshake_all_cores: Core 4: AIC, physical_id=4, reg_addr=0xaaaae190c5d0
[INFO] handshake_all_cores: Core 5: AIC, physical_id=5, reg_addr=0xaaaae190cad0
[INFO] handshake_all_cores: Core 6: AIC, physical_id=6, reg_addr=0xaaaae190cfd0
[INFO] handshake_all_cores: Core 7: AIC, physical_id=7, reg_addr=0xaaaae190d4d0
[INFO] handshake_all_cores: Core 8: AIC, physical_id=8, reg_addr=0xaaaae190d9d0
[INFO] handshake_all_cores: Core 9: AIC, physical_id=9, reg_addr=0xaaaae190ded0
[INFO] handshake_all_cores: Core 10: AIC, physical_id=10, reg_addr=0xaaaae190e3d0
[INFO] handshake_all_cores: Core 11: AIC, physical_id=11, reg_addr=0xaaaae190e8d0
[INFO] handshake_all_cores: Core 12: AIC, physical_id=12, reg_addr=0xaaaae190edd0
[INFO] handshake_all_cores: Core 13: AIC, physical_id=13, reg_addr=0xaaaae190f2d0
[INFO] handshake_all_cores: Core 14: AIC, physical_id=14, reg_addr=0xaaaae190f7d0
[INFO] handshake_all_cores: Core 15: AIC, physical_id=15, reg_addr=0xaaaae190fcd0
[INFO] handshake_all_cores: Core 16: AIC, physical_id=16, reg_addr=0xaaaae19101d0
[INFO] handshake_all_cores: Core 17: AIC, physical_id=17, reg_addr=0xaaaae19106d0
[INFO] handshake_all_cores: Core 18: AIC, physical_id=18, reg_addr=0xaaaae1910bd0
[INFO] handshake_all_cores: Core 19: AIC, physical_id=19, reg_addr=0xaaaae19110d0
[INFO] handshake_all_cores: Core 20: AIC, physical_id=20, reg_addr=0xaaaae19115d0
[INFO] handshake_all_cores: Core 21: AIC, physical_id=21, reg_addr=0xaaaae1911ad0
[INFO] handshake_all_cores: Core 22: AIC, physical_id=22, reg_addr=0xaaaae1911fd0
[INFO] handshake_all_cores: Core 23: AIC, physical_id=23, reg_addr=0xaaaae19124d0
[INFO] handshake_all_cores: Core 24: AIV, physical_id=24, reg_addr=0xaaaae19129d0
[INFO] handshake_all_cores: Core 25: AIV, physical_id=25, reg_addr=0xaaaae1912ed0
[INFO] handshake_all_cores: Core 26: AIV, physical_id=26, reg_addr=0xaaaae19133d0
[INFO] handshake_all_cores: Core 27: AIV, physical_id=27, reg_addr=0xaaaae19138d0
[INFO] handshake_all_cores: Core 28: AIV, physical_id=28, reg_addr=0xaaaae1913dd0
[INFO] handshake_all_cores: Core 29: AIV, physical_id=29, reg_addr=0xaaaae19142d0
[INFO] handshake_all_cores: Core 30: AIV, physical_id=30, reg_addr=0xaaaae19147d0
[INFO] handshake_all_cores: Core 31: AIV, physical_id=31, reg_addr=0xaaaae1914cd0
[INFO] handshake_all_cores: Core 32: AIV, physical_id=32, reg_addr=0xaaaae19151d0
[INFO] handshake_all_cores: Core 33: AIV, physical_id=33, reg_addr=0xaaaae19156d0
[INFO] handshake_all_cores: Core 34: AIV, physical_id=34, reg_addr=0xaaaae1915bd0
[INFO] handshake_all_cores: Core 35: AIV, physical_id=35, reg_addr=0xaaaae19160d0
[INFO] handshake_all_cores: Core 36: AIV, physical_id=36, reg_addr=0xaaaae19165d0
[INFO] handshake_all_cores: Core 37: AIV, physical_id=37, reg_addr=0xaaaae1916ad0
[INFO] handshake_all_cores: Core 38: AIV, physical_id=38, reg_addr=0xaaaae1916fd0
[INFO] handshake_all_cores: Core 39: AIV, physical_id=39, reg_addr=0xaaaae19174d0
[INFO] handshake_all_cores: Core 40: AIV, physical_id=40, reg_addr=0xaaaae19179d0
[INFO] handshake_all_cores: Core 41: AIV, physical_id=41, reg_addr=0xaaaae1917ed0
[INFO] handshake_all_cores: Core 42: AIV, physical_id=42, reg_addr=0xaaaae19183d0
[INFO] handshake_all_cores: Core 43: AIV, physical_id=43, reg_addr=0xaaaae19188d0
[INFO] handshake_all_cores: Core 44: AIV, physical_id=44, reg_addr=0xaaaae1918dd0
[INFO] handshake_all_cores: Core 45: AIV, physical_id=45, reg_addr=0xaaaae19192d0
[INFO] handshake_all_cores: Core 46: AIV, physical_id=46, reg_addr=0xaaaae19197d0
[INFO] handshake_all_cores: Core 47: AIV, physical_id=47, reg_addr=0xaaaae1919cd0
[INFO] handshake_all_cores: Core 48: AIV, physical_id=48, reg_addr=0xaaaae191a1d0
[INFO] handshake_all_cores: Core 49: AIV, physical_id=49, reg_addr=0xaaaae191a6d0
[INFO] handshake_all_cores: Core 50: AIV, physical_id=50, reg_addr=0xaaaae191abd0
[INFO] handshake_all_cores: Core 51: AIV, physical_id=51, reg_addr=0xaaaae191b0d0
[INFO] handshake_all_cores: Core 52: AIV, physical_id=52, reg_addr=0xaaaae191b5d0
[INFO] handshake_all_cores: Core 53: AIV, physical_id=53, reg_addr=0xaaaae191bad0
[INFO] handshake_all_cores: Core 54: AIV, physical_id=54, reg_addr=0xaaaae191bfd0
[INFO] handshake_all_cores: Core 55: AIV, physical_id=55, reg_addr=0xaaaae191c4d0
[INFO] handshake_all_cores: Core 56: AIV, physical_id=56, reg_addr=0xaaaae191c9d0
[INFO] handshake_all_cores: Core 57: AIV, physical_id=57, reg_addr=0xaaaae191ced0
[INFO] handshake_all_cores: Core 58: AIV, physical_id=58, reg_addr=0xaaaae191d3d0
[INFO] handshake_all_cores: Core 59: AIV, physical_id=59, reg_addr=0xaaaae191d8d0
[INFO] handshake_all_cores: Core 60: AIV, physical_id=60, reg_addr=0xaaaae191ddd0
[INFO] handshake_all_cores: Core 61: AIV, physical_id=61, reg_addr=0xaaaae191e2d0
[INFO] handshake_all_cores: Core 62: AIV, physical_id=62, reg_addr=0xaaaae191e7d0
[INFO] handshake_all_cores: Core 63: AIV, physical_id=63, reg_addr=0xaaaae191ecd0
[INFO] handshake_all_cores: Core 64: AIV, physical_id=64, reg_addr=0xaaaae191f1d0
[INFO] handshake_all_cores: Core 65: AIV, physical_id=65, reg_addr=0xaaaae191f6d0
[INFO] handshake_all_cores: Core 66: AIV, physical_id=66, reg_addr=0xaaaae191fbd0
[INFO] handshake_all_cores: Core 67: AIV, physical_id=67, reg_addr=0xaaaae19200d0
[INFO] handshake_all_cores: Core 68: AIV, physical_id=68, reg_addr=0xaaaae19205d0
[INFO] handshake_all_cores: Core 69: AIV, physical_id=69, reg_addr=0xaaaae1920ad0
[INFO] handshake_all_cores: Core 70: AIV, physical_id=70, reg_addr=0xaaaae1920fd0
[INFO] run: [device_runner.cpp:464] Waiting for threads to complete
[INFO] handshake_all_cores: Core 71: AIV, physical_id=71, reg_addr=0xaaaae19214d0
[INFO] handshake_all_cores: Core discovery complete: 24 AIC, 48 AIV
[INFO] assign_cores_to_threads: Assigning cores (round-robin): 24 clusters across 2 sched threads (24 AIC, 48 AIV)
[INFO] assign_cores_to_threads: Thread 0: cluster 0 (AIC=0, AIV0=24, AIV1=25)
[INFO] assign_cores_to_threads: Thread 1: cluster 1 (AIC=1, AIV0=26, AIV1=27)
[INFO] assign_cores_to_threads: Thread 0: cluster 2 (AIC=2, AIV0=28, AIV1=29)
[INFO] assign_cores_to_threads: Thread 1: cluster 3 (AIC=3, AIV0=30, AIV1=31)
[INFO] assign_cores_to_threads: Thread 0: cluster 4 (AIC=4, AIV0=32, AIV1=33)
[INFO] assign_cores_to_threads: Thread 1: cluster 5 (AIC=5, AIV0=34, AIV1=35)
[INFO] assign_cores_to_threads: Thread 0: cluster 6 (AIC=6, AIV0=36, AIV1=37)
[INFO] assign_cores_to_threads: Thread 1: cluster 7 (AIC=7, AIV0=38, AIV1=39)
[INFO] assign_cores_to_threads: Thread 0: cluster 8 (AIC=8, AIV0=40, AIV1=41)
[INFO] assign_cores_to_threads: Thread 1: cluster 9 (AIC=9, AIV0=42, AIV1=43)
[INFO] assign_cores_to_threads: Thread 0: cluster 10 (AIC=10, AIV0=44, AIV1=45)
[INFO] assign_cores_to_threads: Thread 1: cluster 11 (AIC=11, AIV0=46, AIV1=47)
[INFO] assign_cores_to_threads: Thread 0: cluster 12 (AIC=12, AIV0=48, AIV1=49)
[INFO] assign_cores_to_threads: Thread 1: cluster 13 (AIC=13, AIV0=50, AIV1=51)
[INFO] assign_cores_to_threads: Thread 0: cluster 14 (AIC=14, AIV0=52, AIV1=53)
[INFO] assign_cores_to_threads: Thread 1: cluster 15 (AIC=15, AIV0=54, AIV1=55)
[INFO] assign_cores_to_threads: Thread 0: cluster 16 (AIC=16, AIV0=56, AIV1=57)
[INFO] assign_cores_to_threads: Thread 1: cluster 17 (AIC=17, AIV0=58, AIV1=59)
[INFO] assign_cores_to_threads: Thread 0: cluster 18 (AIC=18, AIV0=60, AIV1=61)
[INFO] assign_cores_to_threads: Thread 1: cluster 19 (AIC=19, AIV0=62, AIV1=63)
[INFO] assign_cores_to_threads: Thread 0: cluster 20 (AIC=20, AIV0=64, AIV1=65)
[INFO] assign_cores_to_threads: Thread 1: cluster 21 (AIC=21, AIV0=66, AIV1=67)
[INFO] assign_cores_to_threads: Thread 0: cluster 22 (AIC=22, AIV0=68, AIV1=69)
[INFO] assign_cores_to_threads: Thread 1: cluster 23 (AIC=23, AIV0=70, AIV1=71)
[INFO] assign_cores_to_threads: Thread 0: total 36 cores (12 clusters)
[INFO] assign_cores_to_threads: Thread 1: total 36 cores (12 clusters)
[INFO] assign_cores_to_threads: Thread 2: total 0 cores (0 clusters)
[INFO] init: Config: threads=3, cores=72, cores_per_thread=36
[INFO] init: Init: orch_built_on_host=0
[INFO] init: Init: PTO2 mode, task count from shared memory
[INFO] init: AicpuExecutor: Init complete
[INFO] run: [INFO] run: [INFO] run: Thread 2: Start
[INFO] run: Thread 2: Orchestrator, loading SO via dlopen
Thread 1: Start
[INFO] run: Thread 2: Cannot create SO at /usr/lib64/aicpu_kernels/0/aicpu_kernels_device/libdevice_orch_olGNkf.so (errno=2), trying next path
Thread 0: Start
[INFO] run: Thread 2: Cannot create SO at /usr/lib64/libdevice_orch_A0OCo1.so (errno=13), trying next path
[INFO] run: Thread 2: Cannot create SO at /lib64/libdevice_orch_e1P9J7.so (errno=13), trying next path
[INFO] run: Thread 2: Created SO file at /var/tmp/libdevice_orch_evbKUB.so (550656 bytes)
[INFO] run: Thread 2: dlopen succeeded, handle=0xfffd2c004a10
[INFO] run: Thread 2: sm_ptr=0xfffcdf17e010, arg_count=3
[INFO] run: Thread 2: orch_args[0] = TENSOR(data=0xaaaae1728630, ndims=2, dtype=0)
[INFO] run: Thread 2: orch_args[1] = TENSOR(data=0xaaaae1768640, ndims=2, dtype=0)
[INFO] run: Thread 2: orch_args[2] = TENSOR(data=0xaaaae17a8650, ndims=2, dtype=0)
[INFO] run: Thread 2: Config: expected_args=3
[INFO] run: Thread 2: Ring sizes: task_window=16384, heap=268435456, dep_pool=16384
[INFO] resolve_and_dispatch_pto2: Thread 0: resolve_and_dispatch_pto2 entry
[INFO] resolve_and_dispatch_pto2: Thread 0: sm_base=0xfffcdf17e010
[INFO] resolve_and_dispatch_pto2: Thread 0: header=0xfffcdf17e010, task_desc_offset[0]=320, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 0: hank=0xfffd3c063010, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 0: doing one-time init
[INFO] resolve_and_dispatch_pto2: Thread 0: one-time init done
[INFO] resolve_and_dispatch_pto2: Thread 0: PTO2 dispatch starting with 36 cores
[INFO] resolve_and_dispatch_pto2: Thread 1: resolve_and_dispatch_pto2 entry
[INFO] resolve_and_dispatch_pto2: Thread 1: sm_base=0xfffcdf17e010
[INFO] resolve_and_dispatch_pto2: Thread 1: header=0xfffcdf17e010, task_desc_offset[0]=320, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 1: hank=0xfffd3c063010, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 1: PTO2 dispatch starting with 36 cores
[INFO] pto2_orchestrator_done: [pto_orchestrator.cpp:872] === [Orchestrator] ring 2: total_tasks=2 ===
[ALWAYS] run: Thread 2: orch_start=88836924594913792 orch_end=88836924594918848 orch_cost=101.120us
[ALWAYS] run: PTO2 total submitted tasks = 2, already executed 0 tasks
[INFO] run: Thread 2: Orchestrator completed
[INFO] run: Thread 2: Completed
[INFO] aicpu_execute: aicpu_execute: Kernel execution completed successfully
[INFO] handle_orchestrator_exit: Thread 0: PTO2 completed tasks 2/2
[ALWAYS] log_profiling_summary: Thread 0: sched_start=88836924594914053 sched_end=88836924595343448 sched_cost=8587.900us
[ALWAYS] log_profiling_summary: Thread 0: Scheduler summary: total_time=8216.680us, loops=12482, tasks_scheduled=1
[INFO] run: Thread 0: Executed 1 tasks from runtime
[INFO] shutdown_aicore: Thread 0: Shutting down 36 cores
[INFO] handle_orchestrator_exit: Thread 1: PTO2 completed tasks 2/2
[ALWAYS] log_profiling_summary: Thread 1: sched_start=88836924594916408 sched_end=88836924595345026 sched_cost=8572.360us
[ALWAYS] log_profiling_summary: Thread 1: Scheduler summary: total_time=8176.040us, loops=12291, tasks_scheduled=1
[INFO] run: Thread 1: Executed 1 tasks from runtime
[INFO] shutdown_aicore: Thread 1: Shutting down 36 cores[INFO] shutdown_aicore: Thread 0: Shutdown complete
[INFO] run: Thread 0: Completed
[INFO] aicpu_execute: aicpu_execute: Kernel execution completed successfully

[INFO] shutdown_aicore: Thread 1: Shutdown complete
[INFO] run: Thread 1: Completed
[INFO] aicpu_execute: aicpu_execute: Last thread finished, cleaning up
[INFO] deinit: DeInit: Runtime execution state reset
[INFO] deinit: DeInit: AicpuExecutor reset complete
[INFO] aicpu_execute: aicpu_execute: Kernel execution completed successfully
[INFO] run: [device_runner.cpp:483] All threads completed
[INFO] validate_runtime_impl: [runtime_maker.cpp:323] === Copying Results Back to Host ===
[INFO] validate_runtime_impl: [runtime_maker.cpp:329] Tensor pairs to process: 6
[INFO] validate_runtime_impl: [runtime_maker.cpp:391] Tensor 0: 262144 bytes copied to host
[INFO] validate_runtime_impl: [runtime_maker.cpp:391] Tensor 1: 262144 bytes copied to host
[INFO] validate_runtime_impl: [runtime_maker.cpp:391] Tensor 2: 262144 bytes copied to host
[INFO] validate_runtime_impl: [runtime_maker.cpp:371] Tensor 3: device-only allocation (no copy-back)
[INFO] validate_runtime_impl: [runtime_maker.cpp:371] Tensor 4: device-only allocation (no copy-back)
[INFO] validate_runtime_impl: [runtime_maker.cpp:371] Tensor 5: device-only allocation (no copy-back)
[INFO] validate_runtime_impl: [runtime_maker.cpp:397] === Cleaning Up ===
[INFO] validate_runtime_impl: [runtime_maker.cpp:403] Freed 6 device allocations
[INFO] validate_runtime_impl: [runtime_maker.cpp:413] Freed 1 kernel binaries
[INFO] validate_runtime_impl: [runtime_maker.cpp:420] === Finalize Complete ===
[INFO] finalize: [device_runner.cpp:610] DeviceRunner(sim) finalized
[RUN] runtime done (2.31s)
[RUN] compute golden ...
[RUN] compute golden done (0.01s)
[RUN] validate ...
  [c] PASS  shape=(256, 256) dtype=torch.float32
[RUN] validate done (0.03s)
[RUN] PASS (2.81s)

### Actual Behavior

[RUN] compile ...
2026-04-21 10:26:58.414 W | /data/gufeng/project/pypto-lib/examples/beginner/matmul.py:53 — Nested chunked parallel loop found with intervening statements between it and its parent chunked parallel — the inner chunk will share the parent's InCore scope instead of getting its own. Consider removing the intervening statements or restructuring the loop nest so the chunked parallels are directly nested.
2026-04-21 10:26:58.487 W | No TileType variables found, skipping memory reuse
[RUN] compile done (0.43s)
[RUN] generate inputs ...
[RUN] generate inputs done (0.02s)
[RUN] runtime ...
[INFO] init_runtime_impl: [runtime_maker.cpp:119] Registering 1 kernel(s) in init_runtime_impl
[INFO] init_runtime_impl: [runtime_maker.cpp:152] RT2 init: 3 tensors + 0 scalars, device orchestration mode
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=0x20318010000 dev=0xaaaaef89c450 size=262144
[INFO] init_runtime_impl: [runtime_maker.cpp:185]   Tensor 0: 262144 bytes at 0xaaaaef89c450
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=0x20318060000 dev=0xaaaaef8dc460 size=262144
[INFO] init_runtime_impl: [runtime_maker.cpp:185]   Tensor 1: 262144 bytes at 0xaaaaef8dc460
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=0x203180b0000 dev=0xaaaaef91c470 size=262144
[INFO] init_runtime_impl: [runtime_maker.cpp:185]   Tensor 2: 262144 bytes at 0xaaaaef91c470
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=(nil) dev=0xaaaaef95c480 size=550656
[INFO] init_runtime_impl: [runtime_maker.cpp:213] Orchestration SO: 550656 bytes copied to device
[INFO] init_runtime_impl: [runtime_maker.cpp:232] Ready queue shards: 3
[INFO] init_runtime_impl: [runtime_maker.cpp:241] Orchestrator-to-scheduler transition: disabled
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=(nil) dev=0xfffcd3fff010 size=1073741824
[INFO] record_tensor_pair: [runtime.cpp:79] Recorded tensor pair: host=(nil) dev=0xfffcca17e010 size=166199616
[INFO] init_runtime_impl: [runtime_maker.cpp:292] Device orchestration ready: 3 tensors + 0 scalars
[INFO] init_runtime_impl: [runtime_maker.cpp:295] TIMING: args_malloc_copy = 0ms
[INFO] init_runtime_impl: [runtime_maker.cpp:296] TIMING: orch_so_copy = 0ms
[INFO] init_runtime_impl: [runtime_maker.cpp:297] TIMING: gm_heap_alloc(1GB) = 0ms
[INFO] init_runtime_impl: [runtime_maker.cpp:298] TIMING: shared_mem_alloc = 0ms
[INFO] init_runtime_impl: [runtime_maker.cpp:299] TIMING: total_init_runtime_impl = 0ms
[INFO] ensure_binaries_loaded: [device_runner.cpp:163] DeviceRunner(sim): Loaded aicpu_execute from /tmp/aicpu_sim_RDYybj
[INFO] ensure_binaries_loaded: [device_runner.cpp:188] DeviceRunner(sim): Loaded aicore_execute_wrapper from /tmp/aicore_sim_cjWUh8
[INFO] run: [device_runner.cpp:383] Allocated simulated registers: 72 cores x 0x500 bytes
[INFO] run: [device_runner.cpp:398] Launching 6 AICPU threads (logical=3)
[INFO] aicpu_execute: aicpu_execute: Starting AICPU kernel execution
[INFO] init: AicpuExecutor: Initializing
[INFO] handshake_all_cores: Handshaking with 72 cores
[INFO] aicpu_execute: aicpu_execute: Starting AICPU kernel execution
[INFO] aicpu_execute: aicpu_execute: Starting AICPU kernel execution
[INFO] platform_aicpu_affinity_gate: [platform_aicpu_affinity.cpp:30] AICPU affinity gate (sim): thread idx=3 DROPPED (logical=3, launched=6)
[INFO] platform_aicpu_affinity_gate: [platform_aicpu_affinity.cpp:30] AICPU affinity gate (sim): thread idx=4 DROPPED (logical=3, launched=6)
[INFO] run: [device_runner.cpp:416] Launching 72 AICore thread(s)
[INFO] platform_aicpu_affinity_gate: [platform_aicpu_affinity.cpp:30] AICPU affinity gate (sim): thread idx=5 DROPPED (logical=3, launched=6)
[INFO] handshake_all_cores: Core 0: AIC, physical_id=0, reg_addr=0xaaaaefa7efe0
[INFO] handshake_all_cores: Core 1: AIC, physical_id=1, reg_addr=0xaaaaefa7f4e0
[INFO] handshake_all_cores: Core 2: AIC, physical_id=2, reg_addr=0xaaaaefa7f9e0
[INFO] handshake_all_cores: Core 3: AIC, physical_id=3, reg_addr=0xaaaaefa7fee0
[INFO] handshake_all_cores: Core 4: AIC, physical_id=4, reg_addr=0xaaaaefa803e0
[INFO] handshake_all_cores: Core 5: AIC, physical_id=5, reg_addr=0xaaaaefa808e0
[INFO] handshake_all_cores: Core 6: AIC, physical_id=6, reg_addr=0xaaaaefa80de0
[INFO] handshake_all_cores: Core 7: AIC, physical_id=7, reg_addr=0xaaaaefa812e0
[INFO] handshake_all_cores: Core 8: AIC, physical_id=8, reg_addr=0xaaaaefa817e0
[INFO] handshake_all_cores: Core 9: AIC, physical_id=9, reg_addr=0xaaaaefa81ce0
[INFO] handshake_all_cores: Core 10: AIC, physical_id=10, reg_addr=0xaaaaefa821e0
[INFO] handshake_all_cores: Core 11: AIC, physical_id=11, reg_addr=0xaaaaefa826e0
[INFO] handshake_all_cores: Core 12: AIC, physical_id=12, reg_addr=0xaaaaefa82be0
[INFO] handshake_all_cores: Core 13: AIC, physical_id=13, reg_addr=0xaaaaefa830e0
[INFO] handshake_all_cores: Core 14: AIC, physical_id=14, reg_addr=0xaaaaefa835e0
[INFO] handshake_all_cores: Core 15: AIC, physical_id=15, reg_addr=0xaaaaefa83ae0
[INFO] handshake_all_cores: Core 16: AIC, physical_id=16, reg_addr=0xaaaaefa83fe0
[INFO] handshake_all_cores: Core 17: AIC, physical_id=17, reg_addr=0xaaaaefa844e0
[INFO] handshake_all_cores: Core 18: AIC, physical_id=18, reg_addr=0xaaaaefa849e0
[INFO] handshake_all_cores: Core 19: AIC, physical_id=19, reg_addr=0xaaaaefa84ee0
[INFO] handshake_all_cores: Core 20: AIC, physical_id=20, reg_addr=0xaaaaefa853e0
[INFO] handshake_all_cores: Core 21: AIC, physical_id=21, reg_addr=0xaaaaefa858e0
[INFO] handshake_all_cores: Core 22: AIC, physical_id=22, reg_addr=0xaaaaefa85de0
[INFO] handshake_all_cores: Core 23: AIC, physical_id=23, reg_addr=0xaaaaefa862e0
[INFO] handshake_all_cores: Core 24: AIV, physical_id=24, reg_addr=0xaaaaefa867e0
[INFO] handshake_all_cores: Core 25: AIV, physical_id=25, reg_addr=0xaaaaefa86ce0
[INFO] handshake_all_cores: Core 26: AIV, physical_id=26, reg_addr=0xaaaaefa871e0
[INFO] handshake_all_cores: Core 27: AIV, physical_id=27, reg_addr=0xaaaaefa876e0
[INFO] handshake_all_cores: Core 28: AIV, physical_id=28, reg_addr=0xaaaaefa87be0
[INFO] handshake_all_cores: Core 29: AIV, physical_id=29, reg_addr=0xaaaaefa880e0
[INFO] handshake_all_cores: Core 30: AIV, physical_id=30, reg_addr=0xaaaaefa885e0
[INFO] handshake_all_cores: Core 31: AIV, physical_id=31, reg_addr=0xaaaaefa88ae0
[INFO] handshake_all_cores: Core 32: AIV, physical_id=32, reg_addr=0xaaaaefa88fe0
[INFO] handshake_all_cores: Core 33: AIV, physical_id=33, reg_addr=0xaaaaefa894e0
[INFO] handshake_all_cores: Core 34: AIV, physical_id=34, reg_addr=0xaaaaefa899e0
[INFO] handshake_all_cores: Core 35: AIV, physical_id=35, reg_addr=0xaaaaefa89ee0
[INFO] handshake_all_cores: Core 36: AIV, physical_id=36, reg_addr=0xaaaaefa8a3e0
[INFO] handshake_all_cores: Core 37: AIV, physical_id=37, reg_addr=0xaaaaefa8a8e0
[INFO] handshake_all_cores: Core 38: AIV, physical_id=38, reg_addr=0xaaaaefa8ade0
[INFO] handshake_all_cores: Core 39: AIV, physical_id=39, reg_addr=0xaaaaefa8b2e0
[INFO] handshake_all_cores: Core 40: AIV, physical_id=40, reg_addr=0xaaaaefa8b7e0
[INFO] handshake_all_cores: Core 41: AIV, physical_id=41, reg_addr=0xaaaaefa8bce0
[INFO] handshake_all_cores: Core 42: AIV, physical_id=42, reg_addr=0xaaaaefa8c1e0
[INFO] handshake_all_cores: Core 43: AIV, physical_id=43, reg_addr=0xaaaaefa8c6e0
[INFO] handshake_all_cores: Core 44: AIV, physical_id=44, reg_addr=0xaaaaefa8cbe0
[INFO] handshake_all_cores: Core 45: AIV, physical_id=45, reg_addr=0xaaaaefa8d0e0
[INFO] handshake_all_cores: Core 46: AIV, physical_id=46, reg_addr=0xaaaaefa8d5e0
[INFO] handshake_all_cores: Core 47: AIV, physical_id=47, reg_addr=0xaaaaefa8dae0
[INFO] handshake_all_cores: Core 48: AIV, physical_id=48, reg_addr=0xaaaaefa8dfe0
[INFO] handshake_all_cores: Core 49: AIV, physical_id=49, reg_addr=0xaaaaefa8e4e0
[INFO] handshake_all_cores: Core 50: AIV, physical_id=50, reg_addr=0xaaaaefa8e9e0
[INFO] handshake_all_cores: Core 51: AIV, physical_id=51, reg_addr=0xaaaaefa8eee0
[INFO] handshake_all_cores: Core 52: AIV, physical_id=52, reg_addr=0xaaaaefa8f3e0
[INFO] handshake_all_cores: Core 53: AIV, physical_id=53, reg_addr=0xaaaaefa8f8e0
[INFO] handshake_all_cores: Core 54: AIV, physical_id=54, reg_addr=0xaaaaefa8fde0
[INFO] handshake_all_cores: Core 55: AIV, physical_id=55, reg_addr=0xaaaaefa902e0
[INFO] handshake_all_cores: Core 56: AIV, physical_id=56, reg_addr=0xaaaaefa907e0
[INFO] handshake_all_cores: Core 57: AIV, physical_id=57, reg_addr=0xaaaaefa90ce0
[INFO] handshake_all_cores: Core 58: AIV, physical_id=58, reg_addr=0xaaaaefa911e0
[INFO] handshake_all_cores: Core 59: AIV, physical_id=59, reg_addr=0xaaaaefa916e0
[INFO] handshake_all_cores: Core 60: AIV, physical_id=60, reg_addr=0xaaaaefa91be0
[INFO] handshake_all_cores: Core 61: AIV, physical_id=61, reg_addr=0xaaaaefa920e0
[INFO] handshake_all_cores: Core 62: AIV, physical_id=62, reg_addr=0xaaaaefa925e0
[INFO] handshake_all_cores: Core 63: AIV, physical_id=63, reg_addr=0xaaaaefa92ae0
[INFO] handshake_all_cores: Core 64: AIV, physical_id=64, reg_addr=0xaaaaefa92fe0
[INFO] handshake_all_cores: Core 65: AIV, physical_id=65, reg_addr=0xaaaaefa934e0
[INFO] handshake_all_cores: Core 66: AIV, physical_id=66, reg_addr=0xaaaaefa939e0
[INFO] handshake_all_cores: Core 67: AIV, physical_id=67, reg_addr=0xaaaaefa93ee0
[INFO] handshake_all_cores: Core 68: AIV, physical_id=68, reg_addr=0xaaaaefa943e0
[INFO] handshake_all_cores: Core 69: AIV, physical_id=69, reg_addr=0xaaaaefa948e0
[INFO] handshake_all_cores: Core 70: AIV, physical_id=70, reg_addr=0xaaaaefa94de0
[INFO] run: [device_runner.cpp:464] Waiting for threads to complete
[INFO] handshake_all_cores: Core 71: AIV, physical_id=71, reg_addr=0xaaaaefa952e0
[INFO] handshake_all_cores: Core discovery complete: 24 AIC, 48 AIV
[INFO] assign_cores_to_threads: Assigning cores (round-robin): 24 clusters across 2 sched threads (24 AIC, 48 AIV)
[INFO] assign_cores_to_threads: Thread 0: cluster 0 (AIC=0, AIV0=24, AIV1=25)
[INFO] assign_cores_to_threads: Thread 1: cluster 1 (AIC=1, AIV0=26, AIV1=27)
[INFO] assign_cores_to_threads: Thread 0: cluster 2 (AIC=2, AIV0=28, AIV1=29)
[INFO] assign_cores_to_threads: Thread 1: cluster 3 (AIC=3, AIV0=30, AIV1=31)
[INFO] assign_cores_to_threads: Thread 0: cluster 4 (AIC=4, AIV0=32, AIV1=33)
[INFO] assign_cores_to_threads: Thread 1: cluster 5 (AIC=5, AIV0=34, AIV1=35)
[INFO] assign_cores_to_threads: Thread 0: cluster 6 (AIC=6, AIV0=36, AIV1=37)
[INFO] assign_cores_to_threads: Thread 1: cluster 7 (AIC=7, AIV0=38, AIV1=39)
[INFO] assign_cores_to_threads: Thread 0: cluster 8 (AIC=8, AIV0=40, AIV1=41)
[INFO] assign_cores_to_threads: Thread 1: cluster 9 (AIC=9, AIV0=42, AIV1=43)
[INFO] assign_cores_to_threads: Thread 0: cluster 10 (AIC=10, AIV0=44, AIV1=45)
[INFO] assign_cores_to_threads: Thread 1: cluster 11 (AIC=11, AIV0=46, AIV1=47)
[INFO] assign_cores_to_threads: Thread 0: cluster 12 (AIC=12, AIV0=48, AIV1=49)
[INFO] assign_cores_to_threads: Thread 1: cluster 13 (AIC=13, AIV0=50, AIV1=51)
[INFO] assign_cores_to_threads: Thread 0: cluster 14 (AIC=14, AIV0=52, AIV1=53)
[INFO] assign_cores_to_threads: Thread 1: cluster 15 (AIC=15, AIV0=54, AIV1=55)
[INFO] assign_cores_to_threads: Thread 0: cluster 16 (AIC=16, AIV0=56, AIV1=57)
[INFO] assign_cores_to_threads: Thread 1: cluster 17 (AIC=17, AIV0=58, AIV1=59)
[INFO] assign_cores_to_threads: Thread 0: cluster 18 (AIC=18, AIV0=60, AIV1=61)
[INFO] assign_cores_to_threads: Thread 1: cluster 19 (AIC=19, AIV0=62, AIV1=63)
[INFO] assign_cores_to_threads: Thread 0: cluster 20 (AIC=20, AIV0=64, AIV1=65)
[INFO] assign_cores_to_threads: Thread 1: cluster 21 (AIC=21, AIV0=66, AIV1=67)
[INFO] assign_cores_to_threads: Thread 0: cluster 22 (AIC=22, AIV0=68, AIV1=69)
[INFO] assign_cores_to_threads: Thread 1: cluster 23 (AIC=23, AIV0=70, AIV1=71)
[INFO] assign_cores_to_threads: Thread 0: total 36 cores (12 clusters)
[INFO] assign_cores_to_threads: Thread 1: total 36 cores (12 clusters)
[INFO] assign_cores_to_threads: Thread 2: total 0 cores (0 clusters)
[INFO] init: Config: threads=3, cores=72, cores_per_thread=36
[INFO] init: Init: orch_built_on_host=0
[INFO] init: Init: PTO2 mode, task count from shared memory
[INFO] init: AicpuExecutor: Init complete
[INFO] run: [INFO] run: Thread 2: Start
Thread 0: Start
[INFO] run: Thread 2: Orchestrator, loading SO via dlopen
[INFO] run: Thread 2: Cannot create SO at /usr/lib64/aicpu_kernels/0/aicpu_kernels_device/libdevice_orch_8ZJjWT.so (errno=2), trying next path
[INFO] run: Thread 1: Start
[INFO] run: Thread 2: Cannot create SO at /usr/lib64/libdevice_orch_wVtqA2.so (errno=13), trying next path
[INFO] run: Thread 2: Cannot create SO at /lib64/libdevice_orch_yjy25Q.so (errno=13), trying next path
[INFO] run: Thread 2: Created SO file at /var/tmp/libdevice_orch_YT6pML.so (550656 bytes)
[INFO] run: Thread 2: dlopen succeeded, handle=0xfffd14001a50
[INFO] run: Thread 2: sm_ptr=0xfffcca17e010, arg_count=3
[INFO] run: Thread 2: orch_args[0] = TENSOR(data=0xaaaaef89c450, ndims=2, dtype=0)
[INFO] run: Thread 2: orch_args[1] = TENSOR(data=0xaaaaef8dc460, ndims=2, dtype=0)
[INFO] run: Thread 2: orch_args[2] = TENSOR(data=0xaaaaef91c470, ndims=2, dtype=0)
[INFO] run: Thread 2: Config: expected_args=3
[INFO] run: Thread 2: Ring sizes: task_window=16384, heap=268435456, dep_pool=16384
[INFO] resolve_and_dispatch_pto2: Thread 1: resolve_and_dispatch_pto2 entry
[INFO] resolve_and_dispatch_pto2: Thread 1: sm_base=0xfffcca17e010
[INFO] resolve_and_dispatch_pto2: Thread 1: header=0xfffcca17e010, task_desc_offset[0]=320, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 1: hank=0xfffd21fa3010, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 1: doing one-time init
[INFO] resolve_and_dispatch_pto2: Thread 1: one-time init done
[INFO] resolve_and_dispatch_pto2: Thread 1: PTO2 dispatch starting with 36 cores
[ERROR] pto2_submit_mixed_task: [pto_orchestrator.cpp:536] ========================================
[ERROR] pto2_submit_mixed_task: [pto_orchestrator.cpp:537] FATAL: Invalid Arg Detected!
[ERROR] pto2_submit_mixed_task: [pto_orchestrator.cpp:538] ========================================
[ERROR] pto2_submit_mixed_task: [pto_orchestrator.cpp:539] Error: (unknown)
[ERROR] pto2_submit_mixed_task: [pto_orchestrator.cpp:540]   tensor_count: 2, scalar_count: -1
[ERROR] pto2_submit_mixed_task: [pto_orchestrator.cpp:541] This is a bug in the orchestration code.
[ERROR] pto2_submit_mixed_task: [pto_orchestrator.cpp:542] ========================================
[WARN] emergency_shutdown: [ERROR] handle_orchestrator_exit: Thread 1: Fatal error (code=5), sending EXIT_SIGNAL to all cores. completed_tasks=0, total_tasks=0Emergency shutdown: sending exit signal to all initialized cores
[WARN] emergency_shutdown: Emergency shutdown: sending exit signal to all initialized cores
[INFO] resolve_and_dispatch_pto2: Thread 0: resolve_and_dispatch_pto2 entry
[INFO] resolve_and_dispatch_pto2: Thread 0: sm_base=0xfffcca17e010
[INFO] resolve_and_dispatch_pto2: Thread 0: header=0xfffcca17e010, task_desc_offset[0]=320, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 0: hank=0xfffd21fa3010, window_size=16384
[INFO] resolve_and_dispatch_pto2: Thread 0: PTO2 dispatch starting with 36 cores
[ERROR] handle_orchestrator_exit: Thread 0: Fatal error (code=5), sending EXIT_SIGNAL to all cores. completed_tasks=0, total_tasks=0
[WARN] emergency_shutdown: Emergency shutdown: sending exit signal to all initialized cores
[WARN] emergency_shutdown: Emergency shutdown complete
[ALWAYS] log_profiling_summary: Thread 0: sched_start=88836921055318582 sched_end=88836921055320749 sched_cost=43.340us
[ALWAYS] log_profiling_summary: Thread 0: Scheduler summary: total_time=0.020us, loops=1, tasks_scheduled=0[WARN] emergency_shutdown: 
[INFO] run: Thread 0: Executed 0 tasks from runtime
[INFO] shutdown_aicore: Thread 0: Shutting down 36 cores
[INFO] shutdown_aicore: Thread 0: Shutdown complete
[INFO] run: Thread 0: Completed
[ERROR] aicpu_execute: aicpu_execute: PTO2 runtime failed with rc=-5
Emergency shutdown complete
[ALWAYS] log_profiling_summary: Thread 1: sched_start=88836921055314709 sched_end=88836921055322505 sched_cost=155.920us
[ALWAYS] log_profiling_summary: Thread 1: Scheduler summary: total_time=18.900us, loops=31, tasks_scheduled=0
[INFO] run: Thread 1: Executed 0 tasks from runtime
[INFO] shutdown_aicore: Thread 1: Shutting down 36 cores
[INFO] shutdown_aicore: Thread 1: Shutdown complete
[INFO] run: Thread 1: Completed
[ERROR] aicpu_execute: aicpu_execute: PTO2 runtime failed with rc=-5

[WARN] emergency_shutdown: Emergency shutdown complete
[ALWAYS] run: Thread 2: orch_start=88836921055314668 orch_end=88836921055331752 orch_cost=341.680us
[ALWAYS] run: PTO2 total submitted tasks = 0, already executed 0 tasks
[INFO] run: Thread 2: Orchestrator completed
[INFO] run: Thread 2: Completed
[INFO] aicpu_execute: aicpu_execute: Last thread finished, cleaning up
[INFO] deinit: DeInit: Runtime execution state reset
[INFO] deinit: DeInit: AicpuExecutor reset complete
[ERROR] aicpu_execute: aicpu_execute: PTO2 runtime failed with rc=-5
[INFO] run: [device_runner.cpp:483] All threads completed
[ERROR] run: [device_runner.cpp:487] AICPU execution failed with rc=-5
[INFO] validate_runtime_impl: [runtime_maker.cpp:323] === Copying Results Back to Host ===
[INFO] validate_runtime_impl: [runtime_maker.cpp:329] Tensor pairs to process: 6
[ERROR] validate_runtime_impl: [runtime_maker.cpp:343] PTO2 runtime failed: orch_error_code=5 sched_error_code=0 runtime_status=-5
[WARN] validate_runtime_impl: [runtime_maker.cpp:357] Skipping tensor copy-back because PTO2 runtime reported fatal status
[INFO] validate_runtime_impl: [runtime_maker.cpp:397] === Cleaning Up ===
[INFO] validate_runtime_impl: [runtime_maker.cpp:403] Freed 6 device allocations
[INFO] validate_runtime_impl: [runtime_maker.cpp:413] Freed 1 kernel binaries
[INFO] validate_runtime_impl: [runtime_maker.cpp:420] === Finalize Complete ===
[RUN] runtime done (2.28s)
Traceback (most recent call last):
  File "/data/gufeng/project/pypto-lib/examples/beginner/matmul.py", line 99, in <module>
    result = run(
  File "/data/gufeng/project/pypto-lib/golden/runner.py", line 225, in run
    execute_compiled(work_dir, ordered, **config.runtime)
  File "/data/gufeng/project/pypto/python/pypto/runtime/runner.py", line 653, in execute_compiled
    execute_on_device(
  File "/data/gufeng/project/pypto/python/pypto/runtime/device_runner.py", line 497, in execute_on_device
    worker.run(chip_callable, orch_args, cfg)
  File "/data/gufeng/project/simpler/python/simpler/worker.py", line 593, in run
    self._chip_worker.run(callable, args, cfg)
  File "/data/gufeng/project/simpler/python/simpler/task_interface.py", line 210, in run
    self._impl.run(callable, args, config)
RuntimeError: run_runtime failed with code -5
[INFO] finalize: [device_runner.cpp:610] DeviceRunner(sim) finalized

### Git Commit ID

20548f4327e814dfabb8665399e3ec34a235f7b6

### CANN Version

8.5.0.alpha001

### Driver Version

25.3.rc1

### Host Platform

Linux (aarch64)

### Additional Context

This bug was introduced by the commit:
Support: retune chip and core arg budgets (20548f4327e814dfabb8665399e3ec34a235f7b6)

---

## #617 [Code Health] Consolidate torch integration helpers into simpler_setup

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/617
- Created: 2026-04-21T03:32:32Z
- Updated: 2026-04-21T06:13:16Z
- Closed: 2026-04-21T06:13:16Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Other — Python package boundary between `simpler` (stable runtime API) and `simpler_setup` (test framework / build helpers).

### Description

The `simpler` package is defined in CLAUDE.md as the minimal stable runtime API (`task_interface`, `worker`, `env_manager`), while `simpler_setup` is the "test framework, compilers, path resolution" package. Today, the torch-aware helpers

- `_TORCH_DTYPE_MAP`
- `torch_dtype_to_datatype()`
- `make_tensor_arg()`

live in `python/simpler/task_interface.py`, even though **nothing inside `python/simpler/` actually uses them**:

| Caller | File |
| ------ | ---- |
| test framework | `simpler_setup/scene_test.py` (imports `make_tensor_arg`) |
| goldens | `simpler_setup/goldens/paged_attention.py` (top-level `import torch`) |
| end-user example | `examples/workers/l3/multi_chip_dispatch/main.py` |
| scene tests | `tests/st/a2a3/tensormap_and_ringbuffer/test_l3_*.py` |
| unit tests | `tests/ut/py/test_task_interface.py` |

Meanwhile `simpler_setup` already has multiple torch-using modules, so moving the helpers there would consolidate all torch integration in one place and let `simpler` stay truly torch-free (torch currently is only lazy-imported, which hides the dependency but doesn't remove it conceptually).

### Why it matters

- **Clearer package role.** Today a reader of `simpler.task_interface` sees torch code and has to guess whether torch is required (it isn't — it's lazy-imported). Moving torch out removes the surprise.
- **Architectural alignment.** `simpler_setup` is already "the place where torch lives" (scene_test, goldens). Splitting torch helpers across two packages creates arbitrary duplication.
- **Future-proofing.** PR #615 (adding UINT16/UINT32) had to add a `hasattr(torch, "uint16")` guard inside `simpler.task_interface` because we can't assume a torch version. Once the helper moves to `simpler_setup`, we can be less defensive — users who opt into the torch path already opted into torch.

No runtime behavior change, no functional regression, pure refactor.

### Location

- `python/simpler/task_interface.py:93-136` — definitions of `_TORCH_DTYPE_MAP`, `_ensure_torch_map`, `torch_dtype_to_datatype`, `make_tensor_arg`
- `python/simpler/task_interface.py:68-69` — `__all__` entries
- Call sites (will need import updates):
  - `simpler_setup/scene_test.py:215, 257`
  - `examples/workers/l3/multi_chip_dispatch/main.py:45`
  - `examples/workers/l3/multi_chip_dispatch/README.md` (docs)
  - `tests/st/a2a3/tensormap_and_ringbuffer/test_l3_child_memory.py:23`
  - `tests/st/a2a3/tensormap_and_ringbuffer/test_l3_dependency.py:19`
  - `tests/st/a2a3/tensormap_and_ringbuffer/test_l3_group.py:20`
  - `tests/ut/py/test_task_interface.py:114, 122, 129`

### Proposed Fix

Two-phase migration to avoid breaking downstream users of `from simpler.task_interface import make_tensor_arg`:

**Phase 1 — introduce the new home (non-breaking):**
1. Create `simpler_setup/torch_interop.py` containing the moved `_TORCH_DTYPE_MAP`, `torch_dtype_to_datatype`, `make_tensor_arg`.
2. In `simpler/task_interface.py`, replace the local definitions with re-exports from `simpler_setup.torch_interop` that emit `DeprecationWarning` on first use.
3. Update all in-repo call sites (`simpler_setup/scene_test.py`, `examples/`, `tests/`) to import from the new location.

**Phase 2 — remove the shim (breaking, one release later):**
4. Delete the deprecated re-exports from `simpler.task_interface`.
5. `simpler` now has zero torch references.

Related: #615 (adds UINT16/UINT32 — had to carry a `hasattr` guard inside `simpler.task_interface` that would be unnecessary after this refactor).

### Priority

Low (no impact today, good to fix eventually)

---

## #631 check_overlap reads beyond input.ndims when entry.ndims > input.ndims

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/631
- Created: 2026-04-22T02:15:56Z
- Updated: 2026-04-22T04:05:56Z
- Closed: 2026-04-22T04:05:56Z
- Labels: bug

### Body

## Parent Issue

Part of #488 (Unit test development tracking)

## Summary

`check_overlap()` in `pto_tensormap.h:128-159` iterates `for i < ndims` using `entry.ndims` as the loop bound, then reads `input.shapes[i]` and `input.offsets[i]`. When `input->ndims < entry->ndims`, the extra elements are **uninitialized memory**. The mirror case (`entry.ndims < input.ndims`) silently skips high-dimension overlap detection.

## Location

`src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_tensormap.h:128-159`

- Fast path (L137): loops with `entry.ndims`, reads `input.shapes[i]` out of bounds
- Slow path (L147): same issue with `input.offsets[i]`

## Severity

**HIGH** — reads uninitialized struct fields; could produce false positives/negatives in overlap detection.

## Reproducing Tests

- `test_tensormap_edge.OverlapDimensionMismatch`
- `test_tensormap_edge.OverlapDimensionMismatchReverse`
- `test_tensormap_edge.OverlapSlowPathOffsetDimensionMismatch`

## Suggested Fix

Iterate `min(entry.ndims, input.ndims)` and define semantics for the extra dimensions (e.g., treat as size 1, or treat dimension mismatch as non-overlapping).

---

## #632 cleanup_retired ABA when cleanup range exceeds task_window_size

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/632
- Created: 2026-04-22T02:15:58Z
- Updated: 2026-04-22T03:56:27Z
- Closed: 2026-04-22T03:56:27Z
- Labels: bug

### Body

## Parent Issue

Part of #488 (Unit test development tracking)

## Summary

In `cleanup_retired()`, when the cleanup range exceeds `task_window_size`, multiple tasks alias the same slot and share the entry chain. In debug builds, `debug_assert` fires. In release builds, entries still referenced by a newer live task are silently freed — a classic ABA problem.

## Location

`src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_tensormap.h` / `pto_tensormap.cpp::cleanup_retired`

## Severity

**HIGH** — silent use-after-free of tensor map entries in release builds.

## Reproducing Test

- `test_tensormap_edge.CleanupRetiredSlotCollision`

## Suggested Fix

Clamp the cleanup range to `task_window_size`, or filter entries by `producer_task_id` before freeing to avoid releasing entries belonging to a newer task occupying the aliased slot.

---

## #633 TensorMap lookup silently drops producers beyond PTO2_LOOKUP_MAX_RESULTS (16)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/633
- Created: 2026-04-22T02:16:02Z
- Updated: 2026-04-27T07:03:35Z
- Closed: 2026-04-27T07:03:35Z
- Labels: bug

### Body

## Parent Issue

Part of #488 (Unit test development tracking)

## Summary

`LookupResult::push()` is a no-op once `count == PTO2_LOOKUP_MAX_RESULTS` (16). In highly-connected dependency graphs, producers beyond the 16th are silently dropped, causing missed dependencies.

## Location

- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_tensormap.h:175` — `push()` definition
- `lookup()` at L307-354

## Severity

**MEDIUM** — correctness issue in graphs with high fan-in tensors; rare in practice but silent when it occurs.

## Reproducing Test

- `test_tensormap_edge.LookupSaturation16ProducersDropsOldest`

## Suggested Fix

Options:
1. Add a saturation flag to `LookupResult` and propagate as a conservative dependency (wait for all prior tasks)
2. Raise `PTO2_LOOKUP_MAX_RESULTS` and record high-water mark for monitoring
3. Return an error status when saturated

---

## #634 pto2_sm_create / validate() missing bounds checks for task_window_size and heap_top

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/634
- Created: 2026-04-22T02:16:06Z
- Updated: 2026-04-22T04:03:34Z
- Closed: 2026-04-22T04:03:34Z
- Labels: bug

### Body

## Parent Issue

Part of #488 (Unit test development tracking)

## Summary

`pto2_sm_create()` and `validate()` in shared memory initialization lack two boundary checks:

1. **`task_window_size == 0`** — causes all ring descriptor/payload pointers to alias the same address, leading to data corruption
2. **`heap_top > heap_size`** — not asserted in `validate()`, allowing an invalid memory layout to pass validation

## Location

`src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_shared_memory.cpp:30-73`

## Severity

**LOW** — validation gap; callers currently provide valid values, but missing guards make the API fragile to misuse.

## Reproducing Tests

- `test_shared_memory_edge.WindowSizeZero_AllRingsAlias`
- FlowCtl HeapTop validation tests

## Suggested Fix

- Require `task_window_size >= 1` at create time (return error or assert)
- Add `heap_top <= heap_size` assertion to `validate()`

---

## #641 [Code Health] Unify profiling abstractions across perf, dump tensor, and PMU

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/641
- Created: 2026-04-22T06:28:14Z
- Updated: 2026-04-30T06:09:31Z
- Closed: 2026-04-24T01:22:29Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Other (please specify in description)

### Description

This is a cross-cutting code health issue across SceneTest, common worker ABI, runtime structs, and platform diagnostics collectors.

Current user-facing profiling capability already includes three distinct features: perf swimlane export, tensor dump, and PMU. However, the front-end still uses `profiling` to mean perf only. `--enable-profiling` / `enable_profiling` drives perf snapshots, perf output directory handling, and swimlane conversion, while dump tensor and PMU are modeled as separate one-off flags. This makes the terminology inconsistent: profiling is the umbrella concept at the product level, but profiling in the current API/CLI effectively means perf.

Perf-specific plumbing also leaks into generic runtime layers. Generic worker/runtime ABI and runtime structs carry perf-named fields such as `enable_profiling`, `perf_data_base`, `perf_records_addr`, and `enable_profiling_flag`. By contrast, dump tensor and PMU are closer to platform-owned collectors. This makes the boundary between common runtime and platform diagnostics inconsistent, and perf ends up polluting runtime internals.

In addition, perf, dump tensor, and PMU duplicate a large amount of lifecycle logic: config propagation, feature-flag publication, per-core/per-thread buffer allocation, AICPU init, host-side collection/export, artifact naming, and cleanup. These paths should be normalized behind a shared diagnostics/profiling abstraction instead of evolving as three parallel implementations.

Observed at commit `89003b5fccf9160bb35c48779c8d20e938aa70dc`.

Related: #510

### Location

- `simpler_setup/scene_test.py:657-691`
- `simpler_setup/scene_test.py:859-867`
- `simpler_setup/scene_test.py:1156-1166`
- `simpler_setup/scene_test.py:1223-1225`
- `simpler_setup/scene_test.py:1288-1297`
- `simpler_setup/scene_test.py:1394-1397`
- `src/common/task_interface/chip_call_config.h:21-26`
- `src/common/worker/pto_runtime_c_api.h:75-98`
- `src/common/worker/chip_worker.cpp:245-248`
- `src/common/hierarchical/worker_manager.cpp:168-178`
- `src/a5/runtime/host_build_graph/runtime/runtime.h:104-118`
- `src/a5/runtime/host_build_graph/runtime/runtime.h:211-213`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/runtime.h:86-111`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/runtime.h:179-187`
- `src/a5/platform/src/host/performance_collector.cpp:57-157`
- `src/a5/platform/src/host/tensor_dump_collector.cpp:45-156`
- `src/a5/platform/src/aicpu/performance_collector_aicpu.cpp:40-118`
- `src/a5/platform/src/aicpu/performance_collector_aicpu.cpp:132-181`
- `src/a5/platform/src/aicpu/tensor_dump_aicpu.cpp:36-57`
- `src/a2a3/platform/sim/host/device_runner.cpp:312-376`
- `src/a2a3/platform/onboard/host/device_runner.cpp:522-603`
- `docs/testing.md:73-117`
- `docs/task-flow.md:30-32`
- `docs/task-flow.md:185-190`
- `docs/profiling-name-map.md:132-163`

### Proposed Fix

- Introduce a first-class umbrella config for diagnostics/profiling with explicit sub-features (`perf`, `dump_tensor`, `pmu`) instead of overloading `enable_profiling` to mean perf only.
- At the CLI/API layer, make perf explicit. If backward compatibility is required, keep `--enable-profiling` / `enable_profiling` only as a compatibility alias to the perf sub-feature and document the deprecation path.
- Move perf-specific state and memory layout ownership out of generic runtime naming. Generic runtime/common ABI should carry only feature-agnostic diagnostics hooks or flags; perf collector pointers and buffer layout should stay in platform diagnostics components, aligned with dump tensor and PMU.
- Extract shared lifecycle logic across perf, dump tensor, and PMU into reusable helpers or components: feature flag encoding/publication, collector init/finalize contract, host/device buffer allocation and copy-back pattern, artifact naming policy, and SceneTest post-processing/export hooks.
- Update docs so profiling is consistently the umbrella term and perf refers only to the swimlane/perf data path.

### Priority

Medium (minor risk, should fix in next few releases)


---

## #656 [Bug] The host_build_graph output swimlane graph is abnormal.

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/656
- Created: 2026-04-23T02:01:36Z
- Updated: 2026-04-24T03:16:59Z
- Closed: 2026-04-24T03:16:59Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

host_build_graph

### Description

After commit 0745dee1b731044f18cd343b4098b0416769a3fa, the test cases of host_build_graph would get stuck when generating the output swimlane diagram.

### Steps to Reproduce

```markdown
1. task-submit --device auto --run "python tests/st/a2a3/host_build_graph/paged_attention/test_paged_attention.py -p a2a3 --case small2 --enable-profiling --manual include"
```

### Expected Behavior

Properly output perf_swimlane_*.json

### Actual Behavior

```
=== rtStreamSynchronize stream_aicpu_===
[INFO] poll_and_collect: [performance_collector.cpp:729] Collecting performance data
[ERROR] poll_and_collect: [performance_collector.cpp:919] Performance data collection idle timeout after 30 seconds
[ERROR] poll_and_collect: [performance_collector.cpp:923] Collected 0 / 16 records before timeout
[INFO] poll_and_collect: [performance_collector.cpp:929] Total buffers processed: 0
[INFO] poll_and_collect: [performance_collector.cpp:930] Total records collected: 0
[WARN] poll_and_collect: [performance_collector.cpp:933] Incomplete collection (0 / 16 records)
[INFO] poll_and_collect: [performance_collector.cpp:936] Performance data collection complete
```

### Git Commit ID

0745dee1b731044f18cd343b4098b0416769a3fa

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (aarch64)

### Additional Context

_No response_

---

## #663 [Bug] Simulator produces incorrect results for parallel loop with assemble+slice on shared input tensor

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/663
- Created: 2026-04-23T10:10:23Z
- Updated: 2026-04-28T03:17:06Z
- Closed: 2026-04-28T03:17:06Z
- Labels: bug

### Body

### Diagnosis

**simpler** — The simulator (a2a3sim) does not correctly isolate tensor state across parallel loop iterations. When multiple iterations of `pl.parallel` each `assemble` into and then `slice` from the same input tensor (writing to non-overlapping regions), the simulator produces incorrect results. Real hardware passes with the same code.

### Description

In `qwen3_32b_prefill_scope2`, `k_cache` and `v_cache` are function input tensors that get updated via `pl.assemble` and later read via `pl.slice` inside a `pl.parallel(0, batch, 1)` loop. Each batch iteration writes to and reads from its own non-overlapping region of the cache tensors.

**Reproducer:**

```python
# In examples/models/qwen3/qwen3_32b_prefill_scope2.py, set:
BATCH = 2
MAX_SEQ = 64
NUM_HEADS = 8
NUM_KV_HEADS = 1
HEAD_DIM = 64
```

```bash
python examples/models/qwen3/qwen3_32b_prefill_scope2.py -p a2a3sim
```

**Results:**
- `BATCH=1` (single parallel iteration): PASS on both sim and hardware
- `BATCH=2` (two parallel iterations): FAIL on sim (~14% element mismatch), PASS on hardware

**Error output:**
```
'attn_out' FAIL  shape=(2, 64, 512) dtype=torch.bfloat16
  Mismatched elements: 9052/65536  rtol=0.002 atol=0.002
```

**Workaround:** Slice the shared input tensor into a per-batch local tensor before the parallel body, so each iteration operates on an independent tensor:

```python
for b in pl.parallel(0, batch, 1):
    cache_base = b * num_kv_heads * max_seq
    k_cache_b = pl.slice(k_cache, [num_kv_heads * max_seq, head_dim], [cache_base, 0])
    # use k_cache_b instead of k_cache for assemble/slice
```

### Environment

| Component | Version |
|---|---|
| pypto-lib | `b6c82cf` |
| pypto | `a0d21d1` (branch: `main`) |
| simpler | `bb7965f` |
| ptoas | `0.17` |
| CANN | `8.5.0.alpha001` |

### Host Platform

Linux (aarch64)

### Additional Context

The root cause appears to be that the simulator does not properly isolate the SSA tensor versions across parallel loop iterations. When iteration 0 does `k_cache = pl.assemble(k_cache, ...)`, the updated tensor version leaks into iteration 1's view (or vice versa), corrupting the subsequent `pl.slice` reads. On real hardware, each AI Core operates on physically separate memory, so no cross-iteration interference occurs.

---

## #666 [Feature] Dump runtime task dependency DAG with per-edge tensor (offset/shape) metadata

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/666
- Created: 2026-04-24T02:29:39Z
- Updated: 2026-05-13T08:36:55Z
- Closed: 2026-05-13T08:36:55Z
- Labels: enhancement

### Body

### Summary

Provide a first-class "dump runtime dependencies" facility that emits a
directed acyclic graph (DAG) of scheduled tasks, where each edge is annotated
with the concrete tensor that creates the producer/consumer dependency,
including its `offset` and `shape` (and ideally `dtype` / element stride) in
the underlying ring buffer or tensormap.

The output should be consumable both as a structured file (e.g., JSON) for
tooling and as a renderable graph (e.g., Mermaid / Graphviz / Perfetto edges)
for human inspection. It should be available regardless of whether profiling
is enabled, so it can be inspected on a single host run without hardware
profiling overhead.

### Motivation / Use Case

When debugging correctness or performance issues across runtime variants
(`tensormap_and_ringbuffer`, `host_build_graph`, `aicpu_build_graph`), we
frequently need to answer questions like:

- Which producer task wrote the slice that consumer task `T` is reading?
- At what `offset` (in bytes / elements) inside the tensor / ring buffer is
  that slice?
- What is the `shape` of the data the consumer actually consumes (vs. the
  full producer tensor)?
- Are two "parallel" tasks accidentally serialized through a shared
  sub-region of one tensor?

Today the only graph artifact close to this is `perf_swimlane_*.json`, which
the `tools/perf_to_mermaid.py` converter renders as a task-level dependency
flowchart. That representation:

1. Requires `--enable-profiling` and an actual hardware run, so it is
   unusable for static / single-host inspection of a generated `.pto`.
2. Carries only `task_id` -> `task_id` edges and a `fanout_count`; it does
   **not** record which tensor the edge represents, nor the offset/shape of
   the data exchanged.
3. Has known completeness problems for already-finished producers
   (see #599), which means it is not a reliable structural source either.

A dedicated "runtime dependency dump" would unblock:

- **Codegen / scheduler debugging** — verify that the orchestrator wired the
  expected producer per `(tensor, offset, shape)` consumer slice, especially
  for fan-in patterns like decoder QK pre-matmul over many K/V/Q RoPE
  producers.
- **Memory / aliasing analysis** — make it obvious when two unrelated tasks
  are sharing the same sub-region, or when ring-buffer reuse changes the
  effective producer.
- **Performance triage** — combined with profiling, tensor-annotated edges
  let users see *why* the critical path goes through a specific edge (e.g.,
  a wide slice from a slow producer), instead of just *that* it does.
- **Documentation / teaching** — produce reproducible per-test reference
  graphs for kernels and models in `examples/` without needing NPU access.

### Proposed API / Behavior

A new dump mode, gated by a runtime flag (e.g., environment variable
`PTO2_DUMP_DEP_GRAPH=<path>` or a CLI flag mirroring `--enable-profiling`),
that writes one file per program execution:

```
outputs/dep_graph_<timestamp>.json
```

Suggested schema (version-tagged so tools can evolve):

```json
{
  "version": 1,
  "runtime_variant": "tensormap_and_ringbuffer",
  "tasks": [
    {
      "task_id": "0xabc...",
      "func_id": 12,
      "func_name": "qk_prematmul",
      "scope": "scope_2"
    }
  ],
  "tensors": [
    {
      "tensor_id": 7,
      "name": "k_rope_out",
      "dtype": "float16",
      "shape": [64, 128, 256],
      "buffer": "ring_buffer_2"
    }
  ],
  "edges": [
    {
      "producer_task_id": "0x111...",
      "consumer_task_id": "0xabc...",
      "tensor_id": 7,
      "offset": [3, 0, 0],
      "offset_bytes": 196608,
      "shape": [1, 128, 256]
    }
  ]
}
```

Required behaviors:

- Edge enumeration must be **structurally complete** (i.e., it must include
  edges that the profiling fast-path currently drops; see #599). This is
  natural here because dumping happens at scheduling/wire-up time, not from
  AICPU-observed completion.
- Available without `--enable-profiling`, and ideally without requiring an
  actual NPU (e.g., works on host-only / simulator runs of the same `.pto`).
- A converter under `tools/` (companion to `perf_to_mermaid.py`) that
  renders the JSON to Mermaid / Graphviz with edge labels of the form
  `tensor=<name>[<offset>:+<shape>]` so the graph is immediately readable.
- Stable, documented schema so downstream tools (codegen, model authors,
  CI diff jobs) can depend on it.

### Alternatives Considered

- **Extending `perf_swimlane_*.json`**: would still require profiling and
  inherits the missing-edge issue from #599. The schema is also already
  optimized for timing, not for structural metadata.
- **Logging during scheduling**: can be done today via ad-hoc prints, but
  produces unstructured output that cannot be diffed across runs or fed to
  tooling.
- **Reading the generated `.pto` directly**: only exposes the static graph
  before runtime tensor placement; the actual `(offset, shape)` per edge is
  determined by the orchestrator at wire-up time and is what users need.

### Additional Context

- Existing tooling: `tools/perf_to_mermaid.py` converts
  `perf_swimlane_*.json` to a Mermaid flowchart of task dependencies — this
  feature is the structural / tensor-aware counterpart to that timing view.
- Related: #599 (swimlane profiling drops fanout edges for early-completed
  producers) — a structural dump as proposed here would not be subject to
  that race and could also serve as a ground-truth reference when validating
  the profiling-based graph.

### Git Commit ID

a9f3ea951bf9f39f9c960cf4af40db2e559fc90d


---

## #677 [Enhancement] PR#655 related: Case1-aligned spmd_paged_attention_highperf cases crash with aicore exception on a2a3

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/677
- Created: 2026-04-25T08:16:04Z
- Updated: 2026-04-27T08:18:38Z
- Closed: 2026-04-27T08:18:38Z
- Labels: enhancement

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

When aligning the standalone high-performance paged-attention test scripts with `Case1` from
`tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention/test_spmd_paged_attention.py`,
both of the newly added cases fail at runtime on hardware instead of completing successfully.

Affected files:
- `tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/kernels/test_pa_accuracy.py`
- `tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/kernels/bench_pa_performance.py`

Reference shape from `spmd_paged_attention` `Case1`:
- `batch=256`
- `num_heads=16`
- `kv_head_num=1`
- `head_dim=128`
- `block_size=128`
- `context_len=8192`
- `max_model_len=32768`
- `dtype=bfloat16`

The newly added highperf cases were intended to match that shape, but both crash:
- `bench_pa_performance.py`: `("Qwen3-8B  b256 h16/kv1 kv8192", 256, 16, 1, 128, 8192, 128)`
- `test_pa_accuracy.py`: `{"batch": 256, "num_heads": 16, "num_kv_heads": 1, "head_dim": 128, "kv_seq": 8192, "block_size": 128}`

### Steps to Reproduce

1. Use commit `57e7a6dd3ac15a28c08b878716a171e65420f26a`.
2. Modify the highperf scripts to add the Case1-aligned shape:
   - `tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/kernels/bench_pa_performance.py`
   - `tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/kernels/test_pa_accuracy.py`
3. Build the standalone kernel library if needed:
   ```bash
   cd tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/kernels
   bash ./compile.sh
   ```
4. Run the accuracy script:
   ```bash
   python ./test_pa_accuracy.py
   ```
5. Run the benchmark script:
   ```bash
   python ./bench_pa_performance.py --bf16
   ```

### Expected Behavior

The Case1-aligned shape should run successfully in both scripts, matching the behavior of
`tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention/test_spmd_paged_attention.py`
Case1, and should produce either correctness results (`test_pa_accuracy.py`) or benchmark
numbers (`bench_pa_performance.py`) without device/runtime exceptions.

### Actual Behavior

Both scripts fail on hardware.

Observed errors include:

```
EE9999[PID: 3700733] 2026-04-25-16:02:42.600.249 (EE9999):  rtDeviceSynchronizeWithTimeout execution failed,
reason=aicore exception[FUNC:FuncErrorReason][FILE:error_message_manage.cc][LINE:65]
TraceBack (most recent call last):
wait for compute device to finish failed, runtime result = 507015.[FUNC:ReportCallError][FILE:log_inner.cpp][LINE:148]
```

and

```
RuntimeError: npuSynchronizeDevice:build/CMakeFiles/torch_npu.dir/compiler_depend.ts:564 NPU function error:
SUSPECT REMOTE ERROR, error code is 507057
```

### Git Commit ID

57e7a6dd3ac15a28c08b878716a171e65420f26a

### CANN Version

8.5.0.alpha001

### Driver Version

Unknown

### Host Platform

Linux (aarch64)

### Additional Context

Relevant reference case:
- `tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention/test_spmd_paged_attention.py` Case1

Relevant modified files:
- `tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/kernels/test_pa_accuracy.py`
- `tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/kernels/bench_pa_performance.py`

This issue is related to the Case1-alignment work associated with PR #655.

---

## #678 Simpler MaxChildren failure for 2-layer Qwen3-14B decode callable

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/678
- Created: 2026-04-25T09:09:27Z
- Updated: 2026-04-27T06:12:04Z
- Closed: 2026-04-27T06:12:04Z

### Body

## Summary
A Qwen3-14B decode PyPTO program compiles successfully for a reduced 2-layer case, but Simpler fails while building the runtime callable with:

ValueError: make_callable: child_count exceeds MaxChildren

This blocks numerical validation against the PyTorch golden before device execution completes. The same harness passes for 1 layer, so the limit is reached between 1 and 2 unrolled Qwen3 decode layers.

## Source File
The reproducer/source file is:

- llm/model/qwen3_14b_decode.py

Local path used during validation:

- /data/liuxu/pypto-lib/llm/model/qwen3_14b_decode.py

## Reproduction
From /data/liuxu/pypto-lib/llm:

PTO_LOG_LEVEL=error python model/qwen3_14b_decode.py --num-layers 2 --max-seq 8 -b 16

In the task queue this was run as:

task-submit --device auto --run "PTO_LOG_LEVEL=error python model/qwen3_14b_decode.py --num-layers 2 --max-seq 8 -b 16"

Observed task id: task_20260425_170540_44481431105

## Observed Output
[RUN] compile done (2.17s)
[RUN] generate inputs done (4.66s)
[RUN] runtime ...
Traceback (most recent call last):
  File "/data/liuxu/pypto-lib/llm/model/qwen3_14b_decode.py", line 991, in <module>
    result = run(
  File "/data/liuxu/pypto-lib/golden/runner.py", line 225, in run
    execute_compiled(work_dir, ordered, **config.runtime)
  File "/data/liuxu/pypto/python/pypto/runtime/runner.py", line 630, in execute_compiled
    chip_callable, runtime_name = compile_and_assemble(work_dir, platform, pto_isa_commit)
  File "/data/liuxu/pypto/python/pypto/runtime/device_runner.py", line 447, in compile_and_assemble
    chip_callable = ChipCallable.build(
ValueError: make_callable: child_count exceeds MaxChildren

## Expected Behavior
Simpler should either support this callable size or report a structured diagnostic with the current child count and configured maximum. The 2-layer decode kernel should proceed to runtime execution and PyTorch-golden validation.

## Additional Notes
The 1-layer version of the same harness passes numerical validation:

PTO_LOG_LEVEL=error python model/qwen3_14b_decode.py --num-layers 1 --max-seq 8 -b 16

The full 40-layer case also reaches the same MaxChildren failure after successful PyPTO compilation and input generation.

---

## #680 [Code Health] Missing validation and logs when kernel func_id exceeds RUNTIME_MAX_FUNC_ID

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/680
- Created: 2026-04-27T02:23:32Z
- Updated: 2026-04-27T03:15:50Z
- Closed: 2026-04-27T03:15:50Z
- Labels: code health

### Body

### Category

Missing Validation

### Component

Host Runtime, AICPU Scheduler

### Description

When a kernel's `func_id` is outside the `[0, RUNTIME_MAX_FUNC_ID)` range, the C++ runtime silently drops the registration in `Runtime::set_function_bin_addr`. The host-side `init_runtime_impl` continues and returns success, so the caller believes all kernels are registered correctly.

Later, on the device side, `SchedulerContext::get_function_bin_addr` returns `0` for the out-of-range `func_id`. The AICore dispatcher dereferences this null pointer (`callable->resolved_addr()`), causing a hardware exception/crash. No log is emitted at any layer, making the root cause impossible to diagnose from host or device logs.

Related issue: #678 (request to raise the `MaxChildren` limit; this issue is about diagnostics and crash prevention within the current limit).

### Location

- `src/a5/runtime/host_build_graph/runtime/runtime.h` / `runtime.cpp`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/shared/runtime.cpp`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_context.h`
- `src/a2a3/runtime/host_build_graph/runtime/runtime.h` / `runtime.cpp`
- `src/a2a3/runtime/aicpu_build_graph/runtime/runtime.cpp`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/shared/runtime.cpp`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_context.h`
- All corresponding `host/runtime_maker.cpp` files

### Proposed Fix

Add three layers of defense:

1. **Host initialization** (`init_runtime_impl`): Validate each `func_id` before calling `upload_kernel_binary`. If out of range, `LOG_ERROR` and return `-1` so initialization fails early.
2. **Runtime API** (`Runtime::set_function_bin_addr`): Add `LOG_ERROR` when `func_id` is out of range and return early, so the API never silently drops a registration.
3. **AICPU scheduler** (`SchedulerContext::get_function_bin_addr`): Add `DEV_ERROR` when `func_id` is out of range, so device-side logs also capture the fault.

### Priority

High (significant risk, fix soon)

---

## #682 Clarify async wait-condition registration vs completion-event ingress

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/682
- Created: 2026-04-27T03:43:11Z
- Updated: 2026-04-27T03:56:50Z
- Closed: 2026-04-27T03:56:50Z

### Body

## Background

While reviewing PR #670's deferred completion implementation, we found two concepts that should be kept semantically distinct:

1. **Wait-condition registration**
   - A task declares what it must wait for before it can be considered complete.
   - Example: `event_counter_addr >= 1`.
   - Current PR #670 uses `deferred_ingress_per_core_[core][buf]` for this path through `pto2_defer_counter()`.

2. **Completion-event ingress**
   - A backend/runtime producer reports that an async operation has already completed.
   - This should be a "done event" queue, not a queue of counters that may still be `0` and need future polling.
   - Current PR #670 allocates and drains `rt->completion_ingress`, but no real producer path is wired.

For `TPUT_ASYNC`, the returned event is a GM counter that becomes `1` after completion. That means the natural representation in the current model is a wait condition:

```cpp
pto2_defer_counter(ctx, event_counter, 1, engine);
```

This should register `event_counter >= 1` as a condition to poll. It should not be confused with pushing an already-completed record into `rt->completion_ingress`.

## Important Semantic Distinction

`rt->completion_ingress` should contain completion signals that have already happened:

```text
task_token = X
completion = done
```

It should not contain a not-yet-complete counter flag:

```text
addr = event_counter
expected_value = 1
// scheduler still needs to wait for this later
```

Putting not-yet-complete counters into a "completion ingress" queue makes the queue semantics ambiguous:

- Is a queued record a completed event, or just a condition to wait on?
- Can `pending_completions` mean "completion already happened but wait entry does not exist yet", or "wait condition exists but is not complete yet"?
- What happens if the event counter is reused or reset after the record is drained?

The code should separate these two flows.

## Architecture Constraint

A5 can support atomic fetch-add from producers, so A5 can implement a true multi-producer runtime-level completion-event queue if backend producers need to report already-completed async operations.

A3 cannot rely on the same atomic fetch-add capability, so A3 should not have multiple AICore/backend producers concurrently writing the same global queue.

This does **not** require `pto2_defer_counter(event, 1)` to use a global MPSC queue. That API is wait-condition registration, and the current A3-friendly per-core/double-buffer model is appropriate for it.

## Proposed Direction

Keep two explicit abstractions:

### 1. Wait-condition registration path

Used by kernels that know the counter/event they launched and want the scheduler to poll it later.

```text
kernel
  -> pto2_defer_counter(ctx, event_counter, 1, engine)
  -> per-core deferred_ingress buffer
  -> scheduler harvests after kernel returns
  -> async wait list polls event_counter >= 1
```

This path should work on both A3 and A5. It does not require A3 AICore atomic fetch-add.

### 2. Completion-event ingress path

Used only by a backend/runtime producer that reports an async operation is already complete.

```text
backend/runtime producer
  -> enqueue done record into completion_ingress
  -> scheduler drains completion_ingress
  -> mark matching condition/task complete
```

On A5, this can be a true MPSC queue using atomic fetch-add. On A3, this should either be unsupported or implemented through an A3-safe producer-specific harvest path.

## Issues Found in Current PR #670

1. `rt->completion_ingress` appears partially wired.
   - It is allocated and drained, but no producer-side enqueue API was found.
   - Current examples only use wait-condition registration via per-core `deferred_ingress` and `pto2_defer_counter()`.
   - If the intended meaning is completion-event ingress, the structure should not be used for not-yet-complete counter polling records.

2. The naming in `PTO2CompletionIngressEntry` currently overlaps with wait-condition fields:

   ```cpp
   addr
   expected_value
   engine
   completion_type
   ```

   These fields look like a counter wait condition, not necessarily an already-completed event. The design should clarify whether this struct is for wait-condition registration or completed-event delivery. If both are needed, use separate names/types.

3. `absorb_pending_completions_locked()` can silently drop matching pending records when the target wait entry is already full. This can make a task wait on only a subset of required conditions and complete too early. It should return/report an error instead.

4. `pto2_defer_counter()` hardcodes:

   ```cpp
   slot->engine = PTO2_COMPLETION_ENGINE_SDMA;
   ```

   The current polling logic only checks `*counter >= expected`, so this is not immediately wrong for correctness. But it is misleading for `TPUT_ASYNC`/ROCE/URMA and will be problematic for diagnostics or future engine-specific behavior. The API should accept an optional `engine` argument with SDMA as the default.

5. There is no `TPUT_ASYNC` regression/example in PR #670.
   - Current examples cover notify-counter waits.
   - Since `TPUT_ASYNC` returns an event counter, a small example should verify that `pto2_defer_counter(event, 1, engine)` gates downstream dependencies correctly.

## Suggested Implementation Plan

1. Rename or split the current ingress structures so the code distinguishes:
   - wait-condition registration records
   - completed-event delivery records
2. Keep `pto2_defer_counter()` on the wait-condition path, backed by per-core `deferred_ingress` so it works on A3 and A5.
3. If `rt->completion_ingress` is retained, define it strictly as an already-completed event queue.
4. A5 can implement completion-event MPSC enqueue using atomic fetch-add.
5. A3 should not use a global MPSC completion-event queue unless there is an A3-safe producer path.
6. Make `pto2_defer_counter()` accept an optional `engine` parameter.
7. Add a `TPUT_ASYNC` event-counter example/test using the wait-condition path.


---

## #686 Infer deferred completion from kernel-registered wait conditions instead of submit-time flag

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/686
- Created: 2026-04-27T06:43:07Z
- Updated: 2026-04-29T02:36:48Z
- Closed: 2026-04-29T02:36:48Z
- Labels: code health

### Body

## Background

Current PR #670 requires orchestration to explicitly mark a task as deferred completion by calling a special submit API such as:

```cpp
pto2_rt_submit_aiv_task_deferred(...)
```

This sets `complete_in_future` in the task payload. The scheduler then prepares a deferred-completion context only for those tasks.

However, whether a task actually needs deferred completion is often only known inside the AICore task implementation: if the kernel calls an async operation and registers a completion counter, the task should complete in the future; otherwise it should complete normally.

This suggests that deferred completion could be triggered by the core task's actual use of async APIs, rather than by orchestration knowing this ahead of time.

## Current Behavior

Today the flow is roughly:

```text
orchestration
  -> submit task with complete_in_future = true
scheduler dispatch
  -> prepare task_token + deferred_ingress only for marked tasks
kernel
  -> calls pto2_defer_counter(...)
scheduler completion
  -> register deferred wait conditions
  -> wait for counters before final completion
```

This requires orchestration to know whether the kernel will use async completion.

## Proposed Direction

Make deferred completion auto-detected from the per-dispatch deferred ingress buffer.

Instead of only preparing deferred context for `complete_in_future` tasks, the scheduler can provide every dispatched task with:

```text
task_token
deferred_ingress
deferred_completion_capacity
```

Then the kernel decides whether the task is deferred:

```cpp
PTO2AsyncCtx ctx = pto2_async_ctx(args);

// Only async kernels call this.
pto2_defer_counter(ctx, event_counter, 1, engine);
pto2_defer_flush(ctx);
```

On completion, the scheduler checks the ingress buffer:

```text
if deferred_ingress.count > 0 or deferred_ingress.error_code != NONE:
    register wait conditions
    complete task only after normal_done && all counters ready
else:
    complete task normally
```

This removes the need for orchestration to predict whether the task uses async completion.

## Benefits

- Simpler orchestration API: normal submit and async submit can use the same entry point.
- Avoids mismatches where orchestration marks a task deferred but the kernel does not register any condition.
- Avoids the opposite mismatch where a kernel uses async completion but orchestration forgot to call the deferred submit API.
- More natural ownership: the kernel that launches the async operation also registers the wait condition.
- Works with counter-based async mechanisms such as `TPUT_ASYNC` event counters.

## Design Notes

1. Every dispatch may need to initialize and flush a deferred ingress header, even for normal tasks.
   - This adds a small fixed dispatch overhead.
   - The tradeoff may be acceptable, but should be measured.

2. The scheduler should treat the deferred ingress buffer as the source of truth:
   - `count == 0 && error_code == NONE`: no deferred completion.
   - `count > 0`: task registered async wait conditions.
   - `error_code != NONE`: report scheduler/runtime error.

3. Mixed tasks need care.
   - Multiple subtasks may register conditions from different cores.
   - The wait entry should accumulate all registered conditions.
   - The task should complete only when all normal subtasks are done and all async conditions are satisfied.

4. The API should define flush requirements clearly.
   - If kernels must call `pto2_defer_flush(ctx)`, tests should catch missing flushes.
   - Alternatively, `pto2_defer_counter()` could flush per entry, trading performance for safety.

5. `complete_in_future` can be kept temporarily for compatibility, but the long-term model could be:
   - deferred completion is inferred from actual registered wait conditions
   - `pto2_rt_submit_aiv_task_deferred(...)` becomes unnecessary or just a compatibility wrapper

## Suggested Implementation Plan

1. Always provide `task_token` and `deferred_ingress` in `LocalContext`.
2. Always initialize the per-dispatch deferred ingress buffer before dispatch.
3. Change scheduler completion path to inspect the ingress buffer for registered conditions.
4. Register async wait conditions only when the buffer contains entries or an error.
5. Remove or deprecate `complete_in_future` once auto-detection is proven.
6. Add tests for:
   - normal task that does not call async API
   - task that calls `pto2_defer_counter()`
   - task mistakenly using async API through normal submit
   - mixed task where only one subtask registers async completion
   - `TPUT_ASYNC` event-counter deferred completion


---

## #697 [Bug] The AICPU View of swimlane cannot be displayed normally

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/697
- Created: 2026-04-28T02:11:52Z
- Updated: 2026-04-29T06:58:29Z
- Closed: 2026-04-29T06:58:29Z
- Labels: bug

### Body

### Diagnosis

**simpler** - The AICPU View of generated swimlane is not displaying properly

### Description

Run "python examples/models/qwen3/32b/qwen3_32b_decode.py -p a2a3 --runtime-profiling"

<img width="1857" height="357" alt="Image" src="https://github.com/user-attachments/assets/51c21ea6-3592-4fc8-a4b2-2819e4205fe0" />
As you can see, out_proj_residual_aic and out_proj_residual_aiv are all displayed in the AIV_27 channel.

<img width="2387" height="1052" alt="Image" src="https://github.com/user-attachments/assets/7f1249c1-b29d-4e78-8eb7-d458b18fd1a3" />
And many aic kernels are displayed in AIV channels.

### Environment

|Component|Version|
|---|---|
|pypto-lib|ac2fb15c2e5bed0c66047d32eba8aaa6128725c1|
|pypto|5e9fe5cf0c497b523577e8d485feb23bbfb7534f|
|simpler|16311c4d8011f88032b8ec2391ec2d0051d977ee|

### Host Platform

Linux (aarch64)

### Additional Context

_No response_

---

## #729 PTO2 fanin spill pool deadlock on whole-tensor reads after disjoint view writes

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/729
- Created: 2026-05-10T02:36:38Z
- Updated: 2026-05-12T02:28:23Z
- Closed: 2026-05-12T02:28:23Z
- Labels: bug, code health

### Body

## Summary

This issue has two related layers:

1. **Fatal handling / exit path**: after PTO2 detects `FATAL: Fanin Spill Pool Deadlock Detected!`, the runtime should terminate cleanly and return an actionable error to the host. It should not hang in scheduler/AICore shutdown, and should not require repeated `Ctrl-C`.
2. **Root-cause prevention**: the runtime/codegen should avoid creating the abnormal high-fanin dependency pattern that fills the fanin spill pool in the first place.

The original reproduction was seen in DeepSeek-V4 SWA decode on `a2a3sim`:

```bash
cd /home/bot/code/PTO/pypto-lib && source .venv/bin/activate
PTOAS_ROOT=/home/bot/code/PTO/ptoas-bin PYTHONPATH=.:models/deepseek/v4 \
  python models/deepseek/v4/deepseek_v4_decode_swa.py -p a2a3sim
```

The same pattern is also reproducible from `deepseek_v4_decode_swa_moe.py -p a2a3sim`.

Typical fatal log from the full SWA graph:

```text
FATAL: Fanin Spill Pool Deadlock Detected!
Fanin spill pool cannot reclaim space after 100000 spins (no progress).
  - Pool used:     16384 / 16384 (100.0%)
  - Pool top:      16385 (linear)
  - Pool tail:     1 (linear)
  - Needed:        1 entries
  - last_task_alive: 165 (stuck here)
  - current_task:    1566
  - In-flight tasks: 1401
  - Runtime env:  PTO2_RING_DEP_POOL=32768
```

## Minimal reproducer

The following reduced PyPTO script reproduces the same fanin spill-pool failure without running the full DeepSeek graph. It intentionally lowers `PTO2_RING_DEP_POOL` to make the failure small and quick.

```python
import argparse
import os

import pypto.language as pl


NUM_WRITERS = 72
NUM_CONSUMERS = 10
WIDTH = 16
DEFAULT_DEP_POOL = 64


@pl.jit
def fanin_spill_repro(
    x: pl.Tensor[[1, WIDTH], pl.FP32],
    y: pl.Out[pl.Tensor[[NUM_CONSUMERS * NUM_WRITERS, WIDTH], pl.FP32]],
):
    shared = pl.create_tensor([NUM_WRITERS, WIDTH], dtype=pl.FP32)

    for writer in pl.parallel(0, NUM_WRITERS, 1):
        with pl.at(
            level=pl.Level.CORE_GROUP,
            name_hint="fanin_repro_writer",
            optimization=pl.chunked_loop_optimizer,
        ):
            row = pl.add(x, 1.0)
            shared = pl.assemble(shared, row, [writer, 0])

    for consumer in pl.parallel(0, NUM_CONSUMERS, 1):
        y_block = pl.slice(y, [NUM_WRITERS, WIDTH], [consumer * NUM_WRITERS, 0])
        with pl.incore(name_hint="fanin_repro_whole_tensor_reader"):
            shared_tile = pl.load(shared, [0, 0], [NUM_WRITERS, WIDTH])
            out_tile = pl.add(shared_tile, 1.0)
            pl.store(out_tile, [0, 0], y_block)

    return y


def build_tensor_specs():
    import torch

    from golden import TensorSpec

    return [
        TensorSpec("x", [1, WIDTH], torch.float32, init_value=1.0),
        TensorSpec("y", [NUM_CONSUMERS * NUM_WRITERS, WIDTH], torch.float32, is_output=True),
    ]


if __name__ == "__main__":
    from golden import RunConfig, run_jit

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-p",
        "--platform",
        type=str,
        default="a2a3sim",
        choices=["a2a3", "a2a3sim", "a5", "a5sim"],
    )
    parser.add_argument("-d", "--device", type=int, default=0)
    parser.add_argument("--dep-pool", type=int, default=DEFAULT_DEP_POOL)
    parser.add_argument("--runtime-profiling", action="store_true", default=False)
    args = parser.parse_args()

    os.environ["PTO2_RING_DEP_POOL"] = str(args.dep_pool)

    result = run_jit(
        fn=fanin_spill_repro,
        specs=build_tensor_specs(),
        golden_fn=None,
        config=RunConfig(
            compile=dict(dump_passes=True),
            runtime=dict(
                platform=args.platform,
                device_id=args.device,
                runtime_profiling=args.runtime_profiling,
            ),
        ),
    )
    if not result.passed:
        if result.error:
            print(result.error)
        raise SystemExit(1)
```

Run command:

```bash
cd /home/bot/code/PTO/pypto-lib && source .venv/bin/activate
PTOAS_ROOT=/home/bot/code/PTO/ptoas-bin PYTHONPATH=.:models/deepseek/v4 \
  python models/deepseek/v4/repro_fanin_spill_pool_deadlock.py -p a2a3sim
```

Observed reduced repro log:

```text
FATAL: Fanin Spill Pool Deadlock Detected!
Fanin spill pool cannot reclaim space after 100000 spins (no progress).
  - Pool used:     64 / 64 (100.0%)
  - Pool top:      65 (linear)
  - Pool tail:     1 (linear)
  - High water:    64
  - Needed:        1 entries
  - last_task_alive: 0 (stuck here)
  - current_task:    80
  - In-flight tasks: 80
  - Runtime env:  PTO2_RING_DEP_POOL=128
```

Generated orchestration has the dependency shape that matters:

```cpp
// 72 producers write disjoint views.
Tensor ret0__out = shared.view(... writer ...);
params_t0.add_input(ext_x);
params_t0.add_output(ret0__out);
rt_submit_aiv_task(0, params_t0);

// Each consumer reads the whole shared tensor as one input.
Tensor y_block = ext_y.view(... consumer ...);
params_t1.add_input(shared);
params_t1.add_inout(y_block);
rt_submit_aiv_task(1, params_t1);
```

## Root-cause analysis

The reduced graph mirrors the DeepSeek SWA failure pattern:

- Many producer tasks write disjoint regions/views of the same tensor.
- Later consumer tasks pass the whole tensor as one runtime input.
- Runtime TensorMap dependency lookup works on the Tensor/View memory region passed to the task. It does not know that the kernel may internally select only a small region using scalar offsets.
- Therefore, a whole-tensor input overlaps every previous disjoint view writer, so all those writers are added to the consumer fanin.
- `PTO2_FANIN_INLINE_CAP` is 64. Fanin beyond 64 goes to the fanin spill pool.
- In the full SWA graph, q-proj creates 256 disjoint writers for `q_proj_fp32`. The per-head q RMS/RoPE stage then passes the whole `q_proj_fp32` tensor and a scalar `h0`, so each head task can depend on all 256 q-proj writers.
- `PTO2FaninPool::reclaim()` reclaims spill entries only for tasks before `last_task_alive`.
- `last_task_alive` only advances through consecutive `CONSUMED` tasks. A completed old producer can still block the ring if its fanout refs have not all been released.

A temporary diagnostic run on the full SWA graph showed the stuck old producer was already completed, but not consumed:

```text
stuck task state: COMPLETED, fanin=5/5, fanout=59/85, subtasks=1/1
stuck task desc: kernels=[-1,22,-1]
```

So this is not a hardware kernel deadlock. It is a runtime resource/lifetime/backpressure failure: high-fanin task submission fills the fanin spill pool faster than the in-order `last_task_alive` based reclamation can free it.

## Layer 1: required fatal-handling fix

When either fanin or dependency pool detects a no-progress fatal condition, runtime should exit cleanly:

- `PTO2FaninPool::ensure_space()` and `PTO2DepListPool::ensure_space()` should not call `exit(1)` or spin forever.
- They should return a failure status and latch a shared fatal error, e.g. `PTO2_ERROR_DEP_POOL_OVERFLOW`.
- Orchestrator submit/allocation paths should stop submitting new work once the fatal is latched.
- Scheduler threads should observe the fatal state, broadcast exit/emergency shutdown, and write a scheduler/runtime status that host can report.
- AICore/AICPU deinit should use bounded waits for exit ACKs so shutdown cannot hang while handling the fatal path.
- Generated orchestration should not turn a failed `alloc_tensors()` / `submit_task()` into a secondary assertion such as `TaskOutputTensors::get_ref(index)`; the final host-side error should be the original runtime fatal.

Expected behavior for this layer: the program returns a deterministic runtime error promptly after the fatal log, without requiring `Ctrl-C` and without an abort caused by a secondary assertion.

## Layer 2: root-cause prevention / graph-level fix

Capacity increase is only a mitigation. The root issue is that runtime sees a whole-tensor dependency where the logical operation may read a narrow region.

Potential fixes:

1. **Prefer precise views in codegen**
   - If a generated kernel only needs a per-head or per-block region, pass that region as a Tensor view to runtime instead of passing the whole tensor plus scalar offsets.
   - For DeepSeek SWA, per-head q RMS/RoPE tasks should ideally input the relevant `q_proj_fp32` slice/view, not the full `q_proj_fp32` tensor.

2. **Add explicit region metadata when whole tensor + scalar offset is unavoidable**
   - If codegen must keep a whole tensor pointer for kernel reasons, allow the task argument to declare the actual read/write region used for dependency lookup.
   - TensorMap should then use this declared region, not the full storage span.

3. **Runtime backpressure/drain under spill-pool pressure**
   - Before declaring a fanin spill-pool deadlock, force scheduler drain/release paths and reclaim from the latest observed `last_task_alive`.
   - Add earlier pressure thresholds so orchestrator slows down high-fanin task submission before the pool is completely full.
   - This is not enough by itself for pathological graphs, but it should improve robustness.

4. **Better diagnostics and sizing hints**
   - Keep reporting pool usage, `last_task_alive`, `current_task`, and recommended `PTO2_RING_DEP_POOL`.
   - Consider logging the stuck task's state/fanout counters and the current task's fanin count when debug diagnostics are enabled.

## Acceptance criteria

- The minimal reproducer above exits cleanly with a meaningful runtime error when `PTO2_RING_DEP_POOL=64`.
- The fatal path does not hang and does not require `Ctrl-C`.
- The fatal path preserves the original error cause instead of reporting only a later assertion/abort.
- A codegen/runtime dependency-region fix prevents the DeepSeek SWA graph from filling the fanin spill pool at the current scale, or at least reduces the fanin count to the actual read region rather than all previous disjoint writers.


---

## #731 [Bug] Stall diagnostics print kernel_id=-1 for almost all stuck tasks

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/731
- Created: 2026-05-11T01:09:38Z
- Updated: 2026-05-13T01:20:11Z
- Closed: 2026-05-13T01:20:11Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware) — also affects a5 (same code path)

### Runtime Variant

tensormap_and_ringbuffer

### Description

`Scheduler::log_stall_diagnostics()` reads each stuck task's kernel id from `slot_state.task->kernel_id[0]` and emits one line per task. For tasks where slot 0 is an epoch / scope sync token (no real kernel attached), `kernel_id[0] == -1`. In a real stall dump, this means nearly every stuck entry shows `kernel_id=-1`, even though the underlying graph has 17 named kernels — only the one task whose slot 0 happens to be a real kernel ends up with a useful id.

Concretely, in the orchestration I was debugging (17 incore kernels, ~1099 submitted tasks, ~440 stuck after timeout), the diagnostic dump produced **one** entry with `kernel_id=14` (`sh_w2_matmul`, AIC) and **every other** STUCK-WAIT / STUCK-READY entry showed `kernel_id=-1`. With only `task_id` as a handle, the user has to manually walk the orchestration cpp's `rt_submit_aiv_task(N, ...)` / `rt_submit_aic_task(N, ...)` call sites and reconstruct the per-ring task numbering to find which kernel a stalled task corresponds to. That defeats the purpose of the diagnostic.

### Steps to Reproduce

1. Build any `tensormap_and_ringbuffer` orchestration that uses scope tokens / epochs (i.e. has tasks whose slot 0 is a sync token rather than a kernel). The deepseek-v4 moe_expert build_output (`pypto-lib/models/deepseek/v4/deepseek_v4_decode_moe_expert.py`) reproduces it with 17 incore kernels.
2. Force a stall (e.g. by mis-wiring a ringbuffer notify on the producer side so the consumer never gets fired).
3. Wait for `Thread N: PTO2 timeout after 800001 idle iterations`.
4. Inspect `build_output/simpler_log/debug/device-*/device-*.log` for the `log_stall_diagnostics` block (`scheduler_cold_path.cpp:119` STUCK-READY / `:127` STUCK-WAIT).

### Expected Behavior

Each STUCK-WAIT / STUCK-READY line names a real kernel for the task, or — when the slot really is an epoch token with no kernel — names the producing kernel for that token (or labels the entry as \`<epoch>\` / \`<scope-sync>\` rather than `kernel_id=-1`). Either way, the dump should let a user identify which kernel is blocked without cross-referencing the orchestration cpp by hand.

### Actual Behavior

In `device-1931057_20260509170924881.log` (under `build_output/simpler_log/debug/device-15/`), the stall dump per scheduler thread contained ~440 stuck task lines. Excerpted:

\`\`\`
log_stall_diagnostics [V9] \"[scheduler_cold_path.cpp:127]   STUCK-WAIT   ring=1 task_id=4294967298 kernel_id=-1 refcount=17 fanin=18 state=0\"
log_stall_diagnostics [V9] \"[scheduler_cold_path.cpp:119]   STUCK-READY  ring=2 task_id=8589934630 kernel_id=-1 refcount=5 fanin=5 state=0\"
log_stall_diagnostics [V9] \"[scheduler_cold_path.cpp:127]   STUCK-WAIT   ring=2 task_id=8589934631 kernel_id=-1 refcount=3 fanin=4 state=0\"
log_stall_diagnostics [V9] \"[scheduler_cold_path.cpp:127]   STUCK-WAIT   ring=2 task_id=8589934657 kernel_id=14 refcount=3 fanin=4 state=0\"
log_stall_diagnostics [V9] \"[scheduler_cold_path.cpp:127]   STUCK-WAIT   ring=2 task_id=8589934658 kernel_id=-1 refcount=3 fanin=5 state=0\"
log_stall_diagnostics [V9] \"[scheduler_cold_path.cpp:119]   STUCK-READY  ring=3 task_id=12884901889 kernel_id=-1 refcount=2 fanin=2 state=0\"
... (repeats with kernel_id=-1 for 100s of entries) ...
log_stall_diagnostics [V9] \"[scheduler_cold_path.cpp:132]   scan result: stuck_ready=11 stuck_waiting=436 in_flight=0\"
\`\`\`

Of those ~440 entries, exactly one (`task_id=8589934657`) carried a real kernel id (14). The other 439 are `-1`, even though every one of them was launched from a kernel via `rt_submit_aiv_task(...)` / `rt_submit_aic_task(...)`.

### Root Cause (source pointer)

`runtime/src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp` line 107 (and the identical line in the `a5` variant under the same path):

\`\`\`cpp
int32_t kid = slot_state.task->kernel_id[0];   // only slot 0
...
LOG_INFO_V9(
    \"  STUCK-WAIT   ring=%d task_id=%\" PRId64 \" kernel_id=%d ...\",
    ..., kid, ...
);
\`\`\`

Tasks whose slot 0 is a sync/epoch token always print `-1` here. The same file later reads `kernel_id[diag_slot]` for running cores (line 150) using `core_exec_states_[cid].running_subslot`, so the mechanism for picking the right slot already exists for the running-core dump — it just isn't applied to the slot-state dump.

### Proposed Fix Sketch

1. Iterate `kernel_id[0..PTO2_TASK_MAX_SUBSLOTS-1]` and print the first non-`-1` entry (or the whole array), rather than hardcoding `[0]`.
2. When the entire array is `-1`, label the slot as a sync/epoch token instead of printing `kernel_id=-1` — and, if cheaply available, name the upstream kernel that produced the token (the most useful thing for a user staring at a stall).

Either change is a localized edit to `scheduler_cold_path.cpp` (two log sites).

### Git Commit ID

`61cad74dcefd70deeff318e8b538c404dcc407c1` — verified the buggy line is still present on `origin/main` HEAD.

### Host Platform

Linux (aarch64)

### Additional Context

- Log evidence: `build_output/simpler_log/debug/device-15/device-1931057_20260509170924881.log` (lines 1055-1132, three full stall reports — one per scheduler thread, all show the same pattern).
- Stall context: AIVs busy, AICs all idle, `in_flight=0` — i.e. the diagnostic is exactly the tool a user would lean on, and it's currently uninformative.
- Reproducer build_output: `pypto-lib/build_output/_jit_moe_expert_test_20260509_164046/` from `models/deepseek/v4/deepseek_v4_decode_moe_expert.py`.

---

## #744 [Bug] L2 standalone runner: worker.register() fails because _create_worker() returns a raw ChipWorker (regression from #710)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/744
- Created: 2026-05-12T01:40:23Z
- Updated: 2026-05-12T06:37:32Z
- Closed: 2026-05-12T06:37:32Z
- Labels: bug

### Body

### Platform

All / Unknown

### Runtime Variant

All / Unknown

### Description

The standalone test runner path (`python <test>.py -p <platform>`) is broken for any L2 `SceneTestCase` after #710. The first per-class case fails with:

```
'ChipWorker' object has no attribute 'register'
```

`simpler_setup/scene_test.py:940` (introduced by #710, c3c1ce0f) calls `worker.register(callable_obj)` inside the L2 fallback registration block. Two entry points feed this code with different worker types:

| Entry point | Worker source | Type | Has `register`? |
| --- | --- | --- | --- |
| pytest + `st_worker` fixture (`conftest.py:899`) | `from simpler.worker import Worker` | `Worker` (high-level wrapper) | yes (`python/simpler/worker.py:668`) |
| Standalone runner — `_create_standalone_worker` L2 branch (`simpler_setup/scene_test.py:1591-1594`) → `first_cls._create_worker()` (`simpler_setup/scene_test.py:808-814`) | `from simpler.task_interface import ChipWorker` | `ChipWorker` (raw nanobind binding) | no — only `prepare_callable` (`python/simpler/task_interface.py:296`) |

CI runs only the pytest path, so the regression slipped through. The standalone runner is silently broken on `main`.

### Steps to Reproduce

```bash
source .venv/bin/activate
python examples/a5/tensormap_and_ringbuffer/paged_attention_unroll_manual_scope/test_paged_attention_unroll.py -p <platform>
```

Any L2 `SceneTestCase` reproduces it (runtime variant doesn't matter; the failing line is runtime-agnostic).

### Expected Behavior

Standalone runner registers the callable, executes the case, and prints `PASSED` (or a genuine numerical/runtime failure). It should behave equivalently to the pytest path for L2.

### Actual Behavior

```
=== Runtime: tensormap_and_ringbuffer  Level: 2 ===
  TestPagedAttentionUnroll::Case1 ... [...][INFO_V0] finalize: [device_runner.cpp:1256] DeviceRunner finalized
FAILED: 'ChipWorker' object has no attribute 'register'
```

The AttributeError comes from `simpler_setup/scene_test.py:940`:

```python
cid = getattr(type(self), "_st_l2_cid", None)
if cid is None:
    cid = worker.register(callable_obj)   # <-- ChipWorker has no .register
```

### Git Commit ID

0c3e3c96b2b073e5a591f775ceaae678985f9b86

### Host Platform

Linux (aarch64)

### Additional Context

**Suggested fixes (in order of cleanliness):**

1. **Add `ChipWorker.register(target) -> int`** that allocates a cid (process-local counter) and internally calls `prepare_callable(cid, target)`. This unifies the L2/L3 API per #710's stated intent ("Worker.register(target) -> cid is the single entry point for sub-fn / orch-fn / ChipCallable at every level"). Both `Worker` and the standalone path then go through the same method.
2. Make `_create_standalone_worker` return a `simpler.worker.Worker` for L2 instead of a bare `ChipWorker`, matching what `st_worker` does.
3. Quick fix: inline cid allocation + `prepare_callable` in `scene_test.py:940`.

**Also:** add a CI smoke that exercises the standalone runner on at least one L2 case, so future divergences between the two entry points are caught.

**Owners:** `simpler_setup/scene_test.py`, `python/simpler/worker.py`, `python/simpler/task_interface.py` (#710 author).

---

## #759 Multi-cid dispatch broken: two distinct ChipCallables on one chip child either fire wrong kernel or stream-timeout

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/759
- Created: 2026-05-12T10:36:44Z
- Updated: 2026-05-13T06:21:27Z
- Closed: 2026-05-13T06:21:27Z

### Body

## Summary

After #710 introduced the `register + run(cid)` ABI, dispatching **two
distinct ChipCallables (different orch SO binaries) to the same chip child
on L3** fails in two flavors:

- **Wrong-kernel-fired**: both cids end up running one of the two kernels.
- **Stream sync timeout**: AICPU stream hangs (`aclrtSynchronizeStreamWithTimeout`
  returns `ACL_ERROR_RT_STREAM_SYNC_TIMEOUT` after 2000ms).

Single-ChipCallable L3 runs work end-to-end. Two cids sharing **the same**
orch SO also work (already covered by
`tests/st/<plat>/<runtime>/prepared_callable/test_prepared_callable.py`).

The case that is **not** covered upstream — and that breaks — is two cids
backed by two **different** orch SO binaries on one chip child.

## Reproducer (in pypto)

Downstream surface lives in PyPTO PR
[hw-native-sys/pypto#1344](https://github.com/hw-native-sys/pypto/pull/1344)
(submodule bumped to `5a76f4f8`). Reproducing tests:

- `tests/st/distributed/test_l3_distributed.py::TestL3Dependency::test_execute_inline`
  — 2 devices, 2 inline `pl.at()` blocks generating 2 ChipCallables.
- `tests/st/distributed/test_l3_parallel_reduce.py::TestL3ParallelReduce::test_execute`
  — 1 device, 2 distinct ChipCallables (`chip_orch_add` + `chip_orch_sub`),
  1 SubWorker reducing both outputs.

Sibling case that **passes**:
`tests/st/distributed/test_l3_distributed.py::TestL3Dependency::test_execute`
— 1 device, single ChipCallable, 1 SubWorker.

## Observed behavior

### `test_l3_parallel_reduce::test_execute`

```text
expected f = (a+b) + (a-b) = 2a = 4.0
got      f = -2.0           = 2·(a-b)
```

Both `sum_ab` and `diff_ab` come back holding `a-b = -1`. The pattern is
consistent with **both submit_next_level dispatches running the second
callable's kernel** (or symmetrically the AICPU resolving both cids to
the same `orch_so_table_` slot).

### `test_l3_distributed::test_execute_inline`

```text
[ERROR] Stream sync timeout: stream=AICPU timeout_ms=2000 device_id=0 block_dim=3
        runtime/src/a2a3/platform/onboard/host/device_runner.cpp:737
[ERROR] PTO2 runtime failed: orch_error_code=0 sched_error_code=100 runtime_status=-100
RuntimeError: WorkerThread::dispatch_process: child failed (code=1):
              chip_process dev=0: RuntimeError: run_prepared failed with code 507046
```

## Expected behavior

Registering two ChipCallables with distinct orch SO binaries on one L3
Worker, then dispatching both to the same chip child via
`orch.submit_next_level(cid, args, cfg)`, should run **each callable's own
kernel** against its own args, with no cross-callable interference.

## Suspected area

PR #710 added `orch_so_table_[MAX_REGISTERED_CALLABLE_IDS]` on the AICPU
and `orch_so_dedup_` (keyed by ELF Build-ID) on the host DeviceRunner.
The upstream coverage in `test_prepared_callable.py` only exercises **same
orch SO under two cids**, so the multi-distinct-SO case has no test
locking the dispatch table down. Likely candidates:

- AICPU `orch_so_table_[callable_id]` indexing / dlopen routing when two
  cids resolve to distinct Build-IDs but share something in state.
- Host `orch_so_dedup_` Build-ID hashing / refcounting when both entries
  land under one chip child.
- `prepare_callable` interleaving in `_chip_process_loop` /
  `_chip_process_loop_with_bootstrap` when the parent prewarms two cids
  back-to-back via `_CTRL_PREPARE`.

## Test gap to add

A new prepared_callable scenario that:

1. Builds **two distinct** ChipCallables (e.g. `kernel_add` + `kernel_sub`).
2. Prepares both under different cids on one chip.
3. Runs `cid_A` then `cid_B` and verifies **each** writes the correct
   independent output (not the other's).

This case is the one the downstream pypto L3 distributed tests actually hit
in production usage; it should pin the contract.

## Context

- Submodule bump in pypto PR #1344 pins simpler to `5a76f4f8`.
- Failing run:
  https://github.com/hw-native-sys/pypto/actions/runs/25718625877/job/75514158855
- Same upstream HEAD as today (newer commits 67a405ea, 0ff1b24e, cf15368b,
  76543e11, d81866a9, 6f022e72 land mostly diagnostics / refactor; haven't
  been verified to address this particular case).


---

## #767 [Bug] split=UP_DOWN MixedKernel deadlock: cclaim residual blocks next task's wait when one AIV subblock outruns the other

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/767
- Created: 2026-05-13T07:21:35Z
- Updated: 2026-05-15T09:22:04Z
- Closed: 2026-05-15T09:22:03Z
- Labels: bug

### Body

### Platform

a2a3sim (Ascend 910B/C simulation)

### Runtime Variant

tensormap_and_ringbuffer

### Description

In Qwen3-32B scope3 (`models/qwen3/32b/qwen3_32b_decode_scope3.py`), the `down_proj_residual` MixedKernel phase deadlocks after `post_rmsnorm` (AIV-only) and `silu` (AIV-only) execute. Detailed instrumentation reveals the deadlock mechanism:

When one AIV subblock (e.g., aiv1) completes its TPOP/TFREE faster than the other (aiv0), aiv1 is dispatched to the next MixedKernel task. The faster aiv1's `wait()` for the new task blocks **forever** because the previous task's `consumers_claimed` bit is still set (the slow aiv0 hasn't called `free()` yet, so `remaining_consumers > 0` and the cclaim bitmask isn't cleared).

The deadlock is real and persists indefinitely even with `MAX_IDLE_ITERATIONS` raised 100×.

### Steps to Reproduce

```bash
python3 models/qwen3/32b/qwen3_32b_decode_scope3.py -p a2a3sim
```

### Expected Behavior

All 574 tasks complete; runtime returns results for golden validation.

### Actual Behavior

Consistently completes 128/130 tasks (or 534/574 for full scope3), then deadlocks. Scheduler stall diagnostic shows AIV cores blocked in `cond_reg_state=ack`:

```
CLUSTER cluster_id=1 aic=core1(idle) aiv0=core26(busy kernel=7 task=12884902459 cond_reg_state=ack) aiv1=core27(busy kernel=7 task=12884902459 cond_reg_state=ack)
[ERROR] handle_timeout_exit: TIMEOUT_EXIT after_idle_iterations=800000
[WARN] emergency_shutdown: Emergency shutdown
Segmentation fault (core dumped)
```

Verified the deadlock is genuine: increasing `MAX_IDLE_ITERATIONS` from 800K to 80M (100×) and running for 60 seconds still produces stalled `completed=128/130`. The blocked threads never make progress.

## Root Cause (verified by instrumentation)

### Instrumentation

Added `fprintf` tracing to `record()`, `wait()`, `free()`, and `popTileFromGMFiFo()` in `pto-isa/include/pto/cpu/TPush.hpp` and `TPop.hpp`. Each trace tagged with `subblockid` (sb) and SharedState pointer.

### Trace evidence

For the isolated reproducer (exp8: AIV-only rmsnorm → MixedKernel down_proj on same cluster), the imbalanced SharedState's full history:

```
1. WAIT_PRE lane=1, occ=0           → blocked  (Task A aiv1 enters wait)
2. WAIT_PRE lane=0, occ=0           → blocked  (Task A aiv0 enters wait)
3. REC slot=0, rem=2, occ=1                    (Task A aic TPUSH; notify wakes waiters)
4. WAIT_OK lane=1, cclaim=0x2                  (aiv1 unblocks, claims lane bit)
5. POP_GM_C_BEFORE_TLOAD sb=1                  (aiv1 enters TLOAD)
6. POP_GM_C_AFTER_TLOAD  sb=1                  (aiv1 exits TLOAD)
7. FREE sb=1, rem:2→1, cclaim[0]=0x2           (aiv1 frees; cclaim NOT cleared because rem>0)
8. WAIT_PRE lane=1, occ=1, cclaim[0]=0x2       ← Task B aiv1 enters wait → PERMANENTLY BLOCKED
9. WAIT_OK lane=0, cclaim=0x3                  (Task A aiv0 finally unblocks, very late)
10. POP_GM_C_BEFORE_TLOAD sb=0                 (Task A aiv0 enters TLOAD)
11. REC slot=1, occ=2                          (Task B aic TPUSH)
    ── stall detected, no further progress ──
```

At stall time:
- **Task A aiv0 (sb=0)** is inside `TLOAD_IMPL` — `BEFORE_TLOAD` printed, `AFTER_TLOAD` not yet
- **Task B aiv1 (sb=1)** is permanently blocked in `wait()` because `consumers_claimed[0] & 0x2 != 0`

### The wait() blocking condition

`pto-isa/include/pto/cpu/TPush.hpp:567-573`:
```cpp
shared_state.cv.wait(lock, [&]() {
    return shared_state.occupied > 0 &&
           shared_state.transfer_dirs[next_consumer_slot] == expectedDir &&
           (shared_state.consumers_claimed[next_consumer_slot] & laneMask) == 0;
});
```

Task B aiv1 sees:
- `occupied = 1` (Task A's slot still occupied with rem=1) → ✓
- `transfer_dirs[0] = C2V` (still set, Task A's claim) → ✓
- `consumers_claimed[0] & 0x2 = 0x2 ≠ 0` → ✗ **BLOCKED**

### Why cclaim isn't cleared

`pto-isa/include/pto/cpu/TPush.hpp:597-606` only clears `consumers_claimed[slot]` when `remaining_consumers` reaches 0:

```cpp
if (remaining > 1) {
    --remaining;                                    // first free: rem 2→1, cclaim untouched
} else {
    remaining = 0;
    shared_state.consumers_claimed[slotIndex] = 0;  // ONLY cleared on second free
    shared_state.transfer_dirs[slotIndex] = cpu_pipe::TransferDir::None;
    shared_state.next_consumer_slot = (tileIndex + 1) % RingFiFo::SLOT_NUM;
    --shared_state.occupied;
}
```

So if aiv1 frees first (rem 2→1) and is then dispatched to a new task before aiv0 frees, the cclaim bit for aiv1's lane stays set. When the new task's aiv1 calls `wait()` on the same `next_consumer_slot` (because Task A's slot hasn't been released), it hits the stale cclaim bit and blocks forever.

### Why AIV-only prefix triggers the bug

| Prefix kernel | Effect on aiv0/aiv1 timing | Result |
|---|---|---|
| None (exp4: MIX only) | Both AIV start simultaneously, finish close in time | PASS |
| AIC-only (exp6: gate_proj × 100 → MIX) | aiv0/aiv1 idle during AIC phase, then start MIX simultaneously | PASS |
| **AIV-only (exp8: rmsnorm → MIX)** | **aiv0/aiv1 run rmsnorm independently, finish at different times, skew propagates into MIX** | **DEADLOCK** |

The AIV-only prefix introduces a timing skew that persists into the MIX phase. The faster AIV completes its first MIX task and is reassigned to the next task before the slower AIV catches up — exposing the cclaim-residual race.

The slow AIV (aiv0) does eventually progress through TLOAD/TADD/TFREE in real time, but by then the faster AIV has already entered the new task's wait() and blocked. Even after the slow AIV's eventual free clears cclaim, the blocked wait() needs to re-evaluate (via cv.notify_all). The scheduler stall detection fires before that recovery can complete in some runs.

But the deeper question remains: **even after waiting 60+ seconds (well beyond any reasonable scheduling delay), the slow aiv0 still doesn't reach TFREE**. So either the slow AIV is itself blocked on something we haven't yet traced, or there's a missed wakeup in the cv mechanism after aiv1 promotes to the next task.

## Suspected Fix Direction

The `consumers_claimed` bitmask is keyed by slot index, but its semantics conflate "this slot is currently being consumed by lane X" with "lane X has claimed slot N for round R". When the slot is reused across rounds (because rem doesn't drain), the stale bit from round R-1 contaminates round R.

Possible fixes:

1. **Clear the lane's own cclaim bit on `free()`** (rather than only when rem=0): aiv1's free clears bit 0x2 from cclaim[slot], so a later aiv1 wait for the same slot won't see it.

2. **Make wait() target the next *task's* slot rather than the cluster-wide `next_consumer_slot`**: track per-task slot indices instead of sharing a cluster-wide pointer.

3. **Block aiv1's reassignment to the next MIX task until both lanes of the current task have freed**: synchronize at the scheduler level so that aiv0 and aiv1 of a `split=UP_DOWN` task complete together.

### Git Commit ID

bb4942ff1729e1258cbb00cc7cdcd5142991f28d

### CANN Version

8.5.0.alpha001

### Driver Version

N/A

### Host Platform

Linux (aarch64)

---

## #785 [Feature] Tensor::view overload that reduces rank by squeezing dropped axes

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/785
- Created: 2026-05-15T06:28:45Z
- Updated: 2026-06-18T02:19:10Z
- Closed: 2026-06-18T02:19:10Z
- Labels: enhancement

### Body

## Summary

Add a `Tensor::view` overload that produces a lower-rank view by squeezing
out size-1 axes (the result of a rank-reducing slice). The current
`view(shapes[], offsets[])` inherits `ndims` from the parent, so it cannot
express \"slice + drop axis\" in a single step, and `view(...).reshape(...)`
does not compose for sliced views.

## Motivation / Use Case

PyPTO RFC #1338 / PR #1343 added a `drop_dims` operand to `tensor.slice` so
that numpy-style indexing (`C[i]`, `C[i, j]`, `C[i, j, :, :]`, ...) can
produce a lower-rank `Tensor`. The orchestration codegen
(`src/codegen/tensor_op_codegen.cpp`, `REGISTER_ORCHESTRATION_OP(tensor_slice)`)
needs to emit a runtime `Tensor` at the reduced rank so that downstream
kernel-call bindings see the correct ndims. Without this, a kernel that
takes a sub-tensor via numpy-style indexing generates wrong-rank code. See
PyPTO follow-up issue: https://github.com/hw-native-sys/pypto/issues/1349.

The composition `view(...).reshape(...)` does not work because:

1. `view(view_shapes[], view_offsets[])` (`tensor.h:331`) inherits
   `ndims = other.ndims` (`init_with_view` at `tensor.h:233`). The view
   stays at the parent's rank with size-1 entries in dropped positions.
2. `reshape(new_shapes[], new_ndims)` (`tensor.h:358`) hard-asserts
   `is_contiguous()` (`tensor.h:360`). A rank-reducing slice produces
   `shapes[i]=1, raw_shapes[i]=B` for any non-leading dropped axis, which
   fails `is_contiguous()` (`tensor.h:341` only allows divergence in dim 0
   via `is_raw_eq_shapes`).
3. Even when the contiguity check passes, `reshape` clobbers the per-dim
   offsets that `view` just installed: `result.is_all_offset_zero = true;
   result.is_raw_eq_shapes = true;` (`tensor.h:364-365`). The data offset
   from the slice is lost.

## Proposed API / Behavior

Add an overload (under `runtime/src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/runtime/tensor.h`):

\`\`\`cpp
// Slice-and-squeeze: produce a view at a lower rank by collapsing size-1
// axes listed in `drop_dims`. `view_shapes` / `view_offsets` are at the
// parent's rank; `view_shapes[d]` for d in drop_dims must equal 1.
Tensor view(
    const uint32_t view_shapes[],
    const uint32_t view_offsets[],
    const uint32_t drop_dims[],
    uint32_t num_drop_dims,
    bool manual_dep = false) const;
\`\`\`

Semantics:

- The result's `ndims` is `parent.ndims - num_drop_dims`.
- The result's `shapes[]` and `raw_shapes[]` are the parent's
  `view_shapes[]` and `parent_raw[]` with the entries at indices in
  `drop_dims` removed.
- The element offset contributed by the dropped axes
  (`sum(view_offsets[d] * stride(d))` for `d in drop_dims`) is folded into
  `start_offset` (or equivalently into `offsets[]` of the surviving
  leading axis), so element addressing in the lower-rank view points at
  the same memory as the parent slice.
- Surviving axes keep their `view_offsets[]` as-is.

Constraint: every `d` in `drop_dims` must have `view_shapes[d] == 1`.
This matches what a rank-reducing slice produces and lets us collapse the
dimension without needing a real reshape (no contiguity requirement).

## Alternatives Considered

- **`view().reshape()` composition** — Rejected, see Motivation #2/#3
  above. Breaks for any non-leading drop and loses per-dim offsets.
- **Standalone `squeeze(keep_mask[])` operation** — Composable but
  requires two C++ calls per slice in generated code and a separate
  intermediate `Tensor`. The overload above is one call and one result.
- **Keep full-rank in runtime; only drop dims in IR / kernel-call binding
  metadata** — Rejected, this diverges runtime tensor rank from IR rank
  and breaks the orchestration → kernel-call ABI inference path.

## Additional Context

- Same change is needed in both `src/a2a3/.../tensor.h` and
  `src/a5/.../tensor.h` so the orchestration codegen path is uniform
  across architectures.
- PyPTO codegen call site that will adopt the new API:
  `src/codegen/tensor_op_codegen.cpp`, `REGISTER_ORCHESTRATION_OP(tensor_slice)`
  (around line 209). It already constructs `_shapes` and `_offsets` arrays;
  it would emit an additional `_drop_dims` array and call the new overload.
- The `tile.slice` rank-reducing path in PyPTO is purely codegen-side and
  does not need runtime support.

---

## #786 Raise CHIP_MAX_TENSOR_ARGS / RUNTIME_MAX_TENSOR_PAIRS (64) to unblock multi-block decode-layer orchestrations

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/786
- Created: 2026-05-15T07:11:11Z
- Updated: 2026-05-16T00:31:06Z
- Closed: 2026-05-16T00:31:06Z

### Body

## Context

While integrating DeepSeek-V4 decode-layer orchestrations (attention + MoE composed into one entry kernel) in pypto-lib, we hit two related fixed caps:

- \`CHIP_MAX_TENSOR_ARGS = 64\` in [\`src/common/task_interface/arg_direction.h:30\`](https://github.com/hw-native-sys/simpler/blob/main/src/common/task_interface/arg_direction.h#L30)
- \`RUNTIME_MAX_TENSOR_PAIRS 64\` in \`src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/runtime/runtime.h:49\` (the host->device record cap also counts internal allocations like \`gm_heap\` / \`sm_ptr\`, so the effective entry-tensor budget is 62, not 64).

Concretely:

| Entry function | Entry tensor params | Status |
|---|---|---|
| \`decode_swa_test\` | 46 | ok |
| \`decode_hca_test\` | 52 | ok |
| \`decode_csa_test\` | 69 | aborts at \`ChipStorageTaskArgs::add_tensor\` with \`IndexError: TaskArgs: tensor capacity exceeded\` |

The CSA layer composes attention_csa (49 params — adds main + inner compressors + indexer beyond HCA) with moe (23 params). Even after dropping shared and intermediate params and packing 7 sibling weight/state pairs into single tensors at the entry boundary (so the layer can fit in 62 inputs), the wins are paid for in extra \`pl.slice\` plumbing and a fragile correctness story (axis-1 packing trips matmul layout inference; certain packed pairs are later \`pl.reshape\`'d inside kernels). The cap is the practical blocker for end-to-end decode-layer benchmarks on FLASH (\`compress_ratios=(0,0,4,128,...)\`).

## Ask

Raise both caps and either:

- bump to a higher fixed value (e.g. 128 for \`CHIP_MAX_TENSOR_ARGS\`, 256 for \`RUNTIME_MAX_TENSOR_PAIRS\`), or
- make them tunable at runtime (env / build flag) so downstream models pay the storage cost only when needed.

Note the second cap counts \`gm_heap\` + shared-memory pair too; the entry-tensor budget is currently \`RUNTIME_MAX_TENSOR_PAIRS - 2\`. If the limits diverge, please document the bookkeeping overhead.

## Repro

\`\`\`bash
# pypto-lib branch feat/decode-orchestration-swa-hca-csa
python models/deepseek/v4/decode_csa.py -p a2a3 -d 0
\`\`\`

## Workarounds tried

1. Pack 7 sibling pairs (\`gamma_cq+gamma_ckv\`, \`even_select_t+odd_select_t\`, etc.) into single tensors at the entry, splitting via \`pl.slice\` inside the inline body. Reduces 69 -> 62. Compiles and runs, but values mismatch ~55% on the \`compressor_ratio4\` path — \`pl.reshape\` inside compressor on a sliced-with-non-zero-offset \`kv_state\` / \`score_state\` likely loses the view offset (\`Tensor::reshape\` sets \`is_all_offset_zero = true\` after copying metadata, but does not reset \`start_offset\`; behavior is inconsistent with other slice→reshape sites).
2. Axis-1 packing trips \`ptoas\` \`layout mismatch: user-specified layout=dn but inferred=nd\` in the rope_assemble matmuls (axis-1 slices are non-contiguous along the inner stride). Axis-0 packing avoids this but exposes the offset-reshape issue above.

---

## #793 [Feature] Report PTO2 ring buffer peak usage and per-step validate timing

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/793
- Created: 2026-05-18T02:01:43Z
- Updated: 2026-05-19T08:29:56Z
- Closed: 2026-05-19T08:29:56Z
- Labels: enhancement

### Body

## Summary

The L2 `tensormap_and_ringbuffer` runtime has two related observability gaps that make it hard to size `PTO2_RING_HEAP` correctly:

1. **No peak usage tracking on the heap ring and task ring.** `PTO2RingBuffer` only exposes the current `heap_top_`; there is no `heap_high_water_`. `PTO2TaskAllocator` is the same. Only `PTO2FaninPool::high_water` ([pto_ring_buffer.h:377](https://github.com/hw-native-sys/simpler/blob/main/src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.h#L377)) is tracked and printed in `mark_done()`.
2. **No per-step timing in `validate_runtime_impl`.** `bind_prepared_to_runtime_impl` logs `TIMING:` for every step (`args_malloc_copy`, `gm_heap_alloc`, `shared_mem_alloc`, total), but `validate_runtime_impl` ([runtime_maker.cpp:322](https://github.com/hw-native-sys/simpler/blob/main/src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp#L322)) emits none.

## Motivation / Use Case

When tuning `PTO2_RING_HEAP`, the user has no feedback to pick a sensible value:

- Too small → deadlock with `PTO2_ERROR_HEAP_RING_DEADLOCK`.
- Too large (e.g. 4 GB) → the run passes, but both init and validate get noticeably slower.

Observed on a paged-attention SPMD test: raising `PTO2_RING_HEAP` from 1 GB to 4 GB makes `validate_runtime_impl` significantly slower, but the log only shows that *validate as a whole* is slower. There is no way to tell which step is the cause:

- `pto2_read_runtime_status` (small `copy_from_device`)?
- `copy_from_device` for the output tensors (may hit the packed output path where `graph_out_size` is large)?
- `device_free(total_heap_size = eff_heap_size * PTO2_MAX_RING_DEPTH)` — a single 4 GB `device_free`?

At the same time, the user cannot see the actual heap peak this run hit — the only way is to bisect by deliberately undersizing the env vars until the run deadlocks, and read the recovery message.

## Proposed API / Behavior

### (1) Peak usage tracking

Add `heap_high_water_` and `task_high_water_` to `PTO2RingBuffer` / `PTO2TaskAllocator`, updated after each successful allocation:

```cpp
// pto_ring_buffer.h
uint64_t heap_high_water_ = 0;
int32_t  task_high_water_ = 0;

// at the tail of each successful branch in alloc_output()
uint64_t used = (heap_top_ >= tail) ? (heap_top_ - tail)
                                    : (heap_size_ - tail + heap_top_);
heap_high_water_ = std::max(heap_high_water_, used);
```

Extend the existing `LOG_INFO_V0` block in `PTO2OrchestratorState::mark_done()` ([pto_orchestrator.cpp:902-914](https://github.com/hw-native-sys/simpler/blob/main/src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp#L902-L914)) to print per-ring peaks plus a recommended env value (next power of 2 above the peak):

```
=== [Ring 0] heap peak=91234304/268435456 (34.0%) task peak=2143/16384 (13.0%) ===
=== Recommended: PTO2_RING_HEAP>=134217728 PTO2_RING_TASK_WINDOW>=4096 ===
```

This mirrors the existing `[FaninPool N] … high_water=…` line.

### (2) Per-step timing in `validate_runtime_impl`

Mirror the style used by `bind_prepared_to_runtime_impl` and emit per-step `TIMING:` logs:

```
TIMING: read_runtime_status        = …ms
TIMING: copy_from_device           = …ms (sum over N tensors)
TIMING: device_free                = …ms (sum, includes gm_heap free)
TIMING: total_validate_runtime_impl = …ms
```

If feasible, break down `copy_from_device` and `device_free` by tensor category (output / gm_heap / sm / inputs). At minimum, `device_free(gm_heap)` should be reported on its own line — it dominates total free time and is the step most directly affected by `PTO2_RING_HEAP`.

## Alternatives Considered

1. Force a deadlock by setting env vars artificially small and reverse-engineer the peak from the deadlock report. Works today but is iterative and gives nothing about validate timing.
2. Add a PMU / profiling mode. Too heavy for what is essentially a few extra fields and `_now_ms()` calls.
3. Estimate heap usage statically in `host_build_graph`. Unreliable for dynamic shapes and orthogonal to the validate-timing question.

## Additional Context

Reproducer (this case passes with both 1 GB and 4 GB heap; the 4 GB run is visibly slower in the validate phase):

```bash
task-submit --run --device auto --env PTO2_RING_HEAP=4294967296 \
  "pytest -s tests/st/codegen/test_paged_attention_spmd.py::TestPagedAttentionSpmdKernels::test_paged_attention_spmd_ptoas[64-64-256-64-8192-32768] --device={}"
```

Relevant code locations (a2a3):

- Existing fanin peak print (style reference): [pto_orchestrator.cpp:907-913](https://github.com/hw-native-sys/simpler/blob/main/src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp#L907-L913)
- Env parsing + defaults: [runtime_maker.cpp:256-267](https://github.com/hw-native-sys/simpler/blob/main/src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp#L256-L267)
- `bind_prepared_to_runtime_impl` existing `TIMING:` logs (alignment target): [runtime_maker.cpp:303-306](https://github.com/hw-native-sys/simpler/blob/main/src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp#L303-L306)
- `validate_runtime_impl` (missing `TIMING:`): [runtime_maker.cpp:322](https://github.com/hw-native-sys/simpler/blob/main/src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp#L322)
- Compile-time defaults: [pto_runtime2_types.h:106-114](https://github.com/hw-native-sys/simpler/blob/main/src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2_types.h#L106-L114)

The A5 runtime has symmetric code under `src/a5/runtime/tensormap_and_ringbuffer/` and should be updated in the same change.

---

## #796 [Performance] validate_runtime_impl is ~2x the chip-side cost per run (avg 50ms, max 91ms) on Qwen3-314B decode

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/796
- Created: 2026-05-18T03:15:37Z
- Updated: 2026-05-25T02:33:11Z
- Closed: 2026-05-25T02:33:11Z
- Labels: performance

### Body

Platform: a2a3 (Ascend 910B/C hardware)
Runtime Variant: tensormap_and_ringbuffer
Host: Linux (aarch64)
Commit: a94d5140 (runtime submodule HEAD, detached)

## Summary

`validate_runtime_impl` (post-`run()` host finalize) is taking **~50ms on average and up to ~91ms** per chip invocation, which is **~2x the cost of the entire chip execution** (runner_run avg 26.6ms incl. AICPU+AICore stream sync). Over a single 16-token decode of Qwen3-314B (1-layer config), it consumed **2.43s of host time across 48 calls** — i.e. ~26% of the entire decode budget is spent here, after the chip is already idle.

Because `run_prepared()` serializes `runner->run()` -> `validate_runtime_impl()` on the host thread, this overhead is on the critical path of every token: it cannot be hidden behind chip execution.

## Reproduction

Driven via pypto-lib running Qwen3-314B 1-layer decode on a2a3 hardware:

```bash
cd pypto-lib
python models/qwen3/314b/qwen3_314b_decode.py -p a2a3 -d 0 \
    --num-tokens 16 --num-layers 1
```

To get the timing breakdown, build `runtime/` with local instrumentation in `src/a2a3/platform/onboard/host/pto_runtime_c_api.cpp` and `device_runner.cpp` (steady_clock timing around `validate_runtime_impl`, kernel launches, and stream syncs, gated by `SIMPLER_CHIP_TIMING=1`). Then:

```bash
SIMPLER_CHIP_TIMING=1 python ... -d 0 2> timing.log
```

## Expected Performance

`validate_runtime_impl` is pure host finalize after the chip has synced. For a 1-layer decode kernel with a small number of output tensors, expected cost is <5ms (a few `aclrtMemcpy` D2H calls + a few device frees).

## Actual Performance

Measured across 48 consecutive `run_prepared()` calls in the same process (no rebuild / no driver re-init between calls):

```
validate_runtime_impl: n=48  total=2426.8ms  avg=50.56ms  min=14.49ms  max=90.62ms
runner_run (chip+sync): n=48  total=1274.5ms  avg=26.55ms  min=17.89ms  max=64.30ms
```

A clear **3-phase periodic pattern** is visible across the trace, one phase per kernel invoked per decode step (`decode_layer`, `final_rms`, `lm_head`):

```
decode_layer  validate ~ 14-20 ms  (small output tensors)
final_rms     validate ~ 82-91 ms  (largest output)
lm_head       validate ~ 48-56 ms  (vocab-sized output)
```

This is consistent with the dominant cost being **per-tensor D2H copy + per-tensor `device_free`** inside the host loop at `src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp:367-410`:

- `runtime->host_api.copy_from_device(...)` is called per tensor pair
- `runtime->host_api.device_free(...)` is called per tensor pair
- both are presumably synchronous ACL calls — no batching, no async, no parallelism, and no skip path for tensors whose host_ptr was already up-to-date.

## Profiling Data

Per-run breakdown extract (`[c_api_timing]` lines, omitted `bind_callable` which is always 0.00ms):

```
run= 0  prepare_ctx=0.83  runner_run=64.30   validate=76.21  total=492.60
run= 1  prepare_ctx=0.70  runner_run=33.69   validate=14.62  total=51.62
run= 2  prepare_ctx=0.74  runner_run=35.67   validate=83.08  total=214.28
run= 3  prepare_ctx=0.69  runner_run=34.40   validate=51.88  total=117.21
...
run=44  prepare_ctx=0.58  runner_run=19.72   validate=90.62  total=150.38
run=45  prepare_ctx=0.60  runner_run=34.32   validate=48.28  total=109.97
run=46  prepare_ctx=0.61  runner_run=18.22   validate=15.97  total=36.60
run=47  prepare_ctx=0.60  runner_run=20.21   validate=82.17  total=142.39
```

Run-level downstream impact in this trace:

```
[api]   run_decode total : 8.37s (15 steps, avg 558.0 ms/step, 1.79 step/s)
[phase] throughput (e2e) : 0.89 tok/s
```

So removing the validate host overhead (~150ms per token = 14+82+50) could in principle bring per-step from ~558ms toward ~408ms — about a 27% improvement on a single chip / single layer.

## Additional Context

- This is host-side overhead AFTER `aclrtSynchronizeStreamWithTimeout` on both streams. The chip is already idle when validate runs.
- The `total` field (`total=492.60` on run 0, `~150` on later runs) is much larger than `prepare_ctx + runner_run + validate`. The remainder is on the Python side (`worker.py` store_to_host flush + mailbox transitions). That overhead is separate and not the subject of this issue.
- Possible angles to investigate:
    1. Are all tensor pairs that `validate_runtime_impl` iterates actually outputs? If the loop is also copying back inputs / weights / KV-cache entries with stale `host_ptr`, that is the bug.
    2. Can `copy_from_device` be issued asynchronously and joined once at the end, rather than serially?
    3. Can `device_free` be batched, or deferred to the next `init_runtime_impl` (free-on-reuse)?
    4. Tensors whose `host_ptr == dev_ptr` (unified addr) or whose output is already known to live in the packed graph_output buffer should skip the per-tensor copy.

Happy to provide the full timing log on request.

---

## #800 [Bug] a5 PMU CNT_TOTAL returns 0 when reg_base read is slow between pmu_disable and ld_dev

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/800
- Created: 2026-05-18T07:47:40Z
- Updated: 2026-06-11T02:32:11Z
- Closed: 2026-06-11T02:32:11Z
- Labels: bug

### Body

### Platform

a5 (Ascend 950 hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

On a5, AICore reads its own PMU MMIO directly via `ld_dev`. The sequence per task is roughly:

```
write_reg(CTRL, CTRL & ~PMU_ENABLE_BIT);   // pmu_aicore_end(): disable PMU
... fetch reg_base from somewhere ...
ld_dev(reg_base + CNT0_OFFSET);            // event counters cnt[0..9]
...
ld_dev(reg_base + CNT_TOTAL0_OFFSET);      // 64-bit cycle counter
ld_dev(reg_base + CNT_TOTAL1_OFFSET);
```

Empirically, the **latency of "fetch reg_base"** decides whether `CNT_TOTAL0/1` reads valid values or returns 0. Event counters (`cnt[0..9]`) are unaffected — they hold their value after PMU disable.

Reporting this as a hardware-mechanism question because the three reg_base-fetch shapes we've tried map cleanly to three outcomes:

| Reg-base fetch shape                                                 | Where the value lives                | Typical latency                                             | `CNT_TOTAL` result   |
| -------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- | -------------------- |
| Read a `volatile uint64_t` field from a GM struct that AICore already accesses every task (so its cache line is L1-hot) | GM (cached, hot) | ~1–2 cycles (L1 hit) | Always non-zero |
| Read `table[block_idx]` from a separate device-memory table that AICore touches only here (cold cache line) | GM (uncached / cold) | dozens to hundreds of cycles (L1 miss → DDR) | ~25% of records read **0** |
| Read a `[[block_local]]` `uint64_t` value resolved once at kernel entry | AICore per-block private storage | ~1 cycle (scalar register access) | Always non-zero |

Same `ld_dev` sequence in all three cases; only the operation immediately before it changes.

### Steps to Reproduce

1. Build the kernel so AICore fetches `reg_base` from a cold GM table per task — i.e. `[[block_local]] static __gm__ uint64_t *table;` and `get_reg_base() { return table[block_idx]; }`, where `table` points to a per-core device-memory array AICore otherwise never touches.
2. Run any PMU-profiling test on real a5 hardware with enough tasks to populate `outputs/<run>/pmu.csv` (we used `examples/paged_attention_unroll`, ~1024 tasks).
3. `awk -F, 'NR>1 && $6=="0"' outputs/<run>/pmu.csv | wc -l`.

### Expected Behavior

`CNT_TOTAL` returns a valid cycle count whenever the kernel actually executed — i.e. should behave the same way the event counters do, sticky after PMU disable.

### Actual Behavior

Cold-GM-table reg-base fetch:

| log level | total rows | rows with `pmu_total_cycles == 0` |
| --------- | ---------- | --------------------------------- |
| debug     | 1024       | 482 (≈47%)                        |
| warn      | 1024       | 265 (≈26%)                        |

Sample row (event counters valid, total cycles zero):

```
0,0,0x00000001000001e1,0,0,0,0,274,38,171,0,0,6,0,0,2
```

After switching to the block-local fetch shape, the same test yields **0 / 1024** zero rows.

The dependency on log level is informative: AICPU log throughput changes dispatch timing, which changes per-core task density, which changes how often the cold cache line gets evicted between reads. More eviction → more `CNT_TOTAL == 0` rows. Suggests the failure is driven by cache-miss-rate, not by any deterministic counter-clear behavior.

### Git Commit ID

N/A — the broken intermediate state is no longer on `main`. The pattern is reproducible by deliberately introducing a cold per-record GM read between `pmu_aicore_end()` and `ld_dev(CNT_TOTAL0)`.

### CANN Version

N/A.

### Driver Version

N/A.

### Host Platform

Linux (aarch64)

### Additional Context

This issue exists as a **hardware-behavior record**, not an open repo bug. The software-side fix is already in place (resolve `reg_base` into block-local storage at kernel entry).

What we'd like the hardware team to confirm or correct:

- Is `CNT_TOTAL0/1` expected to remain readable indefinitely after PMU disable (CTRL bit 0 = 0), or is there a defined valid-read window after disable?
- If a window exists: is it specified in cycles, or in terms of "next access on the MMIO interface after disable"?
- Is the cycle counter's post-disable behavior expected to differ from event counters' (which are clearly sticky)?

If this is **expected hardware behavior**, then software has a hard constraint: after `pmu_aicore_end()`, nothing slow (cache miss, long scalar dependency, etc.) is allowed before `ld_dev(CNT_TOTAL)`. The current fix relies on that constraint informally; a documented spec would let us assert it.

If this is **unexpected / a hardware bug**, please advise on a hardware-side guard so software does not have to manage this timing window.

---

## #805 [Code Health] CI passes on failing test and (stale?/leftover) commit hash

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/805
- Created: 2026-05-18T12:25:58Z
- Updated: 2026-05-19T06:47:40Z
- Closed: 2026-05-19T06:47:40Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Other (please specify in description)

### Description

Hi everyone, while looking at the CI, together with @vloncar we noticed a commit hash (from gitcode PTO-ISA) that is expected to act as a fallback in testing. More specifically we refer to this line here [PTO_ISA_COMMIT:](https://github.com/hw-native-sys/simpler/blob/54c66d5649ea68e903a5db0a3524256b5170e890/.github/workflows/ci.yml#L12)

while investigating its use, we ended up in finding failing CI tests, though CI still being green, as in:

- https://github.com/hw-native-sys/simpler/actions/runs/26029797590/job/76512506255 (Look into Run pytest scene tests), you will see:

```bash
  =========================== short test summary info ============================
  FAILED tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention/test_spmd_paged_attention.py::TestPagedAttentionUnrollTpushPop::test_run - AssertionError: Golden mismatch on 'out': max_diff=0.004472039639949799, rtol=0.002, atol=0.002
  =================== 1 failed, 34 passed in 66.71s (0:01:06) ====================
  --- L2 tensormap_and_ringbuffer: FAIL rc=1 67.0s ---
*** FAIL: L2 tensormap_and_ringbuffer — expand group above ***
```



### Location

```markdown
- https://github.com/hw-native-sys/simpler/blob/54c66d5649ea68e903a5db0a3524256b5170e890/.github/workflows/ci.yml#L12
- https://github.com/hw-native-sys/simpler/actions/runs/26029797590/job/76512506255
```

### Proposed Fix

Should the redundant code be droppe, and cleanup some of the code around the pytest pto-isa commit tags?

### Priority

Low (no impact today, good to fix eventually)

---

## #818 [Performance] SPMD blocks start sequentially instead of simultaneously despite single dispatch

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/818
- Created: 2026-05-19T07:26:09Z
- Updated: 2026-05-21T02:57:59Z
- Closed: 2026-05-21T02:57:59Z
- Labels: performance

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

When using `pl.spmd(n)` to dispatch n SPMD blocks, the blocks start sequentially with ~5us offset per block, rather than starting simultaneously as expected for a single dispatch. The total start-time spread across 20 blocks is ~14.5us.

### Git Commit ID

54c66d5649ea68e903a5db0a3524256b5170e890

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (x86_64)

### Reproduction

```bash
In a Qwen3-14B decode model, the output projection uses `pl.spmd(20)` to dispatch 20 SPMD blocks for the matmul `[16,5120] x [5120,256]`. Each block computes a different N-dimension slice.


for ob in pl.spmd(out_proj_n_blocks, name_hint="out_proj"):
    o0 = ob * OUT_PROJ_N_CHUNK
    o_acc = pl.create_tensor([BATCH_TILE, OUT_PROJ_N_CHUNK], dtype=pl.FP32)
    for kb in pl.pipeline(0, out_proj_k_blocks, stage=2):
        k_idx = (kb + ob) % out_proj_k_blocks
        k0 = k_idx * OUT_PROJ_K_CHUNK
        a_chunk = attn_out[b0 : b0 + BATCH_TILE, k0 : k0 + OUT_PROJ_K_CHUNK]
        w_chunk = wo[k0 : k0 + OUT_PROJ_K_CHUNK, o0 : o0 + OUT_PROJ_N_CHUNK]
        if kb == 0:
            o_acc = pl.matmul(a_chunk, w_chunk, out_dtype=pl.FP32)
        else:
            o_acc = pl.matmul_acc(o_acc, a_chunk, w_chunk)
    resid1_tile = pl.assemble(resid1_tile, o_acc, [0, o0])
```

### Expected Performance

Profiling the L2 perf records shows the 20 SPMD blocks start sequentially:

### Actual Performance

5-6us per block

### Profiling Data (Optional)

_No response_

### Additional Context

_No response_

---

## #819 [Performance] SPMD blocks start sequentially instead of simultaneously despite single dispatch

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/819
- Created: 2026-05-19T07:29:38Z
- Updated: 2026-05-19T08:30:40Z
- Closed: 2026-05-19T08:30:40Z
- Labels: performance

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

When using `pl.spmd(n)` to dispatch n SPMD blocks, the blocks start sequentially with ~5us offset per block, rather than starting simultaneously as expected for a single dispatch. The total start-time spread across 20 blocks is ~14.5us.

### Git Commit ID

54c66d5649ea68e903a5db0a3524256b5170e890

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (x86_64)

### Reproduction

```bash
In a Qwen3-14B decode model, the output projection uses `pl.spmd(20)` to dispatch 20 SPMD blocks for the matmul `[16,5120] x [5120,256]`. Each block computes a different N-dimension slice.


for ob in pl.spmd(out_proj_n_blocks, name_hint="out_proj"):
    o0 = ob * OUT_PROJ_N_CHUNK
    o_acc = pl.create_tensor([BATCH_TILE, OUT_PROJ_N_CHUNK], dtype=pl.FP32)
    for kb in pl.pipeline(0, out_proj_k_blocks, stage=2):
        k_idx = (kb + ob) % out_proj_k_blocks
        k0 = k_idx * OUT_PROJ_K_CHUNK
        a_chunk = attn_out[b0 : b0 + BATCH_TILE, k0 : k0 + OUT_PROJ_K_CHUNK]
        w_chunk = wo[k0 : k0 + OUT_PROJ_K_CHUNK, o0 : o0 + OUT_PROJ_N_CHUNK]
        if kb == 0:
            o_acc = pl.matmul(a_chunk, w_chunk, out_dtype=pl.FP32)
        else:
            o_acc = pl.matmul_acc(o_acc, a_chunk, w_chunk)
    resid1_tile = pl.assemble(resid1_tile, o_acc, [0, o0])
```

### Expected Performance

Profiling the L2 perf records shows the 20 SPMD blocks start sequentially:

### Actual Performance

5-6us per block

### Profiling Data (Optional)

_No response_

### Additional Context

_No response_

---

## #822 [Bug] Mode B (kernelType=AICPU_CUSTOM): cust_aicpu_sd subprocess cache stale on AICore HBM writes → AICPU handshake deadlock (507018)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/822
- Created: 2026-05-19T09:01:34Z
- Updated: 2026-05-20T14:00:37Z
- Closed: 2026-05-20T14:00:37Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

PR #537 migrates the AICPU dispatcher from CANN 6.x `RuntimeAicpuKernelLaunchExWithArgs` (path A) to CANN 7.0+ `rtsBinaryLoadFromFile + rtsLaunchCpuKernel` (path B). The motivation is to enable **a single host process binding both `host_build_graph` and `tensormap_and_ringbuffer` runtimes** — path A is blocked by a process-wide one-shot `firstCreatSo_` latch inside CANN preinstalled `libaicpu_processer.so::BackendServerHandleManager::SaveSoFile`, which makes loading a second runtime's inner SO a silent no-op.

In path B, the JSON descriptor uses `opKernelLib=AICPUKernel + userDefined="True"`, which CANN routes to `KERNEL_TYPE_AICPU_CUSTOM (4)` (`cann/runtime/src/runtime/core/src/kernel/program_common.cc`). Per `ae_so_manager.cc::GetSoPath`, `KERNEL_TYPE_AICPU_CUSTOM` is the only path that searches `/home/CustAiCpuUser/cust_aicpu_<dev>_<vf>_<pid>/` (where our uploaded SO actually lands); all other types search `/usr/lib64/aicpu_kernels/...` which is root-owned and unwritable from a user process. A gate at `ae_so_manager.cc:514` (`IsCustAicpuSd()`) also enforces that `KERNEL_TYPE_AICPU_CUSTOM` MUST execute inside the `aicpu_custom_scheduler` subprocess.

Everything routes through correctly: CANN dispatches our `Dyn*` exports to the cust subprocess, our `libsimpler_aicpu_<runtime>.so` is dlopen'd, three phases (Null/Init/Run) all reach our code, and `SchedulerContext::handshake_all_cores` step 1 writes complete to all 9 cores' `Handshake` slots in shared HBM. **AICPU writes are visible to host (verified via `aclrtMemcpy DEVICE_TO_HOST` readback). AICore stream dispatches, runs past its phase 1, writes `aicore_regs_ready=1` back to HBM (also confirmed via host D2H).**

**The bug: the cust AICPU's L1 cache holds a stale 0 for the `aicore_regs_ready` field**, even though HBM and host both see 1. `SchedulerContext::handshake_all_cores` step 2 spin loop never observes the update:

```cpp
// src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp
while (hank->aicore_regs_ready == 0) {}   // ← cust AICPU stuck here, HBM has 1
```

After 2 s the host `aclrtSynchronizeStreamWithTimeout(stream_aicpu_)` reports `ACL_ERROR_RT_AICPU_EXCEPTION (507018)`. Mode A (path A) does not exhibit the bug because the main `aicpu_scheduler` shares a cache coherency domain with AICore; the cust subprocess gets bound (`SetAffinity`) to a different AICPU cluster whose L1 is not snooped by AICore HBM writes.

User-space workarounds attempted (all fail):

| Attempt | Result |
| --- | --- |
| `volatile uint32_t` field qualifier | No effect — prevents register reuse, not L1 cache |
| `__atomic_load_n(..., __ATOMIC_ACQUIRE)` (→ `ldar`) | No effect — only an ordering instruction, still reads L1 |
| `dc civac` (clean + invalidate) in spin loop | Worse — same cache line co-hosts AICPU-written `aicpu_ready/task` and AICore-written `aicore_regs_ready`; civac writes back AICPU's dirty stale view, clobbering AICore's HBM writes |
| `dc ivac` (invalidate-only) in spin loop | Silently NOP'd from EL0 (SCTLR_EL1.UCI=0 in kernel) |

### Steps to Reproduce

1. Apply the PR #537 mode B refactor (single SO `libsimpler_aicpu_<runtime>.so` with merged outer dispatcher + inner runtime kernels; JSON `opKernelLib=AICPUKernel + userDefined=True` for all three phases — Null/Init/Run; orch SO `candidate_dirs[]` adds `/home/CustAiCpuUser` as first entry)
2. Run the simplest a2a3 onboard example:
   ```bash
   python3 -m venv --system-site-packages .venv
   source .venv/bin/activate
   pip install --no-build-isolation -e .
   python examples/a2a3/tensormap_and_ringbuffer/vector_example/test_vector_example.py -p a2a3
   ```
3. Test fails with timeout. Optional D2H diagnostic in `device_runner.cpp::run` after the timeout shows HBM has the right values:
   ```cpp
   if (rc == ACL_ERROR_RT_STREAM_SYNC_TIMEOUT || rc == 507018) {
       Handshake h0 = {};
       aclrtMemcpy(&h0, sizeof(h0),
                   reinterpret_cast<const uint8_t*>(kernel_args_.args.runtime_args) + offsetof(Runtime, workers),
                   sizeof(h0), ACL_MEMCPY_DEVICE_TO_HOST);
       LOG_ERROR("workers[0] readback: aicpu_ready=%u task=0x%lx aicore_regs_ready=%u",
                 h0.aicpu_ready, (uint64_t)h0.task, h0.aicore_regs_ready);
   }
   ```
   Output: `workers[0] readback: aicpu_ready=1 task=0x... aicore_regs_ready=1` — both handshake bits set in HBM, both visible to host, but cust AICPU never sees the AICore-written `aicore_regs_ready=1`.

### Expected Behavior

`tensormap_and_ringbuffer` vector example passes end-to-end with `kernelType=AICPU_CUSTOM (4)` routing. Multi-runtime in a single host process becomes possible (one ChipWorker process binds both `host_build_graph` and `tensormap_and_ringbuffer`), which is the entire motivation for path B over path A.

### Actual Behavior

```
=== Runtime: tensormap_and_ringbuffer  Level: 2 ===
  TestVectorExample::default ... [ERROR] run: [device_runner.cpp:797] aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
FAILED: run_prepared failed with code 507018
```

Device log shows our dispatcher and inner kernel running cleanly in the cust subprocess; the deadlock is purely the AICPU-side read-side cache miss on AICore-written HBM data. The bug is **not** in user-space code and cannot be fixed there: the four standard AArch64 cache-bypass primitives all fail as documented above.

### Possible fix directions

(Listed by where the change has to live — none can be done purely in this repo's user-space.)

| # | Where | Change |
| --- | --- | --- |
| **A** | CANN device kernel / driver | Enable EL0 `dc ivac` (set `SCTLR_EL1.UCI=1` for the `aicpu_custom_scheduler` process). Smallest change, user-side spin loops can then explicitly invalidate. |
| **B** | CANN runtime / driver | Allocate `Handshake` HBM (`runtime->workers`) with non-cacheable / write-through attribute when called from `aicpu_custom_scheduler` context. Slight per-access HBM latency cost. |
| **C** | CANN cust scheduler | Pin `aicpu_custom_scheduler` worker threads to the same AICPU cluster as AICore's snoop domain (today `aicpusd_worker.cpp::SetAffinity` binds them to a separate `cpuId=0`). |
| **D** | simpler runtime (this repo) | Split `Handshake` so AICPU-written and AICore-written fields live on disjoint cache lines, then make AICPU spin loops `dc civac` only the AICore-written line — but EL0 invalidate semantics still apply, so this only works in combination with A or B. Alternatively, replace the spin-wait protocol with a device event/notify primitive that bypasses shared-memory polling entirely (substantial runtime refactor). |

A/B/C are CANN-side; D is user-side but on its own is insufficient. We'd appreciate guidance from the CANN team on whether A or B is feasible for the cust subprocess in a near-term release.

### Git Commit ID

ec7363a2eb6fbed4d71f848e1532dbcef7adc6c8

### CANN Version

26.0.rc1 (V100R001C10SPC001B257)

### Driver Version

26.0.rc1 (ascendhal 7.35.23)

### Host Platform

Linux (aarch64)

### Additional Context

Related open issues (different surface, may share root once A/B/C lands):
- #84 — 507018 in tensormap_and_ringbuffer (different reproducer)
- #266 — cache coherency in handshake on sim
- #480 — handshake failure on 910B3
- #759 — stream timeout on multi-cid dispatch

Concrete D2H diagnostic + per-iteration markers + cust subprocess routing analysis lived in the long debug session that produced this issue; the architecture diagram and CANN source pointers are in `.docs/ISSUE-mode-b-cache-coherency.md` of the PR #537 worktree. CANN open-source references:
- `cann/runtime/src/runtime/core/src/kernel/program_common.cc` — `opKernelLib` → `kernelType` table
- `cann/runtime/src/aicpu_sched/aicpu_processer/ae_so_manager.cc` — `GetSoPath`, `LoadSo` cust-vs-inner routing and the `IsCustAicpuSd` gate
- `cann/runtime/src/aicpu_sched/aicpu_schedule/core/aicpusd_worker.cpp` — `SetAffinity` binding worker threads to specific AICPU cores
- `cann/runtime/src/aicpu_sched/aicpu_schedule/core/aicpusd_cust_so_manager.cpp` — cust SO upload to `/home/CustAiCpuUser/cust_aicpu_*/`

---

## #824 [Feature] Support persistent communication domains across Worker.run calls

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/824
- Created: 2026-05-20T03:00:35Z
- Updated: 2026-06-17T08:52:32Z
- Labels: enhancement

### Body

### Summary

`Worker` appears to support multiple `Worker.run()` calls over its lifetime, but the new orch-driven dynamic communication domain lifetime is effectively tied to one `Worker.run()` invocation. This may be too short for common training and inference workloads where tensor-parallel and data-parallel communication domains are usually long-lived, and their lifetime may span multiple training or inference tasks.

As a result, the same fixed communication domain may be dynamically allocated and released repeatedly within one `Worker` lifetime. Since HCCL dynamic allocation can involve device allocation, IPC export/import, and subset synchronization, this repeated cost may be unacceptable in training, inference, or benchmark loops.

### Motivation / Use Case


A typical application may keep one `Worker` alive and call `Worker.run()` many times:

```python
worker.init()
for step in range(num_steps):
    worker.run(train_step_orch, args=step_args[step], config=cfg)
worker.close()
```

Inside `train_step_orch`, the application may need a fixed TP or DP domain:

```python
def train_step_orch(orch, args, cfg):
    with orch.allocate_domain(
        name="tp",
        workers=[0, 1, 2, 3],
        window_size=window_size,
        buffers=buffer_specs,
    ) as tp:
        orch.submit_next_level(...)
        orch.submit_next_level(...)
```

If the TP or DP membership, window size, and buffer layout are unchanged across steps, this domain is logically a long-lived resource. However, with the current run-scoped dynamic allocation model, each `Worker.run()` would allocate and release the same fixed domain again.

This matters for workloads such as:

- TP/DP/EP groups reused across many training or inference tasks.
- Benchmark or warmup/timed loops where repeated allocation overhead would pollute the measured steady-state cost.


### Proposed API / Behavior

Consider adding a persistent or cacheable communication domain lifetime that is longer than one `Worker.run()` call. For example, the runtime could support a domain that is created once, reused by multiple orch invocations, and released explicitly or at `Worker.close()`.

The exact API is open, but the intended behavior is:

- Temporary domains remain available for per-DAG or per-phase scratch space.
- Fixed domains can be reused across multiple `Worker.run()` calls when their workers, window size, and buffer layout are unchanged.
- The runtime avoids paying HCCL dynamic allocation cost once per run for the same fixed domain.
- Cleanup remains explicit and safe, either by user request or during `Worker.close()`.

### Alternatives Considered

One workaround is to merge more work into a single large `Worker.run()` so the dynamic allocation cost is amortized across more submitted tasks. This is not a complete solution:

- It makes host-side orchestration less flexible for training steps, inference requests, benchmark iterations, and staged workflows.
- It can increase peak memory usage because current domain release is deferred until the whole `Worker.run()` drains.
- It does not match fixed TP/DP domain lifetimes, which may naturally span multiple training or inference tasks.


### Additional Context

This concern comes from reviewing PR #817, which moves communication domain allocation to the orch-only dynamic path. The dynamic path is a useful API for domains whose membership or buffers are genuinely per-DAG, but fixed TP/DP domains may need a longer-lived resource model to avoid repeated HCCL dynamic allocation overhead.

Reference commit: `681f3315`.

---

## #831 [Bug] A2A3 triangular inverse AIC kernel times out in `tensormap_and_ringbuffer` runtime

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/831
- Created: 2026-05-20T14:11:40Z
- Updated: 2026-06-19T08:02:04Z
- Closed: 2026-06-19T08:02:04Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B2)

### Runtime Variant

tensormap_and_ringbuffer

### Description

The triangular inverse example in PR https://github.com/hw-native-sys/simpler/pull/830 compiles for `a2a3` hardware after separating simulator-only L0C-to-L1 store handling from hardware direct accumulator stores, but the AIC task times out at runtime.

The timeout happens both with the recursive/unrolled triangular inverse kernel and with a reduced single-core `tri_inv_trick` kernel. Probing the single-core version shows that initial GM-to-L1 loads, L1-to-L0 moves, the first `TMATMUL`, and accumulator-to-L1 moves can complete. The timeout starts when the kernel enters the refinement loop and reuses L0A/L0B buffers after prior cube/FIX work.

This suggests a missing or incorrect pipe/event synchronization sequence around reusing L0 buffers after `TMATMUL`/`TMOV` accumulator paths, or a runtime/device scheduling issue triggered by that pattern.

### Steps to Reproduce
From the PR https://github.com/hw-native-sys/simpler/pull/830 
```bash
python examples/a2a3/tensormap_and_ringbuffer/triangular_inverse_example/test_triangular_inverse.py \
  -p a2a3 \
  -d 1 \
  --case TestTriangularInverse::Case_upper_tri_matrix_size_32 \
  --skip-golden \
  --log-level debug
```

### Expected Behavior

The AIC task should complete on hardware, copy output tensors back to host, and the test should pass or at least proceed to numerical validation.

### Actual Behavior

The AIC task launches but the AICPU stream synchronization times out. Typical failure:

```text
aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
PTO2 runtime failed: orch_error_code=0 sched_error_code=100 runtime_status=-100
FAILED: run_prepared failed with code 507018
```

A debug run shows the runtime reaches AICore launch:

```text
=== launch_aicpu_kernel DynTileFwkKernelServerInit ===
=== launch_aicpu_kernel DynTileFwkKernelServer ===
=== launch_aicore_kernel ===
=== aclrtSynchronizeStreamWithTimeout stream_aicpu_ ===
```

Then it times out before successful completion.

### Git Commit ID

d423e878c960e5dd3c5b65aeba5f8a82fda88e96

### CANN Version

9.0.0

### Driver Version

25.5.1

### Host Platform

Linux (aarch64)

### Additional Context

_No response_

---

## #833 [Bug] #808 strided Tensor: multi-config paged-attention deadlocks GM heap ring on a2a3

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/833
- Created: 2026-05-21T06:29:09Z
- Updated: 2026-05-25T01:32:10Z
- Closed: 2026-05-25T01:32:10Z
- Labels: bug

### Body

## Platform
a2a3 (Ascend910B), real device.

## Runtime Variant
`tensormap_and_ringbuffer` (onboard).

## Description
Since #808 ("a2a3 + a5 Tensor to strided (start_offset/stride) model", `f20a8393`), the **multi-config fused paged-attention** task graph deadlocks the orchestrator on a2a3 device. The host's `aclrtSynchronizeStreamWithTimeout` then fails with ACL `507018`.

The deadlock is **not** a ring-buffer sizing/tuning issue — it persists at every ring size tried (see sweep below), surfacing as a GM heap-ring flow-control deadlock.

This is exercised by the pypto consumer's `tests/st/codegen/test_paged_attention_multi_config.py` and is the cause of pypto's `system-tests` CI failure when bumping the runtime submodule past #808 (the hang kills the worker before logs flush, hence "failing with no log").

## Steps to Reproduce
With a pypto checkout whose `runtime` submodule is at the tip including #808 (e.g. `d423e878`), built + installed against pto-isa `2c607938`, on an a2a3 device:

```
pytest "tests/st/codegen/test_paged_attention_multi_config.py::TestPagedAttentionMultiConfigKernels::test_paged_attention_multi_config_ptoas[4-16-128-64-1024-2048-16-64]" \
  --device <dev> --pto-isa-commit=2c607938
```

Ring-buffer sweep (env `PTO2_RING_TASK_WINDOW` / `PTO2_RING_DEP_POOL` / `PTO2_RING_HEAP`):

| window/dep_pool/heap | result |
| --- | --- |
| 4 / 4 / 1024 (defaults) | `sched_error_code=100` PTO2_ERROR_SCHEDULER_TIMEOUT |
| 64 / 64 / 8192 | `orch_error_code=2` PTO2_ERROR_HEAP_RING_DEADLOCK |
| 256 / 256 / 65536 | `orch_error_code=2` PTO2_ERROR_HEAP_RING_DEADLOCK |

So larger rings just move the symptom from scheduler-timeout to a persistent heap-ring deadlock.

### Scope (bisected on device)
PASS under #808: hello_world, batch_matmul, basic_ops, broadcast; **basic** paged-attention (`test_paged_attention.py`, all cases incl. full end-to-end); **dynamic** paged-attention (`test_dynamic_paged_attention.py`, incl. batch=4 / dynamic context_len). Only the large fused **multi_config** graph deadlocks.

## Expected Behavior
multi-config paged-attention runs to completion (it passes on the pre-#808 pin `1bd07121`).

## Actual Behavior
```
[ERROR] run: [device_runner.cpp:762] aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
[ERROR] validate_runtime_impl: [runtime_maker.cpp:351] PTO2 runtime failed: orch_error_code=0 sched_error_code=100 runtime_status=-100   # default rings
# or, with larger rings:
[ERROR] validate_runtime_impl: PTO2 runtime failed: orch_error_code=2 sched_error_code=0 runtime_status=-2   # PTO2_ERROR_HEAP_RING_DEADLOCK
```
`run_prepared failed with code 507018`.

## Git Commit ID
Regressor: #808 `f20a8393`. Reproduced at tip `d423e878`. Last-good pin: `1bd07121` (one commit before #808).

## Host Platform
aarch64 Linux; CANN 9.0.0; PTOAS v0.40; pto-isa `2c607938`.

## Additional Context
The pypto-side generated orchestration for multi-config is byte-identical to the pre-#808 (working) case — it uses `.view(shapes, offsets)` and standard kernel dispatch, with no change in the consumer. Suspicion: #808's strided extent/size computation (`extent_elem` vs `numel`) feeding GM heap footprint / free accounting, causing a heap-ring allocate/free cycle that never makes progress for the larger multi-config graph. Codes per `src/a2a3/runtime/tensormap_and_ringbuffer/common/pto_runtime_status.h`.


---

## #834 [Feature] Replace scattered runtime env-var knobs with a structured config API

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/834
- Created: 2026-05-21T07:03:26Z
- Updated: 2026-06-18T09:41:50Z
- Closed: 2026-06-18T09:41:50Z
- Labels: enhancement

### Body

### Summary

The simpler runtime currently exposes its host-side tuning/config knobs only as
individual environment variables, read via scattered `std::getenv` calls in
`runtime_maker.cpp`. Today this includes at least:

| Env var | Meaning | Constraint |
|---|---|---|
| `PTO2_RING_HEAP` | per-ring GM heap size | power-of-2, >= 1024 |
| `PTO2_RING_TASK_WINDOW` | ring task window size | power-of-2, >= 4 |
| `PTO2_RING_DEP_POOL` | dependency pool size | >= 4 |
| `PTO2_READY_QUEUE_SHARDS` | AICPU ready-queue shard count | [1, MAX_AICPU_THREADS] |
| `PTO2_ORCH_TO_SCHED` | orchestrator->scheduler transition flag | bool |

Requesting a more ergonomic, programmatic configuration mechanism (a config
struct / API, or Python-level kwargs/config object) so callers don't have to
export environment variables to tune the runtime.

### Motivation / Use Case

Configuring runtime parameters through environment variables is awkward in
practice:

- **Hard to discover**: the full set of knobs, their valid ranges, and
  power-of-2 constraints are only visible by reading the C++ source; there is no
  single declared schema.
- **Inconvenient to set**: tuning requires `export PTO2_RING_HEAP=...` before
  every run, and per-run or per-callable values can't be expressed cleanly. CI,
  benchmarks, and notebooks all have to wrangle the process environment.
- **Error-prone**: invalid values are silently ignored (warn + fall back to
  default), and there's no typed validation at the call site.
- **Not composable**: you cannot configure two runtimes differently within the
  same process, since env vars are process-global.

A structured config would make these parameters self-documenting, validated at
the API boundary, and settable per-runtime/per-run.

### Proposed API / Behavior

Expose a typed config object that the runtime accepts directly, e.g.:

```python
cfg = RuntimeConfig(
    ring_heap=2048,        # PTO2_RING_HEAP
    ring_task_window=8,    # PTO2_RING_TASK_WINDOW
    ring_dep_pool=8,       # PTO2_RING_DEP_POOL
    ready_queue_shards=4,  # PTO2_READY_QUEUE_SHARDS
    orch_to_sched=True,    # PTO2_ORCH_TO_SCHED
)
runtime.run(callable, args, config=cfg)
```

Suggested behavior:
- Validation (range / power-of-2) raises a clear error instead of silent fallback.
- Precedence: explicit config arg > environment variable > compile-time default,
  so existing env-var usage keeps working for backward compatibility.

### Alternatives Considered

- **Keep env vars only** — current state; the ergonomics problems above remain.
- **Config file (TOML/JSON)** — better than env vars for discoverability, but a
  typed in-process API composes better with existing call sites.

### Additional Context

- Env-var parsing site: `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp`
  (`parse_env_uint64`, ~lines 56, 226-266).
- Related: hw-native-sys/simpler#833 (same GM heap ring subsystem).

---

## #836 [Feature] Generate MindStudio Insight replay traces from kernel args dump

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/836
- Created: 2026-05-21T07:31:32Z
- Updated: 2026-06-05T01:59:46Z
- Closed: 2026-06-05T01:59:46Z

### Body

### Summary

Add a first-class Insight Trace replay workflow that consumes kernel args dump artifacts and generates a MindStudio Insight-compatible simulator trace directory.

The runtime side already has dump producer work, including tensor dump infrastructure and args metadata export. This feature covers the consumer side: take a dump directory, select a target kernel dispatch, reconstruct replay arguments, generate a replay workspace, run `msprof op simulator`, and export the `simulator/` directory that MindStudio Insight can open.

### Motivation / Use Case

When debugging or profiling a single incore kernel, developers need a way to move from an observed runtime execution to an offline replay artifact that can be inspected in MindStudio Insight.

Before this feature, the workflow required manually converting dump output into an `--arg-spec` JSON file. That manual step is error-prone and duplicates information already present in dispatch-level kernel args dumps.

A direct dump-to-replay path would allow developers to:

- Reuse runtime dump artifacts as replay inputs
- Select a specific `func_id` and `dispatch_id`
- Avoid manually writing tensor/scalar arg specs
- Generate a replay workspace for a single `kernel_entry(args)` kernel
- Export a MindStudio Insight-compatible `simulator/` artifact

### Proposed API / Behavior

Add CLI support similar to:

```bash
python -m simpler_setup.tools.insight_trace \
  <test_module> \
  --case <case_name> \
  --func-id <func_id> \
  --dump-dir <dump_output_dir> \
  --dispatch-id <dispatch_id>
```

Expected behavior:

1. Load the scene case and select the target incore kernel by `--func-id`.
2. Read `kernel_args_dump.json` from either:
   - `<dump-dir>/kernel_args_dump.json`
   - `<dump-dir>/tensor_dump/kernel_args_dump.json`
3. Select the dispatch matching both `func_id` and `dispatch_id`.
4. Convert tensor and scalar entries into replay `TraceArg` values.
5. Ignore runtime context slots such as local/global context pointers when generating single-task replay args.
6. Generate the replay workspace and run the existing `msprof op simulator` collect/export path.
7. Print the generated MindStudio Insight input directory:

```text
<workspace>/insight_export/OPPROF_*/simulator/
```

### Relationship to Existing Work

This is the consumer side of the dump pipeline.

Related existing work:

- #506 introduced tensor dump for runtime debugging and validation.
- #641 tracks profiling/diagnostics abstraction cleanup across perf, tensor dump, and PMU.

This issue is related to those diagnostics capabilities, but it does not close them. It adds the offline replay/Insight consumption path on top of dump artifacts.

### Acceptance Criteria

- `simpler_setup.tools.insight_trace` accepts `--dump-dir` and `--dispatch-id` for the simpler backend.
- The CLI requires `--func-id` when `--dump-dir` is used.
- Dispatch-level tensor/scalar args are parsed from `kernel_args_dump.json`.
- Local/global context slots are filtered out for single-task replay.
- Unit tests cover dump arg parsing, context slot filtering, and `func_id + dispatch_id` matching.
- A real paged_attention `CaseSmall1` / `SF` replay can generate a MindStudio Insight-compatible `simulator/` directory.

---

## #837 [Feature] Add per-kernel dispatch args dump for Insight Trace

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/837
- Created: 2026-05-21T07:45:21Z
- Updated: 2026-07-13T09:34:03Z
- Closed: 2026-07-13T09:34:03Z

### Body

## Summary

Follow-up to PR #792: `--dump-args` currently only exports orchestrator-level arguments to `tensor_dump/args_dump.json`.

Downstream Insight Trace needs the actual per-dispatch `kernel_entry(args)` layout for individual incore kernels so it can replay a single kernel dispatch directly.

## Motivation / Use Case

The current `args_dump.json` is useful for orchestration-level inspection, but it is not sufficient to reconstruct one real kernel dispatch such as QK / SF / PV / UP.

Insight Trace needs the finalized args after scheduler payload construction, including the real slot ordering and per-dispatch metadata. Without that, downstream tooling cannot reliably replay one incore kernel from dump artifacts.

## Proposed API / Behavior

Add a separate kernel-level dump artifact, for example:

```text
tensor_dump/kernel_args_dump.json
```

This new dump should:

- keep existing `tensor_dump/args_dump.json` unchanged for compatibility
- capture records after scheduler payload construction, using the actual `kernel_entry(args)` layout
- include per-dispatch identifiers such as:
  - `dispatch_id`
  - `func_id`
  - `task_id`
  - `subtask_id`
  - `core_type`
  - `core_id`
  - `block_idx`
- mark the capture stage as `before_dispatch`
- preserve the real `arg_index` ordering seen by the kernel
- include tensor arg metadata:
  - `dtype`
  - `ndims`
  - `shape`
  - pointer value if needed
- include scalar arg raw values with enough information to distinguish value/bits semantics
- include context pointer args separately from normal tensor/scalar args

A possible top-level schema would group args by dispatch and include:

- `schema_version`
- `total_dispatches`
- `total_args`
- `dispatches[]`

## Alternatives Considered

- Reusing only `args_dump.json`: insufficient, because it reflects orchestration-level arguments rather than real per-kernel dispatch payload layout.
- Reconstructing dispatch args offline from existing dump artifacts: possible only heuristically, and too fragile for downstream replay tooling.

## Additional Context

- Related baseline PR: #792
- PR URL: https://github.com/hw-native-sys/simpler/pull/792
- This issue tracks the functional gap left after #792: orchestrator-level args dump exists, but per-kernel dispatch args dump is still missing for Insight Trace replay.

---

## #838 [Feature] Support partial task selection for tensor dump

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/838
- Created: 2026-05-21T08:05:34Z
- Updated: 2026-05-26T13:14:39Z
- Closed: 2026-05-26T13:14:39Z

### Body

### Summary

Add support for partial task selection in tensor dump, allowing users to dump tensors only for selected tasks instead of dumping tensors for all tasks.

### Motivation / Use Case

Current tensor dump behavior is too coarse-grained when debugging large workloads or long execution graphs. Users often only need tensor data from specific tasks, but enabling tensor dump can produce output for every task. This increases storage usage, slows down debugging, and makes the dump results harder to inspect.

Partial task dump would make tensor debugging more targeted and practical, especially when investigating a specific task, narrowing down incorrect outputs, or reducing dump overhead in large model scenarios.

### Proposed API / Behavior

Tensor dump should support selecting a subset of tasks to dump.

Expected behavior:

- Users can specify one or more target tasks, or specify task ranges.
- Only tensors associated with the selected tasks are dumped.
- Existing full tensor dump behavior remains unchanged when no partial task filter is configured.
- Invalid or unmatched task selectors should produce a clear error or warning.

### Alternatives Considered

The current workaround is to enable full tensor dump and manually filter the generated dump files afterward. This is inefficient and can produce a large amount of unnecessary dump data.

### Additional Context

This feature improves tensor dump usability and reduces dump overhead during focused debugging.

Related: #837, #836

---

## #840 [Bug] CPU sim scheduler times out on slow TMATMUL-heavy kernels before real deadlock timeout

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/840
- Created: 2026-05-21T12:10:11Z
- Updated: 2026-05-25T06:41:45Z
- Closed: 2026-05-25T06:41:45Z
- Labels: bug

### Body

### Platform

a2a3sim (Ascend 910B/C simulation)

### Runtime Variant

tensormap_and_ringbuffer

### Description

`compressor_ratio4.py` fails on `a2a3sim` with `RuntimeError: run_prepared failed with code -100`.

This does not appear to be a functional PTO-ISA deadlock. The failing kernel family (`compressor_ratio4`, `indexer_compressor`, `hc_pre`) emits many `TMATMUL` operations. On PTO-ISA CPU sim, `TMatmulNzZn` is slow enough that an AIC task can run for hundreds of milliseconds. While that task is still making forward progress inside CPU sim, the simpler scheduler sees no completed tasks and increments its idle spin counter quickly. The scheduler then reaches `MAX_IDLE_ITERATIONS = 800000` and reports `PTO2_ERROR_SCHEDULER_TIMEOUT`, which surfaces as `run_prepared failed with code -100`.

The current scheduler comment says the 800000 idle iterations are approximately 20 seconds, but in CPU sim they can elapse much faster than wall-clock time.

### Steps to Reproduce

```markdown
1. Run:

   
   task-submit --device <device_id> --run "export PTOAS_ROOT=<ptoas_bin_dir> && \
   export PTO_ISA_ROOT=<pto_isa_repo> && \
   python models/deepseek/v4/compressor_ratio4.py --platform a2a3sim"
   

2. Observe that execution reaches the runtime phase and fails from `run_prepared`.
```

### Expected Behavior

The kernel should keep running while CPU sim is executing long `TMATMUL` tasks, and the scheduler should only report a timeout after a real continuous no-progress wall-clock timeout, for example 20 seconds.

CPU sim `TMATMUL` should also be fast enough for matmul-heavy kernels to complete in a reasonable time.

### Actual Behavior

The run fails with:

```text
Traceback (most recent call last):
  File "models/deepseek/v4/compressor_ratio4.py", line 497, in <module>
    result = run_jit(
  File "golden/runner.py", line 651, in run_jit
    _execute_via_runner(work_dir, specs, tensors, scalar_specs_eff, runtime_cfg)
  File "golden/runner.py", line 279, in _execute_via_runner
    execute_compiled(work_dir, ordered, **_execute_compiled_kwargs(runtime_cfg))
  File "pypto/runtime/runner.py", line 851, in execute_compiled
    execute_on_device(
  File "pypto/runtime/device_runner.py", line 610, in execute_on_device
    worker.run(cid, orch_args, cfg)
  File "runtime/python/simpler/worker.py", line 1684, in run
    return self._chip_worker.run(int(callable), args, cfg)
  File "runtime/python/simpler/task_interface.py", line 395, in run
    return self._impl.run(int(callable_id), args, config)
RuntimeError: run_prepared failed with code -100
[ERROR] 2026-05-21-19:26:32 (PID:2146739, Device:-1, RankID:-1) ERR99999 UNKNOWN applicaiton exception
```

### Git Commit ID

827fc2784eb9a4cb46493facb7930a427dc527d6

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (aarch64)

### Additional Context

Local investigation points to two contributing issues:

1. The scheduler timeout is iteration-count based instead of wall-clock based. Slow CPU sim tasks can therefore be mistaken for a deadlock.
2. PTO-ISA CPU `TMatmulNzZn` has avoidable overhead: unused `double` conversions, disabled vectorization hint, and CPU sim is built with `PTO_CPU_MAX_THREADS=1`.

Suggested fixes:

- Track the start time of a continuous no-progress period with `get_sys_cnt_aicpu()` and only timeout after the configured wall-clock threshold.
- Optimize `TMatmulNzZn` by removing unused double casts, restoring vectorization, precomputing common NZ/ZN offsets or specializing common layouts.
- Allow CPU sim matmul to use multiple host threads.

---

## #848 [Bug] Track spmd_paged_attention A2/A3 golden tolerance drift

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/848
- Created: 2026-05-22T11:32:04Z
- Updated: 2026-05-25T03:24:00Z
- Closed: 2026-05-25T03:24:00Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

## Summary

`st-onboard-a2a3` can fail in `spmd_paged_attention` because the observed
hardware numerical drift is slightly above the current golden tolerance.

## Failure

Observed in PR #839 CI run `26282368753`, job `st-onboard-a2a3`
(`77361524802`):

```text
FAILED tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention/test_spmd_paged_attention.py::TestPagedAttentionUnrollTpushPop::test_run
AssertionError: Golden mismatch on 'out': max_diff=0.005540801212191582, rtol=0.005, atol=0.005
```

The current test already documents relaxed tolerance for this AIC/AIV
cooperative TPUSH/TPOP pipeline, but the latest onboard run exceeded the
`5e-3` bound by roughly `5.5e-4`.

## Notes

- A targeted follow-up should decide whether to relax this case's tolerance,
  improve the golden comparison strategy, or investigate the hardware numeric
  drift source.


### Steps to Reproduce

```markdown
1. Run the A2/A3 onboard scene tests for `spmd_paged_attention`:

     
     python -m pytest \
       tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention/test_spmd_paged_attention.py \
       --platform a2a3 \
       --device <a2a3-device-range> \
       -v \
       --clone-protocol ssh \
       --require-pto-isa

  2. Observe that TestPagedAttentionUnrollTpushPop::test_run may fail golden
     comparison with output drift slightly above the current tolerance.

  Observed in CI:

  AssertionError: Golden mismatch on 'out':
  max_diff=0.005540801212191582, rtol=0.005, atol=0.005
```

### Expected Behavior

  A2/A3 onboard `spmd_paged_attention` should pass golden comparison; output
  difference should stay within the configured tolerance rtol=0.005, atol=0.005,
  or the test tolerance/golden strategy should cover expected BF16 hardware drift.

### Actual Behavior

  `TestPagedAttentionUnrollTpushPop::test_run` fails golden comparison on A2/A3
  onboard hardware.

  Observed failures:
  - first run: max_diff=0.005348655860871077, rtol=0.005, atol=0.005
  - retry with pinned PTO-ISA: max_diff=0.005540801212191582, rtol=0.005, atol=0.005

### Git Commit ID

CI merge commit: 27ad98b59e14f583daf141feab79723f8b8a4989; PR head commit: 75d9d737e45df5ebfa6e7fc5a86b2afa2d4e2e74

### CANN Version

9.0.0

### Driver Version

_No response_

### Host Platform

Linux (aarch64)

### Additional Context

_No response_

---

## #849 [Performance] Orchestration taking most of the running time

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/849
- Created: 2026-05-22T12:24:19Z
- Updated: 2026-06-24T11:24:35Z
- Closed: 2026-06-24T11:24:35Z
- Labels: performance

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

For:

examples/a2a3/tensormap_and_ringbuffer/vector_example/test_vector_example.py

We profiled the main activities of the AICPU cores:

<img width="3482" height="382" alt="Image" src="https://github.com/user-attachments/assets/7bec0d89-2069-471c-bc7f-cf384005e3f1" /> (timeline produced by Noah Baumann using TracR+Perfetto )

- Initialization (green)
- DLL_loading (light lilac)
- Orchestration (pink)
- Scheduling (lilac)
- Deinitializing (light green)

We find the following
- DLL_loading takes a non-trivial amount of time. Other solutions, like JIT (static or dynamic) compiling the orchestration functions could help alleviate this cost.
- Orchestration (maybe building the initial graph?) is taking by far the longest time.
- Scheduling takes very little time. This might be because the operation itself is very small, but still is noticeably small
- Deinitialization also takes some time

The most urgent thing, in my opinion, is looking into why orchestration takes so long.



### Git Commit ID

d423e878c960e5dd3c5b65aeba5f8a82fda88e96

### CANN Version

9.0.0

### Driver Version

25.5.1

### Host Platform

Linux (aarch64)

### Reproduction

```bash
python examples/a2a3/tensormap_and_ringbuffer/vector_example/test_vector_example.py -p a2a3
```

### Expected Performance

No pre-existing expectations.

### Actual Performance

For the orchestrator thread:

231us Initialization
750us DLL_loading
9900us Orchestration
3050us Deinitialization

For one of the scheduling threads:
200us - 240us Initialization
100us - 170us Scheduling

### Profiling Data (Optional)

The timeline is shown above.

### Additional Context

_No response_

---

## #851 [Feature] Scheduler: avoid dispatching MIX task to a core group whose AIV is already occupied

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/851
- Created: 2026-05-25T02:07:40Z
- Updated: 2026-06-22T07:03:51Z
- Closed: 2026-06-22T07:03:51Z
- Labels: enhancement

### Body

### Summary

In the a2a3 `tensormap_and_ringbuffer` runtime, when an AIV core in a 1C2V cluster is already executing a task, the scheduler should **not** dispatch a MIX task to that AIV's core group. The MIX task would conflict with the in-flight AIV task because it requires both the AIC and both AIVs of the group.

### Motivation / Use Case

Observed while iterating on `models/deepseek/v4/moe.py`. A MIX task was dispatched to a core group whose AIV slot was already occupied by an earlier AIV-only task, producing a conflict (screenshot to be attached).

The current scheduler appears to admit a MIX task into a group based on AIC availability without checking that **all** AIVs in the group are free. Because MIX requires the entire 1C2V cluster, partial-occupancy AIV state must be considered before MIX admission.

Without this guard, mixed AIV-only + MIX workloads on the same cluster (e.g. MoE pipelines that interleave vector-only and mix kernels) can hit hard-to-diagnose dispatch conflicts.

### Proposed API / Behavior

MIX-queue admission check should be tightened from "AIC group free" to "AIC free **AND** every AIV in the same group free." Concretely, when picking a target group for a MIX task, the scheduler must consult the per-AIV occupancy state in addition to the group/AIC state, and skip groups where any AIV is currently running an AIV-only task.

Equivalently, AIV-only dispatch should reserve the AIV slot in a way that MIX admission can observe before it reserves the cluster.

### Alternatives Considered

- **User-side serialization** (insert a barrier so AIV-only tasks drain before MIX): pushes scheduler responsibility onto kernel authors and gives up overlap that is otherwise legal.
- **Always reserve full cluster for AIV-only tasks**: loses AIV parallelism for vector-only workloads.

### Additional Context

- Repro source: `models/deepseek/v4/moe.py` (current `moe_rewrite` branch)
- Runtime: `src/a2a3/runtime/tensormap_and_ringbuffer`
- Related (closed): hw-native-sys/simpler#441 — MIX reserve-then-release for sync-start SPMD. This issue is a refinement of MIX admission policy for the non-sync-start case where AIV-only and MIX tasks coexist.
- Screenshot of the observed dispatch conflict will be attached via GitHub web UI.

---

## #853 [Bug] Runtime static arena allocation is too large and causes pypto-lib CPU sim CI to fail

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/853
- Created: 2026-05-25T07:18:46Z
- Updated: 2026-05-26T02:43:16Z
- Closed: 2026-05-26T02:41:14Z
- Labels: bug

### Body

### Platform

a2a3sim (Ascend 910B/C simulation)

### Runtime Variant

tensormap_and_ringbuffer

### Description

After simpler commit `324df3d6557b0c6571a3ff3d170675324df0fa1c` (`Refactor: collapse trb runtime init memory into a single DeviceArena (#835)`), pypto-lib CPU sim CI can fail during runtime initialization because the runtime attempts to allocate a very large pooled static arena in one `malloc`.

This affects pypto-lib CI for large model tests such as `models/qwen3/14b/decode_layer.py`. Compile, input generation, and golden computation finish successfully, but runtime setup fails before execution.

The failure is caused by the new static arena setup path combining GM heap and PTO2 shared memory into one backing allocation.

### Steps to Reproduce

```markdown
1. Run pypto-lib CI CPU sim for `models/qwen3/14b/decode_layer.py` on GitHub hosted `ubuntu-latest`.
2. Use the CI ring settings:

   
   PTO2_RING_DEP_POOL: 1048576
   PTO2_RING_TASK_WINDOW: 1048576
   PTO2_RING_HEAP: 4294967296
   

3. Use pypto with simpler/runtime submodule at:

   
   324df3d6557b0c6571a3ff3d170675324df0fa1c
   

4. Observe failure during runtime initialization.
```

### Expected Behavior

CPU sim CI should complete successfully, or the runtime should avoid requiring a single approximately 28 GiB static allocation for this configuration.

If the requested ring settings are too large for the host, the runtime should fail early with a clear capacity/configuration error before attempting a huge allocation.

### Actual Behavior

Runtime initialization attempts to allocate about 29.7 GB and fails:

```text
[RUN] compile ...
2026-05-25 07:02:07.496 I | [perf_hint] 41 hints across 17 sites; see build_output/_jit_test_decode_layer_20260525_070207/report/perf_hints.log
[RUN] compile done (6.50s)
[RUN] generate inputs ...
[RUN] generate inputs done (10.45s)
[RUN] compute golden ...
[RUN] compute golden done (2.12s)
[RUN] runtime ...
Error: [ERROR] alloc: [memory_allocator.cpp:27] malloc failed (size=29695674175)
Error: [ERROR] bind_prepared_to_runtime_impl: [runtime_maker.cpp:283] Failed to setup pooled static arena
[RUN] runtime done (29.31s)
RuntimeError: run_prepared failed with code -1
Error: FAIL
FAILED: models/qwen3/14b/decode_layer.py
```

The allocation size matches the new pooled static arena calculation:

```text
PTO2_RING_HEAP = 4294967296
PTO2_MAX_RING_DEPTH = 4

GM heap = 4 GiB * 4 = 16 GiB
PTO2 shared memory ~= 1048576 slots * 4 rings * ~2984 bytes = 11.66 GiB
Total ~= 27.66 GiB
```

### Git Commit ID

324df3d6557b0c6571a3ff3d170675324df0fa1c

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (aarch64)

### Additional Context

This appears to be introduced by simpler commit:

```text
324df3d6557b0c6571a3ff3d170675324df0fa1c
Refactor: collapse trb runtime init memory into a single DeviceArena (#835)
```

`git log -S "Failed to setup pooled static arena"` and `git log -S "setup_static_arena"` both point to this commit.

pypto currently pulls this simpler commit through its `runtime` submodule. As a result, pypto-lib CI CPU sim can fail even though the same test may pass locally on machines with more memory or different `PTO2_RING_*` settings.

---

## #860 [Question] Tensor dump cannot keep up with moderately-sized kernel workloads (paged_attention 64bat/8192ctx) — host collector drain becomes a kernel-hang root cause

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/860
- Created: 2026-05-26T06:34:14Z
- Updated: 2026-06-05T01:52:24Z
- Closed: 2026-06-05T01:52:24Z
- Labels: enhancement, question

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

When `enable_dump_tensor=True` is used on a moderately-sized kernel
(paged_attention SPMD, 64 batch × 8192 ctx), the run reliably fails
with device error codes `507017` / `507018` / `507046` after some
seconds. Diagnosis indicates the host-side dump collector PCIe drain
rate cannot keep up with the device-side AICPU dump production rate;
AICPU back-pressures on the dump arena and gets STARS-killed once
`PLATFORM_OP_EXECUTE_TIMEOUT_US` elapses. The same kernel runs to
completion with dump disabled.

Looking for guidance: are users expected to scale down the test case
when they need dumps at this scale, or should the dump pipeline adapt?

### Steps to Reproduce

1. Build a moderately-sized kernel through pypto. In our case:
   `paged_attention_spmd_64bat_64h_256d_64bs_8192ctx` — 8 tensor
   bindings (largest 2 × 1 GB), block_dim=24, 4 AICPU threads,
   heap=4 GB, task_window=131072.
2. Run the debug replay with `enable_dump_tensor=True` (equivalent to
   `RunConfig(enable_dump_tensor=True)` in the user-facing API).
3. Observe a device error after a few seconds.

### Expected Behavior

Either:
- The dump completes and the kernel finishes normally (preferred), or
- A clearer "dump capacity exceeded — drop to selective dump"
  diagnostic surfaces *before* the device-side op-timeout kill.

### Actual Behavior

#### Run A — default `platform_config.h`

Config:
```
PLATFORM_OP_EXECUTE_TIMEOUT_US     = 1_000_000   (1 s)
PLATFORM_STREAM_SYNC_TIMEOUT_MS    = 2_000       (2 s)
PLATFORM_DUMP_AVG_TENSOR_BYTES     = 65_536
PLATFORM_DUMP_BUFFERS_PER_THREAD   = 8
=> dump arena: 128 MB/thread × 4 threads = 512 MB
```

Log excerpt:
```
WARN process_dump_buffer: Tensor dump truncation detected.
     Increase PLATFORM_DUMP_AVG_TENSOR_BYTES.
ERROR run: Stream sync timeout: stream=AICPU timeout_ms=2000
INFO on_buffer_collected: Collecting: 1280 tensors, 9.5 GB written (227 s)
RuntimeError: run_prepared failed with code 507046
```

Effective collector drain rate: 9.5 GB / 227 s ≈ **42 MB/s**.

#### Run B — tuned `platform_config.h` (raised timeouts + arena)

Config:
```
PLATFORM_OP_EXECUTE_TIMEOUT_US     = 60_000_000  (60 s)
PLATFORM_STREAM_SYNC_TIMEOUT_MS    = 600_000     (10 min)
PLATFORM_DUMP_AVG_TENSOR_BYTES     = 1_048_576   (1 MB)
PLATFORM_DUMP_BUFFERS_PER_THREAD   = 16
PLATFORM_DUMP_TIMEOUT_SECONDS      = 300
=> dump arena: 4096 MB/thread × 4 threads = 16 GB
```

Log excerpt:
```
INFO aclrtSetOpExecuteTimeOutV2: requested=60000000 us, actual=60129542 us
INFO Tensor dump initialized: 4 threads, arena=4096 MB/thread, 16 buffers/thread
INFO === aclrtSynchronizeStreamWithTimeout stream_aicpu_ ===
[~77 s elapsed, no truncation warning, no stream-sync-timeout branch hit]
ERROR aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507017
```

Notable: no truncation warning, and the host-side `Stream sync timeout:
…` log line was *not* hit. The 77 s wait + return code 507017 (not
`ACL_ERROR_RT_STREAM_SYNC_TIMEOUT`) matches STARS killing the AICPU op
after `OP_EXECUTE_TIMEOUT_US = 60 s` while it was back-pressured on
dump buffers.

#### Run C — same case, dump disabled

Runs to completion successfully.

### Git Commit ID

324df3d6557b0c6571a3ff3d170675324df0fa1c

### Host Platform

Linux (aarch64)

### Additional Context

#### Analysis

- Arena size only delays *when* the per-thread ring fills; it does not
  change the steady-state imbalance between AICPU dump production and
  host PCIe consumption.
- At ~42 MB/s drain, this case's ~9.5 GB payload needs >220 s just to
  land on host. Any per-op timeout shorter than that is hit while
  AICPU is back-pressured.
- Raising `PLATFORM_OP_EXECUTE_TIMEOUT_US` globally to mask the
  problem is a hammer that also hides real hangs in non-dump runs.

#### Question for maintainers

What is the intended workflow for tensor-dumping at this scale?

1. **Scale down**: are users expected to shrink the test case (smaller
   batch / shorter context) whenever they need dumps? Is there a
   documented "max dump-friendly case size"?
2. **Pipeline adapts**: would you be open to changes in any of these
   directions?
   - **Per-tensor / per-task dump filter** so users can opt-in for a
     subset (today `enable_dump_tensor` is all-or-nothing)
   - **Async / larger PCIe writeback path** to raise the ~42 MB/s
     collector drain ceiling
   - **Dump-aware op timeout** (longer when dump is enabled, default
     otherwise) so the non-dump path stays strict
3. Any combination of the above?

Happy to test patches or contribute the per-tensor filter route if it
matches the direction the maintainers prefer.

#### Environment notes

- CANN version: not captured (collect_env path warns about ownership
  mismatch on this host)
- Driver version: `npu-smi info` unavailable on this host
  (`DrvMngGetConsoleLogLevel failed`, `dcmi module initialize failed
  ret=-8005`)
- Reproducible on device 4 of the test machine

---

## #868 [Feature] Dump all scheduler thread stall state before emergency shutdown

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/868
- Created: 2026-05-27T05:02:39Z
- Updated: 2026-05-30T02:00:34Z
- Closed: 2026-05-29T01:40:24Z

### Body

### Summary

Add a shutdown-time scheduler diagnostic snapshot before
`tensormap_and_ringbuffer` calls `emergency_shutdown()` on scheduler timeout.

The snapshot should reuse the existing `log_stall_diagnostics()` machinery to
dump all active scheduler threads, not only the thread that first reaches
`MAX_IDLE_ITERATIONS`.

### Motivation / Use Case

When one scheduler thread times out, the current log only guarantees a final
stall dump for the triggering thread. Other scheduler threads may have printed
older half-time stall diagnostics, but their exact state immediately before
emergency shutdown is missing.

This makes timeout diagnosis ambiguous. For example, in a paged-attention
unroll debug run, `thread1` triggered:

```text
[STALL thread=1 idle_iterations=800000] TIMEOUT_EXIT after_idle_iterations=800000
Emergency shutdown: sending exit signal to all initialized cores
```

The log showed `thread1` cores stuck on `kernel=2` with AIC COND state `ack`,
while AIV cores were idle. However, the shutdown-time state of `thread0` and
`thread2` was not printed; only older `idle_iterations=400000` diagnostics were
available. A final all-thread snapshot would make it clear whether other
threads were still making progress, also stalled, or blocked behind the same
dependency chain.

### Proposed API / Behavior

On the first scheduler timeout path, before calling `emergency_shutdown()`,
print a one-time shutdown snapshot:

```text
[SHUTDOWN_SNAPSHOT trigger_thread=1 reason=scheduler_timeout idle_iterations=800000] dumping all scheduler threads before emergency shutdown
[STALL thread=0 idle_iterations=800000] TASK ...
[STALL thread=0 idle_iterations=800000] SUMMARY ...
[STALL thread=0 idle_iterations=800000] CLUSTER ...
[STALL thread=1 idle_iterations=800000] CLUSTER ...
[STALL thread=2 idle_iterations=800000] CLUSTER ...
Emergency shutdown: sending exit signal to all initialized cores
```

Suggested implementation:

- Add a cold-path wrapper such as `log_shutdown_stall_snapshot(...)`.
- The wrapper loops over `active_sched_threads_` and calls the existing
  `log_stall_diagnostics(t, total_tasks_, trigger_idle_iterations,
  trigger_last_progress_count)`.
- Call the wrapper from `handle_timeout_exit()` after `completed_.exchange(...)`
  succeeds and before `emergency_shutdown(runtime)`.
- Keep the snapshot best-effort; do not add a cross-thread barrier or wait for
  other scheduler threads to stop.
- Preserve the existing `log_stall_diagnostics()` format so existing grep
  workflows continue to work.

The only semantic compromise in the minimal version is that the
`idle_iterations` printed for every thread would be the trigger thread's count,
not each thread's private local counter. That is acceptable for the initial
diagnostic enhancement because the important core/task/COND state is read live
at snapshot time. If exact per-thread idle counts become necessary later, that
can be added via separate per-thread diagnostic counters.

### Alternatives Considered

- Add per-thread diagnostic counters first. This would make the printed idle
  counts exact, but it touches the scheduler loop and is not necessary for the
  first version.
- Print diagnostics after `emergency_shutdown()`. This is less useful because
  shutdown writes exit signals and deinitializes AICore register blocks, so COND
  state no longer represents the failure site.
- Add synchronization before printing. This risks making the fatal diagnostic
  path more fragile and should be avoided.

### Additional Context

Observed while analyzing:

```bash
task-submit --device auto --run "python tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_unroll/test_paged_attention_unroll.py --device {} --platform a2a3 --enable-l2-swimlane --log-level v0"
```

Relevant files:

- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_dispatch.cpp`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_context.h`

Related: #831, #860


---

## #884 [Bug] Dynamic Register/Unregister Instability In A2A3 Sim CI

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/884
- Created: 2026-05-28T08:45:14Z
- Updated: 2026-05-30T01:06:33Z
- Closed: 2026-05-30T01:06:33Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

#839  introduced dynamic post-init callable register/unregister coverage under:

```text
tests/st/a2a3/tensormap_and_ringbuffer/dynamic_register/test_dynamic_register.py
```

The dynamic register/unregister path is still unstable in #861 CI. Two PR861
CI runs exposed failures in the same dynamic-register ST file on the same CI
job family:

1. PR861 CI #2723
   - Run: https://github.com/hw-native-sys/simpler/actions/runs/26559663566
   - Job: https://github.com/hw-native-sys/simpler/actions/runs/26559663566/job/78239340891
   - Job name: `st-sim-a2a3 (ubuntu-latest, 3.10)`
   - Environment: Ubuntu hosted runner, Python 3.10.20, pytest 9.0.3
   - Failing test:
     `test_register_after_init_parallel_broadcast`
   - Failure signature: `rc=-11`, Python segmentation fault in
     `simpler/worker.py`, line 2369, during `worker.run(...)`.

2. PR861 CI #2749
   - Run: https://github.com/hw-native-sys/simpler/actions/runs/26575577396
   - Job: https://github.com/hw-native-sys/simpler/actions/runs/26575577396/job/78293886852
   - Job name: `st-sim-a2a3 (ubuntu-latest, 3.10)`
   - Environment: Ubuntu hosted runner, Python 3.10.20, pytest 9.0.3
   - Failing test:
     `test_register_unregister_register_runs_each_time`
   - Failure signature: pytest session timeout after 600s; scheduler reported
     the standalone test as hung for 490.1s; process exited with code 124.

These are not the same exact failure signature: CI #2723 failed with a
segmentation fault in the two-device parallel dynamic-register case, while CI
#2749 passed that case and instead hung in the single-device
unregister/re-register reuse case. They should still be tracked together as a
PR839 dynamic register/unregister stability issue because both failures occur in
the same feature area and the same ST file.


### Steps to Reproduce


Run PR861 CI on the `host-device_mapped-region` branch with the standard CI
workflow and inspect the Ubuntu A2A3 simulation ST job:

```text
CI / st-sim-a2a3 (ubuntu-latest, 3.10)
```

The relevant full CI invocations were:

```text
PR861 CI #2723:
https://github.com/hw-native-sys/simpler/actions/runs/26559663566

PR861 CI #2749:
https://github.com/hw-native-sys/simpler/actions/runs/26575577396
```

For local focused reproduction, run the dynamic-register ST cases on A2A3 sim:

```bash
pytest tests/st/a2a3/tensormap_and_ringbuffer/dynamic_register/test_dynamic_register.py \
  --platform a2a3sim --device 0-1 -p no:xdist --pto-session-timeout 600
```

The two observed failing standalone cases can also be targeted directly:

```bash
pytest tests/st/a2a3/tensormap_and_ringbuffer/dynamic_register/test_dynamic_register.py::test_register_after_init_parallel_broadcast \
  --platform a2a3sim --device 0-1 -p no:xdist --pto-session-timeout 600

pytest tests/st/a2a3/tensormap_and_ringbuffer/dynamic_register/test_dynamic_register.py::test_register_unregister_register_runs_each_time \
  --platform a2a3sim --device 0 -p no:xdist --pto-session-timeout 600
```

Because the failures appear intermittent, a single local run may pass. Looping
these focused cases is likely needed to reproduce the instability.


### Expected Behavior

Dynamic post-init register and unregister should be deterministic and safe in
A2A3 simulation:

- `test_register_after_init_parallel_broadcast` should successfully broadcast a
  post-init `CTRL_REGISTER` to both chip children, return only after each child
  has prepared the callable, and then run the dynamically registered cid on
  both chips without crashing.
- `test_register_unregister_register_runs_each_time` should successfully run a
  dynamically registered cid, unregister it, reuse the freed cid slot on a
  subsequent register, and run the re-registered callable without hanging.
- The full `st-sim-a2a3 (ubuntu-latest, 3.10)` CI job should complete without
  segfaults, hangs, or session-level timeouts.

### Actual Behavior

Observed in PR861 CI #2723:

```text
[scheduler] START standalone test_register_after_init_parallel_broadcast
(rt=tensormap_and_ringbuffer, dev=2) pid=8668 devices=[6, 10]

standalone test_register_after_init_parallel_broadcast
(rt=tensormap_and_ringbuffer, dev=2) [FAIL rc=-11 57.8s, devices=[6, 10]]

tests/st/a2a3/tensormap_and_ringbuffer/dynamic_register/
test_dynamic_register.py Fatal Python error: Segmentation fault

File ".../site-packages/simpler/worker.py", line 2369 in run
File ".../dynamic_register/test_dynamic_register.py", line 234
in test_register_after_init_parallel_broadcast

Process completed with exit code 1.
```

Observed in PR861 CI #2749:

```text
[scheduler] START standalone test_register_after_init_parallel_broadcast
(rt=tensormap_and_ringbuffer, dev=2) pid=8857 devices=[6, 10]

standalone test_register_after_init_parallel_broadcast
(rt=tensormap_and_ringbuffer, dev=2) [PASS 21.4s, devices=[6, 10]]

[scheduler] START standalone test_register_unregister_register_runs_each_time
(rt=tensormap_and_ringbuffer, dev=1) pid=9389 devices=[8]

[pytest] TIMEOUT: session exceeded 600s (10min) limit

HUNG standalone test_register_unregister_register_runs_each_time
(rt=tensormap_and_ringbuffer, dev=1) pid=9389 devices=[8]
elapsed=490.1s descendants=[9565, 9566]

Process completed with exit code 124.
```

This indicates that the PR839 dynamic register/unregister path can fail in at
least two ways under CI load: a post-register `worker.run(...)` segfault in the
two-device broadcast case, and a hang in the unregister/re-register cid reuse
case.


### Git Commit ID

825f0fd4a053e6864424ac537f206ad6fd9176b5

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (x86_64)

### Additional Context

_No response_

---

## #897 [Bug] Idle scheduler thread independently latches PTO2_ERROR_SCHEDULER_TIMEOUT, causing fatal cascade in distributed runs

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/897
- Created: 2026-05-29T07:51:13Z
- Updated: 2026-05-31T06:42:07Z
- Closed: 2026-05-31T06:42:07Z
- Labels: bug

### Body


# Platform

a2a3 (Ascend 910B/C hardware)

# Runtime Variant

tensormap_and_ringbuffer

# Description

In a multi-rank distributed run where only a subset of scheduler threads have local work, an **idle** scheduler thread (one whose owned clusters have no `RUNNING` tasks) can still reach `MAX_IDLE_ITERATIONS` (~92 ms) and latch `PTO2_ERROR_SCHEDULER_TIMEOUT` (100). The other scheduler threads (including the one that legitimately owns the in-progress task) then observe this in `handle_orchestrator_exit` and abort, producing a fatal `runtime_status=-100` even though the actual work was making progress.

This is most easily triggered when inter-rank startup skew approaches the local idle budget — e.g. when `PTO2_RING_HEAP` is set to a large value, host-side `device_malloc` tail-latency becomes a significant fraction of 92 ms.

# Steps to Reproduce

1. Build pypto + simpler runtime on Ascend 910B/C hardware
2. Run the distributed allreduce smoke test (or any 2-rank, single-task distributed workload):

```bash
export PTO2_RING_HEAP=4294967296          # 4 GiB per ring → 16 GiB total device_malloc
export PTO2_RING_TASK_WINDOW=131072       # optional; amplifies effect
export PTO2_RING_DEP_POOL=131072          # optional; amplifies effect
python -m pytest tests/st/distributed/test_l3_allreduce.py --device "<2 npu ids>" -v
```

3. Repeat 20+ times. Observe intermittent failures (~10–25% rate).

Reduced reproducer: ablation showed `PTO2_RING_HEAP=4294967296` alone is sufficient (~5% failure rate on 20 rounds).

# Expected Behavior

The scheduler timeout should fire only when there is genuine deadlock or stall on a task the thread is responsible for. A thread whose local clusters have no `RUNNING` tasks should not be able to declare global fatal status.

# Actual Behavior

A scheduler thread with no local work spins to 800k idle iterations (~92 ms wall on this build), calls `handle_timeout_exit`, and writes `sched_error_code = 100` to shared memory. Sibling threads see this in their next `handle_orchestrator_exit` call and abort. Host then sees:

```
[device_runner.cpp:800] aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
[runtime_maker.cpp:360] PTO2 runtime failed: orch_error_code=0 sched_error_code=100 runtime_status=-100
```

## Evidence: device log timing (round 12, failing)

Rank A device-4 vs Rank B device-5, AICPU cycle counter (≈50 MHz, 1 cycle ≈ 20 ns):

| Event | Rank A (dev=4, failing) | Rank B (dev=5) | Δ |
|---|---|---|---|
| Thread 3 orch_start | 38968757553362 | 38968767365105 | **+196 ms** |
| Thread 0 sched_start | 38968757553361 | 38968767365108 | +196 ms |
| Thread 1 sched_start | 38968757553359 | 38968767365105 | +196 ms |
| Thread 2 sched_start | 38968757553362 | 38968767365112 | +196 ms |

Rank A's failing thread:

```
[scheduler_cold_path.cpp:267] [STALL thread=0 idle_iterations=400000]
  TASK ring=1 task_id=4294967296 state=RUNNING fanin_refcount=1/1
  kernels=[aic:-1 aiv0:0 aiv1:-1] running_on=[owner_thread=1 cores=[core=26(aiv0)]]
[scheduler_cold_path.cpp:295] [STALL thread=0 idle_iterations=400000]
  SUMMARY completed=0/1 last_progress_iteration=0 scan_ready=0 scan_waiting=0 scan_running=1
[scheduler_cold_path.cpp:340] [STALL thread=2 idle_iterations=800000]
  TIMEOUT_EXIT after_idle_iterations=800000
[scheduler_cold_path.cpp:67] Thread 0: Scheduler fatal error detected (code=100)
```

Per-thread summary (same round):

| Thread | role | exit path | sched_cost | loops | own work completed? |
|---|---|---|---|---|---|
| 3 (orch) | orchestrator | normal completion | 31.4 µs | — | yes (wiring done in 31 µs) |
| 0 (sched) | idle peer (no local task) | reads `sched_err=100` in `handle_orchestrator_exit` → exits | 92.59 ms | 748,553 | n/a — never had a task |
| 1 (sched, **task owner** of core 26) | actively polling its core for the RUNNING task | reads peer-set `completed_=true` → exits | 92.58 ms | 391,608 | **no — task still `state=RUNNING`** at exit |
| 2 (sched, **idle peer**) | no local task | **TIMEOUT** at MAX_IDLE_ITERATIONS → latches `sched_err=100` | 196.34 ms | 800,000 | n/a — never had a task |

Critical detail: thread 1 (the only thread with a real task) did **not** time out — it was actively making progress (polling its assigned core). Yet it was forced to exit because thread 2 (a thread with **no local work**, only idle-spinning) declared global fatal first. The TASK STALL line above confirms the task was still `state=RUNNING` at the moment thread 2 latched the timeout, with `completed=0/1`. The work had been correctly dispatched and was waiting only for Rank B's `notify` — it never got the chance to complete.

The `sched_end` log line (no `(timeout)` suffix) on threads 0 and 1 is misleading: it does not mean their work finished, only that they did not personally trip `MAX_IDLE_ITERATIONS`. Both were terminated by thread 2's cascade.

## Evidence: pass vs fail correlation with inter-rank skew

20-round run with all three ring envs enabled (default `aicpu_thread_num=4`):

| Round | Result | Leading rank | Δ (rank skew) | Leading rank sched_cost | Trailing rank sched_cost |
|---|---|---|---|---|---|
| 1 | PASS | dev5 | 30 ms | 29.79 ms | 56 µs |
| 2 | PASS | dev4 | 30 ms | 30.31 ms | 58 µs |
| 12 | FAIL | dev4 | **196 ms** | 196.34 ms (timeout) | 59 µs |

Passing rounds: leading rank waits ~30 ms (well below 92 ms budget). Failing round: skew exceeds budget. The 92 ms boundary equals `MAX_IDLE_ITERATIONS × per-iter cost` exactly.

## Evidence: env-var ablation (20 rounds each)

| Configuration | PASS/FAIL |
|---|---|
| baseline (no env override) | 30 / 0 (0%) |
| `PTO2_RING_HEAP=4294967296` only | 19 / 1 (5%) |
| `PTO2_RING_TASK_WINDOW=131072` only | 20 / 0 (0% at n=20) |
| `PTO2_RING_DEP_POOL=131072` only | 20 / 0 (0% at n=20) |
| all three | 9 / 41 fail across 50 rounds (~18%) |

`PTO2_RING_HEAP` dominates because it adds host-side `device_malloc(16 GiB)` to the critical path, which has long-tail variance. `TASK_WINDOW` and `DEP_POOL` only amplify AICPU-side init loops, which are deterministic and symmetric across ranks.

## Evidence: causality validated by rebuild

Modified `runtime/scheduler/scheduler_types.h:46` to set `MAX_IDLE_ITERATIONS = 8000000` (10×, giving ~920 ms wall-clock budget instead of ~92 ms) and rebuilt via `pip install --no-build-isolation ./runtime`. Re-ran the same 30-round campaign with all three ring envs unchanged:

| Configuration | Runtime | PASS/FAIL |
|---|---|---|
| All three envs | `MAX_IDLE_ITERATIONS = 800000` (default) | 9 / 41 across 50 rounds (~18%) |
| All three envs | `MAX_IDLE_ITERATIONS = 8000000` (rebuild) | **30 / 0 (0%)** |

A single-variable change (one constexpr from 800000 to 8000000, everything else identical) eliminates the failure completely. This pins the threshold as the binding constraint and removes any ambiguity about whether ring envs themselves introduce a separate correctness bug.

Round-duration distribution after the rebuild: median 11 s, max 23 s. The longest round corresponds to a particularly large rank-startup skew, comfortably absorbed by the wider budget. This also indicates the proposed wall-clock-based fix needs a budget on the order of seconds — not microseconds — to cover realistic distributed-launch tail latency.

## Evidence: per-iter cost is NOT affected by these envs

`MAX_IDLE_ITERATIONS=800000` is a constant; comment claims `~20s idle` but actual is **~92 ms** wall — per-iter cost is roughly constant (~115 ns) regardless of ring sizes. The idle hot path does not iterate over `task_window_size` / `dep_pool_size` / `heap_size`:

- Only loop using `ring->task_window_size` is `PTO2SchedulerState::RingSchedState::init` (one-time init, [`runtime/scheduler/pto_scheduler.cpp:109`](src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/pto_scheduler.cpp#L109))
- `log_stall_diagnostics` ([`scheduler_cold_path.cpp:226`](src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp#L226)) scans `ring.fc.current_task_index` (= submitted task count, here 1), not `task_window_size`
- Idle loop body: `completed_.load()` + `tracker.has_any_running_cores()` + `async_wait_list.count > 0` short-circuit + scalar bookkeeping — all O(1)

# Git Commit ID

324df3d6557b0c6571a3ff3d170675324df0fa1c (pypto submodule pin)

# CANN Version

cann-9.0.0

# Driver Version

Not captured (`npu-smi` not accessible from this account).

# Host Platform

Linux (aarch64)

# Additional Context

## Root cause

[`runtime/scheduler/scheduler_cold_path.cpp:66-73`](src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp#L66-L73) latches `sched_error_code` to the shared header whenever **any** thread hits `MAX_IDLE_ITERATIONS`, and `handle_orchestrator_exit` propagates this to all sibling threads, killing the whole runtime. There is no check that the timing-out thread was actually responsible for an in-progress task — purely-idle threads (no `RUNNING` task in their clusters) can declare global fatal.

This is logically inverted: an idle thread with nothing to wait for should be the **last** to declare a hang, not the first.

The device log evidence above demonstrates this directly: the thread that actually owned the running task (thread 1) was making correct progress (polling its core for completion of a task that was legitimately still waiting on a remote `notify`). The thread that declared fatal (thread 2) had no local task at all — it was monitoring clusters with nothing dispatched. Yet thread 2's timeout was treated as global. After the latch, thread 1 read `sched_err=100` from shared memory in its very next `handle_orchestrator_exit` call and exited while its task was still `state=RUNNING, completed=0/1`.

## Proposed fixes (in order of invasiveness)

1. **Minimal**: In `handle_timeout_exit`, before calling `latch_scheduler_error`, check whether `thread_idx` owns any core with `running_slot_state != nullptr`. If not, skip the latch — let a thread that actually has a stuck task report the fatal.

2. **Cleaner**: Convert per-thread timeout into a barrier. Each thread increments a shared `threads_at_idle_limit` counter when it hits `MAX_IDLE_ITERATIONS`; only the last thread (counter == `sched_thread_num`) calls `latch_scheduler_error`. This correctly distinguishes "one thread idle while another makes progress" (counter never reaches max) from "true global hang" (all threads idle out).

3. **Best, addresses both this bug and the misleading comment**: Replace iteration-count timeout with wall-clock timeout. Sample `get_sys_cnt_aicpu()` every N idle iterations and compare against a configurable wall-clock budget (e.g. `PTO2_SCHED_TIMEOUT_MS`, default 5000). Update the comment `// ~20s idle then scheduler gives up` which is currently off by ~200×.

## Reproduction artifacts

- Per-round host logs and device logs are archived locally and can be attached on request:
  - `device_logs/round_{1,2,5,7,11,12,16}/debug/device-{4,5}/device-*.log`
  - Pass + fail round pairs from the same env configuration to control for non-skew factors

## Related observations (not part of this bug but worth noting)

- `PTO2_SCOPE_TASKS_CAP` ([`pto_runtime2_types.h:116`](src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2_types.h)) is a compile-time constant `PTO2_TASK_WINDOW_SIZE × PTO2_MAX_RING_DEPTH = 65536`. When `PTO2_RING_TASK_WINDOW` is env-overridden above the compile-time default, this cap no longer scales with the override. Not the cause of this report, but a latent bug for larger workloads.
- Setting `aicpu_thread_num=2` (1 orch + 1 sched) on this hardware fails 100% but for an **unrelated** reason: 24 clusters × 3 cores = 72 cores assigned to one scheduler exceeds the static `CoreTracker::MAX_CORE_PER_THREAD = 63` limit in [`scheduler_types.h:108`](src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_types.h#L108), so `assign_cores_to_threads` fails before the dispatch loop even starts. This is a separate latent bug (the limit should auto-adjust to the device's cluster count, or `aicpu_thread_num=2` should be rejected up-front with a clearer error). Not part of this report, but worth filing separately.


---

## #900 [Bug] A2A3 `spmd_paged_attention_highperf` hardware run times out or produces partial zero output while `a2a3sim` passes

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/900
- Created: 2026-05-29T14:41:22Z
- Updated: 2026-06-02T00:59:27Z
- Closed: 2026-06-02T00:59:27Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

`spmd_paged_attention_highperf` does not behave correctly on A2A3 hardware, even though the same test passes on `a2a3sim` simulation. The original hardware run timed out in the runtime. After diagnostic changes that avoided unresolved relocations in the dynamically loaded AICore payload, the kernel completed but produced a golden mismatch: a subset of attention heads were computed accurately, while many heads remained all zero.

This points to a hardware-only dynamic payload loading / SPMD context issue rather than a numerical error in the attention math itself. The relevant loader currently extracts only raw `.text` bytes from AIC/AIV ELF objects and does not apply `.rela.text` relocations. The PA kernel object contains relocations for out-of-line calls and block-local/global symbols, so those references can be invalid when the raw payload is called directly on device.

### Steps to Reproduce

From PR https://github.com/hw-native-sys/simpler/pull/899 :

```bash
cd tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf
python test_spmd_paged_attention_highperf.py -p a2a3
```

Control comparison:

```bash
python test_spmd_paged_attention_highperf.py -p a2a3sim
```

### Expected Behavior

The A2A3 hardware run should match the golden output within the scene test tolerance, as the `a2a3sim` run does.

### Actual Behavior

The original hardware run failed with an AICPU/runtime timeout similar to:

```text
aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
PTO2 runtime failed: orch_error_code=0 sched_error_code=100 runtime_status=-100
```

After diagnostic changes to avoid some payload relocations, the run completed but failed validation:

```text
FAILED: Golden mismatch on 'out': max_diff=0.60693359375, rtol=0.005, atol=0.02
```

A manual device-output dump showed that the device is computing some heads correctly and leaving many heads unwritten/all zero. Example stats from the diagnostic run:

```text
Device shape: (1, 32, 128), dtype: torch.float16
Device nonzero: 1280 / 4096
Golden nonzero: 4096 / 4096
Device min/max: -0.515625 / 0.41748046875
Golden min/max: -0.5966796875 / 0.60693359375
Max diff: 0.60693359375
Mean diff: 0.07562728971242905
Argmax diff: (batch=0, head=19, dim=2)
```

Top mismatches are device zeros where golden is nonzero, for example:

```text
head=19 dim=2:  device=0.0, golden=0.60693359375
head=1  dim=98: device=0.0, golden=-0.5966796875
head=17 dim=123: device=0.0, golden=0.5498046875
```

Computed heads have tiny error (`~1e-4` to `2e-4` max diff), while skipped heads are exactly zero. This suggests work partitioning/SPMD context is not preserved correctly after avoiding the relocation-triggering code paths.

### Git Commit ID

e85e8aa59d47f54ed1ff611321cd4244581ae7cf

### CANN Version

9.0.0

### Driver Version

25.5.1

### Host Platform

Linux (aarch64)

### Additional Context

_No response_

---

## #902 [Feature] Add per-task and partial-scope granularity to scope_stats collection

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/902
- Created: 2026-05-30T01:19:58Z
- Updated: 2026-06-10T01:44:56Z
- Closed: 2026-06-10T01:44:56Z
- Labels: enhancement

### Body

Follow-up to #858 / #573.

## Summary

`scope_stats` (#858) profiles ring-buffer (and tensormap) resource peaks at **per-scope** granularity. This issue tracks extending it with **per-task** and **partial-scope** collection granularity, added incrementally so the hot path stays cheap.

## Motivation / Use Case

#858 deliberately samples only at `scope_begin` / `scope_end` to keep overhead minimal — one bool load when disabled, two pure-value calls per scope when enabled. That answers "which scope drove the peak" but not:

- **Per-task attribution** — within a scope that dispatches many tasks, which task(s) actually pushed ring task-window / heap to the high-water mark.
- **Partial-scope sampling** — intermediate peaks inside a long-running scope, so a single scope record does not flatten a time-varying occupancy profile into one number.

Without these, debugging memory pressure inside a large scope still requires guesswork once scope_stats has narrowed it to a scope.

## Proposed API / Behavior

- Add an opt-in finer sampling level on top of `--enable-scope-stats` (e.g. a per-task probe at `submit_task` and/or periodic in-scope sampling), so the default per-scope mode keeps its current low overhead and the finer mode is paid for only when explicitly enabled.
- Emit the extra granularity into the existing `scope_stats.jsonl` stream (additional record types / fields) rather than a new artifact, to keep the consumer side unified.
- Preserve the single-producer, non-atomic, pooled-buffer + host-drain model from #858 so the finer sampling does not add atomics or fixed-ring back-pressure on the hot path.

## Alternatives Considered

- Always-on per-task sampling — rejected: adds per-`submit_task` cost to every profiled run; #858 intentionally avoided this.
- A separate per-task profiler unrelated to scope_stats — rejected: duplicates the buffer-pool/drain infra and the JSON consumer.

## Additional Context

- Implemented baseline: #858 (`docs/dfx/scope-stats.md`), merged as 22538de8.
- Originating request: #573 (closed; per-scope requirements satisfied, per-task deferred here).

---

## #903 [Feature] Simplify selective tensor dump API: drop enable_dump_tensor_selective() and add per-task dump-all

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/903
- Created: 2026-05-30T01:34:24Z
- Updated: 2026-06-02T01:05:39Z
- Closed: 2026-06-02T01:05:39Z
- Labels: enhancement

### Body

Follow-up to #838 / #844.

## Summary

#844 added selective tensor dump (`enable_dump_tensor_selective()` + `Arg::dump(...)`), resolving #838. Two usability gaps remain:

1. **No "dump all tensors of this task" shortcut.** In selective mode, dumping a whole task means enumerating every tensor argument by hand — `args.dump(x, y, z)`. `Arg::dump(...)` even `static_assert`s on `sizeof...(Args) >= 1`, so there is no terse "all args of this task" form.
2. **`enable_dump_tensor_selective()` is a redundant mode toggle.** Selective mode can be inferred from whether any `Arg::dump(...)` marker was placed: if at least one task marks tensors → selective; if none → full dump. The explicit enable call is an extra step users must remember, and forgetting it silently falls back to full dump even when `Arg::dump(...)` markers are present (current documented behavior).

## Motivation / Use Case

The current flow forces two decisions on the user where one suffices:

```cpp
enable_dump_tensor_selective();   // (1) remember to flip the mode
...
args.dump(x, y, z);               // (2) then enumerate every tensor by hand
```

- Forgetting (1) makes every `args.dump(...)` a silent no-op — the run dumps everything, which is exactly what selective mode was meant to avoid.
- For "dump this entire task, nothing else", the user must list all tensor args, which is verbose and drifts out of sync as the task signature changes.

Removing the toggle and adding a dump-all shortcut reduces the API to a single intuitive call site and removes a silent-fallback footgun.

## Proposed API / Behavior

**Infer selective mode from markers — remove `enable_dump_tensor_selective()`:**

- If any `Arg::dump(...)` marker is present in the orchestration, AICPU collection runs in selective mode (only marked tasks / args dumped).
- If no `Arg::dump(...)` marker is present anywhere, behavior is the legacy full dump (every task, every tensor) — unchanged default.
- `--dump-tensor` remains the top-level host enable switch; nothing here changes that.

**Add a per-task dump-all shortcut:**

```cpp
Arg args;
args.add_input(x);
args.add_input(y);
args.add_output(z);
args.dump();        // dump-all: mark every tensor arg on this Arg
rt_submit_aiv_task(FUNC_ADD, args);
```

i.e. relax `dump()` so a no-argument call (or an explicit `dump_all()`) marks all tensor args currently on the `Arg`, instead of `static_assert`-ing on ≥1 argument.

## Alternatives Considered

- **Keep `enable_dump_tensor_selective()`** — current state; redundant call and silent-fallback footgun remain.
- **A separate "dump whole task by id" host-side selector** — heavier, and duplicates the per-`Arg` marker mechanism #844 already established on the device side.

## Additional Context

- Baseline: #844 (`feat: support selective tensor dump by tensor argument`), Fixes #838.
- Current API surface:
  - `enable_dump_tensor_selective()` — `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/orchestration/pto_orchestration_api.h:141`
  - `Arg::dump(...)` (`static_assert sizeof...(Args) >= 1`) — `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/runtime/pto_types.h:206`
  - Documented behavior — `docs/dfx/tensor-dump.md` §3.2 (the doc notes that without `enable_dump_tensor_selective()`, `dump(...)` markers are ignored — the silent fallback this issue removes).

---

## #904 [Code Health] Add opt-in sanitizer builds (ASAN/UBSan host, TSAN) + sim CI job

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/904
- Created: 2026-05-30T01:39:32Z
- Updated: 2026-06-12T01:06:42Z
- Closed: 2026-06-12T01:06:42Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Build System

### Description

The build system has **no first-class sanitizer support** (no ASAN/TSAN/UBSan toggle in `CMakeLists.txt`, the nanobind module, `toolchain.py`, or CI). For a codebase this concurrency- and lifetime-heavy (host orchestrator threads + ~100 sim AICPU/AICore host threads, custom ring allocators, drain/teardown races), memory-safety and data-race bugs currently surface only as **intermittent `st-sim-*` crashes** (`rc=-11` SIGSEGV / `rc=-6` SIGABRT / `rc=124` hang), which are slow and painful to root-cause.

This is not hypothetical — the recently-fixed sim-oversubscription bug family is exactly the class sanitizers target:
- **#901** (host hierarchical `drain()` **use-after-free**) was effectively unfindable from a stripped core dump; it was only located by hand-injecting `-fsanitize=address` into a throwaway build (which then hit pip wheel-cache traps). ASAN named the free/alloc/read sites instantly.
- **#898** (sync_start drain) was a **data race** on a non-atomic `pending_task` pointer + a null-deref — exactly what **TSAN** (race) and **UBSan** (null deref) flag directly.

A standing sanitizer build + an on-demand CI job would catch these automatically, before they become flaky production crashes.

### Location

- `CMakeLists.txt` (top-level — no sanitizer option)
- `python/bindings/CMakeLists.txt` (host `_task_interface` / `src/common/hierarchical/` — where the #901 UAF lived; ASAN covers this cleanly)
- `simpler_setup/toolchain.py`, `simpler_setup/runtime_compiler.py` (device runtime build flags — would need threading for device-side coverage)
- `.github/workflows/ci.yml` (no sanitizer job)

### Proposed Fix

Stage it by value/effort:

1. **ASAN (host) + UBSan, opt-in.** Add a `SIMPLER_ENABLE_ASAN` CMake option (off by default) that appends `-fsanitize=address,undefined -fno-omit-frame-pointer -g` to the **host** targets (`_task_interface` + `src/common/hierarchical/` + host runtime). Provide a documented build/run recipe so contributors don't re-hit the `pip --no-cache-dir` / `LD_PRELOAD=libasan` setup pain. ASAN+UBSan combine in one build; this is the cheap, high-value first step (covers the #901 host-UAF class with standard `new`/`delete` redzones).
2. **TSAN as a separate build** (`SIMPLER_ENABLE_TSAN`) — ASAN and TSAN can't share one binary. Highest payoff for the scheduler/drain races (the #898 class), but needs false-positive triage with the custom sync primitives, so do it second.
3. **Optional `asan-sim` CI job** (nightly or label-triggered, since ASAN is ~2-3x slower) running the L2/L3 examples under `LD_PRELOAD=libasan` on `ubuntu-latest` (no hardware needed).

**Known limitation to document:** host-side coverage is clean (standard allocators), but the device runtime compiled into `aicpu_sim`/`aicore_sim` uses custom `mmap`/`DeviceArena`/`HeapRing` allocators that bypass ASAN redzones unless manually poisoned — so device-runtime bugs get weaker coverage than host bugs until the custom allocators are wired to ASAN's manual-poisoning API.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #905 [Feature] A5 onboard: self-managed perfmon path for L0 swimlane

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/905
- Created: 2026-05-30T01:45:11Z
- Updated: 2026-06-10T06:03:12Z
- Labels: enhancement

### Body

### Summary

Propose adding L0 (intra-core) swimlane profiling on **a5 onboard (hardware)** via a self-managed path: AICPU directly programs the AICore perfmon hardware registers and points the writeback target buffer at our own per-core GM buffer; drain reuses the existing PMU/L2 `ProfilerBase` buffer→host pipeline.

Scope: a5 **onboard only**. Sim path is out of scope for this issue.

### Motivation / Use Case

A separately prototyped alternative built on the host driver's biu_perf / msprof channel pipeline (HDC consumer ring) was investigated and shown to have structural limits that make it unsuitable as the on-tree L0 path:

- **Channel-count cap**: biu_perf channels only cover **6 physical cores** (`{0, 9, 17, 18, 27, 35}`). Tasks scheduled to other cores silently produce zero L0 data.
- **Driver-paced delivery**: device→host fill cadence is HDC batch-flush, not streaming. Symptoms: "first marker grabs all, subsequent markers return 0"; same scene-test shows **~10× variance** in record count run-to-run.
- **~60s prof_stop teardown** (18 channels × ~3-4s each) on every run.
- **Host-side task-window matching required**: channel data is not synced to our task lifecycle.
- **Knobs don't help**: `prof_start_para.real_time` is coarse-grain only; `sample_period` requires a software `sample_func` (mark_stamp is hardware-driven); `halProfDataFlush` returns `DRV_ERROR_NOT_SUPPORT` for biu_perf channels.

By bypassing the driver/msprof pipeline and programming perfmon ourselves, the data rhythm becomes our rhythm: every covered AICore can be enabled (no 6-core cap), the buffer fills as the kernel runs, drain happens on our task boundary, and the slow `prof_stop` handshake disappears.

### Proposed API / Behavior

Mirror the existing PMU collector architecture (`pmu_collector_aicore.h`, on tree), but replace the per-task software counter readout with a hardware-DMA writeback path.

**AICPU init** — via the existing `write_reg(reg_base, …)` facility. `0xB000` is within the 3MB per-core AICore MMIO window already mapped by `halResMap(RES_AICORE)` (same window PMU at `0x4200` uses), so no new mapping is needed:

| Register | Offset | Action |
| --- | --- | --- |
| `perf_mon_base_addr_l` | `0xB00C` | low 32 bits of per-core GM buffer device address |
| `perf_mon_base_addr_h` | `0xB010` | high 16 bits |
| `perf_mon_buf_len` | TBD | per-core buffer length |
| `perf_mon_samp_crt_clr` | `0xB024` bit0 | write 1 to clear |
| `perf_mon_samp_wrt` | `0xB028` | write 0 to clear |
| `perf_mon_global_en` | `0xB000` bit0 | write 1 to enable (last) |

**Runtime drain** — on AICPU, on task boundary / COND FIN (sibling to L2/PMU drain):

- Read `perf_mon_wptr_o` (`0xB01C`) / `perf_mon_samp_wrt` (`0xB028`) to learn bytes written.
- Push the populated buffer slice through the existing `ProfilerBase` `mgmt_thread` → `collector_thread` pipeline (same path PMU/L2 already use). No additional thread; no `prof_channel_read` call.
- Reset counters and continue.

**Decode** — host side:

- Start with msprof's biu_perf 4-byte chunk format (per `biu_perf_bean.py` / `biu_perf_chip6_parser.py`) as the **starting hypothesis**.
- Empirically validate against raw bytes captured from our own buffer. If the format matches, implement the decoder against our own record structs (do not re-export the msprof interface). If not, redefine the layout from observed bytes.

**Teardown**: clear `global_en`, drain remainder, free per-core buffers. No `prof_stop` handshake → ~60s saved per run.

### Alternatives Considered

- **Drive L0 via biu_perf channels (the prototyped alternative)** — see Motivation. Doesn't meet the on-tree need due to channel cap, HDC jitter, and ~60s teardown.
- **Add tiered profiling dials (#510)** — addresses overhead by lowering collection density, but does not remove the 6-core channel cap, the HDC batch jitter, or the ~60s teardown. Complementary, not a substitute.
- **Wait for a streaming driver API** — out of our control. Driver investigation (below) confirms the open-sourced driver tree only transports opaque bytes; any streaming-API change would have to come from TS firmware (closed).
- **Use the existing PMU collector for pipe-utilization** — PMU samples 10 counters per task: a useful but different signal from `mark_stamp` instruction trace. PMU stays; this issue is about the L0 *trace* path.

### Additional Context

**Driver investigation.** A targeted search of the open-sourced CANN driver tree (host HAL + TS *agent* in `src/sdk_driver/ts_agent/`) confirms it is **not** TS firmware. The perfmon register map (`0xB000-0xB028`), the register programming sequence, and any binary record/chunk decoder are **not in the open-sourced driver tree** — they live in TS firmware. The driver itself never parses AICore trace bytes; `prof_buff.c` / `prof_hdc.c` do raw `memcpy_s` only — no struct casts, no bitfield extraction, no sentinels. ABI structs (`ts_ai_core_profile_config_t`, `tsPCTrace_task_t`) are header-only and unused by any `.c`.

**One useful datum the driver does give us.** Device-side SQE addresses are **SMMU-translated virtual addresses** tagged with `streamid` + `substreamid` (PASID), with `ADDR_UNIFIED`/`ADDR_INDEPENDENT` modes. This makes it likely that `perf_mon_base_addr` is also a device VA under SMMU (not raw physical), encouraging for pointing it at a GM buffer. Residual risk: the BIU/DFX engine may have its own streamid; if so, our GM buffer needs a mapping under that stream's context.

**Open feasibility questions** to resolve before / during prototyping — will be answered empirically by capturing raw bytes from our own buffer:

1. `base_addr` address type (physical vs SMMU-VA; same stream/PASID as kernel writes?)
2. On-wire chunk format vs msprof's 4-byte chunk hypothesis
3. Ring vs linear; `wptr_o` wrap semantics; `samp_wrt` reset model
4. Cache coherency / invalidate model on AICPU read (sibling to `rmb()` model in L2/PMU)
5. Ownership conflict — must ensure driver instr-profiling is fully off so TS firmware does not race us on `base_addr`

**On-tree references (upstream).** Existing infrastructure this proposal builds on:

- AICPU PMU collector pattern to mirror: [pmu_collector_aicore.h](src/a5/platform/include/aicore/pmu_collector_aicore.h) / [pmu_collector_aicpu.cpp](src/a5/platform/src/aicpu/pmu_collector_aicpu.cpp)
- Register access facility already used by PMU: [platform_regs.h](src/a5/platform/include/aicpu/platform_regs.h)

Related: #510, #641

---

## #907 [Feature] Port dep_gen DFX collector to a5 (align with a2a3)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/907
- Created: 2026-05-30T01:51:17Z
- Updated: 2026-06-02T01:21:48Z
- Closed: 2026-06-02T01:21:48Z
- Labels: enhancement

### Body

## Summary

`dep_gen` — the complete per-submit dependency-graph collector (tensor-annotated, host-replayed `deps.json`) — exists only on **a2a3**. a5 has every other DFX collector mirrored (pmu, l2_perf, tensor_dump, scope_stats) but **no dep_gen at all**. This issue tracks porting dep_gen to a5 so the two platforms have parity.

## Motivation / Use Case

`dep_gen` captures the inputs to every `Orchestrator::submit_task` into a host-resident record stream and replays them offline through the same `compute_task_fanin` / `register_task_outputs` primitives the device orchestrator uses, producing `deps.json` — a strict superset of the swimlane `fanout[]` edges (it recovers edges that fanout silently drops when a producer has already retired; see #599).

On a5 this diagnostic is currently unavailable, so a5 users cannot get a complete dependency graph for debugging missed/incorrect dependencies. Every other DFX subsystem already works on both platforms; dep_gen is the lone gap.

## Proposed API / Behavior

Mirror the a2a3 dep_gen implementation under `src/a5/...`, preserving the same enable flag, record schema, and `deps.json` output so existing tooling and docs apply unchanged. Files to port (a2a3 → a5):

- `src/a2a3/platform/include/common/dep_gen.h`
- `src/a2a3/platform/include/aicpu/dep_gen_collector_aicpu.h`
- `src/a2a3/platform/include/host/dep_gen_collector.h`
- `src/a2a3/platform/src/aicpu/dep_gen_collector_aicpu.cpp`
- `src/a2a3/platform/src/host/dep_gen_collector.cpp`
- `src/a2a3/runtime/tensormap_and_ringbuffer/host/dep_gen_replay.{h,cpp}`
- ST coverage: `tests/st/a2a3/tensormap_and_ringbuffer/dfx/dep_gen/` → `tests/st/a5/...`
- Wire-up in a5 `kernel.cpp`, `device_runner.cpp`, host CMakeLists, and `pto_runtime_c_api`, matching how a5 already wires pmu/scope_stats.

**a5-specific adaptation:** the a5 host collector must follow a5s no-SVM model (malloc host shadow + `copy_to/from_device`, per-tick shm mirror), the same pattern the a5 `PmuCollector` / `ScopeStatsCollector` ports already use — a verbatim copy of the a2a3 host collector will not work.

## Alternatives Considered

- **Leave dep_gen a2a3-only** — rejected: leaves a5 without complete dependency-graph diagnostics while every other DFX collector has parity.
- **Share one collector across both platforms** — out of scope here; the host side genuinely differs (SVM vs no-SVM), which is why a5 maintains its own mirror of each collector.

## Additional Context

- Baseline + design: `docs/dfx/dep_gen.md`.
- a2a3 reference implementation: the files listed above.
- a5 already mirrors pmu / l2_perf / tensor_dump / scope_stats, so the porting pattern (incl. the no-SVM host adaptation) is well established — see the a5 `scope_stats` port (#858) and `PmuCollector` for the template.

---

## #908 [Performance] Cut device-side fanout collection from a5 L2 swimlane (dep_gen is sole source)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/908
- Created: 2026-05-30T01:55:39Z
- Updated: 2026-06-03T06:53:55Z
- Closed: 2026-06-03T06:53:55Z
- Labels: performance

### Body

Depends on #907 (a5 dep_gen port).

## Note on scope: a5 only

a2a3 **already** cut this. Its `l2_perf_aicpu_complete_record` no longer takes fanout params and the commit path explicitly "does not touch fanout" — deps.json (from dep_gen) is the sole source, joined post-run by `swimlane_converter.py` (`src/a2a3/platform/include/aicpu/l2_perf_collector_aicpu.h:77-79`, `src/a2a3/platform/include/common/l2_perf_profiling.h:89-96`). This issue brings **a5** to the same state. (The title/request originally said "a2a3 and a5"; a2a3 needs no change.)

## Summary

On a5, the L2 swimlane hot path still records `L2PerfRecord::fanout[]` on the scheduler critical completion path. Once a5 has dep_gen (#907), deps.json becomes the complete fanout source, so this device-side collection is redundant overhead and should be removed — mirroring a2a3.

## Motivation / Use Case

a5 T&R `scheduler_completion.cpp:159-175` walks the fanout linked list and builds a `uint64_t fanout_arr[RUNTIME_MAX_FANOUT]` (128 entries) per completed task, then `l2_perf_aicpu_complete_record(... fanout_arr, fanout_n)` stores it into the GM record (`src/a5/platform/src/aicpu/l2_perf_collector_aicpu.cpp:290-295`). That is a per-task linked-list walk + ~1 KB GM store on the schedulers critical fanin/completion tail — the exact cost a2a3 removed when dep_gen landed.

dep_gens replay sees every submit (no "already retired" producer race, see #599), so deps.json is a strict superset of the swimlane fanout edges. Keeping device-side fanout on a5 buys nothing once #907 is in and just taxes the hot path.

## Proposed API / Behavior

Mirror a2a3s already-shipped change on a5:

- Drop the `fanout` / `fanout_count` params from a5 `l2_perf_aicpu_complete_record` so the commit path no longer touches fanout (`src/a5/platform/include/aicpu/l2_perf_collector_aicpu.h`, `.../src/aicpu/l2_perf_collector_aicpu.cpp`).
- Remove the fanout linked-list walk + `fanout_arr` build at a5 `scheduler_completion.cpp:159-175`.
- a5 host collector: stop emitting per-record fanout; emit empty fanout fields and let `swimlane_converter.py` join deps.json post-run (`src/a5/platform/src/host/l2_perf_collector.cpp:610-620`), matching a2a3 (`src/a2a3/platform/src/host/l2_perf_collector.cpp:608`).
- Handle the `L2PerfRecord::fanout[] / fanout_count` struct fields the same way a2a3 does (the struct is shared `common/l2_perf_profiling.h`; HBG still uses fanout, so follow a2a3s exact treatment rather than deleting the fields outright).

## Alternatives Considered

- **Keep a5 device-side fanout** — rejected: redundant once deps.json exists, and it is the documented reason a2a3 moved fanout off the hot path.
- **Do this before #907 lands** — rejected: removing fanout without dep_gen would leave a5 with no fanout source at all. Hard dependency on #907.

## Additional Context

- a2a3 reference change (the template): the fanout-free commit path + host empty-fanout export + `swimlane_converter.py` join.
- a5 current state confirmed at: `scheduler_completion.cpp:159-175`, `l2_perf_collector_aicpu.{h,cpp}`, `l2_perf_collector.cpp:610-620`.
- Design background: `docs/dfx/dep_gen.md`, #599.

---

## #919 [Bug] Host hangs until watchdog kill when a --dump-tensor run times out or fails

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/919
- Created: 2026-05-30T10:08:09Z
- Updated: 2026-05-31T01:15:19Z
- Closed: 2026-05-31T01:15:19Z
- Labels: bug

### Body

### Platform

All / Unknown

### Runtime Variant

All / Unknown

### Description

When tensor dump is enabled (`--dump-tensor`), a run that does **not** complete normally — i.e. it times out or the runtime reports a fatal status — does not fail cleanly on the host. Instead the host process hangs indefinitely and is only terminated by an external watchdog (e.g. the job/task-queue limit).

The same failing run **without** `--dump-tensor` returns and exits promptly. The hang is purely host-side and specific to the dump-enabled path. This issue is only about the host-side hang on an abnormal run — not about why the run timed out in the first place.

### Steps to Reproduce

1. Run any example with `--dump-tensor` on hardware.
2. Have the run end abnormally — a stream-sync timeout, or the PTO2 runtime reporting a fatal status — so the host's run path bails out **before** reaching the normal collector-teardown / `export_dump_files()` step.
3. Observe that the host process never returns: it sits idle after reporting the failure until the external watchdog SIGKILLs it (e.g. the 300s task-queue limit).

### Expected Behavior

On an abnormal run, the host tears down the dump collector and returns/reports the error promptly — the same fast exit as a non-dump run. The process should not hang.

### Actual Behavior

After the run reports failure and `finalize` completes, the host process hangs and is only killed by the external watchdog (300s task-queue timeout).

### Git Commit ID

aa6ce642f9bbd527137a304d2a554e6f5685681a

### Host Platform

Linux (aarch64)

### Additional Context

Root cause: `TensorDumpCollector`'s writer thread is only signalled (`writer_done_`) and joined inside `export_dump_files()`, which runs only on the success path. On an abnormal run, `DeviceRunner::run()` returns early and skips the collector-teardown block; the cleanup path still reaches `TensorDumpCollector::finalize()`, but `finalize()` (and the base-class `stop()`) only join the mgmt + poll threads — never the writer thread. The writer thread is left blocked on its condition variable while `writer_thread_` stays joinable, which wedges teardown.

Affected files:
- `src/a2a3/platform/src/host/tensor_dump_collector.cpp`
- `src/a5/platform/src/host/tensor_dump_collector.cpp`

---

## #943 L2 swimlane: regression test for aicore_rotate failure paths + perf check on cache-line sharing

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/943
- Created: 2026-05-31T08:21:39Z
- Updated: 2026-06-01T01:54:49Z
- Closed: 2026-06-01T01:54:48Z

### Body

Follow-up from #939 (ActiveHead cache-line refactor).

## Pending: regression test for `aicore_rotate` failure-path accounting

PR #939 fixed a pre-existing over-counting bug: the pre-emptive `dropped_record_count += BUFFER_SIZE` in `aicore_rotate`'s two failure branches (empty free queue, full ready queue) double-counted records that the flush retry path would still deliver, breaking the `collected + dropped == total` reconcile invariant when the run ended before the slot guard actually overflowed the projected BUFFER_SIZE more records.

We need a regression test that exercises both failure paths and asserts the reconcile invariant. Triggers are hard to set up in the existing 5-task vector example:

- **Empty free queue at rotation:** requires driving enough rotations to exhaust the free pool (`PLATFORM_AICORE_BUFFERS_PER_CORE` per core). A long stress run with many tasks per core.
- **Ready queue full at rotation:** requires the host drain thread to be slow / paused.

Approach options:
- Add a stress test that runs N×PLATFORM_AICORE_BUFFERS_PER_CORE tasks per core and asserts the reconcile invariant in the captured JSON.
- Add a sim-only knob to artificially block the host drain for a window.

## ~~Pending: perf measurement on `paged_attention_unroll`~~ (RESOLVED)

Measured on a2a3 onboard, paged_attention_unroll Case1 with --enable-l2-swimlane 4, 3 iters each via task-submit:

| | pytest body | wall (incl. import) |
|---|---|---|
| Baseline (upstream/main pre-#939) | 15.46–15.67s | 22.85–23.01s |
| B alone (#939) | 15.19–15.34s | 22.99–23.28s |

Within noise (<2%); no measurable regression from packing head + counters into the same cache line. Design choice validated — counters can stay co-located with head.

## Priority

Regression test is non-blocking; the fix in #939 is correct by code review and validated by reconcile math. Add when test-infra can model the trigger.

---

## #959 [Bug] PTO2 dep_pool/wiring can deadlock under full tensor dump backpressure

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/959
- Created: 2026-06-01T08:50:49Z
- Updated: 2026-07-02T11:06:29Z

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

Related: #860

The full tensor dump path can expose a PTO2 scheduler/wiring progress
failure. The current evidence points to a device-side scheduler issue rather
than the original "host PCIe drain cannot keep up" hypothesis.

In the issue860 CSA refresh replay, `dump_tensor_record` synchronously copies
large tensor payloads into the AICPU dump arena from the scheduler hot path.
That copy path can move tens of MiB for one oversized tensor record. In this
workload, the successful workaround run emitted:

```text
total_tensors=5690
expected payload bytes ~= 69.6 GiB
copied payload bytes   ~= 43.2 GiB
truncated_tensors=161
dropped_records=0
dropped_overwrite=0
```

The largest single tensor payload is 512 MiB class. With the default dump
arena sizing, one oversized tensor can still synchronously copy roughly
`arena_size / 2` bytes before being marked truncated. Repeating that from the
AICPU scheduler path slows dispatch/completion/consume progress enough to
hit PTO2 scheduler watchdogs and then expose a dep_pool/wiring reclaim loop.

The problematic PTO2 interaction is:

```text
orchestrator submits a task
  -> producer fanout_count is incremented before the consumer edge is wired
  -> scheduler drain_wiring_queue needs dep_pool entries for fanout edges
  -> if dep_pool.available() < wfanin, drain_wiring_queue tries reclaim then
     breaks at the FIFO head
  -> later consumers remain submitted but not wired
  -> some producers cannot reach CONSUMED because fanout_count already
     includes not-yet-wired consumers
  -> last_task_alive does not advance
  -> dep_pool cannot reclaim
  -> wiring remains stuck until scheduler timeout
```

This failure is easier to trigger under full tensor dump because synchronous
payload copy stretches the time between scheduler-visible progress events.

### Steps to Reproduce

Use the issue860 replay workload in the `zm_pypto` environment:

```bash
task-submit --max-time 1200 --device auto \
  --env ASCEND_PROCESS_LOG_PATH=log_issue860_full_dump \
  --run "python _jit_attention_csa_test_refresh_20260526_103922/test_attention_csa_test_refresh.py --device {} --platform a2a3 --log-level info --dump-tensor --build"
```

Useful isolation variants:

1. Run without `--dump-tensor`: workload passes.
2. Run with full dump and default timeouts: host sees `507018`.
3. Increase only CANN op timeout / stream sync timeout: the 1s CANN timeout
   no longer fires first, but PTO2 still fails with scheduler timeout.
4. Increase only scheduler dump idle watchdog while keeping
   `PTO2_DEP_LIST_POOL_SIZE=16384`: the run advances further, then stalls
   around `completed=1249/1934`.
5. Increase both scheduler dump idle watchdog and dep_pool capacity
   (`PTO2_DEP_LIST_POOL_SIZE` or `PTO2_RING_DEP_POOL` to 65536): the same
   workload completes and emits both `tensor_dump.bin` and
   `tensor_dump.json`.

### Expected Behavior

Full tensor dump should not deadlock PTO2 scheduler wiring or dep_pool
reclaim.

Large payload dumps may be slow, truncated, budget-limited, or explicitly
rejected with a clear diagnostic, but they should preserve scheduler progress
and should not leave submitted tasks permanently not-wired while their
producers' `fanout_count` already accounts for them.

On failure, the host dump collector should also stop/reconcile/export a
partial manifest or failure summary instead of leaving only a partial
`tensor_dump.bin` without `tensor_dump.json`.

### Actual Behavior

Observed failure modes:

```text
aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
PTO2 runtime failed: orch_error_code=0 sched_error_code=100 runtime_status=-100
```

With only CANN timeout increased:

```text
aclrtSetOpExecuteTimeOutV2: requested=300000000 us
Config OP execute timeout success, enable[1] timeout[300s]

[STALL thread=2 idle_iterations=800000]
TIMEOUT_EXIT after_idle_iterations=800000
simpler_aicpu_exec: aicpu_execute failed with rc=-100
rtStreamSynchronizeWithTimeout: ErrCode=507018, desc=[aicpu exception]
```

With scheduler idle watchdog increased but default dep_pool capacity:

```text
dep_pool=16384
TIMEOUT_EXIT after_idle_iterations=80000000
completed=1249/1934
scan_ready=685 scan_waiting=0 scan_running=0
queue_aic=0 queue_aiv=0 queue_mix=0 queue_dummy=0
```

This run produced a large partial `tensor_dump.bin` but no
`tensor_dump.json`, because the host run exits on the AICPU stream sync
failure before the normal dump export path.

With both the dump watchdog and dep_pool capacity increased:

```text
PASSED
Tensor dump anomalies: truncated=161, dropped_records=0, overwritten=0

tensor_dump.bin   44G
tensor_dump.json  1.9M
total_tensors=5690
truncated_tensors=161
dropped_records=0
dropped_overwrite=0
```

This indicates that host drain/write speed is not the first blocking root
cause for this replay. Host export is slow because the output is tens of GiB,
but the device-side AICPU timeout/stall is avoided by making scheduler
watchdog and dep_pool capacity large enough.

### Git Commit ID

1996ba4d047dce46dbfc3ca34c20624851770d67

### CANN Version

Not captured in the final replay. Logs confirm the dump op timeout was
successfully changed to 300s in the isolation run.

### Driver Version

Not captured. `npu-smi info` was unavailable in this environment during the
investigation.

### Host Platform

Linux (aarch64)

### Additional Context

Relevant code paths:

```text
src/a2a3/platform/src/aicpu/tensor_dump_aicpu.cpp
  dump_tensor_record
  synchronous payload copy / truncation into dump arena

src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp
  submit_task_common
  producer->fanout_count++ before pushing to scheduler wiring queue

src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/pto_scheduler.h
  drain_wiring_queue
  dep_pool.available() < wfanin -> reclaim -> break
  wire_task -> dep_pool.prepend(...)
  check_and_handle_consumed requires fanout_refcount == fanout_count

src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.cpp
  dep_pool reclaim depends on last_task_alive advancement

src/a2a3/platform/onboard/host/device_runner.cpp
  stream sync failure returns before normal dump export, causing bin-without-json
```

Suggested fix directions:

1. Make full tensor dump copy progress visible to the scheduler watchdog, or
   replace pure idle-iteration accounting with time/progress-epoch based
   logic that understands dump progress.
2. Split or async the large payload copy path so one tensor dump record does
   not monopolize the AICPU scheduler hot path for a long synchronous copy.
3. Fix the PTO2 wiring/dep_pool coupling:
   - avoid permanent FIFO head-of-line blocking when dep_pool is temporarily
     insufficient;
   - delay `fanout_count` accounting until a consumer edge is successfully
     wired, or track not-yet-wired consumers separately;
   - reclaim based on actual live fanout entries instead of a pessimistic
     `wfanin` precheck when completed producers do not need live dep entries.
4. Make failure cleanup bounded: preserve the first stream/AICPU error, but
   still stop the collector and export a partial manifest or failure summary.
5. Add product-level controls for full dump scale: selective dump, payload
   budget, and/or storage-level deduplication.

The current workaround is to enlarge dump-only scheduler watchdog and dep_pool
capacity. That is useful for debugging issue860, but the root fix should make
large full tensor dumps unable to break scheduler wiring progress.


---

## #961 [Bug] Concurrent disjoint-slice writers to one internal tensor non-deterministically corrupt the downstream read or deadlock the scheduler (low-fanin, distinct from #729)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/961
- Created: 2026-06-01T09:14:54Z
- Updated: 2026-06-02T02:12:33Z
- Closed: 2026-06-02T02:12:33Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

A task graph of N concurrent, **independent** tasks that each write a **disjoint slice** of one shared/internal tensor (`pl.create_tensor`), read by a downstream task, is executed **non-deterministically incorrectly** by the PTO2 runtime.

The writes are provably disjoint and write-only — verified down to the generated AIV kernel: each writer's only two `TSTORE`s target rows `[idx*16 : idx*16+16] × full 512 cols` at GM offset `batch_base*512 + col` (`batch_base = idx*16`), with **no load-back** of the tensor. So the 4 tasks are genuinely independent and the concurrent schedule is semantically valid. Yet the same graph fails at random in two ways:

- **Wrong values** — the downstream consumer reads stale/partial data (a slice that should be `0` returns another batch's real values).
- **Scheduler stall/deadlock** — `507046`, `sched_error_code=100`, watchdog `TIMEOUT_EXIT after_idle_iterations=800000`.

Serializing the writers (or gating the reader with a spin-wait) always passes. This looks **related to but distinct from #729**: here the fanin is **low** (`fanin_refcount=5/6, missing_deps=1`, no fanin-spill-pool exhaustion), and there is an additional silent **wrong-values** mode that #729 did not cover. It may be an incomplete root-cause fix of #729, or a distinct low-fanin lost-completion + stale-read defect in the same disjoint-write→read area.

### Steps to Reproduce

Reproducer archive (attached) contains 4 prebuilt variants under `build_output/` (`rmsnorm_rope_{range,spmd,parallel,parallel_manual}`), each with the generated `.pto` / `.cpp` (kernels + orchestration) and pass dumps. Binaries (`.o/.so`) and `.pt` data are excluded; the runner rebuilds binaries and regenerates inputs/golden on first run.

```bash
# from a pypto-lib checkout
tar -xzf rmsnorm_rope_experiments.tar.gz -C build_output/
python models/deepseek/v4/decode_compressor_ratio4.py -p a2a3 -d 0 \
    --runtime-dir build_output/rmsnorm_rope_parallel
```

Run repeatedly (10–40×). The `…_parallel` / `…_spmd` (`add_output`) variants fail intermittently; the `…_range` (`add_inout`, serialized) variant passes every time.

**Controlling knob:** a single line in `orchestration/compressor_test.cpp` — `params_t3.add_output(normed_kv…)` vs `add_inout`. Flipping it on the *same* kernel binary turns a racy build into 10/10 reliable, i.e. the difference is purely the task-graph concurrency annotation the scheduler acts on, not the kernel compute.

### Expected Behavior

The runtime executes the independent disjoint-write tasks and the downstream read correctly and deterministically (as it does when the writers are serialized) — no wrong values, no deadlock.

### Actual Behavior

Non-deterministic wrong values OR scheduler deadlock.

Stall device log:

```text
SUMMARY completed=7/9 last_progress_iteration=0 scan_ready=0 scan_waiting=1 scan_running=1
TASK ring=1 ... state=WAIT    fanin_refcount=5/6 kernels=[aiv0:4] missing_deps=1     # consumer kv_and_cache_write
TASK ring=2 ... state=RUNNING fanin_refcount=3/3 kernels=[aiv0:3] running_on=[core=29(aiv0)]  # producer rmsnorm_rope
... [STALL idle_iterations=800000] all clusters idle ...
[ERROR] handle_timeout_exit "... TIMEOUT_EXIT after_idle_iterations=800000"
[ERROR] handle_orchestrator_exit "... Scheduler fatal error detected (code=100)"
```

One producer is `RUNNING` on a core that is actually idle (completion handshake never posted) → the consumer's last dependency never resolves → all cores idle → watchdog `TIMEOUT_EXIT`. The stuck producer index / core differ run-to-run.

### Git Commit ID

324df3d6557b0c6571a3ff3d170675324df0fa1c

### CANN Version

not detected

### Host Platform

Linux (aarch64)

### Additional Context

**Versions:** pypto `d5b35363` (#1606), simpler/pypto-runtime `324df3d6` (#835), ptoas `0.43`, pto-isa `8bd3ac8f` (#153).

**Related:**
- #729 — same disjoint-write→read pattern, high-fanin **spill-pool** deadlock variant (CLOSED with partial fixes); this report is a low-fanin / wrong-values manifestation.
- hw-native-sys/pypto-lib#419 — kernel-side write-up and reproducer (full content reproduced below).

---

## Full write-up (from pypto-lib#419)

### Symptom
The per-batch `rmsnorm_rope` scope writes an internal `pl.create_tensor` `normed_kv`, read downstream by `kv_and_cache_write`. With the 4 batch-iterations running concurrently, runs fail **non-deterministically** as either wrong values (RoPE span cols ≥ 448 of a non-compress batch returns real RoPE values instead of `0`; only `kv` / `cmp_kv_cache` fail, `compress_state` always passes) or stall (`507046` / AICPU 2s sync-timeout).

### Configuration matrix (pass / total runs)

| Loop | `normed_kv` task edge | Pass/Total | Verdict |
|---|---|---|---|
| `pl.range` | `add_inout` (serialized) | 10/10 | ✅ reliable |
| `pl.spmd` | `add_inout` (serialized) | 40/40 | ✅ reliable |
| `pl.parallel` | `add_output` + spin-wait (in/after loop) | 20/20 | ✅ reliable |
| `pl.spmd` | `add_output` | 34/40 | ❌ racy |
| `pl.parallel` | `add_output` | 16/25 | ❌ racy |
| `pl.parallel` | `add_output` + `set_dependencies(consumer→4 producers)` | 36/40 | ⚠️ mitigates, not reliable (2 wrong + 2 stall) |

All three reliable configs share one property: **the 4 writers are not genuinely concurrent** (serialized by `inout`, or gated by a spin-wait).

### Established facts (verified)
- **The 4 writes to `normed_kv` are disjoint and write-only** (verified at the generated AIV kernel; no load of `normed_kv`). → iterations genuinely independent; concurrency is semantically valid.
- **Swimlane** confirms the 4 `rmsnorm_rope` tasks overlap in time.
- **Stall root cause (device logs):** `completed=7/9`; consumer `kv_and_cache_write` `WAIT, fanin_refcount=5/6, missing_deps=1`, while one producer `rmsnorm_rope` is `RUNNING` on an actually-idle core (completion handshake lost) → fanin never resolves → deadlock. Stuck producer/core differ per run.
- **One-line controlled flip:** patching only the orchestration cpp `add_output → add_inout` on the *same* kernel binary turned a racy build 10/10 reliable → the race is the task-graph concurrency annotation, not the kernel compute.

### Working hypothesis
The runtime mis-handles **multiple concurrent independent tasks each writing a disjoint slice of one internal tensor, read by a downstream task**: consumer-side fanin over multiple `add_output` writers is under-aggregated (→ stale read → wrong values), and producer-side completion handshakes are occasionally lost under concurrent dispatch (→ deadlock). Removing real writer concurrency (serialize via `inout`, or gate with a spin-wait) avoids both.


---

## #965 [Feature] Tensor dump: support float/int32 scalar types besides uint64

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/965
- Created: 2026-06-01T11:38:55Z
- Updated: 2026-06-11T07:48:30Z
- Closed: 2026-06-11T07:48:30Z

### Body

### Summary

Tensor dump (`--dump-tensor`) currently treats all scalar arguments as `UINT64` — the raw `uint64_t` bit pattern is stored as the scalar value. When a user passes a `float` or `int32_t` scalar via `Arg::add_scalar()`, the dump loses type information: the value appears as a meaningless large integer (the IEEE 754 bit pattern) with dtype `"UINT64"` instead of the decoded float value.

### Motivation / Use Case

Users debugging kernels with `--dump-tensor` cannot see the actual scalar values they passed — a float `1.0` shows up as `1065353216` with `dtype: "UINT64"`. This is confusing and forces users to manually decode the bit pattern.

The fix involves three layers:
1. **C++ API** — store the original dtype alongside the scalar value in `Arg` and `PTO2TaskPayload` (a `uint8_t scalar_dtypes[]` array parallel to `scalars[]`)
2. **Dump collector** — in `tensor_dump_collector.cpp`, read `pl.scalar_dtypes[i]` and decode FLOAT32 via `memcpy(&f, &scalar_value, sizeof(float))`; output the decoded float as `value` alongside the correct `dtype`
3. **Viewer** — `dump_viewer.py` already reads `kind` and `value`; no new fields needed

Initial support for `FLOAT32`, `UINT32`, and `INT32` dtypes is sufficient; others can default to `UINT64` for backward compatibility.

### Git Commit ID

`f04514e0` (PR #792 base)

### Related

PR #792 added the initial uint64-only scalar dump.

---

## #967 [Bug] Non-deterministic column-scatter data corruption on a2a3, bisected to #878 (trigger, not root cause)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/967
- Created: 2026-06-01T11:59:26Z
- Updated: 2026-06-02T09:16:05Z
- Closed: 2026-06-02T09:16:05Z
- Labels: bug

### Body

## Platform

a2a3 (Ascend 910B/C hardware)

## Runtime Variant

tensormap_and_ringbuffer (the culprit commit also touches `host_build_graph/aicore/aicore_executor.cpp` identically, so `host_build_graph` is likely affected too)

## Description

`git bisect` shows that **#878 (`1d424912` "Refactor: AICore-as-producer for L2 swimlane (skip per-task staging read)")** is the first commit where a column-scatter kernel starts producing **non-deterministic data corruption** on a2a3 hardware.

The important and counter-intuitive part: **#878's entire diff is gated behind the L2-swimlane profiling flag, and the failing test runs with L2-swimlane profiling OFF.** So #878 does not change any live behavior in this scenario — it only changes the recompiled binaries' code/BSS layout and therefore execution timing. The conclusion is that **#878 is a trigger, not the root cause**: it perturbs timing/layout just enough to make a pre-existing latent data race in the scatter task completion/scheduling path manifest. Reverting #878 would mask the symptom but not fix the underlying race.

## Steps to Reproduce

Reproduced via the PyPTO ST suite (the kernel is generated by PyPTO; the corruption is in the runtime's execution of it). With this repo checked out as PyPTO's `runtime/` submodule:

```bash
# rebuild the runtime from the commit under test, then run the scatter ST cases on a locked device
rm -rf runtime/build && pip install ./runtime/
task-submit --device auto --run \
  "pytest -q \
     tests/st/runtime/ops/test_scatter.py::TestScatterIndexForm::test_scatter_fp16[a2a3] \
     tests/st/runtime/ops/test_scatter.py::TestScatterIndexForm::test_scatter_bf16[a2a3] \
     tests/st/runtime/ops/test_scatter.py::TestScatterIndexForm::test_scatter_int16[a2a3] \
     --device={} --pto-isa-commit=8bd3ac8f30bd237f9eaf12c142002a5cc0edb143"
```

The kernel is a per-row column scatter on a `[16, 32]` 2-byte tensor: `out[i, index[i, m]] = val[i, m]`, where `index[i, m] = (m + i) % 32` and `val[i, m] = i*16 + m + 1`; `base[i, j] = -(j+1+i)` is a negative sentinel for the untouched columns. **L2-swimlane profiling is disabled** (no `--enable-l2-swimlane`; `enable_l2_swimlane` defaults to `False`).

Run it several times — the outcome varies run to run (it is a race). To bisect / judge: any golden mismatch ⇒ bad; only declare good after many clean runs.

### Bisect log

```
# good: 324df3d (and parent 1469d791f77df04fe1304545f88b868a44642622)
# bad:  49012fd9 (tip) and 1d424912072c4402d2818d1d20c694c9ac566e7a
git bisect good 1469d791   # parent of #878 — clean across repeated runs
git bisect bad  1d424912   # #878 — reproduces the mismatch
=> 1d424912072c4402d2818d1d20c694c9ac566e7a is the first bad commit
```

## Expected Behavior

All scatter cases pass deterministically (they do on the parent commit `1469d791` and on the older baseline `324df3d`: 10/10 scatter ST cases pass).

## Actual Behavior

Non-deterministic across identical runs at/after #878. The same `int16` case in three back-to-back runs:

- Run 1: 32/512 elements mismatched — the **last 2 rows** (rows 14–15) were never scattered; the output kept the untouched `base` sentinel.
- Run 2: `aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018` — no result.
- Run 3: 49/512 mismatched — a **different** pattern: row 0 cols 14–30 received `225, 241, 242, ...` (these are `val[14,0]`, `val[15,0]`, `val[15,1]` — values destined for rows 14/15 landed in row 0), while rows 14/15 still held the sentinel.

```
First 20 mismatches (run 1):
    [462] actual=-29, expected=225   # row 14, col 14 — got base sentinel instead of val
    [463] actual=-30, expected=226
    ...
    [495] actual=-31, expected=241   # row 15, col 15
```

Characteristic signature: the **per-row base offset `i*cols` of the flattened scatter index is intermittently dropped** — writes meant for a high row land in row 0 (displacement exactly `448 = 14*32`, one full row stride), or vanish entirely. When `fp16`/`bf16`/`int16` are run together all three corrupt; in isolation it is whichever case loses the race that run. Strongly load/timing dependent.

## Git Commit ID

First bad: `1d424912072c4402d2818d1d20c694c9ac566e7a` (#878). Also fully reproduces on tip `49012fd9`. Parent/last-good: `1469d791f77df04fe1304545f88b868a44642622`.

## CANN Version

cann-9.0.0

## Host Platform

Linux (aarch64)

## Additional Context

Why #878 looks like the cause but is only the trigger — every change in #878 is gated behind L2-swimlane profiling, which is OFF here:

- host `src/a2a3/platform/onboard/host/device_runner.cpp:374` — `if (enable_l2_swimlane_) init_l2_perf(...)`; with profiling off no L2Perf device memory is allocated and `KernelArgs::aicore_ring_addr` stays 0.
- `src/a2a3/platform/onboard/aicore/kernel.cpp:93` — rotation setup gated on `GET_PROFILING_FLAG(..., PROFILING_FLAG_L2_SWIMLANE)`.
- `src/a2a3/runtime/.../aicore/aicore_executor.cpp` — both record calls gated on `l2_perf_enabled`.
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp:839` — gated on `is_l2_swimlane_enabled()`.

So with profiling off, #878's **live** behavior equals its parent's. The only residual deltas are binary-level: changed `platform_config.h` constants (`PLATFORM_PROF_READYQUEUE_SIZE` 640→928, drop `PLATFORM_L2_AICORE_RING_SIZE`, add `PLATFORM_AICORE_BUFFERS_PER_CORE`) recompiled into all kernels, and a new static BSS array `s_aicore_buffer_states[PLATFORM_MAX_CORES]` in `l2_perf_collector_aicpu.cpp`. These shift code/symbol/BSS layout and thus timing — enough to expose a latent race.

Suggested investigation: the synchronization between AICore writing scatter results and AICPU collecting task completion (the per-row base-offset drop / cross-row displacement above) in the scatter path, rather than reverting #878. A TSAN / race-analysis pass over the a2a3 scatter task completion path is likely to find it. Happy to provide the generated kernel `.pto`, pass dumps, or run additional repro iterations on request.


---

## #970 [Bug] SIMT 指令(MSCATTER/MGATHER)通过 SU dispatcher fn-pointer 路径调用时 chip hang

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/970
- Created: 2026-06-02T08:45:02Z
- Updated: 2026-06-17T10:16:10Z
- Closed: 2026-06-17T10:16:10Z
- Labels: bug

### Body

### Platform

a5 (Ascend 950 hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

在 a5 平台 `tensormap_and_ringbuffer` 运行时上,如果一个 user incore kernel 在内部直接或间接使用任何 SIMT 类指令(`pto::MSCATTER`、`pto::MGATHER` 及其内部展开的 `cce::async_invoke<...>`),通过当前 SU dispatcher 模型(`src/a5/runtime/tensormap_and_ringbuffer/aicore/aicore_executor.cpp`)调用进入这个 kernel 之后,**SIMT scheduler 无法在 AICore 上正确启动**,表现为 chip 静默 hang(host 上 stream sync 不返回,task-submit 超时被 kill,无 errcode 抛出)。

PR #764(`Fix: a5 AICore SIMT launch — set localMemorySize + inject SIMT TLVs`)已经把 launch-registration 阶段的 `cfg.localMemorySize = 216 KB` + ELF `.ascend.meta.<func>` 的 5 条 SIMT TLV(`COMPILER_ALLOC_UB_SIZE`, `SU_STACK_SIZE`, `SIMT_WARP_STACK_SIZE`, `SIMT_DVG_WARP_STACK_SIZE`, `AIV_TYPE_FLAG=MIX_VF`)装好,**runtime 不再抛 `ACL_ERROR_RT_PARAM_INVALID (107000)`**,launch 注册成功。但**进入 user kernel body 执行到 MSCATTER 时仍然 hang**。

根因:bisheng 把 dispatcher `aicore_executor.cpp:42` 处通过 `payload->function_bin_addr` 加载的 fn-pointer call lowering 成 `HiIPUISD::LongCALL`(4 字编码,目标地址通过 linker reloc 填入,decode 期不可解析),**而 SIMT scheduler 的启动需要 decode 期能解析目标 PC 才能预热**。短分支 `HiIPUISD::CALL`(3 字 + 立即数偏移)路径上,bisheng 自动发了一组 SIMT-aware setup 指令(`0x0c..` + `0x1c..` 系列),LongCALL 路径不发。bisheng 也未把这组 setup 暴露成 user-callable builtin。

详细实验记录会在评论里补。

### Steps to Reproduce

1. checkout PR #764 (`ChaoZheng109:fix-a5-aicore-simt-tlv`),包含 `tests/st/a5/tensormap_and_ringbuffer/simt_basic/`
2. 在 a5 实机上跑 simt_basic:
   ```bash
   task-submit --timeout 600 --max-time 600 --device auto --device-num 2 \
     --run "python -m pytest \
       tests/st/a5/tensormap_and_ringbuffer/simt_basic/test_simt_basic.py \
       --platform a5 --device \$TASK_DEVICE -v -s"
   ```
3. 观察到:
   - Orchestration `.so` 编译 ✅ (583KB)
   - AIV kernel `kernel_simt_scatter.o` 编译 ✅ (197KB,含 SIMT TLV)
   - 12 个 CANN runtime 线程 spawn(说明 runtime 已 init,chip handle 已开)
   - 接下来在 chip 上**0 输出持续 600s**,task-submit 超时 kill

### Expected Behavior

simt_basic 用例应在硬件上完成 8x32→256 elements 的 MSCATTER,golden 比对 PASS,跟 pto-isa 自家 `tests/npu/a5/src/st/testcase/mscatter` 在同硬件上的 5332ms PASS 形态一致。

具体:
- AIV 三个 block(`block_dim=3`)各自的 MSCATTER 应该把 8x32=256 float 元素按 identity 索引散写到 256-slot dst,使 `out == src`
- max diff = 0,err count = 0
- 任务在 ~10 秒内完成,不应该出现长时间静默

### Actual Behavior

```
[npu-lock] 获取设备 0 的锁 (无超时)...
[npu-lock] 已获取设备 0 的锁 (pid=...)
[npu-lock] 获取设备 1 的锁 (无超时)...
[npu-lock] 已获取设备 1 的锁 (pid=...)
============================= test session starts ==============================
platform linux -- Python 3.10.20, pytest-9.0.3, pluggy-1.6.0
collected 1 item

tests/st/a5/tensormap_and_ringbuffer/simt_basic/test_simt_basic.py::TestSimtBasic::test_run
  [V5] [Orchestration] Compilation .../simt_basic_orch.cpp.orch_*.so successful: 583600 bytes
  [V5] [Incore] Compilation .../kernel_simt_scatter.cpp.incore_*.o successful: 197840 bytes
  ───── 之后整整 600s 零输出 ─────
错误: 等待超时 (600s)
```

对照参考:

| Test | 路径 | 结果 |
|---|---|---|
| `simpler simt_basic`(本 issue 现象) | SU dispatcher → fn-pointer → user kernel → MSCATTER | ❌ 600s hang |
| `pto-isa tests/npu/a5/.../mscatter`(我用同一台 a5 硬件验证) | host `<<<1, nullptr, stream>>>` → kernel(里头 MSCATTER) | ✅ 5332ms PASS |

两者跑的是**同一段 MSCATTER 内核代码**,**唯一差别是 launch + dispatch 路径**。

### Git Commit ID

86b633cc88dd64fd3b50457ac262393048e42ec3

### CANN Version

9.1.T500 (V100R001C10B813)

### Driver Version

25.6.rc1.b108 (ascendhal 7.35.23)

### Host Platform

Linux (aarch64)

### Additional Context

- Related PR: #764(引入 simt_basic 测试 + 给 dispatcher 注入 SIMT TLV)
- 上游参考:pto-isa `tests/npu/a5/src/st/testcase/mgather/MGATHER.md` §"Runtime Dispatch Requirement"(line 377-403)已经把这条限制写明:`cce::async_invoke` 需要 launch path 在 kernel 进入前装好 TID/warp/vec-pipe scheduler 状态,标准 `rtKernelLaunch` 这么做了,fn-pointer 直接调用 skips 这一步,所以第一条 `async_invoke` 起不来 warp 调度
- pto-isa 给出三条 fix 路径(MGATHER.md line 400-402):全部需要 simpler dispatcher 侧改造
- 我们做了一整套定位实验(byte-level disasm 对比、bisheng intrinsic 全扫、host-side builtin 注入、SDAG 节点分析),会在下面评论里补全

---

## #977 [Code Health] DFX buffer sizing audit — dep_gen drops on realistic workloads, cross-subsystem capacity review

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/977
- Created: 2026-06-03T03:21:31Z
- Updated: 2026-06-25T10:41:13Z
- Closed: 2026-06-25T10:41:13Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Other (please specify in description) — DFX subsystems (dep_gen, l2_swimlane, pmu, tensor_dump, scope_stats) under `src/a2a3/platform/include/common/platform_config.h` and the AICPU collector implementations.

### Description

`PLATFORM_DEP_GEN_BUFFERS_PER_INSTANCE = 4` × `PLATFORM_DEP_GEN_RECORDS_PER_BUFFER = 32` gives only **128 in-flight records** before the device-side rotation in `dep_gen_collector_aicpu.cpp` hits `free_queue` empty and silently drops 32 records at a time (overwrite current buffer + bump `dropped_record_count`). On the realistic `paged_attention_unroll_manual_scope` Case1 workload (1024 `submit_task` calls, ~16 ms total run, burst window ~1 ms), this drops **512/1024 records = 50%**, and `dep_gen_collector.cpp:reconcile_counters()` (correctly) refuses to emit `deps.json`. The user-visible symptom is "`--enable-dep-gen` alone produces no deps.json" while paired `--enable-dep-gen --enable-l2-swimlane` works (because l2_swimlane slows the AICPU dispatch loop enough for the host mgmt thread to drain in time — an accidental coupling, not a reliable workaround).

This issue is broader than just dep_gen. The same SPSC + ProfilerBase pattern is used by all five DFX subsystems, but the sizing budgets across them are wildly asymmetric, and dep_gen is the smallest by **2000×** measured in in-flight record count, only partly explained by its larger record size. Below is the audit data + a design discussion.

#### 1. The drop path (all DFX subsystems share this contract)

\`dep_gen_collector_aicpu.cpp:97-104\`:

\`\`\`cpp
if (head == tail) {  // free_queue empty
    LOG_WARN(\"dep_gen: no free buffer, overwriting current (dropped %u records)\", full_buf->count);
    s_dep_gen_state->dropped_record_count += full_buf->count;
    full_buf->count = 0;
    return;
}
\`\`\`

Identical pattern in `l2_swimlane_collector_aicpu.cpp:switch_records_buffer()` and `pmu_collector_aicpu.cpp` (with the matching \"avoids blocking the AICPU dispatch loop\" header comment). The design philosophy is consistent and explicit: **DFX records are best-effort; orch / dispatch hot paths must never block on diagnostics**. Backpressure (spin-wait until host drains) is structurally forbidden because it would change the observed system's timing — defeating the purpose of profiling.

This is the right invariant. The bug is **sizing under this invariant**, not the invariant itself.

#### 2. Cross-subsystem sizing comparison

| Subsystem | Per-unit | BUFFERS_PER_? | RECORDS_PER_BUFFER | Record size | In-flight records (per unit) | Bytes per unit |
|---|---|---|---|---|---|---|
| l2_swimlane AICpu task | core | 8 | 1000 | 64 B | 8000 | ~500 KB |
| l2_swimlane AICore task | core | 4 | 1024 | 32 B | 4096 | ~128 KB |
| l2_swimlane phase (sched/orch) | thread | 16 | **16384** | 40 B / 32 B | **262 144** | ~10 MB |
| tensor_dump | thread | 8 | 256 | 128 B | 2048 | 256 KB |
| pmu | core | 4 | 512 | ~64 B | 2048 | ~128 KB |
| scope_stats | instance | 8 | 512 | small | 4096 | small |
| **dep_gen (current)** | **instance** | **4** | **32** | **2624 B** | **128** | **336 KB** |

dep_gen sits 16–2000× below every other subsystem on in-flight record count. The justification given in the existing comment (`platform_config.h:266`) is:

> Each DepGenRecord is ~2.3 KB ... sized to fit a typical example's submit count (~100-200) in a few buffers.

That \"typical example\" assumption (100–200 submits) is **stale**. Realistic workloads in the repo today:

- `paged_attention_unroll_manual_scope` Case1: 1024 submits / launch — already 5–10× the assumption
- `paged_attention_manual_scope` CaseSmall1: ~50 submits — within assumption
- A `qwen3_14b` decode step per-layer: substantially more

#### 3. Empirical verification (commit `20ba6a2f`, onboard a2a3 via task-submit)

| `PLATFORM_DEP_GEN_BUFFERS_PER_INSTANCE` | Dropped records | deps.json emitted? |
|---|---|---|
| 4 (default) | 512 / 1024 | ❌ |
| 16 | 384 / 1024 | ❌ |
| 64 | 0 / 1024 | ✅ (865 KB) |

So even at 16 the workload still drops 38%. The fix has to be substantial, not incremental.

#### 4. Why \"few big buffers\" beats \"many small buffers\" for dep_gen

Within the same total byte budget there are two ways to scale:

| Sizing | RECORDS_PER_BUFFER | BUFFERS_PER_INSTANCE | In-flight | Total memory | Rotations for 1024 records |
|---|---|---|---|---|---|
| Many small | 256 | 16 | 4096 | 10.7 MB | 4 |
| **Few big (proposed)** | **1024** | 4 | **4096** | **10.7 MB** | **1** |

Few-big matches the l2_swimlane phase pool philosophy (16384 records per buffer, 16 buffers). For dep_gen specifically, few-big is the better trade:

1. **Per-rotation host cost is non-trivial.** `mirror_shm_from_device` + `try_pop_aicpu_entry` + `proactive_replenish` runs every mgmt loop iteration regardless of how many records were drained. Fewer rotations → fewer mgmt loop wakeups during a burst.
2. **AICPU rotation cost scales with rotation count, not buffer size.** A single SPSC pop+push is the same work whether the buffer holds 32 or 1024 records.
3. **Failure-mode granularity is acceptable**: when a drop *does* occur, losing 1024 records is no worse than losing 32 — the reconcile path already rejects the whole deps.json (it's an all-or-nothing graph artifact, unlike per-task swimlane records that degrade gracefully).

### Location

- Sizing constants: `src/a2a3/platform/include/common/platform_config.h:266-282`
- Device-side drop path: `src/a2a3/platform/shared/aicpu/dep_gen_collector_aicpu.cpp:97-104`
- Host reconcile gate: `src/a2a3/platform/shared/host/dep_gen_collector.cpp:155-215` (`reconcile_counters`)
- Cross-subsystem reference: `src/a2a3/platform/include/common/l2_swimlane_profiling.h:496` (phase = 16384/buffer), `src/a2a3/platform/include/common/pmu_profiling.h` (pmu = 512/buffer), `src/a2a3/platform/include/common/tensor_dump.h:124` (dump = 256/buffer), `src/a2a3/platform/include/common/scope_stats.h` (scope_stats = 512/buffer)

### Proposed Fix

**Primary**: bump dep_gen's per-buffer records to align with other DFX subsystems' headroom.

\`\`\`cpp
// platform_config.h
constexpr int PLATFORM_DEP_GEN_RECORDS_PER_BUFFER = 1024;  // was 32
constexpr int PLATFORM_DEP_GEN_BUFFERS_PER_INSTANCE = 4;   // unchanged
// In-flight: 4 * 1024 = 4096 records (32× current).
// Memory: 4 buffers * 1024 records * 2624 B/record ≈ 10.7 MB per instance.
// Aligns with l2_swimlane Aicpu task pool (8000 records/core, ~500 KB)
// in capacity philosophy. Verified to eliminate drops on
// paged_attention_unroll Case1 (1024 submits).
\`\`\`

Update the stale `\"typical example's submit count (~100-200)\"` comment with measured numbers + the new headroom rationale.

**Secondary**: as part of the same PR or a follow-up, audit the other DFX subsystems against realistic workloads to confirm they have adequate headroom. The l2_swimlane phase pool already does (262K in-flight); pmu and tensor_dump may be worth re-measuring.

**Not appropriate** (explicitly considered and rejected):

- **Spin-wait backpressure on the AICPU side**: violates the \"DFX never blocks dispatch\" invariant that all five subsystems share. Would change the observed system's timing → swimlane measurements stop reflecting real workload behavior. The current \"overwrite + drop + accept count\" is the right contract.
- **Faster host drain (smaller poll sleep)**: tested via reasoning — at BUFFERS=16 the workload still drops 38%, meaning the bottleneck isn't drain frequency but pool depth.

### Priority

Medium (minor risk, should fix in next few releases) — dep_gen is opt-in (`--enable-dep-gen`), and the broken case is \"solo dep_gen on workloads >200 submits\". Users who notice silently get steered toward paired mode (which works for the wrong reason). But the silent failure mode + the broader sizing-philosophy question across DFX subsystems make it worth fixing before more subsystems hit the same wall.

Related: #860 (tensor dump host drain backpressure — same SPSC pattern), #908 (dep_gen fanout overhead), #959 (scheduler wiring deadlock — different mechanism, same hot-path-must-not-block principle).

---

## #980 [Bug] L3 Worker leaves chip child defunct after submit_next_level run

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/980
- Created: 2026-06-03T08:56:01Z
- Updated: 2026-06-09T06:21:03Z
- Closed: 2026-06-09T06:21:03Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

A level-3 `simpler.worker.Worker` used as a single-chip host worker can become unusable after a successful `Worker.run()` that submits a chip callable through `orch.submit_next_level(...)`.

In the observed PyPTO serving integration, the prefill kernel completes successfully and `Worker.run()` returns to Python, but the chip child process is already left as a defunct process while the parent `Worker` still appears initialized. Reusing the same L3 worker for the next submitted chip task, or closing/switching the worker through the normal wrapper path, hangs instead of cleanly reusing or tearing down the child. The local workaround was to treat this L3 worker as one-shot: after every submitted child task, write `_SHUTDOWN` to child mailboxes, `waitpid` the children, unlink shared-memory mailboxes, and discard the worker state before creating a new Worker for the next kernel.

This looks like a Worker lifecycle bug: either `Worker.run()` should keep the chip child alive for later runs, or `Worker.close()` / post-run cleanup should reliably reap and mark the worker unusable when the child has exited.

Related: #824

### Steps to Reproduce

Using a PyPTO Serving branch that dispatches non-L3 Qwen3 kernels through an L3 Simpler worker:

```bash
cd /data/liuxu/pypto-serving

task-submit --device auto --max-time 0 --run \
  "PTO2_RING_HEAP=4294967296 PTO2_RING_TASK_WINDOW=1048576 PTO2_RING_DEP_POOL=1048576 \
   python examples/model/qwen3_14b/npu_generate.py \
     --model-dir /data/linyifan/models/Qwen3-14B \
     --prompt 'Huawei is' \
     --platform a2a3 \
     --max-seq-len 512 \
     --max-new-tokens 5"
```

The serving-side dispatch shape is roughly:

```python
worker = Worker(
    level=3,
    platform="a2a3",
    runtime="tensormap_and_ringbuffer",
    device_ids=[device_id],
    num_sub_workers=0,
)
cid = worker.register(chip_callable)
worker.init()

def orch_fn(orch, _args, _cfg):
    task_args = TaskArgs()
    # host tensors and/or child_memory ContinuousTensor args
    orch.submit_next_level(cid, task_args, call_config, worker=0)

worker.run(orch_fn)
# The chip child is observed as defunct here, while the Worker object is still considered initialized.
# A later worker.run(...) or normal close/switch path hangs.
```

### Expected Behavior

After a successful `Worker.run()`:

- the level-3 worker should remain reusable for a later `Worker.run()` on the same chip child, or
- if the child process exits, the Worker should detect/reap it and report a clear unusable/closed state, and
- `Worker.close()` should not hang after the child has already exited.

### Actual Behavior

The first submitted prefill task completes:

```text
[chip_process pid=574954 dev=4] ready
[timing] prefill: fused 40 layers, 9574.72 ms
```

Immediately afterward, process inspection shows the child process as defunct while the parent Python process remains alive with the Worker still in use:

```text
554986 ... python examples/model/qwen3_14b/npu_generate.py ... --device 4
574954 554986 Z [python] <defunct>
```

The parent then makes no progress into the next decode task. In repeated checks it had to be killed manually. Before the one-shot discard workaround, this blocked offline generation after prefill. With the manual one-shot discard/recreate workaround, the same generation completed:

```text
text:  a Chinese company. The
token_ids: [264, 8453, 2813, 13, 576]
finish_reason: length
```

A separate resource-related symptom was also observed with small ring settings (`PTO2_RING_HEAP=536870912 PTO2_RING_TASK_WINDOW=131072 PTO2_RING_DEP_POOL=131072`): prefill can fail with AICPU `507018`. The lifecycle bug above was reproduced with the larger ring settings where prefill itself succeeds.

### Git Commit ID

293e88a3277f7fab61b042a4762a29462af58b79

### CANN Version

9.0.0 (`Ascend-cann-toolkit`, `innerversion=V100R001C10SPC001B250`)

### Driver Version

`npu-smi` reports version `26.0.rc1`.

### Host Platform

Linux (aarch64)

### Additional Context

The workaround currently used in PyPTO Serving adds a wrapper-level best-effort discard path for one-shot L3 workers:

- write `_SHUTDOWN` into `_sub_shms`, `_chip_shms`, and `_next_level_shms`
- `waitpid` child PIDs
- close/unlink mailbox shared memory
- clear `_worker`, `_orch`, child PID/shm lists, and initialized state

That avoids the hang but relies on Simpler private internals, so the lifecycle should be fixed or exposed as a supported API in Simpler.


---

## #982 [Bug] Producer GM store tail not visible to a later cross-scope MTE-load under concurrent readers (a2a3) — open tail of pypto#1648

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/982
- Created: 2026-06-03T09:23:37Z
- Updated: 2026-06-17T10:07:20Z
- Closed: 2026-06-17T10:07:20Z
- Labels: bug

### Body

### Description

A GM tensor **produced by a scope** and then **read by a later scope's MTE-load** is released to the consumer **before the producer's trailing GM store bursts are globally visible**, so the consumer reads zero-init data in the *tail* of the tensor. The compile-time dependency edge is present and correct — this is a **runtime store-completion / visibility** issue, not a missing edge.

It is the still-open tail of pypto#1648 (closed as fixed by the runtime bump to `49012fd9`, but only *narrowed*). Two new experiments isolate it precisely:

- **Not consumer-specific.** Both an **AIC cube** matmul-RHS load and an **AIV vec** load of the same vec-produced tensor race (same fail rate, same signature). So it is not a cube-MTE gating issue — the producer store must be fenced for *any* consumer.
- **Scales with producer store size; only the tail is corrupted.** Stores ≤ ~one burst never race; above a threshold (between 4 KB and 8 KB for this shape) the race appears and becomes deterministic as the store grows, and the wrong region is always the **last few rows** (the final store burst(s)).

Likely the same family as #961 / #967 (non-deterministic cross-scope corruption on a2a3); filing separately because the trigger here is specifically a **single producer → many concurrent readers of one whole tensor**, with the corruption localized to the store tail.

### Steps to Reproduce

Three minimal `@pl.jit` repros (in `pypto-lib` `models/deepseek/v4/`). Each builds an identity `W` in-kernel (vec `arange+cmp+cast`) in a CORE_GROUP scope, then reads it from `NR` concurrent `pl.spmd` tasks. A control reads the **same `W` passed as a kernel input** (no producer) and always passes.

```python
# build identity W in-kernel into GM (one CORE_GROUP vec scope)
w_build = pl.create_tensor([K, N], dtype=pl.BF16)
with pl.at(level=pl.Level.CORE_GROUP, name_hint="build_w"):
    ones  = pl.full([K, N], dtype=pl.FP32, value=1.0)
    col   = pl.col_expand_mul(ones, pl.cast(pl.arange(0,[1,N],dtype=pl.INT32), target_type=pl.FP32))
    row   = pl.cast(pl.reshape(pl.arange(0,[1,K],dtype=pl.INT32),[K,1]), target_type=pl.FP32)
    w_build[:, :] = pl.cast(pl.cmp(col, pl.row_expand_mul(ones,row), cmp_type=0), target_type=pl.BF16)

# CUBE consumer (race2): W as matmul RIGHT operand, NR concurrent readers
for rb in pl.spmd(NR, name_hint="cube_inkernel"):
    out[rb*RB : rb*RB+RB, :] = pl.matmul(a[rb*RB:rb*RB+RB, :], w_build[:, :], out_dtype=pl.FP32)  # == a (W=I)

# VEC consumer (race3): pure vec read of W, NR concurrent readers
for rb in pl.spmd(NR, name_hint="vec_inkernel"):
    out_vec[rb*K : rb*K+K, :] = pl.mul(pl.cast(w_build[:, :], target_type=pl.FP32), 2.0)          # == 2*I
```

- `_tmp_rhs_race2.py` — cube consumer, `NR=32`. Run ~10×.
- `_tmp_rhs_race3.py` — vec consumer, `NR=32`. Run ~10× (cube-only vs vec-only must be **separate** kernels: co-locating a vec reader incidentally fences the cube one).
- `_tmp_rhs_raceB.py` — vec consumer, `W` dims via env `RHS_K`/`RHS_N`. Sweep store size.

Run on real `a2a3` (`PYTHONPATH=<pypto-lib> python _tmp_rhs_race2.py -p a2a3 -d <dev>`). The original single-consumer repro `_tmp_rhs_race.py` is too narrow (can pass 20/20 on an idle device) — the amplifier is **many concurrent readers**.

### Expected Behavior

`out_inkernel == out_param`. The consumer must see the producer's complete store (`W == I`), so cube → `a`, vec → `2*I`, on every run.

### Actual Behavior

`out_inkernel` is intermittently/deterministically wrong; the control `out_param` always passes.

**Experiment A — consumer type (same batch, NR=32, separate kernels):**

| consumer | FAIL rate | control (`W` as input) |
|---|---|---|
| cube (matmul-RHS) | 4/6 | 6/6 PASS |
| vec (`2*W`) | 5/6 | 6/6 PASS |

Same tail signature: cube fails on `W`'s last **columns** (RHS load into L0B), vec on `W`'s last **rows** (row-major tile into UB) — both the **tail of the producer store**.

**Experiment B — producer store size (vec consumer, NR=32):**

| `W [K,N]` | store | result | corrupted region |
|---|---|---|---|
| [16,16] | 512 B | 4/4 PASS | — |
| [64,32] | 4 KB | 4/4 PASS | — |
| [64,64] | 8 KB | 2/4 FAIL | last 4 rows |
| [64,128] | 16 KB | 4/4 FAIL | last 2 rows |
| [64,256] | 32 KB | 4/4 FAIL | last 4 rows |

Store ≤ ~one burst never races; above a 4 KB–8 KB threshold it races and becomes deterministic as the store grows; only the trailing burst(s) are corrupted (`actual=0.0`).

**dep-gen (`--enable-dep-gen`) on a failing run** shows the RAW edge is present and covered:

```
build_w (writes w_build) -> consumer (reads w_build)   source=tensormap
consumer waits on [creator, build_w];  control waits on []   (correct)
```

So the orchestration graph is correct — the gap is runtime store-completion ordering.

### Git Commit ID

simpler `49012fd9c0dede59d35e0a9ad9932fb952d1b3c7` (pypto `468a51eb`, the version that closed pypto#1648). The partial fix appears to be runtime #855 (FlushGuard in dispatch) — it covers the leading store but not the trailing bursts under concurrent multi-consumer dispatch.

### CANN Version

cann-9.0.0

### Driver Version

(not collected)

### Host Platform

aarch64 Linux

### Additional Context

Platform: **a2a3** (real device). Runtime variant: PTO2 ring.

**Suggested direction:** the consumer-release condition must guarantee the producer's **entire multi-burst GM store** is globally visible (a full store fence), not just that the producer task reached completion / its first burst landed — and it must apply to **all** dependent MTE consumers (cube and vec), not only the cube load path.

**Real-world impact:** blocks the in-kernel matmul-RoPE re-interleave in DeepSeek-V4 decode (`decode_qkv_proj_rope.py`): with the interleave-select matrix built in-kernel and consumed as a matmul RHS, `q` is intermittently wrong (~0.78%) / deterministically wrong (~0.98%). Workaround: pass the matrix as a kernel input. See pypto#1648.


---

## #984 [Performance] Streaming orchestrator design space (a2a3/a5/Host/HW)

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/984
- Created: 2026-06-04T03:05:24Z
- Updated: 2026-06-04T11:10:30Z
- Labels: performance

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

Tracking issue for the a2a3 `tensormap_and_ringbuffer` orchestrator. Captures a `PTO2_ORCH_PROFILING=1` measurement baseline of the per-task submit hot path, side-by-side numbers for the auto-dependency (`paged_attention_unroll`) and manual-dependency (`paged_attention_unroll_manual_scope`) variants on the same workload, and the architectural background needed to interpret them.

The intent of this issue is characterization, not regression reporting. Concrete evolution directions are posted as separate comments.

Related: #545 (overall runtime perf tracking — scheduler / dispatch / runtime-wrapping side), #849, #902.

### Git Commit ID

60742ff844c1d79998dc5739c57b61a671373a35

### CANN Version

9.0.0 (V100R001C10SPC001B250)

### Driver Version

26.0.rc1 (ascendhal_version 7.35.23)

### Host Platform

Linux (aarch64)

### Reproduction

```bash
# 1. Enable orchestrator + tensormap profiling
#    (src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2_types.h)
#      #define PTO2_ORCH_PROFILING        1
#      #define PTO2_TENSORMAP_PROFILING   1
# 2. Rebuild the a2a3 onboard runtime
python3 -m venv --system-site-packages .venv && source .venv/bin/activate
pip install --no-build-isolation -e .
python simpler_setup/build_runtimes.py --platforms a2a3

# 3. Run the auto-dep variant on a free a2a3 device
task-submit --device auto --device-num 1 --run "source .venv/bin/activate && \
    python -m pytest \
        tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_unroll/test_paged_attention_unroll.py \
        --platform a2a3 --device \$TASK_DEVICE -v -s --log-level v9 --enable-l2-swimlane 4"
# Inspect device log for the '=== Orchestrator Profiling' block:
ls -lt $HOME/ascend/log/debug/device-<id>/ | head -3

# 4. Repeat with the manual-scope variant
task-submit --device auto --device-num 1 --run "source .venv/bin/activate && \
    python -m pytest \
        examples/a2a3/tensormap_and_ringbuffer/paged_attention_unroll_manual_scope/test_paged_attention_unroll.py \
        --platform a2a3 --device \$TASK_DEVICE -v -s --log-level v9 --enable-l2-swimlane 4"
```

Both tests use the same `Case1` parameters (`batch=256, num_heads=16, kv_head_num=1, head_dim=128, block_size=128, context_len=8192, max_model_len=32768, dtype=bfloat16`, `aicpu_thread_num=4`, `block_dim=24`).

### Additional Context

#### 1. What the orchestrator does

Single AICPU thread (Thread 3 of 4 on a2a3). Per `runtime/pto_orchestrator.h:11-26`: executes the user orchestration function, allocates intermediate buffers from the GM heap (heap ring), submits tasks via `PTO2OrchestratorState::submit_task` (real work), `submit_dummy_task` (barrier), or `alloc_tensors` (inline-complete buffer carve-out), builds the dependency graph through TensorMap or `explicit_deps`, and manages scopes via `PTO2_SCOPE`. It is not an executor — it writes records into shared memory and pushes opaque slot-state pointers onto a single SPSC wiring queue; the scheduler threads do all fanout wiring, list maintenance, and watermark advancement.

#### 2. Two components: runtime interface and user code

The runtime is split into a function-pointer ops table and the user `.so` that calls it through that table. There is no link dependency: AICPU Thread 3 dumps the orchestration `.so` to a temp file, `dlopen`s it, looks up `aicpu_orchestration_config` and `aicpu_orchestration_entry`, the runtime populates `rt->ops`, and the user code calls back via `current_runtime()->ops->submit_task` (etc.).

- **Runtime interface**: `src/a2a3/runtime/tensormap_and_ringbuffer/orchestration/pto_orchestration_api.h` — opaque `struct PTO2Runtime { const PTO2RuntimeOps *ops; PTO2ScopeMode pending_scope_mode; }`, the `PTO2RuntimeOps` function table (`submit_task`, `scope_begin/end`, `alloc_tensors`, `submit_dummy_task`, logging, `set_tensor_data`/`get_tensor_data`, fatal handling), inline `rt_submit_*_task` wrappers, the `Arg` builder, and `PTO2_SCOPE(...)` RAII.
- **User code**: `examples/.../paged_attention_orch.cpp` exports exactly `aicpu_orchestration_entry` (and `_config`). Includes only `pto_orchestration_api.h`. Zero runtime symbol dependencies.

#### 3. Six phases of one task submission

All happen inside `submit_task_common` (`runtime/pto_orchestrator.cpp:507-688`), instrumented by `CYCLE_COUNT_LAP` calls:

1. **Alloc** (`g_orch_alloc_cycle`) — task ring slot allocation, heap ring packed-output allocation, `prefetch_payload`, `bind_buffers`, `task_state.store(PENDING)`, `scope_tasks_push`. Blocks on back-pressure here.
2. **sync_tensormap** (`g_orch_sync_cycle`) — acquire-load `fc.last_task_alive`, possibly `cleanup_retired` every `PTO2_TENSORMAP_CLEANUP_INTERVAL=64` retired tasks.
3. **lookup+dep** (`g_orch_lookup_cycle`) — explicit_deps loop (retire-skip + fanin append) and `compute_task_fanin` (`pto_dep_compute.h:81-129`): per non-OUTPUT tensor, Step A creator retention from `tensor->owner_task_id`, then Step B `tensor_map.lookup` — hash-bucket walk + `check_overlap` cascade (L1 byte-range, L2 hyper-rectangle, L3 conservative-OTHER). INOUT+COVERED removes the entry. Inline fanin builder caps at `PTO2_FANIN_INLINE_CAP`, spills to fanin_pool above that.
4. **tensormap_ins** (`g_orch_insert_cycle`) — `register_task_outputs` (`pto_dep_compute.h:140-154`): for each INOUT and OUTPUT_EXISTING, allocate entry from free list or bump region, 64-byte `copy_from_tensor` memcpy, hash-bucket and per-task chain prepends.
5. **param_copy** (`g_orch_args_cycle`) — `task.task_id` / `kernel_id[3]` / `packed_buffer_*` writes, per-producer `fanout_count++`, fanin metadata into payload, and `payload.init(args, result, alloc_result, layout)` — the actual tensor + scalar deep copy into the GM payload that AICore will read.
6. **fanin+ready** (`g_orch_fanin_cycle`) — single SPSC push of the slot-state pointer to `sched->wiring.queue`. The actual fanout wiring (lock + dep_pool prepend + early-finished check + ready-queue push) is deferred to scheduler thread 0's `drain_wiring_queue` (`scheduler/pto_scheduler.h:671-711`).

`scope_end` cost is tracked separately (`g_orch_scope_end_cycle`) — iterates scope tasks and calls `scheduler->on_scope_end` to release the +1 scope reference on each producer's `fanout_count`.

Raw device-log excerpts on the 1280-task Case1 workload (verbatim, paths anonymized):

```text
# paged_attention_unroll (auto-dep, PTO2_SCOPE())
Thread 3: === Orchestrator Profiling: 1280 tasks, total=646.960us ===
Thread 3:   task+heap_alloc: 171.280us (26.5%)  work=171.280us wait=0.000us  atomics=1280
Thread 3:   sync_tensormap : 56.400us (8.7%)
Thread 3:   lookup+dep     : 80.720us (12.5%)
Thread 3:   tensormap_ins  : 70.520us (10.9%)
Thread 3:   param_copy     : 235.600us (36.4%)  atomics=2048
Thread 3:   fanin+ready    : 32.440us (5.0%)  work=32.440us wait=0.000us
Thread 3:   avg/task       : 0.505us
Thread 3: === TensorMap Lookup Stats ===
Thread 3:   lookups        : 3584, inserts: 768
Thread 3:   chain walked   : total=11, avg=0.0, max=1
Thread 3:   overlap checks : 0, hits=0 (0.0%)
Thread 3: PTO2 total submitted tasks = 1280, already executed 1256 tasks
```

```text
# paged_attention_unroll_manual_scope (manual deps, PTO2_SCOPE(PTO2ScopeMode::MANUAL))
Thread 3: === Orchestrator Profiling: 1280 tasks, total=486.820us ===
Thread 3:   task+heap_alloc: 161.580us (33.2%)  work=161.580us wait=0.000us  atomics=1280
Thread 3:   sync_tensormap : 33.080us (6.8%)
Thread 3:   lookup+dep     : 19.360us (4.0%)
Thread 3:   tensormap_ins  : 3.520us (0.7%)
Thread 3:   param_copy     : 252.120us (51.8%)  atomics=2048
Thread 3:   fanin+ready    : 17.160us (3.5%)  work=17.160us wait=0.000us
Thread 3:   avg/task       : 0.380us
Thread 3: === TensorMap Lookup Stats ===
Thread 3:   lookups        : 256, inserts: 0
Thread 3:   chain walked   : total=0, avg=0.0, max=0
Thread 3:   overlap checks : 0, hits=0 (0.0%)
Thread 3: PTO2 total submitted tasks = 1280, already executed 1051 tasks
```

#### 4. TensorMap cost and sequentiality

The orchestrator is one thread, so steps 2/3/4 run strictly in order with no pipelining: N tasks back-to-back cost N×(sync + lookup + insert). The TensorMap is private to the orchestrator (no atomics), so there's no contention — but also no parallelism. Auto-dep mode runs `compute_task_fanin` and `register_task_outputs`; manual-dep mode short-circuits both (`pto_dep_compute.h:84-86` and `:142-144`). That's why the manual run shows `inserts=0` and `lookups=256` (only one trivial lookup per submit, no chain walked, no overlap check).

Side-by-side per-phase breakdown on the same 1280-task Case1 workload, same commit, both runs on a free a2a3 device under `task-submit` exclusive lock:

| Phase | unroll (auto-dep) | unroll_manual_scope | Δ |
|---|---:|---:|---:|
| `total` (sum of phases) | **646.96 us** | **486.82 us** | **-24.8%** |
| `avg/task` | **0.505 us** | **0.380 us** | **-24.8%** |
| `task+heap_alloc` | 171.28 us (26.5%) | 161.58 us (33.2%) | -5.7% |
| `sync_tensormap` | 56.40 us (8.7%) | 33.08 us (6.8%) | -41.3% |
| `lookup+dep` | **80.72 us (12.5%)** | **19.36 us (4.0%)** | **-76.0%** |
| `tensormap_ins` | **70.52 us (10.9%)** | **3.52 us (0.7%)** | **-95.0%** |
| `param_copy` | 235.60 us (36.4%) | 252.12 us (51.8%) | +7.0% |
| `fanin+ready` | 32.44 us (5.0%) | 17.16 us (3.5%) | -47.1% |

TensorMap-internal stats:

| Stat | unroll (auto-dep) | unroll_manual_scope |
|---|---:|---:|
| lookups | **3584** | 256 |
| inserts | **768** | 0 |
| chain walked total / avg / max | 11 / 0.0 / 1 | 0 / 0.0 / 0 |
| overlap checks / hits | 0 / 0 | 0 / 0 |

Observations:
- `param_copy` stays the largest single phase in both runs (36-52%) — the unavoidable Tensor + scalar deep copy into the GM payload, tensormap-independent.
- Eliminating TensorMap collapses two phases (`lookup+dep` + `tensormap_ins`) from a combined **151.24 us (23.4%)** to **22.88 us (4.7%)**, a 128.36 us / 19% absolute drop on `total`.
- `sync_tensormap` does not go to zero in manual mode because it is unconditional (`pto_orchestrator.cpp:574-578`) — it still loads `last_task_alive` and may run `cleanup_retired` even with zero inserts.
- `fanin+ready` drops 47% — orch is pushing fewer slot states through the SPSC wiring queue because explicit deps don't synthesize redundant edges.
- `task+heap_alloc` is essentially flat — the ring buffers are uncontested at this 1280-task / 16K-window scale.
- The 3584 lookups in the auto run come from the 4-tensor-input per submit × 1280 submits × ~0.7 non-OUTPUT-tensor fraction. Even with max chain length of 1 and zero overlap checks (this workload's tensors don't share base addrs in the same hash bucket — unsurprising for paged attention), the per-lookup cost is non-trivial because `lookup` always pays the hash + cache-line fetch + iterate cost.

#### 5. Orch ↔ scheduler interaction factors

Two distinct cost regimes for orch↔sched data sharing on the hot path:

- **Factor A — Write-once-by-orch, read-by-sched payload (capacity-bound, small)**: `PTO2TaskDescriptor`, `PTO2TaskPayload`, and the per-slot `PTO2TaskSlotState` payload/task pointers are written once by the orchestrator at step 5, read once by the scheduler at dispatch (and again by AICore at execute). No coherence ping-pong: orch dirties, sched reads. Per-task payload is bounded (≤16 tensors + ≤16 scalars), and active payload working set fits in L2 by design — `task_window_size` is small, default 16384/ring, often as small as 16. Cost: bandwidth only.
- **Factor B — Shared coordination cache lines (coherence-bound, big)**: lines that both threads write or one writes and the other reads on the hot path force snoop / invalidation round-trips. The hot lines are:
  - `PTO2RingFlowControl` (`pto_shared_memory.h:54-76`) — `current_task_index` and `last_task_alive` are on separate 64B-aligned lines on purpose, so each is single-writer.
  - `PTO2TaskSlotState` (`pto_runtime2_types.h:316-398`) — single 64B line carrying both orch-managed (`task_state=PENDING`, `bind_buffers`, `active_mask`, `fanout_count` increments on producers) and sched-managed (`task_state=COMPLETED/CONSUMED`, `fanout_refcount`, `fanin_refcount`, `fanin_count`) fields. Pings on every fan-out edge.
  - `sched->wiring.queue` slot lines — orch pushes (step 6), sched batch-pops (`drain_wiring_queue`). One ping per submit.

Factor B is what scales with fan-out density. The recent deferred-wiring redesign (orch no longer takes `fanout_lock` per producer, no longer allocates `dep_pool`) was a targeted cut on this; the remaining orch-side coherence work is the per-producer `fanout_count++` increment. Auto-dep mode pays more on this dimension too, because every discovered TensorMap edge becomes a fanout_count++ on the producer slot's hot cache line. Manual mode discovers fewer redundant edges → fewer pings.

---

Evolution directions are discussed in follow-up comments below.



---

## #991 [Feature] Improve scope_stats HTML readability and add dep_pool channel

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/991
- Created: 2026-06-05T01:59:10Z
- Updated: 2026-06-09T09:50:27Z
- Closed: 2026-06-09T09:50:27Z
- Labels: enhancement

### Body

### Summary

Improve the `scope_stats` HTML report so resource pressure is easier to read
at a glance, and add a `dep_pool` resource channel alongside the existing Task
window, Heap, and TensorMap views.

### Motivation / Use Case

The current `scope_stats.html` output already exposes useful per-scope resource
data, but the first-screen summary, peak table, formulas, and charts can be
hard to interpret without prior knowledge of the raw fields. Users need the
report to make the important result stand out quickly:

- whether collection was healthy;
- which resource is closest to capacity;
- which scope and source site caused the peak;
- how high water, live-at-exit, and scope allocation evolve across scopes.

In addition, dependency-pool pressure is currently not surfaced as a first-class
HTML resource channel. That leaves an important runtime resource invisible when
debugging backpressure or dependency scheduling pressure in
`tensormap_and_ringbuffer`.

### Proposed API / Behavior

- Add `dep_pool` parsing, peak extraction, summary rows, and charts to the
  `scope_stats` HTML path.
- Present resources in a consistent order: Task window, Heap, Dep pool, and
  TensorMap.
- Make the top summary focus on the most actionable fields: collection health,
  total paired scopes, ring depth count, dominant scope site, and max-use
  resource.
- Improve chart readability with dynamic axes, clearer grid/ticks, hover
  coordinates, highlighted hover points, and click-to-expand charts.
- Make the formula/legend guide explain the main plotted metrics:
  high water, live at exit, and scope allocation.
- Keep the report compact and readable, with peak values, capacity, percent
  use, peak scope, and peak source site visible near each resource chart.

### Alternatives Considered

- Keep `dep_pool` only in raw JSONL: rejected because users need the HTML report
  to be the primary DFX entry point.
- Add more raw fields to the page without reorganizing the summary/charts:
  rejected because it increases information density without improving
  readability.

### Additional Context

This request came from polishing `scope_stats.html` output for
`paged_attention_unroll` under `tensormap_and_ringbuffer`.

Related: #902

Current commit while filing: `b69f70997f473c2f8b268d7b5a3dec95468ac2d1`.
Host platform: Linux (aarch64).


---

## #995 [Tracking] DFX (Diagnostics) capability overview & roadmap

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/995
- Created: 2026-06-05T08:07:06Z
- Updated: 2026-06-18T09:28:50Z

### Body

This issue tracks **DFX (diagnostics / observability) support in `simpler`** — what is
implemented today, where it is documented, and the open work. Previously scattered DFX
issues are now attached as **sub-issues** below (the panel auto-updates as items are added
or closed).

## Current capabilities

`simpler` ships **five DFX features**, all on **a2a3** and **a5**. Each is enabled per run
via a flag in `src/common/task_interface/call_config.h` (or the matching pytest CLI flag)
and writes under the run's `output_prefix` (required whenever any flag is on). All five are
documented under `docs/dfx/`.

| Feature | Description | Enable | Output | Tool |
| ------- | ----------- | ------ | ------ | ---- |
| **Args Dump** | Per-task input/output tensor **+ scalar arg values** | `--dump-args` 0/1/2/3 | `args_dump/*.json`+`.bin` | dump_viewer.py *(manual)* |
| **L2 Swimlane** | Per-task **timeline** + scheduler phases | `enable_l2_swimlane` 0–4 | `l2_swimlane_records.json` | swimlane_converter.py *(auto)* |
| **PMU** | AICore **hardware counters** | `enable_pmu` 1–8 | `pmu.csv` | — |
| **Dep Gen** | Full **dependency graph** | `enable_dep_gen` | `deps.json` | deps_viewer.py *(auto)* |
| **Scope Stats** | Per-scope **resource peaks** *(T&R only)* | `enable_scope_stats` | `scope_stats/scope_stats.jsonl` | scope_stats_plot.py *(auto)* |

### Args Dump
Captures every task's input/output tensor values **and scalar input values** to disk.
**Use it for correctness / numerical bugs** — wrong results, NaNs, locating which task
produced bad data. Levels: `0` off, `1` only args marked with `Arg::dump()`, `2` all tasks
(JSON manifest + BIN payload), `3` (`FULL_JSON_ONLY`) all tasks but metadata-only — no
`.bin` payload, for when shapes/dtypes/strides are enough.
- **Doc:** `docs/dfx/tensor-dump.md`
- **Output:** `args_dump/args_dump.json` (manifest) + `args_dump.bin` (payload); scalar
  entries are manifest-only (`kind: scalar`).
- **Tool:** `simpler_setup/tools/dump_viewer.py` — extract/filter dumped args (by task /
  stage / role / arg). **Manual**: the runtime writes the files; you run the viewer yourself.
- **Abnormal path:** the dump still flushes on a hang / op-timeout — you get the inputs of
  every dispatched task plus the outputs of every task that completed before the hang.

### L2 Swimlane
Per-task timeline plus AICPU dispatch/scheduler phases. **Use it for latency & scheduling
cost** — where time goes, dispatch overhead, serialization, the long-pole task. Levels
`0–4` add progressively more phase detail.
- **Doc:** `docs/dfx/l2-swimlane-profiling.md`
- **Output:** `l2_swimlane_records.json` (raw) → Perfetto-trace JSON
- **Tool:** `simpler_setup/tools/swimlane_converter.py` — **auto-run** by the test framework
  after each case; produces the Perfetto trace and joins `dep_gen` edges when present.
- **Scheduler-overhead model:** `simpler_setup/tools/sched_overhead_analysis.py` (text
  report) and `swimlane_converter --overhead` (Perfetto counter track) attribute wasted
  makespan vs. busy/dependency-limited time. See `docs/dfx/sched-overhead-model.md`.
- **Device-log timing:** `--enable-device-log-timing` parses orch/sched/total timing from
  the device log via `simpler_setup/tools/device_log_timing.py`; host_wall/device_wall
  RunTiming numbers are documented in `docs/dfx/l2-timing.md`.

### PMU
AICore hardware performance counters (pipe utilization, memory, L2 cache, …); event type
selected by `enable_pmu` 1–8. **Use it for kernel micro-performance** — compute- vs
memory-bound, pipeline stalls.
- **Doc:** `docs/dfx/pmu-profiling.md`
- **Output:** `pmu.csv` (per-task counter rows)
- **Tool:** none — read the CSV directly.

### Dep Gen
The complete per-submit dependency graph (tasks, tensors, edges), built by host replay.
**Use it for dependency / scheduling correctness** — missing or wrong deps, fan-in
truncation, deadlock structure.
- **Doc:** `docs/dfx/dep_gen.md`
- **Output:** `deps.json`
- **Tool:** `simpler_setup/tools/deps_viewer.py` — **auto-run** by the framework after each
  dep-gen case; renders `deps.json` into a `deps_viewer.txt` report (and a pan/zoom HTML
  dependency graph).

### Scope Stats *(tensormap_and_ringbuffer runtime only)*
Per-`PTO2_SCOPE` resource peaks — task-window slots, heap bytes, tensormap entries. **Use
it for resource sizing / exhaustion** — ring-buffer or heap overflow, capacity tuning.
- **Doc:** `docs/dfx/scope-stats.md`
- **Output:** `scope_stats/scope_stats.jsonl`
- **Tool:** `simpler_setup/tools/scope_stats_plot.py` — **auto-run** by the framework;
  produces an HTML report with SVG charts.

**Framework:** `docs/profiling-framework.md`, `docs/profiling-name-map.md`,
`docs/dfx/sched-overhead-model.md`, `docs/dfx/l2-timing.md`. 
**Tests:**
`tests/st/a2a3/tensormap_and_ringbuffer/dfx/` (all five),
`tests/st/a5/tensormap_and_ringbuffer/dfx/` (dep_gen).

## Open work

See the **sub-issues panel** above — kept current automatically as items are attached or
closed.


---

## #996 [Code Health] scope_stats heap-ring wrap: scope_high_water / scope_alloc miscompute when heap_top < heap_tail

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/996
- Created: 2026-06-05T08:44:37Z
- Updated: 2026-06-17T03:46:38Z
- Closed: 2026-06-17T03:46:38Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Other — DFX / `scope_stats` (heap ring usage accounting)

### Description

`scope_stats` snapshots each ring's head/tail at every `PTO2_SCOPE` boundary and reports usage
as `end - start` deltas. This is correct for the **task_window** ring (`task_head`/`task_tail`
are monotonic sequence numbers, so `head >= tail` always), but not for the **heap** ring, whose
`heap_top_`/`heap_tail_` are **wrapping byte offsets** in `[0, heap_size)`. Two consequences:

1. The on-device contract comment ("`heap_end - heap_start` is bytes in use") is wrong once the
   heap has wrapped (`heap_end < heap_start`), so any consumer that subtracts the raw fields gets
   a garbage/negative value. The Python plotter compensates with a single-fold wrap correction,
   which only happens to be enough for instantaneous occupancy (always `< capacity`).

2. The span/cumulative metrics are not recoverable from two wrapped snapshots. `scope_alloc` and
   `scope_high_water` are not bounded by capacity: a scope whose cumulative heap throughput
   exceeds `heap_size` wraps more than once, and the wrapped end/begin offsets can no longer
   reconstruct the true value. (Backpressure bounds *instantaneous* occupancy, not per-scope
   throughput.) Separately, `scope_high_water = end.top - begin.tail` is not even a true peak in
   the no-wrap case — it is the total address span touched, an upper bound, not the realized peak.

### Location

- `src/common/platform/include/common/scope_stats.h:72-89` — contract comment + raw heap fields
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.h:183-206` — monotonic task
  head/tail vs wrapping heap top/tail
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp:443-448,466-471` —
  capture site
- `simpler_setup/tools/scope_stats_plot.py:65-67,88-94` — metrics + single-fold wrap correction
- a5 mirror: `src/a5/runtime/tensormap_and_ringbuffer/runtime/{pto_ring_buffer.h,pto_orchestrator.cpp}`

### Proposed Fix

Record **monotonic (non-wrapping) heap accounting** at the scope boundary instead of the raw
wrapping `heap_top_`/`heap_tail_`, so every metric becomes an exact subtraction and the Python
wrap correction can be removed. Relabel `scope_high_water` to reflect what it actually is (an
upper bound on occupancy, not an observed peak). The task_window ring needs no change. Keep a5
in sync and add a regression test for a scope that wraps the heap more than once.

### Priority

Medium (minor risk, should fix in next few releases)

---

Tracked under #995. Distinct from #991 (HTML readability / dep_pool channel) and #902 (per-task
granularity).


---

## #997 [Feature] DFX global backpressure mode (block-on-contention instead of dropping records)

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/997
- Created: 2026-06-05T09:14:20Z
- Updated: 2026-07-13T06:56:48Z
- Labels: enhancement

### Body

### Summary

Add an opt-in **global backpressure mode** for DFX device→host data transfer. Today all five
DFX subsystems are lossy by design: when the device (AICPU) cannot get a free buffer
(`free_queue` empty / `ready_queue` full) it drops the record and only bumps
`dropped_record_count`. The proposal: instead of dropping, the device **blocks until the host
has fully drained**, then resumes — trading scattered data loss for a single contiguous gap.

### Motivation / Use Case

The current drop-on-contention design (chosen to avoid stalling the orchestrator hot path)
scatters holes throughout the DFX output. Scattered loss corrupts results that depend on
completeness — e.g. a dep_gen graph missing edges, or a swimlane trace missing tasks — and is
hard to interpret. A clean contiguous gap is far more usable: the data on both sides is complete
and correct, and only a known window is missing. Partial-but-correct beats complete-looking-but-lossy.

### Proposed API / Behavior

- Opt-in flag (alongside the existing `enable_*` DFX flags) that switches all DFX subsystems
  from drop-on-contention to block-on-contention.
- When the device cannot acquire a buffer, it backpressures until the host has **fully drained**
  (not just freed one buffer), then resumes with the full buffer pool. Draining to empty before
  resuming batches many small stalls into a few clean ones, so the gap count stays low.
- The DFX result shows one contiguous blank window per stall; everything before and after stays
  consistent. Users accept the gap.

Direction only — implementation left open.

### Alternatives Considered

Current behavior (drop + record `dropped_record_count`): non-blocking but produces scattered,
result-corrupting loss.

### Additional Context

Two things the implementation must keep in mind (not a design spec):

- **Deadlock risk** — same class as #959 (full tensor-dump backpressure deadlocking
  dep_pool/wiring). The host drain path must always be able to make progress while the device is
  blocked.
- **Structural vs timeline data react differently to a gap** — a swimlane gap is just a blank
  span, but a dep_gen gap that drops a task referenced by later records can make the graph
  inconsistent. The gap should land on a clean boundary so the post-gap graph/trace stays valid.

Tracked under #995.


---

## #998 [Performance] Benchmark high-perf Paged Attention (#899) vs PA unroll on a2a3

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/998
- Created: 2026-06-05T09:23:50Z
- Updated: 2026-06-26T01:43:04Z
- Closed: 2026-06-26T01:43:04Z
- Labels: performance

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

#899 added a **high-performance Paged Attention** variant
(`spmd_paged_attention_highperf`). We need to benchmark it against the existing **PA unroll**
variant (`paged_attention_unroll`) on a2a3 and determine which is faster (and under which
shapes), so we can decide which to keep / recommend.

### Git Commit ID

f2578501b9a52dae464f054872fb8de462453522

### Host Platform

Linux (aarch64)

### Reproduction

Run both on the same locked device(s) and compare. (Wrap onboard runs in `task-submit`; gate
the arch with `onboard-arch-precheck`.)

```bash
.claude/skills/onboard-arch-precheck/check.sh a2a3 || exit 1

# High-perf PA (#899)
task-submit --device auto --device-num 1 --run "\
  python tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/test_spmd_paged_attention_highperf.py \
    -p a2a3 -d \$TASK_DEVICE --rounds 10 --skip-golden"

# PA unroll (baseline to compare)
task-submit --device auto --device-num 1 --run "\
  python tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_unroll/test_paged_attention_unroll.py \
    -p a2a3 -d \$TASK_DEVICE --rounds 10 --skip-golden"
```

### Expected Performance

Open question — this issue is to produce the numbers. Acceptance: a side-by-side latency
comparison of `spmd_paged_attention_highperf` vs `paged_attention_unroll` across the shared
shapes, with a clear verdict on which wins (overall and per-shape if it varies).

### Actual Performance

Not yet measured.

### Additional Context

- High-perf PA: `tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/` (from #899)
- PA unroll: `tests/st/a2a3/tensormap_and_ringbuffer/paged_attention_unroll/`
  (also `paged_attention_unroll_4dims`)
- Related: #545 (runtime performance optimization tracking).


---

## #999 [Feature] Level-aware DFX profiling keyed on callable digest (post-hashid #891)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/999
- Created: 2026-06-05T09:43:53Z
- Updated: 2026-06-29T08:37:28Z
- Closed: 2026-06-29T08:37:28Z
- Labels: enhancement

### Body

### Summary

We will add profiling at hierarchical levels beyond L2 (L3+). Today DFX is produced only at the
L2/runtime layer, and the per-level name map identifies L3 callables by their **positional index**
in the CALLABLE `callables` list. Since #891 made hierarchical callable identity a stable
**SHA-256 digest**, the new per-level profiling should identify and name callables by **digest**,
not positional index.

### Motivation / Use Case

The positional-index naming is order-fragile and unrelated to the runtime identity, so it does not
scale to real multi-level profiling. The digest is now the canonical, stable, cross-run identity
(`compute_callable_hashid` → `sha256:<hex>`), and registration already produces the
`(name <-> digest)` pair — keying DFX on it is both more robust and enables clean cross-level
correlation ("this L3 submit == that L2 run").

Note: #891 did not break current DFX — existing records key on `func_id` / PTO2 `task_id`, which
it left untouched. This is forward-looking work for upcoming multi-level profiling.

### Proposed Behavior

Direction only — implementation left open.

- Add a **hierarchical-level perf producer**: `src/common/hierarchical/` currently emits no DFX
  records; per-level profiling needs per-submit timing for L3+.
- Key L3+ records and the name map by **callable digest**; build `digest -> name` from the
  registered `CallableHandle`s, replacing the static positional-index extraction in
  `scene_test._extract_name_map`.
- Teach the tools (`swimlane_converter`, `deps_to_graph`) to accept digest-keyed name maps and
  render a stable **short-digest label** (32 bytes is too long for a swimlane label).
- **Keep L2 on `func_id`** — incore kernels are not registered hierarchical callables and have no
  digest. The per-level name-map model stays; only the L3+ key type changes (hybrid: L2 func_id,
  L3+ digest).
- Update `docs/profiling-name-map.md` for the digest-keyed L3+ mapping.

### Additional Context

- Identity primitives: `python/simpler/callable_identity.py` (`compute_callable_hashid`,
  `hashid_to_digest`).
- Current L2-only name map: `simpler_setup/scene_test.py:425-466` (`_extract_name_map`).
- Tool consumers: `simpler_setup/tools/swimlane_converter.py:498`,
  `simpler_setup/tools/deps_to_graph.py:812`.
- Background: #891 (hashid-based callable registration). Tracked under #995.


---

## #1001 [Feature] Text-based rendering for dep_gen dependency graph (deps_to_graph.py)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1001
- Created: 2026-06-08T01:12:10Z
- Updated: 2026-06-17T03:15:27Z
- Closed: 2026-06-17T03:15:27Z
- Labels: enhancement

### Body

## Summary

Add a **text-based** rendering of the dep_gen task dependency graph as an
alternative (and preferred default) to the current HTML directed-graph output
produced by `simpler_setup/tools/deps_to_graph.py`.

## Motivation / Use Case

`deps_to_graph.py` currently turns `deps.json` into a Graphviz-laid-out SVG
wrapped in a pan/zoom HTML page. On real workloads with many tasks this has two
problems:

1. **Slow to generate.** The Graphviz layout step scales poorly with task count
   — large/wide-fan-in graphs take a long time to render (the tool already has
   to force `concentrate=true` and recommends switching to the `sfdp` engine
   past ~1000 nodes just to keep `dot` from choking).

2. **Hard to navigate / locate a task.** The resulting graph is huge. There is
   no search — finding a specific task means panning and zooming around a giant
   SVG by eye, which is impractical once there are thousands of nodes.

For day-to-day debugging the common need is simply: "what does task X depend on,
and what depends on it?" — a question a graphical layout answers slowly and a
text view answers instantly.

## Proposed API / Behavior

A text representation of the same `deps.json` data that is:

- **Fast** — generated without an external layout engine, so it stays usable on
  large graphs.
- **Searchable** — plain text that can be grepped to jump straight to a given
  task and read its predecessors / successors.
- Carrying the same information already in `deps.json` (per-edge source /
  overlap / tensor annotation, and the perf-sidecar `func` / `core_type`
  labels).

The exact text layout is left to the implementer. Preference: make the text
view the default output, with the existing HTML graph kept available as an
opt-in for cases where a visual layout is genuinely wanted.

## Additional Context

- Tool: `simpler_setup/tools/deps_to_graph.py`
- Input schema and current viewer docs: `docs/dfx/dep_gen.md`


---

## #1012 [Feature] First-class DFX run-timing breakdown for run_prepared() (replace the SIMPLER_CHIP_TIMING fork patch)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1012
- Created: 2026-06-08T08:22:06Z
- Updated: 2026-06-28T09:01:22Z
- Closed: 2026-06-28T09:01:22Z
- Labels: enhancement, performance

### Body

## Summary

Provide a **first-class DFX facility** that reports a detailed, per-stage timing breakdown of a single `run_prepared()` — host layers, the AICPU device-wall phases, and the actual AICore compute window — as an officially supported, opt-in feature of the runtime.

I have a working prototype (3 local commits, described below) but it is **intrusive instrumentation hand-patched into the runtime** (host + AICPU + scheduler). I'd like this capability to live in simpler as a maintained DFX feature instead of a downstream fork patch I have to keep rebasing.

## Motivation / Use Case

When profiling a chip run, the runtime currently surfaces only two numbers (`host_wall_ns` / `device_wall_ns`). That hides *where* the time actually goes:

- On the host side, a `run_prepared()` spans `attach` / `bind_callable` / `bind_impl` / `runner_run` / `validate`, and `bind_impl` alone can be hundreds of ms (per-tensor `device_malloc` + H2D copy, static-arena reservation, GM-heap / shared-mem acquisition, prebuilt-arena image build + upload).
- The single `device_wall_ns` number conflates the AICPU **preamble**, **orch-SO dlopen**, **task-graph build**, and the post-orchestration AICore exec tail — most of which sits *before* the first AICore dispatch and is therefore invisible in the L2 swimlane window.
- The teardown bucket silently includes diagnostics cleanup (swimlane JSON export, dep_gen reconcile + deps.json replay, handshake read), which can dominate and be mistaken for real runtime cost.

Without a breakdown, it's very hard to tell whether a slow run is host binding, dlopen, graph build, actual compute, or profiling teardown. The two existing wall numbers are not enough to drive optimization decisions.

## Proposed API / Behavior

Opt-in (env-gated, off by default, no-op when disabled), emitting **one consolidated indented tree per run** to stderr (or, better, exposed through the runtime's logging/DFX channel). Conceptually:

```text
[chip_timing dev=0 run=3] total=XXX.XX ms
  |- attach            X.XX ms
  |- bind_callable     X.XX ms
  |- bind_impl       XXX.XX ms  (NN%)
  |  |- args_malloc_copy  XX.XX ms   (N tensors)
  |  `- prebuilt_arena    XX.XX ms
  |     |- static_arena   XX.XX ms
  |     |- gm_heap        XX.XX ms
  |     `- shared_mem     XX.XX ms
  |- runner_run      XXX.XX ms  (NN%)
  |  |- launch+setup   X.XX ms
  |  |- sync          XX.XX ms
  |  |  |- sync_aicpu  XX.XX ms
  |  |  |  :  device wall NNNN.N us (orchestrator-thread phases):
  |  |  |  |- preamble       NN.N us
  |  |  |  |- so_load        NN.N us  (dlopen)
  |  |  |  |- graph_build    NN.N us  (submit tasks; sched dispatches concurrently)
  |  |  |  `- post_orch      NN.N us  (AICore exec tail + drain)
  |  |  |     => compute_window NNN.N us  (first dispatch..last finish == swimlane)
  |  |  `- sync_aicore XX.XX ms
  |  `- teardown      XX.XX ms  (diagnostics cleanup)
  |     |- collectors XX.XX ms  (swimlane stop + JSON export)
  |     |- dep_gen    XX.XX ms  (reconcile + deps.json replay)
  |     `- handshake  XX.XX ms
  `- validate          X.XX ms  (NN%)
```

Key mechanisms in the prototype that the feature would formalize:

1. **Host per-stage timing** across the three call layers (`run_prepared` envelope, `bind_callable_to_runtime_impl`, `DeviceRunner::run`). Because the bind layer has no runner pointer, the prototype uses a small thread-local carrier (`chip_run_timing.h`: `BindTimingParts` / `RunnerTimingParts`, each with a `valid` flag) so the outermost layer assembles and prints one tree. Platforms that don't fill a slice render that node childless — backward compatible.

2. **AICPU device-phase stamps** — an optional, host-allocated `uint64_t[DEVICE_PHASE_SLOTS]` buffer whose address rides on a trailing `KernelArgs::device_phase_data_base` field (additive; front offsets preserved). The AICPU stamps raw `get_sys_cnt_aicpu()` cycles at coarse boundaries (WALL_START / ORCH_START / SO_LOADED / ORCH_END), and the host converts inter-slot deltas to subdivide the device wall. Same host-allocated-buffer trick already used by `device_wall_data_base`.

3. **Actual AICore compute window** — two extra scheduler-stamped slots (FIRST_DISPATCH via CAS-once first-writer-wins, LAST_FINISH via last-writer store) recorded with the *same* timestamps the L2 swimlane uses, so `last_finish - first_dispatch == swimlane "Total Test Time"`. This is gated on the existing `PTO2_PROFILING` + swimlane `AICPU_TIMING` level. Note these overlap graph_build's tail + post_orch rather than partitioning the wall.

4. **Teardown sub-buckets** — split the single teardown number into collectors (swimlane stop + JSON export), dep_gen (reconcile + deps.json replay), handshake (device read), so diagnostics-cleanup cost is attributable and not confused with runtime.

Design goals for the upstreamed version:
- Off by default; zero overhead when disabled (env read once; stamps no-op when the phase buffer is unallocated).
- Cross-platform (a2a3 / a5 / sim) — the prototype already mirrors the slot enum and the value-taking stamp helpers across onboard + sim.
- Trailing/additive `KernelArgs` changes only, so CANN-fixed front offsets stay intact.
- Ideally surfaced through the runtime's DFX/logging channel (not only raw stderr) and/or returned programmatically alongside the existing `host_wall_ns` / `device_wall_ns`, so tooling can consume it.

## Alternatives Considered

- **Keep it as a downstream fork patch** (current state): works, but it's intrusive across host + AICPU + scheduler and has to be re-applied on every runtime bump — exactly what motivates this request.
- **Rely on the existing two wall numbers** (`host_wall_ns` / `device_wall_ns`): insufficient — they don't separate host binding vs dlopen vs graph build vs compute vs profiling teardown.
- **Rely on the L2 swimlane alone**: the swimlane only covers the AICore compute window and misses the (often dominant) host-side bind + the pre-dispatch AICPU phases.

## Additional Context

Prototype shape (3 commits, currently local against the runtime submodule used by PyPTO):

1. **Add: opt-in per-stage chip timing + AICPU device-phase profiling (`SIMPLER_CHIP_TIMING`)** — host per-stage timers + the device-phase buffer/enum + onboard/sim stamp helpers + lazy buffer lifecycle on `DeviceRunnerBase`.
2. **Improve: consolidate `SIMPLER_CHIP_TIMING` into one indented per-run tree** — replace the four separate `[*_timing]` stderr lines with a single tree via `chip_run_timing.h` + the thread-local bind→c_api handoff.
3. **Add: scheduler-stamped AICore compute window + teardown sub-buckets** — FIRST_DISPATCH / LAST_FINISH slots stamped from the scheduler with the swimlane's own timestamps, plus the teardown collectors/dep_gen/handshake split.

Happy to upstream the prototype as a PR if the maintainers agree on the shape (env name, output channel, whether to also expose the breakdown programmatically).

---

## #1013 [Performance] Orchestration fanin dedup uses O(N^2) linear scans during TensorMap lookup

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1013
- Created: 2026-06-08T08:59:36Z
- Updated: 2026-06-18T06:09:31Z
- Closed: 2026-06-18T06:09:31Z
- Labels: performance

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

Orchestration fanin/dependency dedup currently performs a linear scan over already-collected producers for each emitted dependency. In workloads with many tensor args, group submits, overlapping TensorMap hits, or repeated producers, this can become O(N^2) in the number of fanin candidates. This should likely use a set-like membership structure while preserving the existing producer order.

Affected areas found on `simpler/main`:

- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp`
- `src/common/hierarchical/orchestrator.cpp`

### Git Commit ID

607f78a775eee8f8437a1444ab2dec3e01c62b1c

### CANN Version

_No response_

### Driver Version

_No response_

### Host Platform

Linux (aarch64)

### Reproduction

```bash
# Inspect L2 fanin dedup:
grep -n -A 25 "bool contains" \
  src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp

grep -n -A 25 "bool contains" \
  src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp

# Inspect hierarchical orchestration dedup:
grep -n -A 20 "add_unique_producer" \
  src/common/hierarchical/orchestrator.cpp
```

### Expected Performance

Dependency/fanin dedup should be approximately O(N) for N emitted producer candidates, using constant-time membership checks such as an unordered_set or a runtime-friendly fixed/open-addressing set.

### Actual Performance

Current code performs a linear membership scan for every candidate producer. Worst-case dedup cost is O(N^2) when many dependencies are emitted during orchestration lookup.

### Profiling Data (Optional)

_No response_

### Additional Context

This was first noticed while implementing the feature in
https://github.com/hw-native-sys/pypto/pull/1545. Before adding dummy task
nodes, the dependency pattern could expand from `N` producers and `M`
consumers into `N*M` dependency edges, and orchestration-side fanin lookup /
dedup became a significant cost.

The dummy task approach reduces that dependency shape from `N*M` to `N+M`,
which makes the issue much less severe in that specific path, but it does not
remove the underlying O(K^2) dedup behavior. When enough submitted tasks depend
on the same preceding `n` tasks, the runtime still repeatedly emits candidate
producers and checks each one by linearly scanning the already-collected fanin
list. As the number of dependent `task x` submissions grows, this can still
become noticeably expensive.


---

## #1014 [Bug] x86_64 a2a3sim/a5sim: cold-path scheduler aborts with rc=-100 (handle_timeout_exit STALL) on long-running InCore kernels

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1014
- Created: 2026-06-08T11:51:23Z
- Updated: 2026-06-09T11:06:10Z
- Closed: 2026-06-09T01:57:24Z
- Labels: bug

### Body

### Platform

a2a3sim (Ascend 910B/C simulation) — **a5sim is equally affected** (same `scheduler_cold_path.cpp` in both trees). a2a3 / a5 hardware are **not** affected.

### Runtime Variant

tensormap_and_ringbuffer

### Description

On the **x86_64** CPU simulator the cold-path scheduler aborts the run with `rc=-100` a few tens of seconds into a long-running InCore kernel. The idle-core watchdog (`handle_timeout_exit` / `idle_iterations`, `scheduler_cold_path.cpp:377`) appears to declare a false-positive STALL while a core is legitimately busy executing a coarse kernel; the other cores then fail to de-init and the whole run hangs until the harness/job timeout.

The **identical kernel** runs correctly on:
- the **aarch64** `a2a3sim` (`python models/deepseek/v4/expert_routed.py -p a2a3sim` → PASS, ~13 s), and
- **real a2a3 hardware** (the on-device run passes).

Only the **x86_64** simulator stalls. The trigger is making each InCore dispatch do more work: in `models/deepseek/v4/expert_routed.py` (pypto-lib) the `pl.spmd` fan-out was coarsened (`GATE_INNER` 8→16, `W2_INNER` 16→32), which halves the spmd-block count and roughly doubles per-kernel runtime. A finer schedule of the same kernel passed this sim (pypto-lib#445). This points at the scheduler/watchdog timing on the (slower) x86_64 CPU sim rather than at kernel correctness or the tile-ISA (pto-isa commit `8e436661` is unchanged and passes on aarch64 sim + hardware).

### Steps to Reproduce

The failure reproduces in pypto-lib CI on the **x86_64** sim runners; it could not be reproduced on an aarch64 dev host.

1. Build an InCore kernel whose per-dispatch body runs for a relatively long time on the CPU sim — e.g. DeepSeek-V4 `expert_routed` with `GATE_INNER=16, W2_INNER=32` (large `pl.spmd` blocks, each looping many tiles).
2. Run it under the `tensormap_and_ringbuffer` runtime on the **x86_64** `a2a3sim` / `a5sim` backend.
3. Observe the scheduler abort ~26 s into that kernel (the preceding, lighter `dispatch.py` kernel passes in ~4 s).

Reference CI runs (`hw-native-sys/pypto-lib#473`), jobs `sim (a2a3sim)` / `sim (a5sim)`: workflow runs `27124238178`, `27126481014`, `27133426053` — deterministic, same failure each time; dependency downloads were fast (not a network issue).

### Expected Behavior

The scheduler should wait for a long-running InCore kernel to complete — as it does on the aarch64 sim and on real hardware — instead of tripping the idle-core watchdog and aborting with `rc=-100`. A correct kernel that merely takes longer per dispatch should not be misclassified as a stall.

### Actual Behavior

```
[RUN] PASS (3.98s)                                  # preceding dispatch.py kernel OK
##[group]models/deepseek/v4/expert_routed.py
[ERROR] handle_timeout_exit: [scheduler_cold_path.cpp:377] [STALL thread=1 idle_iterations=...] TIMEOUT_EXIT
[ERROR] shutdown:           [scheduler_cold_path.cpp:573] Thread 0: Core 24 deinit timed out
...                         Core 25 / 26 / 27 deinit timed out
[ERROR] aicpu_execute:      [aicpu_executor.cpp:829] Thread execution failed with rc=-1
[ERROR] aicpu_execute:      [aicpu_executor.cpp:841] PTO2 runtime failed with rc=-100
[ERROR] emergency_shutdown: [scheduler_cold_path.cpp:836] Emergency shutdown: 6 cores did not acknowledge exit
[ERROR] run:                [aicpu_executor.cpp:714] Thread 2: Scheduler failed with rc=-100
# Python side: RuntimeError: run_prepared failed with code ...
```

The process then hangs on core de-init until the 30-minute CI job timeout cancels it.

### Git Commit ID

`48980572b3537df4ed5e6d9720cb6162939eb58a` (PTO runtime / simpler, as bundled in the pypto used here; CI installs pypto with its own pinned runtime, but the watchdog behavior is general).

### CANN Version

cann-9.0.0

### Host Platform

Linux (x86_64)

### Additional Context

- Real-device `a2a3` and the **aarch64** `a2a3sim` both pass with the identical kernel + pto-isa commit `8e436661`, so this is specific to the **x86_64** simulator's scheduler timing.
- The watchdog appears to be `idle_iterations`-based; on the slower x86_64 CPU sim a long-running InCore kernel keeps peer cores idle past the threshold and trips it. Possible directions: make the idle/stall threshold aware that a core is actively running a (long) kernel, or scale the threshold for CPU-sim execution speed.
- Originating context and a fuller write-up: `hw-native-sys/pypto-lib#473` (PR description + the "Note on the failing sim checks" comment).


---

## #1018 [Bug] Multi-rank `comm_init` fails in `os.fork()`'d chip worker — rank 0 dies during HCCL bring-up, version-invariant

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1018
- Created: 2026-06-09T08:52:44Z
- Updated: 2026-07-11T12:25:13Z
- Closed: 2026-07-11T12:25:13Z

### Body

**Repository**: `hw-native-sys/simpler`

> Re-filed after the previous issue was closed. This version isolates the
> failure to simpler's **own** in-tree example (no pypto-lib / model code) and
> adds a version-invariance matrix that rules out CANN, simpler, Python, and
> PTOAS versions as the cause. Net: the bug tracks the **`os.fork()` + raw
> `HcclGetRootInfo` chip-worker bootstrap**, not any dependency version.

## Summary

Any multi-rank `Worker(level=3)` dispatch that reaches `_ensure_comm_base`
crashes during HCCL base-communicator bootstrap:

- **rank 0** (the rootinfo writer) dies inside `comm_init`
  (`simpler/task_interface.py:589` → C++ `ChipWorker::comm_init` →
  `comm_hccl.cpp` `HcclGetRootInfo`) **before** it writes the rootinfo
  handshake file.
- every other rank then reports
  `[ERROR] comm_init: [comm_hccl.cpp:286] [comm rank N] Timeout waiting for rootinfo`
  after `HCCL_CONNECT_TIMEOUT`, because rank 0 never produced the file.

This blocks every multi-rank L3 deployment in our environment.

It reproduces with **simpler's own `l3/allreduce_distributed` example** — no
model, no pypto-lib, and the parent process does **no** NPU/ACL work before
forking the chips.

## Minimal reproducer (simpler in-tree example only)

```bash
# venv with simpler installed, pto-isa available, >=2 NPUs, ptoas on PATH
export PTO_ISA_ROOT=/path/to/pto-isa
cd /path/to/simpler/examples/workers/l3/allreduce_distributed   # in-tree example
PYTHONFAULTHANDLER=1 python -X faulthandler main.py -p a2a3 -d 0-1
```

Observed:

```
[chip_process pid=14062 dev=0] ready
[chip_process pid=14064 dev=1] ready
Fatal Python error: Segmentation fault
Current thread (most recent call first):
  File ".../simpler/task_interface.py", line 589 in comm_init
  File ".../simpler/worker.py", line 732 in _handle_ctrl_comm_init
  File ".../simpler/worker.py", line 937 in _run_chip_main_loop
  File ".../simpler/worker.py", line 999 in _chip_process_loop
  File ".../simpler/worker.py", line 1959 in _start_hierarchical
  File ".../simpler/worker.py", line 2573 in run
  ...
  File ".../examples/workers/l3/allreduce_distributed/main.py", line 208 in run
[ERROR] comm_init: [comm_hccl.cpp:286] [comm rank 1] Timeout waiting for rootinfo
```

In `main.py`, the parent only builds CPU `torch` tensors and compiles kernels
before `worker.init()` forks the chips (the base comm is lazy). Verified that
`import torch` does **not** load `libhccl`/`libascendcl` in the parent
(checked `/proc/self/maps`) — so the parent is clean at fork time.

## Crash locus (rank-0 Ascend plog)

The forked rank-0 chip sets its device and brings up ACL/runtime cleanly, then
dies right at the start of HCCL bring-up — last lines before SIGSEGV:

```
DRV ... Setup device succeeded. (logical_devid=0; devid=8; ...)
RUNTIME ... StarsEngine: Constructor.
ASCENDCL ... GetAllPackageVersion: Version of hccl package is 9.0.0.beta1
ASCENDCL ... GetAllPackageVersion: Version of driver package is not found   <-- last line, then SIGSEGV
```

No `HcclGetRootInfo` completion; no rootinfo file written. The crash is inside
the HCCL library call path, in the `os.fork()`'d child.

## Version-invariance matrix (the decisive evidence)

The same minimal repro was run across four independent version axes. **Every
combination fails identically** (`rank 1 Timeout waiting for rootinfo`, rank 0
gone):

| CANN | simpler | Python | PTOAS | Result |
|---|---|---|---|---|
| 9.0.0-beta.1 | `6e84154d` | 3.10 | v0.43 | ❌ rank-1 rootinfo timeout |
| 9.0.0-beta.1 | `afb5c5a9` (latest main) | 3.11 | v0.44 | ❌ |
| **8.5.1** | `afb5c5a9` (latest main) | 3.11 | v0.44 | ❌ |

For the 8.5.1 row we confirmed the chip actually loaded the 8.5.1 HCCL (not a
stale 9.0.0 one) via the live process map:

```
$ grep libhccl /proc/<rank1-chip-pid>/maps
/usr/local/Ascend/cann-8.5.1/x86_64-linux/lib64/libhccl.so
```

So **CANN version, simpler version, Python version, and PTOAS version are all
ruled out**. The only invariant is the chip-worker bootstrap: a process created
by `os.fork()` (`worker.py:1935/1955/2002`, lazily at `Worker.init()`) calling
raw `HcclGetRootInfo` from `comm_hccl.cpp`.

## Control: vLLM (spawn) works on the identical hardware/CANN

On the **same pod, same 8 cards, same CANN 9.0.0-beta.1, same driver 25.5.1**,
`vllm serve <model> -tp 8` (vLLM-Ascend, which uses `torch.distributed`
`init_process_group("hccl")` with **spawned** workers) initializes HCCL across
all 8 ranks and serves cleanly. So the driver / HCCL / hardware stack is
healthy; the differentiator is **how the rank process is created** — vLLM
spawns fresh processes, simpler forks.

## Root-cause hypothesis

`HcclGetRootInfo` / HCCL bring-up is not safe to call from an `os.fork()`'d
child under these CANN builds, even when the parent never touched HCCL/ACL
before the fork. vLLM avoids it by spawning fresh worker processes.

Candidate fixes (all upstream / simpler-side):

1. **Spawn (or `fork`+`exec`) chip workers** for the HCCL/comm path instead of
   bare `os.fork()`, so each rank brings up HCCL in a clean process.
2. **Guarantee the chip is forked before any ACL/HCCL/driver state is loaded**
   in the parent, and that the child performs a complete clean ACL init before
   `HcclGetRootInfo` — then document/verify that ordering invariant.
3. Provide a distributed L3 ST that exercises `cw.comm_init` end-to-end from a
   forked chip on CANN 8.5.1 / 9.0.0 + driver 25.5.1, so this is covered in CI.

## What we ruled out

- **CANN version** — fails on both 9.0.0-beta.1 and 8.5.1 (8.5.1 libhccl load verified).
- **simpler version** — fails on `6e84154d` and latest main `afb5c5a9`.
- **Python version** — fails on 3.10 and 3.11.
- **PTOAS version** — fails on v0.43 and v0.44 (PTOAS is not in the comm path).
- **Parent pre-initialized HCCL** — the allreduce parent does no NPU work before fork; `import torch` does not load libhccl/libascendcl.
- **Missing HCCL env** — `HCCL_CONNECT_TIMEOUT=3600`, `HCCL_INTRA_ROCE_ENABLE=1`, `HCCL_INTRA_PCIE_ENABLE=0`, `HCCL_OP_EXPANSION_MODE=AIV` all set; `HCCL_SOCKET_IFNAME`/`HCCL_IF_BASE_PORT` overrides change nothing.
- **NPU contention** — cards are exclusively assigned (private pod); verified free before each run.

## Environment

| Item | Value |
|---|---|
| OS | Ubuntu 22.04, x86_64 host + Ascend 910B via PCIe |
| NPU | 8 × Ascend 910B2C |
| Driver | `npu-smi 25.5.1` |
| CANN | `9.0.0-beta.1` (also reproduced on `8.5.1`) |
| Python | 3.10.12 (also reproduced on 3.11.14) |
| simpler | `6e84154d` and latest main `afb5c5a9` |
| pto-isa | `109c9f72` |
| ptoas | binary `v0.44` (also v0.43) |

## Note on a symbolized C++ backtrace

We could not produce a `gdb`/core backtrace in our pod: `gdb` is not installed,
`ulimit -c` is hard-capped at 0, and `core_pattern` pipes to apport (not
running in-container). The Ascend ATRACE SIGSEGV handler did not leave a
symbolized stack in plog either. Happy to capture one if you can advise a
symbol build / point us at a gdb-enabled image.

---

## #1019 [Bug] PagedAttentionUnrollManualScope intermittent 207001 is NOT OOM — AICore launch wedge (op-timeout family, #1016)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1019
- Created: 2026-06-09T12:12:28Z
- Updated: 2026-06-17T08:52:40Z
- Closed: 2026-06-17T08:52:40Z
- Labels: bug

### Body

### Platform

a5 (Ascend 950 hardware)

### Runtime Variant

tensormap_and_ringbuffer

> **⚠️ This issue was originally filed as an HBM-OOM / pooled-worker AICore-ELF
> accumulation bug under 2-die xdist. Direct measurement disproved that on every
> count (see comments). The text below is the corrected diagnosis; the original
> framing is retracted.**

### Description

`TestPagedAttentionUnrollManualScope::test_run` (and other tests — the trigger
varies) intermittently fails in the `st-onboard-a5` suite with:

```
launch_aicore_kernel: rtKernelLaunchWithHandleV2 failed: 207001
RuntimeError: run_prepared failed with code 207001
recover_device_or_mark_unusable: aclrtSynchronizeDeviceWithTimeout failed: 507901
```

`207001` is nominally `ACL_ERROR_RT_MEMORY_ALLOCATION`, which is why this was
first read as HBM OOM. **It is not OOM.**

### Root cause — intermittent AICore launch wedge, NOT memory

Measured with an `aclrtGetMemInfo(ACL_HBM_MEM)` probe placed immediately before
the failing launch, plus timestamp analysis. Across every reproduction:

```
HBMDIAG pre-launch  free = 122602 MB / total = 126110 MB   <-- 122 GB FREE
... 11.3 s later (consistently) ...
rtKernelLaunchWithHandleV2 failed: 207001                  <-- FIRST error, no prior fault
aclrtSynchronizeDeviceWithTimeout failed: 507901           <-- device wedged
then every rtMalloc -> 507899, every rtFree -> 107000 (incl. Finalize)
```

- **No memory shortage** — 122 GB free at the failing launch. `207001` is a
  misleading return code here.
- **The 11.3 s is entirely inside `rtKernelLaunchWithHandleV2`** (a pure async
  submit of the AICore worker kernel to the device scheduler / STARS) — a fixed
  timeout, not execution. It is the **first** error in the run.
- The **previous** run's `sync_run_streams()` (which syncs both the AICPU and
  AICore streams) passed, so the device was **healthy at the start of this run**
  — the wedge is produced **within this run**, not left over from a prior op.
- The failing test is often a *repeated identical* run (e.g.
  `test_dlopen_count_same_slot_repeated_runs` runs the same prepared callable
  5×; an earlier iteration succeeds, a later one wedges) → this is a **race at
  AICore-submit time between the already-running AICPU orchestration and the
  AICore worker launch**, not a working-set/resource issue.
- After the wedge the whole device context is poisoned (`507899` / `107000`),
  which is the cascade.

This is the **same op-timeout / launch-wedge family as #1016**, surfaced under
the wrong (`207001`) code.

### What was disproven (with measurements)

- **Not chip-buffer / AICore-ELF accumulation.** Instrumenting
  `upload_chip_callable_buffer` / `unregister_callable` shows chip buffers at
  **max-live = 1** (every alloc is followed by a free at the same GM address).
  A refcounted free-on-unregister changed the failure rate by nothing.
- **Not 2-die / xdist / cross-device contention.** Reproduces **single-device,
  sequential, no xdist, ~25-33%**. On a5 one chip = two dies = **one
  `device_id`** (`src/a5/docs/hardware.md`), and GM is **exclusive per
  `device_id`** — there is no shared-HBM "2-die" pressure. `--device A-B` is two
  independent chips. (The original "shared HBM between dies" claim was wrong; see
  `docs/hardware/chip-architecture.md`.)
- **Not working-set size.** The wedge also hits tiny kernels (e.g. a
  `block_dim=3` prepared_callable launch), early in a fresh process.

### Steps to Reproduce

On an exclusively-locked a5 host, **single device is enough**:

```
python -m pytest \
  tests/st/a5/host_build_graph/prepared_callable \
  tests/st/a5/tensormap_and_ringbuffer/prepared_callable \
  examples/a5/tensormap_and_ringbuffer/paged_attention \
  examples/a5/tensormap_and_ringbuffer/paged_attention_manual_scope \
  examples/a5/tensormap_and_ringbuffer/paged_attention_unroll_manual_scope \
  tests/st/a5/tensormap_and_ringbuffer/paged_attention_unroll \
  examples/a5/tensormap_and_ringbuffer/bgemm \
  --platform a5 --device <one-device>
```

Looping this sequentially reproduces ~2-3 failures per ~8 runs. The triggering
test varies (PA-unroll-MS, or the prepared_callable dlopen-count tests).

### Expected Behavior

The AICore worker launch is accepted promptly; no intermittent submit wedge.

### Actual Behavior

`rtKernelLaunchWithHandleV2` blocks ~11.3 s then returns `207001`; the device is
left poisoned (`507901` / `507899` / `107000`), failing the rest of that
worker-process's tests.

### Git Commit ID

afb5c5a95cf05d5bb346eaef83a318c6f3164971

### CANN Version

cann-9.1.T500

### Driver Version

25.6.rc1.b108 (ascendhal 7.35.23)

### Host Platform

Linux (aarch64)

### Additional Context

**Containment vs fix:** #1016 (merged) already contains the cascade — it marks
the runner unusable and force-resets the device so a fresh worker process runs
the remaining tests clean. A bounded **retry of the failed test** on the
reset device is a sound mitigation. The **root fix** requires eliminating the
intermittent AICore-submit race (STARS-level handshake between the AICPU
orchestration and the AICore worker launch) — likely a CANN/runtime-layer
investigation, tracked with #1016.

Related: #884 (dynamic register/unregister instability), #1016 (a5 AICore
op-timeout poison containment). The earlier paged-attention OOM framing here is
retracted.

---

## #1020 [Feature] Add JSON-only tensor-dump level (metadata, no .bin payload)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1020
- Created: 2026-06-10T01:20:01Z
- Updated: 2026-06-11T02:48:06Z
- Closed: 2026-06-11T02:48:06Z
- Labels: enhancement

### Body

## Summary

Add a new **JSON-only** tensor-dump level that captures every task's tensor/scalar
**metadata** to `tensor_dump/tensor_dump.json` but copies **no payload** and writes
**no `.bin`** file.

Concretely: extend `DumpTensorLevel` / `enable_dump_tensor` / `--dump-tensor` with a
new level `3` (`FULL_JSON_ONLY`) alongside the existing `0=off`, `1=partial`,
`2=full`.

## Motivation / Use Case

Today every enabled dump level emits the JSON manifest **and** the `.bin` payload
together — the level only controls *which tasks* are captured, never JSON-vs-BIN.

Some downstream consumers need only the per-task tensor **structure** — `task_id`,
`role`, `stage`, `arg_index`, `dtype`, `shape`, `strides`, `is_contiguous`, and
scalar `value` — not the element data. For those consumers, full mode (`2`) is
pure overhead:

- the AICPU copies every tensor's bytes into its arena (device→host bandwidth),
- the arena fills up and triggers truncation / overwrite anomalies on large runs,
- a large `.bin` is written to disk and then ignored.

A metadata-only level gives those consumers exactly the manifest they need at a
fraction of the cost.

## Proposed API / Behavior

```bash
# pytest / standalone runner
pytest <case> --platform a5sim --dump-tensor 3
python <case>/test_*.py -p a5sim --dump-tensor 3
```

```cpp
enum class DumpTensorLevel : uint32_t {
    OFF = 0,
    PARTIAL = 1,
    FULL = 2,
    FULL_JSON_ONLY = 3,  // every task's metadata to JSON; no payload, no .bin
};
```

Behavior at level `3`:

- every task's tensor I/O is recorded as metadata (same coverage as `FULL`);
- the AICPU **skips the arena payload copy entirely** (treats each tensor like a
  scalar for payload purposes), so there is no device→host payload traffic and no
  arena pressure;
- `tensor_dump.json` is written with `"bin_file": null` and every entry's
  `"bin_size": 0`;
- no `tensor_dump.bin` file is produced.

## Alternatives Considered

- **Run at level `2` and ignore the `.bin`** — still pays the full device→host
  copy, arena pressure, and disk cost; defeats the purpose.
- **Reconstruct metadata offline from other artifacts** — fragile and incomplete;
  the per-task tensor layout is exactly what the manifest already encodes.

## Additional Context

This is the metadata-only input capability needed by #837 (per-kernel dispatch
args dump for Insight Trace): that tooling replays a single kernel dispatch from
the dumped per-task tensor/scalar **structure** (dtype / shape / scalar values)
and does not need the element payload, so a JSON-only manifest is exactly the
right input — full mode's `.bin` would be pure overhead for it.

DFX Tensor Dump enhancement (sub-capability of the DFX roadmap in #995).

- Doc: `docs/dfx/tensor-dump.md`
- Tool: `simpler_setup/tools/dump_viewer.py` (lists metadata; tolerates a null
  `bin_file`).


---

## #1022 [Bug] SPMD Paged Attention Highperf Fails For >= 8192 sequences

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1022
- Created: 2026-06-10T12:07:29Z
- Updated: 2026-06-19T08:02:27Z
- Closed: 2026-06-19T08:02:26Z
- Labels: bug

### Body

### Platform

a2a3

### Runtime Variant

tensormap_and_ringbuffer

### Description

The `spmd_paged_attention_highperf` scene test works for shorter decode
sequence lengths, but fails when extended to longer paged-attention sequences.
The failure is reproducible for the 8192-token case added in
[hw-native-sys/simpler#986](https://github.com/hw-native-sys/simpler/pull/986).

The compared PyPTO SPMD implementation can run the same logical GQA paged
attention problem for 8192 and 16384 tokens, so the long-sequence failure
appears specific to the simpler highperf kernel/runtime path rather than the
input shape itself.


### Steps to Reproduce

1. Check out the code from
   [hw-native-sys/simpler#986](https://github.com/hw-native-sys/simpler/pull/986).
2. Build/install the project as usual for onboard a2a3 testing.
3. Run the highperf SPMD paged-attention long sequence case on an a2a3 device:

```bash
   python tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/test_spmd_paged_attention_highperf.py \
     -p a2a3 -d 6 --case b1_h32_kv8_s8192_bs128_fp16
```

### Expected Behavior

The highperf SPMD paged-attention kernel should complete successfully for the
8192-token GQA decode case and produce output matching the golden reference.

The expected shape is:

```text
batch = 1
num_heads = 32
num_kv_heads = 8
head_dim = 128
kv_seq = 8192
block_size = 128
dtype = fp16
```

### Actual Behavior

The 8192-token highperf case fails with an AICore timeout. The observed error
code is:

```text
507018
```

Shorter cases such as 128, 512, and 4096 tokens complete successfully. The
failure has been reproduced for the 8192-token highperf case.

### Git Commit ID

afb5c5a95cf05d5bb346eaef83a318c6f3164971

### CANN Version

9.0.0

### Driver Version

25.5.1

### Host Platform

Linux (aarch64)

### Additional Context

_No response_

---

## #1024 Hierarchical worker TaskArgs blob can exceed 4KB mailbox capacity

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1024
- Created: 2026-06-11T02:12:48Z
- Updated: 2026-06-11T11:22:40Z
- Closed: 2026-06-11T11:22:40Z

### Body

## Summary

A hierarchical worker dispatch can fail with `WorkerThread::dispatch_process: args blob exceeds mailbox capacity` when a host orchestration calls a child kernel with many tensor arguments.

The current mailbox is 4096 bytes, but the usable TaskArgs blob area is smaller because the mailbox also stores `CallConfig` and the child error-message region. In the observed case, the child dispatch needs 3064 bytes while the current capacity is 2768 bytes.

## Reproduction Shape

This was reproduced with a 2-device host orchestration that dispatches a child decode-layer kernel. The top-level host function fits in the current mailbox, but the host-to-child dispatch does not.

Argument blob accounting:

```text
MAILBOX_SIZE = 4096
MAILBOX_OFF_ARGS = 1072
MAILBOX_ERROR_MSG_SIZE = 256
MAILBOX_ARGS_CAPACITY = 4096 - 1072 - 256 = 2768 bytes

child kernel args:
  tensors = 76
  scalars = 2
  blob = 8 + tensors * sizeof(ContinuousTensor) + scalars * sizeof(uint64_t)
       = 8 + 76 * 40 + 2 * 8
       = 3064 bytes
```

Failure:

```text
RuntimeError: WorkerThread::dispatch_process: args blob exceeds mailbox capacity
```

The top-level host entry has only 68 tensors + 1 scalar:

```text
blob = 8 + 68 * 40 + 1 * 8 = 2736 bytes
```

So it barely fits the current 2768-byte capacity, while the nested child dispatch exceeds it.

## Why This Matters

Layer-level orchestration often composes multiple primitives and passes extra per-dispatch workspace/window handles to child kernels. The current fixed 4KB mailbox is too tight for these realistic composed kernels. A small increase in tensor arguments can break an otherwise valid host orchestration even when each tensor descriptor is compact.

## Suggested Fix

Increase the hierarchical worker mailbox capacity or move large TaskArgs blobs out of the fixed mailbox.

A minimal local workaround that unblocked the repro was:

```diff
-static constexpr size_t MAILBOX_SIZE = 4096;
+static constexpr size_t MAILBOX_SIZE = 16384;
```

It was also useful to include the computed size in the error message:

```text
need <blob_bytes> bytes, capacity <MAILBOX_ARGS_CAPACITY> bytes, tensors=<T>, scalars=<S>
```

A more robust long-term design could stage the TaskArgs blob in shared memory and pass only a handle through the mailbox.

## Expected Behavior

Valid hierarchical worker dispatches with realistic composed-kernel argument counts should not fail solely because their serialized TaskArgs descriptor blob is slightly larger than the current fixed 4KB mailbox allows. If the limit remains fixed, the error should include the required byte count, capacity, tensor count, and scalar count.


---

## #1025 [Feature] Per-L2 RUNTIME_ENV: allow each L2 task to configure its own PTO2_RING_* sizes via CallConfig

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1025
- Created: 2026-06-11T02:18:01Z
- Updated: 2026-06-12T09:32:09Z
- Closed: 2026-06-12T09:32:09Z
- Labels: enhancement

### Body

### Summary

`PTO2_RING_TASK_WINDOW` / `PTO2_RING_HEAP` / `PTO2_RING_DEP_POOL` are read process-globally via `std::getenv` in `bind_callable_to_runtime_impl()` (`src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp:258-260`). Today the only way to set them is `SceneTestCase.RUNTIME_ENV`, which `_temporary_env()` applies to `os.environ` for the whole run (`simpler_setup/scene_test.py:310-325`, applied at the L2 path :1037 and L3 path :1124).

This works when L2 dispatches a single L2 callable, but when an L3 orchestration submits **multiple L2 tasks** via `Orchestrator.submit_next_level()` (`python/simpler/orchestrator.py:114-129`), all of them inherit the same process env — there is no way to give each L2 its own ring sizing. `CallConfig` (block_dim, aicpu_thread_num, ...) carries no env/ring-size fields.

Request: extend the config interface so each L2 can carry its own ring configuration, e.g. an optional per-task `env` / ring-size override on `CallConfig` (and the corresponding per-case `config` knobs in scene_test `CASES`), so an L3 dispatching N heterogeneous L2s can size each ring independently:

```python
RUNTIME_ENV = {
    "PTO2_RING_TASK_WINDOW": "128",
    "PTO2_RING_HEAP": "262144",
    "PTO2_RING_DEP_POOL": "256",
}
```

### Motivation / Use Case

- An L3 orchestration that fans out several different L2 kernels in one launch: a large attention L2 needs a big heap and 128-task window, while small element-wise L2s only need defaults. Today everyone gets the max footprint, wasting device memory, or the global setting underprovisions the large L2 (failure modes documented in `MULTI_RING.md` suggest raising the env vars).
- Sizing values are part of the per-callable contract, not process state; per-L2 config also removes the `os.environ` mutation from the test harness.

Likely plumbing: add optional ring-size fields to `CallConfig`, serialize them in the task descriptor/mailbox to AICPU, and have `bind_callable_to_runtime_impl()` prefer per-task values over the global env fallback.

Related: #834 (global structured runtime config API — orthogonal: it covers how to set these values programmatically; this issue covers per-task granularity within one L3 dispatch)

---

## #1026 [Feature] Support selective scalar dump via Arg::dump(...)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1026
- Created: 2026-06-11T02:30:08Z
- Updated: 2026-06-12T08:16:12Z
- Closed: 2026-06-12T08:16:11Z

### Body

### Summary

Support selecting scalar arguments in the existing `Arg::dump(...)` partial-dump API, so users can request mixed tensor/scalar dumps such as:

```cpp
params.dump(tensor1, tensor2, scalar1, scalar2);
```

This should dump only the selected tensor and scalar arguments instead of requiring all scalar arguments on the task to be dumped.

### Motivation / Use Case

Partial tensor dump already supports selecting specific tensor arguments with `params.dump(tensor1, tensor2)`. Scalar dump should follow the same user-facing model so users can focus debug output on the scalar values that matter for a given task.

Without selective scalar dump, `params.dump()` dumps every tensor and scalar argument on the `Arg`, which is noisy for kernels with many scalar parameters. Users also need mixed selection to debug real orchestration code where one tensor output and one scalar control value are the relevant pair.

### Proposed API / Behavior

```cpp
params.dump();                          // dump all tensor + scalar args
params.dump(tensor1, tensor2);          // dump selected tensor args
params.dump(tensor1, scalar1, scalar2); // dump selected tensor/scalar args
```

Expected behavior:

- no-arg `dump()` keeps task-level behavior and dumps all tensor and scalar args on the `Arg`;
- variadic `dump(...)` can select tensors and scalar lvalues in one call;
- selected scalar args are recorded using the same task arg-index selection mechanism as selected tensors;
- scalar records are emitted at `before_dispatch`;
- scalar payload belongs to the task, so mixed-subtask tasks should record each selected scalar once per task, while tensor records remain tied to callable signature traversal;
- if the same scalar lvalue is added more than once, selection can use the first matching scalar arg and log a warning so users know to use distinct local variables when they need a later duplicate.

### Alternatives Considered

A separate scalar handle API such as `add_scalar_arg(...)` was considered, but it would introduce a new user-facing concept that tensor selection does not need. Reusing `params.dump(scale)` keeps the scalar and tensor partial-dump interfaces consistent.

Value-based scalar matching alone is not enough, because repeated scalar values, equivalent bit patterns, and type conversion to `uint64_t` can be ambiguous. The API should treat scalar selection as selecting registered scalar lvalues rather than every scalar with the same value.

### Additional Context

Related: #965

This tracks the selective scalar dump enhancement for tensor dump DFX. It is separate from scalar dtype decoding: this issue is about which scalar arguments are selected and recorded, not how scalar values are decoded in the manifest.


---

## #1027 L3 worker cannot see host tensors created after worker startup

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1027
- Created: 2026-06-11T02:50:01Z
- Updated: 2026-07-08T07:43:42Z
- Closed: 2026-07-08T07:43:42Z

### Body

## Summary

`DistributedWorker` / L3 worker currently requires all host input/output tensors passed to `worker.run(...)` to be created and moved to shared memory before the L3 worker child process is created. If a later run uses a newly-created tensor, or a tensor with a shape/storage that was not shared before worker creation, the child process cannot reliably see that storage.

This creates a practical limitation for dynamic-shape serving workloads: every possible input/output buffer shape must be preallocated up front, otherwise repeated `worker.run(...)` calls with changed input shapes may fail or require awkward fixed-size buffer workarounds.

## Context

This was observed while migrating `pypto-serving` Qwen3-14B prefill/decode dispatch from the L2 worker path to a shared L3 `DistributedWorker` path:

- Feature issue: https://github.com/hw-native-sys/pypto-serving/issues/26
- Implementation PR: https://github.com/hw-native-sys/pypto-serving/pull/29

In that PR, serving currently has to preallocate fixed-size host buffers for prefill/decode before creating the L3 worker:

- prefill hidden / seq_lens / chunk_lens / chunk_offsets / block_table / slot_mapping / logits
- decode hidden / seq_lens / block_table / slot_mapping / logits

The worker is then created once and reused for both prefill and decode. This works, but only because all runtime input/output buffers have stable shared-memory storage before the child process starts.

## Problem

For dynamic serving workloads, input shapes can change between runs:

- prefill total token count changes per request batch / chunk
- user batch size changes
- block table and slot mapping sizes may vary with max sequence / page layout
- output logits buffers may vary with batch shape in other models

With the current L3 worker behavior, tensors created after the worker child exists are not visible to that child unless they were already backed by shared memory visible at fork/spawn time. This means a natural pattern like:

```python
worker = DistributedWorker([program])

for request_batch in batches:
    hidden = torch.empty((dynamic_tokens, hidden_size), dtype=torch.bfloat16)
    out = torch.empty((dynamic_batch, vocab), dtype=torch.float32)
    worker.run(program, hidden, out)
```

is not safe unless `hidden` and `out` are replaced with slices of pre-created shared-memory buffers.

## Current workaround

`pypto-serving` now preallocates maximum-capacity buffers before L3 worker creation and reuses slices for each run. For example:

- prefill uses a fixed `kernel_batch * max_seq` hidden buffer but passes only the active token slice
- fixed-size metadata buffers are zeroed / filled each run
- decode uses fixed `kernel_batch` buffers and pads inactive rows

This workaround is functional, but it has drawbacks:

- higher memory footprint because maximum-size buffers must exist up front
- model runner code becomes more complex
- dynamic-shape programs need fixed-capacity host buffers even when only a small shape is active
- shape changes are constrained by preallocated capacity
- child-process visibility details leak into serving-side code

## Expected behavior

The L3 worker runtime should support one of the following:

1. Passing newly-created shared-memory host tensors to an already-running L3 worker, with the child process able to attach/map them for that run.
2. A documented runtime API to register or refresh host tensor storage mappings after worker creation.
3. A clear error if a non-visible host tensor is passed to `worker.run(...)`, instead of failing indirectly or forcing users to discover the preallocation requirement.
4. Documentation explaining the exact lifetime/visibility rules for host tensor arguments used by `DistributedWorker.run(...)`.

## Why this matters

Serving engines naturally have dynamic request batches. Requiring every possible host input/output tensor to be created before worker startup makes the L3 worker path harder to use as a general replacement for the L2 runtime path.

The limitation is manageable for Qwen3-14B today through fixed-size buffers, but it becomes fragile for other models, variable vocab/logit outputs, dynamic prefill chunking, or future serving paths that need more flexible input shapes.

## Validation from pypto-serving

After applying the fixed preallocation workaround in `pypto-serving`, these checks pass:

- offline generation without larger PTO2 runtime envs
- single-request HTTP serving without larger PTO2 runtime envs
- multi-request HTTP serving with:

```text
PTO2_RING_HEAP=4294967296
PTO2_RING_TASK_WINDOW=1048576
PTO2_RING_DEP_POOL=1048576
```

This confirms the workaround is viable, but the underlying L3 child-process tensor visibility limitation remains.


---

## #1029 Per-ring (per-scope-level) heap / task-window / dep-pool config — uniform sizing has no working value for deep kernels

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1029
- Created: 2026-06-11T03:52:00Z
- Updated: 2026-06-23T02:13:42Z
- Closed: 2026-06-23T02:13:41Z

### Body

## Summary

The 4 HeapRings / task-window / dep-pool are configured **uniformly** (one global size applied to every ring via `PTO2_RING_HEAP` / `PTO2_RING_TASK_WINDOW` / `PTO2_RING_DEP_POOL`), but real workloads load the rings **very unevenly**. There is no way to size each ring level independently, which forces the global knobs to the worst single ring — wasting capacity on the idle rings and capping the device on the hot one. Request: an interface to set per-ring (per-scope-level) heap / task-window / dep-pool sizes.

## Background

`ring.h`: `MAX_RING_DEPTH = 4`, `ring_idx = min(scope_depth, MAX_RING_DEPTH - 1)`, `DEFAULT_HEAP_RING_SIZE = 1 GiB` (uniform), total VA = size × 4. The three `PTO2_RING_*` env knobs apply the same value to all 4 rings.

Because scope depth saturates at `MAX_RING_DEPTH-1`, any nesting deeper than 4 collapses into ring 3 — so ring 3 is structurally the hot one for deep kernels.

## Evidence (Qwen3-14B prefill_fwd, 40 layers, batch1×seq128, manual 4-ring scopes)

Per-ring peak occupancy measured via scope_stats, with `HEAP=4 GiB/ring`, `TASK_WINDOW=262144`:

| ring | scope level | heap peak | task_window peak |
|------|-------------|-----------|------------------|
| r0 | entry | 10 MB (0.2%) | 7,131 (2.7%) |
| r1 | layer loop | 50 MB (1.2%) | 40 (0.0%) |
| r2 | token-block | 1,340 MB (32.7%) | 68,240 (26%) |
| **r3** | **per-token attn** | **4,095 MB (100%)** | **343,040** |

r3 is ~100% while r0/r1 sit near 0%. Consequences with uniform sizing:

- **task_window**: r3 needs ≥262144 to avoid a deadlock (`507018` AICPU sync timeout); at the default 131072 the 40-layer kernel deadlocks. Raising the *global* window to 524288 (the next step that would give r3 headroom) makes the static arena request 6.25 GB and `rtMalloc` fails (`207001`, device HBM). So the uniform knob has no value that fits: 131072 deadlocks, 524288 OOMs — purely because r0/r1/r2 also get the inflated window they don't need.
- **heap**: r3 wants ~4 GB while r1 is happy with 50 MB, but both are forced to the same 1 GiB default (or the same global override), so 3 of 4 rings reserve VA they never touch.

## Request

Allow per-ring configuration, e.g.:

```
PTO2_RING_HEAP=10M,64M,1.5G,4G          # comma-separated per ring 0..3
PTO2_RING_TASK_WINDOW=8192,1024,131072,524288
PTO2_RING_DEP_POOL=...
```

or a programmatic equivalent on the worker/CallConfig (e.g. `ring_config=[{heap, task_window, dep_pool}, ...]`). With per-ring sizing, the 40-layer prefill above fits comfortably (r3 gets the big window/heap, r0–r2 stay small) and the total arena stays well under the failing 6.25 GB — whereas the uniform knob has no working value.

Secondary asks (optional, lower priority):
- Surface the deadlock more clearly: when a ring's task-window is exhausted, report which ring + that it is a window-capacity stall (today it manifests only as `507018` after the 2 s sync timeout).
- Consider allowing `MAX_RING_DEPTH > 4`, or an explicit `pl.scope(ring=N)` so callers can map deep nests onto rings deliberately instead of saturating at ring 3.

## Environment

simpler 48980572 (pypto main), a2a3 / Ascend910, Qwen3-14B prefill_fwd (pypto-lib).


---

## #1034 [Feature] Produce tensor dump on the abnormal path (hang / AICore op-timeout)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1034
- Created: 2026-06-11T13:18:39Z
- Updated: 2026-06-12T00:52:10Z
- Closed: 2026-06-12T00:52:10Z
- Labels: enhancement

### Body

### Summary

Tensor dump (`--dump-tensor`) only yields output on a clean run today. When a
kernel hangs and the run aborts via the AICPU scheduler-hang / AICore
op-execution timeout, the dumped inputs (and completed-task outputs) are
stranded on-device and no JSON manifest is written, so a hung run produces
**no usable dump** — exactly when the dump is most valuable for triage.

### Motivation / Use Case

Debugging a kernel hang is the single most common reason to reach for tensor
dump, and the current behaviour is the worst possible: you get nothing. The
dumped inputs of every dispatched task, the outputs of every task that
completed before the hang, and ideally the partial output the stuck kernel
managed to write are all valuable for locating where execution wedged — but
they are silently dropped.

Reproduced on hardware with a deliberately-hung kernel:

```
sync_run_streams: aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
reconcile_counters: thread 1 has un-flushed buffer (current_buf_ptr=0x..., count=14) after stop() — device flush failed
export_dump_files: No tensor dump data to export
```

### Proposed API / Behavior

No new user-facing API — `--dump-tensor` should also work when the run aborts.
Internally:

1. **Device flush on timeout** — the scheduler-timeout exit path must run the
   end-of-loop dump flush instead of early-returning past it.
2. **In-flight partial output** — on the timeout path, dump the current GM
   OUTPUT of every task still RUNNING on a core (best-effort; written at the
   `after_completion` stage) so you can see how far the stuck kernel got.
3. **Host export on the error path** — export the collected dump on `run()`'s
   error return, not only on the success path.
4. **Host-side recovery** — when the AICPU is reaped (STARS op-timeout) before
   it can flush, `reconcile_counters` recovers the stranded buffer's records
   directly from device memory (before the force-reset) instead of dropping
   them.
5. **Timeout ordering** — tune the budgets so the AICPU detects the hang and
   dumps *before* STARS reaps the op:
   `SCHEDULER_TIMEOUT_MS < PLATFORM_OP_EXECUTE_TIMEOUT_US < PLATFORM_STREAM_SYNC_TIMEOUT_MS`.

### Additional Context

Related: #959 (tensor dump + timeout backpressure failure modes — shares the
timeout/dump interaction root cause; this issue focuses on dump-on-hang,
host-side recovery, and the AICore op-timeout ordering).

---

## #1036 [Bug] AICore VEC UB-not-aligned (507018) on step3p5 single-rank, while qwen3/32b passes on the same chip

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1036
- Created: 2026-06-11T17:18:27Z
- Updated: 2026-07-12T02:00:17Z
- Closed: 2026-07-12T02:00:17Z

### Body

# [Bug] AICore VEC UB-not-aligned (507018) on step3p5 single-rank, while qwen3/32b passes on the same chip

**Repository**: `hw-native-sys/simpler` (primary) — likely also touches
`hw-native-sys/pypto` or `hw-native-sys/ptoas` codegen; refile to the right
component on triage.

**Filed as**: [simpler#1036](https://github.com/hw-native-sys/simpler/issues/1036) (2026-06-12)

**Severity**: blocking — Phase 15 single-rank NPU bring-up cannot proceed,
and any TP=N follow-up will hit the same fault per-rank.

> **2026-06-15 update — kernel pinned to `full_head_gate` (task 11), not
> `full_rope_kv_cache`.** A subsequent `P15_DISPATCH_LIMIT` bisect that
> comments out late `rt_submit_*_task(K, …)` calls in the generated
> `chip_orch.cpp` before the .so build flipped the result at exactly
> `LIMIT=11`:
>
> | `P15_DISPATCH_LIMIT` | dispatched tasks | result |
> |---|---|---|
> | 6  | 0..6 (rmsnorm → rope) | **PASS** |
> | 10 | 0..10 (incl. fa_fused 4-spmd block, no head_gate) | **PASS** |
> | **11** | + `full_head_gate` | **FAIL 507018** |
> | 12, 14, 22 | progressively more | FAIL (same signature) |
>
> The `tslot:6` field in plog is an FFTS+ internal slot, NOT the
> `chip_orch` task index — the apparent match to "task 6 =
> `full_rope_kv_cache`" was a misread that this issue's first version
> propagated. The actual culprit is dispatched at chip_orch task 11 (AIV)
> = the per-rank head-wise sigmoid gate. This also matches the local
> `TASK-30 full_head_gate AIV0 stall` entry in our backlog (CLAUDE.md);
> 507018 single-rank and TASK-30 are the same bug.
>
> **Reproducer pinned more precisely**: `pypto-lib/tools/p15_trace/run_with_trace.py`
> with `P15_DISPATCH_LIMIT=10` PASSes, `P15_DISPATCH_LIMIT=11` FAILs. The
> trace harness sits at the `compile_single_orchestration` chokepoint;
> no simpler-runtime rebuild required.
>
> **What this changes for the maintainer ask below**: the disassembly
> request is now scoped to the dispatched function for `full_head_gate`
> (AIV, source `pypto-lib/models/step3p5/attention_full.py:564-586` —
> outer `pl.spmd(BATCH // BATCH_TILE) + pl.range(NUM_HEADS_FULL_LOCAL)`
> head-wise sigmoid then assemble into `attn_out_gated`), not the rope
> body. The rest of this issue's diagnosis (executor binary identification,
> qwen3 counter-example, version pin matrix, what we tried) remains valid.

> **Supersedes the operating hypothesis in `pypto-1702-followup.md`** (filed
> 2026-06-10 as pypto#1738 = "PR#1718 doesn't fix 507018 — SSA aliasing in
> another path"). After this session's eight Phase A model-side mitigations
> all failed to shift the fault hash, the SSA-aliasing theory is now ruled
> out. The crashing kernel binary is shown below to be **simpler runtime's
> own AICore polling-dispatch executor** (binSize 140920 = exact match for
> `simpler/build/lib/a2a3/onboard/tensormap_and_ringbuffer/aicore_kernel.o`),
> so the fix path moves out of pypto codegen and into simpler/PTOAS.

## Summary

Running step3p5's `step3p5_decode -p a2a3 -d 0 --no-smoke --dummy-weights`
crashes the chip ~22 ms after the first kernel dispatch with:

- Host: `aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018`
- Plog: `errcode 0x800 errorStr: The UB address accessed by the VEC
  instruction is not aligned. ... subErrType:4, tslot:6`
- `fault kernel_name=aicore_kernel_0_mix_aic, hash=15033215677169261682,
  binSize=140920`

That `binSize=140920` matches **exactly** the simpler runtime's compiled
`build/lib/a2a3/onboard/tensormap_and_ringbuffer/aicore_kernel.o` (140920
bytes). The "fault kernel" is the simpler-runtime polling-dispatch executor
itself; the genuinely faulting VEC instruction lives in a function dispatched
via `payload->function_bin_addr` from `execute_task` (FFTS+ MIX stream,
`tslot:6`). CANN's `PrintErrorInfoForDavinciTask` reports the entry-point
binary, not the dispatched function, so the *executor* hash is constant
across all model-side mitigations we tried.

A counter-example in the same repo passes cleanly on the same chip / CANN /
simpler / pto-isa / PTOAS: see "Counter-example" below.

## Reproducer

Single command from a `--no-smoke --dummy-weights` invocation against the
current `pypto-lib/models/step3p5/` working tree:

```bash
# venv with pypto + simpler + pto-isa + ptoas installed
cd /path/to/pypto-lib
python -m models.step3p5.step3p5_decode \
    -p a2a3 -d 0 --no-smoke --dummy-weights
```

Observed (truncated):

```
[chip_process pid=… dev=0] ready
[ERROR] sync_run_streams: [device_runner_base.cpp:877]
        aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
[ERROR] recover_device_or_mark_unusable: [device_runner.cpp:456]
        Device unrecoverable after AICore error 507018:
        aclrtSynchronizeDeviceWithTimeout failed: 507015.
RuntimeError: WorkerThread::dispatch_process: child failed (code=1):
              chip_process dev=0: RuntimeError:
              run_prepared failed with code 507018
```

Plog (from `ASCEND_PROCESS_LOG_PATH=$LOGDIR` then `find $LOGDIR -name
'plog-*.log'`):

```
AllKernelRegister: Runtime_alloc_size 1240, type=0,
    kernel_name=aicore_kernel_0_mix_aic, tilingkey=0, offset=144,
    length=232, dfxAddr=0x0, dfxSize=0, kernelVfType=0, shareMemSize=0.
LaunchKernelWithHandle: kernel info : device_id=0, stream_id=45, task_id=0,
    kernelType=0, kernel_name=aicore_kernel_0_mix_aic,
    arg_size=8, mixType=3, taskRation=2, funcType=0,
    addr1=0x124000000090, addr2=0x12400000076c, flag=0, kernelFlag=0x0,
    qos=0, partId=0, schemMode=1, infoAddr=(nil), atomicIndex=0.
FillFftsMixSqeForDavinciTask: kernelNames_=aicore_kernel_0_mix_aic,
    stackSize=32768.
PrintCoreInfo: The extend info: errcode:(0, 0x800, 0)
    errorStr: The UB address accessed by the VEC instruction is not aligned.
    fixp_error0 info: 0xcc175f7, fixp_error1 info: 0x8e,
    fsmId:0, tslot:6, thread:0, ctxid:0, blk:0, sublk:0, subErrType:4.
PrintErrorInfoForDavinciTask: Aicore kernel execute failed, device_id=0,
    stream_id=45, report_stream_id=45, task_id=0, flip_num=0,
    fault kernel_name=aicore_kernel_0_mix_aic, fault kernel info ext=none,
    program id=0, hash=15033215677169261682.
GetBinAndKernelNameExceptionArgs: kernel_name=aicore_kernel_0_mix_aic,
    kernelNameSize=23, binSize=140920.
```

A subsequent `PrintAicpuErrorInfo: funcName=simpler_aicpu_exec,
errorCode=0x2a` appears ~1900 ms later; this is a **cascade** from the
chip's fault state, not a primary cause (verified by timestamp ordering).

## Counter-example

The qwen3-32b decode reference in the same `pypto-lib`, with the same
single-card harness, passes end-to-end in ~20 seconds:

```bash
cd /path/to/pypto-lib
python -m models.qwen3.32b.qwen3_32b_decode -p a2a3 -d 0
# [RUN] PASS (20.15s)
# [RUN]   'out' PASS  shape=(16, 8192) dtype=torch.bfloat16
```

Same chip / CANN / simpler / pto-isa / PTOAS / Python. The chip + runtime
stack itself is healthy. step3p5 specifically triggers the fault.

## What is at tslot:6 in step3p5

Reading the compiled `next_levels/chip_orch/orchestration/chip_orch.cpp`,
task dispatch index 6 is `full_rope_kv_cache` — a per-batch AIV scope that
applies partial RoPE (rotary_dim=64 of head_dim=128, pass-through tail=64)
and writes K/V cache + a padded Q block. The relevant Python source is
`pypto-lib/models/step3p5/attention_full.py:387-484` (scope 2).

## Mapping addr to the fault PC

`addr1=0x124000000090` and `addr2=0x12400000076c` are the chip-side virtual
addresses of the executor entry. Plog `PrintCoreInfo` reports
`pc current: 0x12c0c00d9d9c`, which is ~0xc00d9d0c bytes past `addr1`. The
executor binary is only 140920 bytes (= 0x22678), so the PC is **not** in
the executor — it is in a dispatched function loaded elsewhere in chip
address space (`function_bin_addr` from `PTO2DispatchPayload`). We were
unable to disassemble device-side binaries from inside the container (no
gdb / objdump for AICore), so we cannot localise the misaligned VEC at the
instruction level. **Asking the maintainer team to do this localisation is
the primary purpose of this report.**

## Version pin table

| Component | HEAD | Notes |
|---|---|---|
| Chip | Ascend 910B2C (`Short_SoC_version=Ascend910B`) | `dav-c220-cube` / `dav-c220-vec`, 24 AIC / 48 AIV / 6 AICPU per die |
| Driver | `npu-smi 25.5.1` | |
| CANN | `9.0.0-beta.1` | Also reproduced on `8.5.1` (verified live `libhccl.so` load) |
| Python | 3.11.14 | Reproduced on 3.10 too |
| simpler | branch `fix/tensor-zero-size-view-bounds:0cd317e7` (= PR #1023 plus host-side `--no-as-needed` link patch + `comm_hccl.cpp` P2P best-effort) | Also reproduces on `main:afb5c5a9` |
| pto-isa | `main:109c9f72` | |
| PTOAS | binary `v0.44` (source `main:29a8af28`) | Also reproduces on `v0.43` |
| pypto | `main:0f4881cb` (post PR#1718 merge) | |
| pypto-lib | `main:9c5593fb` + step3p5 working-tree WIP | qwen3/32b passes against the same SHA |

The constancy of `hash=15033215677169261682, binSize=140920,
addr1=0x124000000090, addr2=0x12400000076c, tslot:6` across all eight
model-side mitigations below (which change every named step3p5 kernel) is
decisive evidence that the faulting kernel is **not** in step3p5 Python
source — it is in code reachable through simpler's polling-dispatch
executor.

## What we tried (all leave the failure unchanged)

1. **Phase A split-scope refactor of `full_fa_fused`** into 4 sequential
   spmds (`full_qk_matmul` AIC → `full_softmax` AIV → `full_sv_matmul` AIC →
   `full_online_softmax` AIV), mirroring qwen3/32b's pattern. Eliminates the
   mixed AIC+AIV dispatch entirely. `chip_orch.cpp` verified — no remaining
   `MixedKernels` groups. → same hash, same tslot:6.
2. **Split `full_out_proj`** into pure-cube matmul + pure-vec cast via FP32
   GM scratch handoff. → same hash.
3. **Split `dense_gate_up_silu_tp` and `dense_down_proj_tp`** the same way.
   → same hash.
4. **SWA mirror** of (1)+(2) in `attention_swa.py`. → same hash.
5. **Full-row cast + overwrite RoPE idiom** for `full_rope_kv_cache` K and Q
   writes (qwen3/32b uses this; replaces a `pl.add(k_pass, 0.0)` workaround
   that was previously masking a different compile-time error). → same hash.
6. **Rewrite `full_rmsnorm_zc`** from `pl.spmd(BATCH//BATCH_TILE=1) +
   pl.range` to qwen3/32b's `pl.at(level=pl.Level.CORE_GROUP) +
   pl.pipeline(stage=4)` form. → same hash.
7. **`pl.parallel(user_batch)` → `pl.parallel(BATCH)`** (dynamic loop bound
   replaced with static Python constant). Tested with defensive `b_safe =
   pl.min(b, user_batch-1)` clamp. → same hash.
8. **TP=1 monkey-patch path** (`--tp-world-size 1`) which takes a different
   code path in `step3p5_decode.py:351-381`. → same hash.

All eight changes are compile-clean (smoke probe rc=0) and structurally
match the working qwen3/32b form in the same repo. None move the fault.

## Rule-out matrix

| Suspect | Outcome | Evidence |
|---|---|---|
| Mixed AIC+AIV dispatch | Ruled out | All `MixedKernels` removed via (1)–(4); `chip_orch.cpp` has only `rt_submit_aic_task` / `rt_submit_aiv_task` |
| pypto#1693 / PR#1718 (multi-output spmd SSA aliasing) | Ruled out | PR #1718 merged on pod (`pypto:0f4881cb`); no effect on this fault |
| CANN version | Ruled out | Reproduces on 8.5.1 and 9.0.0-beta.1 |
| Python version | Ruled out | Reproduces on 3.10 and 3.11 |
| PTOAS version | Ruled out | Reproduces on v0.43 and v0.44 |
| SDMA workspace (`aclnnShmemSdmaStarsQuery`) AICPU 0x2a | Ruled out | `SIMPLER_ENABLE_PTO_SDMA_WORKSPACE=OFF` already in effect; `nm -D libhost_runtime.so` returns zero `SdmaWorkspaceManager` symbols; AICPU 0x2a in the log is a cascade ~1900 ms after the AICore 0x800 |
| TP=8 canonical vs TP=1 monkey-patch | Ruled out | Same hash on both code paths |
| Driver `support_shmem_map_exbus=0` | Ruled out for single-rank | This driver flag affects multi-rank `aclrtIpcMemImportByKey` (filed separately); single-rank reproducer here uses no cross-card IPC |
| Dummy input out-of-bounds (`pos = ctx_len-1` underflow when `seq_lens=0`) | Ruled out | Current `step3p5_decode.py:552` sets `seq_lens = torch.ones(...)` so `pos = 0` is always in-bounds; `slot_mapping = torch.arange(B)` gives unique slots |
| `pl.parallel(dynamic)` vs `pl.parallel(static)` loop bound | Ruled out | (7) above |

## What we believe but cannot verify locally

The faulting VEC instruction is inside a model-kernel dispatched by
simpler's executor at the 7th FFTS+ MIX SQE slot. Strong candidate based on
the dispatch sequence we read out of `chip_orch.cpp`:

- `full_rope_kv_cache` (per-batch loop, AIV) — its position in dispatch
  order matches `tslot:6` directly.

The TileType::Vec declarations we read out of the generated
`full_rope_kv_cache.cpp` all use 32-byte-aligned widths (`float[1,32]`,
`bfloat16[1,32]`, `float[8,32]`, etc.). We did not find a structural
alignment violation by inspection. The pattern that differs from qwen3/32b
and is unique to step3p5 is **partial RoPE** (`ROTARY_HALF_FULL=32`,
rotary_dim=64, pass-through=64) versus full RoPE (rotary_dim=128). Whether
PTOAS lowers the partial-RoPE pattern into an unaligned VEC is what we'd
like the codegen team to confirm.

## What we are asking for

1. **Disassemble** `aicore_kernel.o` (140920 bytes, source
   `simpler/src/a2a3/runtime/tensormap_and_ringbuffer/aicore/aicore_executor.cpp`
   + `simpler/src/a2a3/platform/onboard/aicore/kernel.cpp`) and the model
   kernels generated by PTOAS for the step3p5 reproducer at
   `next_levels/chip_orch/kernels/aiv/full_rope_kv_cache.cpp`. Find the VEC
   instruction at PC offset `~0xc00d9d0c` from kernel base.
2. **Confirm** whether the offending VEC originates in (a) the simpler
   executor, (b) a PTOAS-injected prologue/epilogue, or (c) the dispatched
   model kernel body.
3. If (c), tell us which IR pattern lowered to it — we will then either
   refactor step3p5 to avoid that pattern or push a fix into PTOAS.
4. If (a) or (b), the fix belongs upstream.

## Related local artifacts (available on request)

- Full plog: `/tmp/p15_devlog3/debug/plog/plog-*.log` (multiple runs across
  this session)
- Compiled chip orchestrator: `/tmp/p15_npu_d0/DecodeLayerDense_*/next_levels/chip_orch/`
- Working tree diffs (this session's eight Phase A refactors): under
  `workspace/pypto-lib/models/step3p5/{attention_full,attention_swa,decode_layer}.py`
- Session diagnosis log: `docs/step3p5/phases/15-singlerank-npu.md` — read
  "Phase A execution status (2026-06-11, end of session)" and
  "Simpler-runtime kernel identification (2026-06-11, follow-up)"

## See also

- `docs/upstream-issues/pypto-1702-followup.md` — earlier hypothesis (now
  ruled out) that PR#1718 should fix this fault; filed as pypto#1738 on
  2026-06-10
- `docs/upstream-issues/simpler-comm-init-segfault.md` — separate
  `comm_init` segfault, fixed via `--no-as-needed` link patch
  ([simpler#1018](https://github.com/hw-native-sys/simpler/issues/1018))
- `docs/upstream-issues/step3p5-multirank-shmem-exbus.md` — Phase 16 driver
  capability gap (filed jointly with this issue)

---

## 中文说明（2026-06-15 最新状态）

### 一句话总结

step3p5 单卡 decode bring-up 卡在 AICore `errcode 0x800 "VEC UB not aligned"`
导致的 507018，**最新 bisect（`P15_DISPATCH_LIMIT` 阶梯）已把 fault 钉死在
chip_orch 第 11 号 task = `full_head_gate`（AIV），不是早期认定的
`full_rope_kv_cache`**。同 chip + 同 CANN 上 `qwen3/32b` decode 端到端跑通
20 秒，证明 chip / driver / runtime 健康；问题是 step3p5 在 `full_head_gate`
这个特定 kernel 触发了一条未对齐的 VEC 指令。

### 复现

```bash
# 在装好 pypto + simpler + pto-isa + ptoas 的 venv 里
cd <pypto-lib>
python -m models.step3p5.step3p5_decode -p a2a3 -d 0 --no-smoke --dummy-weights
# 期望: chip 在第一次 kernel dispatch 后 ~22 ms 崩溃
# host: aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
# plog: errcode 0x800 errorStr: "The UB address accessed by the VEC instruction is not aligned"
#       fault kernel_name=aicore_kernel_0_mix_aic, hash=15033215677169261682, binSize=140920
```

`binSize=140920` 字节精确等于 simpler runtime 自带的 polling-dispatch
executor `simpler/build/lib/a2a3/onboard/tensormap_and_ringbuffer/aicore_kernel.o`，
所以"fault kernel"是 simpler 的 dispatch 跳板；真正 fault 的 VEC 指令在
被 dispatch 的 `full_head_gate` body 里。

### 反证：qwen3/32b 同环境通过

```bash
python -m models.qwen3.32b.qwen3_32b_decode -p a2a3 -d 0
# [RUN] PASS (20.15s)   'out' PASS  shape=(16, 8192) dtype=torch.bfloat16
```

同 chip / 同 CANN / 同 simpler / 同 pto-isa / 同 PTOAS / 同 Python。
chip + runtime 没毛病，是 step3p5 特有 IR 模式触发的。

### 定位：dispatch-limit bisect

通过在生成的 `chip_orch.cpp` 里把晚于某个 K 的 `rt_submit_*_task(K, ...)` 调用
注释掉再编 .so，`LIMIT=11` 是 PASS↔FAIL 的精确分水岭，对应单一新增的
`rt_submit_aiv_task(11, params_t11)` = `full_head_gate`（per-rank
head-wise sigmoid gate，source 在
`pypto-lib/models/step3p5/attention_full.py:564-586`，外层
`pl.spmd(BATCH // BATCH_TILE)` + 内层 `pl.range(NUM_HEADS_FULL_LOCAL)`）。

trace harness 文件: `pypto-lib/tools/p15_trace/run_with_trace.py`，
通过 `P15_DISPATCH_LIMIT` 环境变量切换 dispatch 上限。harness sits at
`compile_single_orchestration` 钩子，**不需要重编 simpler runtime**。

### 排除路径（耗时但确凿）

| 排除目标 | 状态 | 证据 |
|---|---|---|
| Mixed AIC+AIV dispatch | ✗ | Phase A 拆完 4 个 fa spmds + out_proj cube/cast 拆分 + dense MLP 拆分；`chip_orch.cpp` 已无 `MixedKernels`，hash 不变 |
| pypto#1693 / PR#1718 (multi-output spmd SSA aliasing) | ✗ | PR#1718 已 ff-merge 进 pypto main；fault 不动 |
| CANN 8.5.1 vs 9.0.0-beta.1 | ✗ | 两个 CANN 版本都崩，`libhccl.so` 加载已实地确认 |
| Python 3.10 vs 3.11 / PTOAS v0.43 vs v0.44 | ✗ | 所有组合都崩 |
| SDMA workspace AICPU 0x2a 级联 | ✗ | `nm -D libhost_runtime.so` 已无 `SdmaWorkspaceManager` 符号；plog 里 AICPU 0x2a 在 AICore 0x800 之后 1900 ms 出现，是 cascade 不是 cause |
| `pos = ctx_len-1` underflow on dummy `seq_lens=0` | ✗ | `step3p5_decode.py:552` 已设 `seq_lens=ones`，`pos=0` 永远 in-bounds |
| `pl.parallel(dynamic)` vs `pl.parallel(static)` | ✗ | 改成静态 `pl.parallel(BATCH=16)` 加 `b_safe` clamp，hash 不变 |
| `full_rope_kv_cache` kernel body | ✗ | rope kernel body 经 byte-wise diff vs 一个 PASS reference 已证明无差，即不是 rope kernel 本身的 bug |

### 我们想请上游做的事

1. **拿到 `aicore_kernel_0_mix_aic` 反汇编**（140920 字节，源
   `simpler/src/a2a3/runtime/tensormap_and_ringbuffer/aicore/aicore_executor.cpp`
   + `simpler/src/a2a3/platform/onboard/aicore/kernel.cpp`）和 PTOAS 为
   step3p5 reproducer 编出来的 `next_levels/chip_orch/kernels/aiv/full_head_gate.cpp`
   反汇编。从 plog 的 `pc current` 找到那条未对齐的 VEC 指令。
2. **告知 fault 来源**: (a) simpler executor 自身、(b) PTOAS 注入的
   prologue/epilogue、还是 (c) `full_head_gate` body 内部。
3. **如果是 (c)**，告诉我们触发的 IR 模式，我们改 step3p5 model code
   绕开。
4. **如果是 (a) 或 (b)**，修在上游。

### 参考产物（按需要可提供）

- 完整 plog（多次失败运行）: `/tmp/p15_devlog3/debug/plog/plog-*.log`
- 编译产物: `/tmp/p15_npu_d0/DecodeLayerDense_*/next_levels/chip_orch/`
- 工作树代码（含 8 处 Phase A 拆分尝试）:
  `pypto-lib/models/step3p5/{attention_full,attention_swa,decode_layer,prefill_attention_full,prefill_attention_swa}.py`
  （已 push 到 `csy0225/pypto-lib:feat/step3p5-phase-a-split-scope`，
  draft PR 已开 = `hw-native-sys/pypto-lib#510`）
- 本地诊断详记: `docs/step3p5/phases/15-singlerank-npu.md`，重点读
  "Phase A execution status (2026-06-11, end of session)" 和
  "Simpler-runtime kernel identification (2026-06-11, follow-up)" 两节


---

## #1037 [Bug] Multi-rank comm_alloc_domain_windows blocked by driver support_shmem_map_exbus=0 (cross-card aclrtIpcMemImportByKey returns 507899)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1037
- Created: 2026-06-11T17:18:40Z
- Updated: 2026-07-12T01:43:41Z
- Closed: 2026-07-12T01:43:41Z

### Body

# [Bug] Multi-rank `comm_alloc_domain_windows` blocked by driver `support_shmem_map_exbus=0` — cross-card `aclrtIpcMemImportByKey` returns 507899

**Repository**: `hw-native-sys/simpler` (for the backend-choice fix path);
secondary CANN driver / Ascend platform team (for the underlying capability
gap). Refile to the right component on triage.

**Filed as**: [simpler#1037](https://github.com/hw-native-sys/simpler/issues/1037) (2026-06-12)

**Severity**: blocking multi-rank L3 deployment on driver 25.5.1 + CANN
9.0.0-beta.1; we cannot reach Phase 16 (TP=8 / EP=8) of step3p5 bring-up.

> Filed jointly with `step3p5-507018-vec-ub-align.md` (Phase 15 single-rank
> blocker). The two problems are logically independent — fixing this one
> unblocks Phase 16 multi-card deployment but does **not** fix the 507018
> single-rank VEC UB align fault, and vice versa.

## Summary

After [simpler#1018](https://github.com/hw-native-sys/simpler/issues/1018)
(comm_init segfault) was resolved via the `--no-as-needed` link patch on
`src/{a2a3,a5}/platform/onboard/host/CMakeLists.txt` (this session, verified
working with `nm -D libhost_runtime.so | grep NEEDED` showing `libhcomm.so`
present), the **next** failure on the multi-rank path is now:

```
[ERROR] domain_alloc_via_ipc: aclrtIpcMemImportByKey failed with 507899
[ERROR] comm_alloc_domain_windows: domain alloc failed for chip N
```

Tracing through CANN runtime, the underlying driver query is:

```c
halShmemOpenHandleByDevId(chip_handle, peer_dev_id, &remote_handle);
// returns DRV_ERROR_PARA_ERROR(8) on this driver, because:
//   driver_query(chip_handle, /*query=*/SUPPORT_SHMEM_MAP_EXBUS) == 0
```

That is, the driver firmware on this machine reports
`support_shmem_map_exbus = 0`, which means cross-die / cross-card shmem
mapping over Ex-Bus is **not supported** on this driver+silicon
combination. simpler's Path-D DIY-IPC comm backend depends on this
capability for cross-card window mapping, so it cannot complete
`comm_alloc_domain_windows`.

## Reproducer

After applying the `--no-as-needed` link patch from simpler#1018 and the
CANN-9.0.0-beta.1 install, run any multi-rank simpler L3 example that calls
`comm_alloc_domain_windows`:

```bash
export PTO_ISA_ROOT=/path/to/pto-isa
export ASCEND_HOME_PATH=/usr/local/Ascend/cann-9.0.0-beta.1
cd /path/to/simpler/examples/workers/l3/allreduce_distributed
PYTHONFAULTHANDLER=1 python -X faulthandler main.py -p a2a3 -d 0-1
```

After `comm_init` succeeds (no longer segfaults), the next stage fails:

```
[chip 0] comm_init done
[chip 1] comm_init done
[ERROR] domain_alloc_via_ipc: aclrtIpcMemImportByKey failed with 507899
        flags=0 (also tested ACL_RT_IPC_MEM_IMPORT_FLAG_ENABLE_PEER_ACCESS)
[ERROR] comm_alloc_domain_windows: domain alloc failed for chip 1
```

## Direct driver query

The capability gap is observable at the driver layer, independent of
simpler:

```bash
# Use Ascend's driver query interface (or equivalent CANN-side probe)
# to read the SUPPORT_SHMEM_MAP_EXBUS bit for chip 0:
$ ascend-driver-query --chip 0 --capability support_shmem_map_exbus
support_shmem_map_exbus = 0   # ← false on this driver/firmware
```

A driver that reports `support_shmem_map_exbus = 1` should accept the same
`halShmemOpenHandleByDevId(...)` call and return a valid remote handle,
unblocking `aclrtIpcMemImportByKey`.

## Verification that this is the driver and not simpler

Two independent control experiments confirm the limitation is in the driver
firmware, not in simpler's IPC bring-up code:

1. **vLLM-Ascend TP=8 on the same pod, same 8 cards, same CANN 9.0.0-beta.1,
   same driver 25.5.1** — passes cleanly:

   ```bash
   vllm serve <model> --tensor-parallel-size 8
   # [OK] Worker 7 ready, all 8 ranks serving traffic
   ```

   vLLM-Ascend uses CANN's HCCL **collective communication** primitives
   (`torch.distributed.init_process_group("hccl")` with `spawn`-style worker
   bring-up). It does **not** touch `aclrtIpcMemImportByKey` or
   `halShmemOpenHandleByDevId` because HCCL collectives bypass user-space
   cross-card device-memory IPC entirely.

2. **simpler's own `aclrtDeviceEnablePeerAccess` succeeds** (returns 0) on
   the same chip pair where `aclrtIpcMemImportByKey` returns 507899. Peer
   access is enabled at the device level; what's missing is the
   shmem-over-exbus path that `aclrtIpcMemImportByKey` requires.

So the runtime stack (driver / HCCL / firmware) is healthy for collective
communication, and the specific gap is "user-space cross-card IPC via Ex-Bus
shmem mapping" which simpler's current DIY-IPC backend relies on.

## Version pin table

| Component | HEAD | Notes |
|---|---|---|
| Chip | 8 × Ascend 910B2C, `Short_SoC_version=Ascend910B` | shared 64 GB HBM per die, PCIe Gen4 x16 between cards |
| OS | Ubuntu 22.04, x86_64 host | |
| Driver | `npu-smi 25.5.1`, firmware `7.8.0.6.201` | the driver where `support_shmem_map_exbus=0` |
| CANN | `9.0.0-beta.1` (matches driver) | Also reproduces on `8.5.1` after similar patches |
| simpler | branch `fix/tensor-zero-size-view-bounds:0cd317e7` (= PR #1023 + host `--no-as-needed` + comm_hccl P2P best-effort + ImportByKey ENABLE_PEER_ACCESS) | comm_init segfault [simpler#1018](https://github.com/hw-native-sys/simpler/issues/1018) fix verified working |
| pto-isa | `main:109c9f72` | |
| PTOAS | binary `v0.44` | |

## What we tried (none fix it)

1. **Enable peer access first** via `aclrtDeviceEnablePeerAccess` before
   `aclrtIpcMemImportByKey` → still 507899.
2. **Pass `ACL_RT_IPC_MEM_IMPORT_FLAG_ENABLE_PEER_ACCESS` flag** to
   `aclrtIpcMemImportByKey` (instead of `flags=0`) → still 507899.
3. **Retry with `ACL_RT_PEER_ACCESS_BLOCK_MODE_AUTO`** and other flag
   combinations from the CANN 9.0 ACL reference → still 507899.
4. **Hit each pair of chip IDs** (0↔1, 0↔7, 6↔7) — all fail identically.
   Not a chip-pair-specific routing problem.

Per the comments at
`simpler/src/a2a3/platform/onboard/host/comm_hccl.cpp:652-660`, the SDMA
workspace path that depends on the same capability is also gated; we have
that path compiled out (`SIMPLER_ENABLE_PTO_SDMA_WORKSPACE=OFF`) as a
side-effect of our `comm_init` workaround, but the underlying capability
remains absent.

## Two possible fix paths (asking maintainers to choose)

### Path A — driver / firmware update enables `support_shmem_map_exbus`

If the underlying silicon (910B2C) actually supports cross-card Ex-Bus shmem
mapping, the right fix is a driver / firmware update that turns the
capability bit on. Cleanest, requires zero simpler-side change. The
infrastructure team has to deploy this — outside our control, hence this
issue.

### Path B — simpler swaps DIY-IPC for HCCL collective comm

If the capability is **not** supported on this silicon and never will be,
simpler's L3 comm backend should fall back to CANN's HCCL collectives
(`HcclAllReduce`, `HcclAllToAll`, etc.) the same way vLLM-Ascend does.
That's a larger refactor but it would unblock all current driver/firmware
combinations. Requires:
- Add a new `comm_backend` selector in simpler init (we'd default to
  `hccl_collectives` on driver-without-exbus, keep `diy_ipc` available for
  driver-with-exbus).
- Map simpler's per-call `pld.tensor.put` / `pld.tensor.get` primitives onto
  HCCL collective calls (or HCCL P2P send/recv where the semantics fit).

We can pilot Path B in our fork if that's the preferred direction; happy to
contribute the patch.

## What we are asking for

1. **Decide which path** (A driver-fix vs B backend-swap) is the intended
   long-term fix.
2. If A: tell us what driver/firmware version turns `support_shmem_map_exbus`
   on for 910B2C, so we can request the install.
3. If B: confirm direction and we'll prepare a draft PR adding the
   HCCL-collective backend behind a comm-backend selector in simpler init.

## Related local artifacts (available on request)

- Plog from a failing 2-rank `allreduce_distributed` run with the
  comm_init segfault fix applied
- `npu-smi info -t topo` output showing PCIe inter-die routing on this pod
- Output of the SDMA workspace probe (`SIMPLER_ENABLE_PTO_SDMA_WORKSPACE=ON`
  reproduces the original AICPU `ShmemSdmaStarsQuery` 0x2a → 507018 cascade
  the CMake comment at `comm_hccl.cpp:36-50` describes; with OFF, that
  particular cascade is gone and we land cleanly at the
  `aclrtIpcMemImportByKey` 507899 described here)

## See also

- `docs/upstream-issues/simpler-comm-init-segfault.md` — the prerequisite
  fix ([simpler#1018](https://github.com/hw-native-sys/simpler/issues/1018))
  for `comm_init` segfault; verified working this session via
  `--no-as-needed` link patch
- `docs/upstream-issues/step3p5-507018-vec-ub-align.md` — Phase 15
  single-rank VEC UB align (filed jointly with this issue; logically
  independent)
- `docs/step3p5/phases/16-multirank-npu.md` — local Phase 16 status,
  including the working comm_init verification and the
  `aclrtIpcMemImportByKey 507899` block detail

---

## 中文说明

### 一句话总结

step3p5 多卡 deployment 在 [simpler#1018](https://github.com/hw-native-sys/simpler/issues/1018)
（comm_init 段错）通过 host CMakeLists `--no-as-needed` 链接补丁解决之后，
**下一个卡点**变成了 driver firmware 的能力缺口：910B2C 在当前 driver/CANN
组合下 `support_shmem_map_exbus = 0`，导致 simpler 的 DIY-IPC 通信后端做
跨卡 window mapping 时 `aclrtIpcMemImportByKey` 一律返回 507899。

### 复现

修了 simpler#1018 的 `--no-as-needed` 之后，跑 simpler 自带的多卡 L3 例子：

```bash
export PTO_ISA_ROOT=/path/to/pto-isa
export ASCEND_HOME_PATH=/usr/local/Ascend/cann-9.0.0-beta.1
cd /path/to/simpler/examples/workers/l3/allreduce_distributed
PYTHONFAULTHANDLER=1 python -X faulthandler main.py -p a2a3 -d 0-1
# 期望: comm_init 已不再段错；下一阶段崩在
# [ERROR] domain_alloc_via_ipc: aclrtIpcMemImportByKey failed with 507899
# [ERROR] comm_alloc_domain_windows: domain alloc failed for chip 1
```

CANN runtime 内部对应：

```c
halShmemOpenHandleByDevId(chip_handle, peer_dev_id, &remote_handle);
// 返回 DRV_ERROR_PARA_ERROR(8)，因为
//   driver_query(chip_handle, /*query=*/SUPPORT_SHMEM_MAP_EXBUS) == 0
```

### 反证：vLLM-Ascend 同环境通过

同 pod / 同 8 卡 / 同 driver 25.5.1 / 同 CANN 9.0.0-beta.1：

```bash
vllm serve <model> --tensor-parallel-size 8
# [OK] Worker 7 ready, all 8 ranks serving traffic
```

vLLM-Ascend 用的是 CANN 的 HCCL 集合通信原语
（`torch.distributed.init_process_group("hccl")` + `spawn` 起 worker），
**完全不走** `aclrtIpcMemImportByKey` 或 `halShmemOpenHandleByDevId`，
因为 HCCL 集合通信绕开了 user-space 跨卡 device-memory IPC。所以 chip
+ runtime + HCCL 没毛病；缺的是 simpler DIY-IPC 后端依赖的"跨卡 Ex-Bus
shmem mapping"这个特定能力。

### 我们的两条 fix path（请上游选）

**Path A — 驱动/固件升级，开 `support_shmem_map_exbus`**

如果 910B2C 硬件确实支持跨卡 Ex-Bus shmem mapping，正确的修法是出一个
开了这个 capability bit 的 driver/firmware。simpler 侧零改动，最干净。
但需要基础设施团队部署 — 不在我们的控制范围，所以才发这个 issue。

**Path B — simpler 把 DIY-IPC 换成 HCCL 集合通信**

如果 silicon 不支持也不会再支持 Ex-Bus shmem mapping，那 simpler 的 L3
通信后端应该 fallback 到 CANN HCCL collectives（`HcclAllReduce`、
`HcclAllToAll` 等），跟 vLLM-Ascend 一样。这个改动大一些但能解锁所有当前
driver/firmware 组合。需要：
- simpler init 加一个 `comm_backend` 选项（默认在 driver-without-exbus
  上选 `hccl_collectives`，driver-with-exbus 时仍可选 `diy_ipc`）
- simpler 的每一次 `pld.tensor.put` / `pld.tensor.get` 原语映射到 HCCL
  collective 调用（或者 HCCL P2P send/recv，按语义合适的）

如果上游选 Path B，我们这边可以试做 patch 在 fork 上，欢迎指导方向。

### 我们已经试过没用的

| 尝试 | 结果 |
|---|---|
| `aclrtIpcMemImportByKey` 之前先 `aclrtDeviceEnablePeerAccess` | 还是 507899 |
| 给 `aclrtIpcMemImportByKey` 传 `ACL_RT_IPC_MEM_IMPORT_FLAG_ENABLE_PEER_ACCESS` flag | 还是 507899 |
| 试 `ACL_RT_PEER_ACCESS_BLOCK_MODE_AUTO` 等其他 CANN 9.0 ACL 文档里的 flag 组合 | 还是 507899 |
| 换不同 chip pair (0↔1, 0↔7, 6↔7) | 都崩，不是 chip-pair-specific 路由问题 |

注：`SIMPLER_ENABLE_PTO_SDMA_WORKSPACE=OFF` 在我们这边已经强制关闭
（`comm_hccl.cpp:36-50` 的注释说明这条路径会触发 `aclnnShmemSdmaStarsQuery`
AICPU 0x2a → 507018 cascade）。关掉之后那条 cascade 不再触发，但底层能力
缺口还在 = 卡在 `aclrtIpcMemImportByKey` 507899。

### 可按需要提供的本地工件

- 加了 #1018 修复后跑 2-rank `allreduce_distributed` 失败的完整 plog
- 本 pod 的 `npu-smi info -t topo` 输出（PCIe inter-die routing）
- 把 `SIMPLER_ENABLE_PTO_SDMA_WORKSPACE=ON` 时复现的 SDMA workspace AICPU
  0x2a → 507018 cascade 完整链（`comm_hccl.cpp:36-50` 注释里描述的那一条）


---

## #1038 [Feature] Recover scope_stats records on the abnormal path (hang / op-timeout)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1038
- Created: 2026-06-12T00:50:18Z
- Updated: 2026-06-17T01:36:19Z
- Closed: 2026-06-17T01:36:19Z
- Labels: enhancement

### Body

### Summary

`scope_stats` (scope-statistics profiling) drops its already-recorded records
when a run hangs (AICPU scheduler-hang / AICore op-timeout). When the AICPU is
reaped before it flushes its scope_stats buffer, the host's
`reconcile_counters` detects the un-flushed buffer ("device flush failed") but
only **logs** it — the records are lost. Give scope_stats the same
abnormal-path recovery that tensor dump just got (#1034 / #1035), so a hung run
still yields the scope records collected up to the hang.

### Motivation / Use Case

scope_stats is a diagnostic; like tensor dump, it is most valuable exactly when
a run misbehaves — yet today its already-recorded records are dropped on the
hang path:

- **Host export on the error path is already covered** —
  `teardown_shared_collectors_after_run()` exports scope_stats on the op-timeout
  return after #1035 (it runs `stop()` → `reconcile_counters()` →
  `write_jsonl()`).
- **Host-side recovery of an un-flushed device buffer is NOT.**
  scope_stats's reconcile (`scope_stats_collector.cpp`, the
  "un-flushed buffer ... device flush failed" path) has the same
  detection-only behaviour that tensor dump's reconcile had before #1035, and
  only logs. When the AICPU is reaped before flushing — or when orchestration
  hangs before the orchestrator-phase flush
  (`scope_stats_aicpu_flush_buffers()` in `aicpu_executor.cpp`) — those records
  never reach disk.

### Proposed API / Behavior

Mirror the tensor-dump fix (#1035) for scope_stats; no user-facing API change:

1. In scope_stats `reconcile_counters`, when `current_buf_ptr != 0` with a
   non-empty buffer, **recover** those records directly from the device buffer
   (before the device force-reset) into the collected set instead of just
   logging, so `write_jsonl` exports them.
2. (Optional) Also flush the scope_stats partial buffer on the
   scheduler-timeout exit path for an AICPU-stall hang, so the device delivers
   cleanly when it still can.

### Additional Context

Related: #1034 / #1035 — tensor-dump abnormal-path dump + host-side recovery;
this issue applies the same pattern to the scope_stats collector. #996 is a
separate scope_stats accounting bug, not this.

---

## #1043 [Code Health] Extract dump/scalar-selection out of runtime Arg + give PTO2_PROFILING a single source of truth

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1043
- Created: 2026-06-12T08:13:44Z
- Updated: 2026-06-18T02:57:22Z
- Closed: 2026-06-18T02:57:22Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Orchestration

### Description

`pto_types.h` (the submit-side `Arg` builder) carries two linked code-health problems, both surfaced while working on the scalar partial-selection (`dump()`) feature.

**Problem 1 — profiling/dump machinery is intrusively bolted onto the runtime `Arg`.**
The dump / scalar-selection bookkeeping — `dump_arg_mask_`, `dump_arg_index_ambiguous_mask_`, `scalar_source_ptrs_[]`, `scalar_dtypes_[]`, `mark_dump_arg(...)`, `mark_all_dump_args`, `is_supported_dump_arg_v`, plus the `#if PTO2_PROFILING` blocks sprinkled through `clear()` / `add_scalar_one()` / `add_scalars*()` / `copy_scalars_from()` — lives inside the runtime `Arg` struct. Most of it has **no runtime-type dependency**: it operates on `uintptr_t` / index / counts plus `dtype_of` / `is_supported_scalar_arg_v` from `common/task_interface`. Only the `Tensor` / `TensorCreateInfo` identity resolution genuinely needs runtime types. The downstream consumers of these masks already live in `src/common/platform/` (`tensor_dump_aicpu.h`), so the producer side is sitting in the wrong layer.

**Problem 2 — `PTO2_PROFILING` has no single source of truth.**
The macro is fallback-defined via scattered `#ifndef PTO2_PROFILING / #define PTO2_PROFILING 1` in ~8 runtime headers across a5 and a2a3. There is no authoritative definition (no `-D`, no central header). Beyond the duplication, this directly blocks Problem 1: relocating the gated interfaces to a lower layer would force that layer to `#include` a runtime header to read the macro — a platform→runtime **reverse dependency**.

The two are linked: keeping the relocated code **macro-free** (gate only at the runtime call site, exactly as `tensor_dump_aicpu.h` already does) avoids the reverse dependency, and `PTO2_PROFILING` independently deserves one home.

Related: #1026 (selective scalar dump API — the feature this refactor unblocks).

### Location

Problem 1 (dump/scalar-selection machinery on `Arg`):
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_types.h` (`Arg`, lines ~180-552)
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_types.h` (byte-identical mirror)
- downstream consumers already in common: `src/common/platform/include/aicpu/tensor_dump_aicpu.h`

Problem 2 (`PTO2_PROFILING` fallback `#ifndef/#define` sites):
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_types.h:44`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2_types.h:57` (full hierarchy + `#error` checks)
- `src/a5/runtime/host_build_graph/runtime/tensor_info.h:25`
- `src/a5/runtime/host_build_graph/runtime/pto_runtime2_types.h:19`
- the four corresponding a2a3 headers

### Proposed Fix

Two independent steps (full plan in the comment below):
1. **Problem 2:** extract `src/common/task_interface/profiling_config.h` holding the full macro hierarchy (keep `#ifndef` guards so `-D` still overrides); repoint all ~8 fallback blocks to `#include` it. Single source of truth, dedups a5/a2a3, no build-config change.
2. **Problem 1:** add a macro-free `DumpArgSelection` struct under `src/common/platform/include/aicpu/`; `Arg` holds it behind `#if PTO2_PROFILING`, resolves `Tensor`/`TensorCreateInfo` to indices on the runtime side, and delegates the rest. Gating stays entirely in `Arg`, so the extracted code never references `PTO2_PROFILING` → no reverse dependency.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1045 [Performance] Wrong AICPU affinity assignment causes significant performance decrease

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1045
- Created: 2026-06-12T11:43:44Z
- Updated: 2026-06-25T01:13:46Z
- Closed: 2026-06-25T01:13:46Z
- Labels: performance

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

Simpler is occasionally choosing AICPU threads across NUMA (AICPU Package) domains to work as scheduler and orchestrator threads. This severely affects AICPU performance during the execution of a kernel (up to 7%, given our measurements). This is in line with what we have recently documented in our recent [Report](https://jx.huawei.com/redirect/qe8vkejFB94) (Huawei-employee only), where we concluded that having the scheduler and orchestrator, all in the same NUMA domain, is a necessary condition for scheduling performance.

The cause is the `platform_aicpu_affinity_gate()` function (see: https://github.com/hw-native-sys/simpler/blob/2668be5a7627c2ae56ecb0012ec2be1181dc9455/src/common/platform/onboard/aicpu/platform_aicpu_affinity.cpp#L39) whose logic does not seem to constrain affinity assignment to a single AICPU package.

To solve this issue, one should make `platform_aicpu_affinity_gate()` enforce that all threads lie in the same NUMA domain — ideally making placement 100% deterministic, except when `runtime->aicpu_thread_num` exceeds the size of a single NUMA domain.

A pull request with a proposed solution can be found here: #1046 

### Git Commit ID

196bcc677b759f8298900871059af5a64fc846fb

### CANN Version

9.0.0

### Driver Version

26.0.rc1

### Host Platform

Linux (aarch64)

### Reproduction

```bash
Let Claude run src/simpler/.claude/skills/benchmark/SKILL.md /benchmark
```

You can use the following snippet to check the assignment is correct or not:

```C++

    #ifdef __linux__
    #include <sched.h>
   #endif

    // Get current CPU ID
    int cpu = sched_getcpu();

    LOG_INFO_V0("Thread[%d] is mapped to cpu %d", cpu);
```

Then check that all cores are set to AICPU package 1 (assigned to 4-7)

### Expected Performance

Example                                          Base (main)   HEAD (us)   Delta (us)   Change (%)
-------------------------------               ---------      ---------   ----------   ----------
benchmark_bgemm (Case0)                    665.3         619.3           -46.0        **-6.92% ✓**
  (host)                                               107086.4    113684.5      +6598.1        +6.16%
  (device)                                                2230.5        1957.1         -273.4       -12.26%
  (sched)                                                   665.3          619.3           -46.0        -6.92%
  (orch)                                                     606.6          563.4           -43.2        -7.12%

### Actual Performance

Example                                          Base (main)   HEAD (us)   Delta (us)   Change (%)
-------------------------------               ---------      ---------   ----------   ----------
benchmark_bgemm (Case0)                    665.3         619.3           -46.0        **-6.92% ✓**
  (host)                                               107086.4    113684.5      +6598.1        +6.16%
  (device)                                                2230.5        1957.1         -273.4       -12.26%
  (sched)                                                   665.3          619.3           -46.0        -6.92%
  (orch)                                                     606.6          563.4           -43.2        -7.12%

### Profiling Data (Optional)

_No response_

### Additional Context

_No response_

---

## #1047 [Performance] Orchestration entry copies every tensor host↔device both directions, ignoring ArgDirection

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1047
- Created: 2026-06-15T01:09:08Z
- Updated: 2026-06-15T12:09:22Z
- Closed: 2026-06-15T12:09:22Z
- Labels: performance

### Body

### Platform

All / Unknown (the copy logic is mirrored on both a5 and a2a3)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

At the orchestration entry point, host↔device tensor transfer **does not look at
the per-argument direction** (`ArgDirection` / `TensorArgType`: `IN` / `OUT` /
`INOUT`). Every non-`child_memory` tensor is copied **host→device at start** and
**device→host at end**, regardless of its direction. This wastes:

- **H2D bandwidth** uploading pure `OUTPUT` buffers — the host-side content is
  uninitialized/garbage, so copying it up is meaningless.
- **D2H bandwidth** copying back pure `INPUT` buffers — read-only inputs are
  never modified by the kernel, so copying them back is wasted work.

Only `INOUT` genuinely needs both directions; `child_memory` tensors need
neither (already on device).

The `signature` (`ArgDirection[]`) is already plumbed end-to-end to the host
runtime, but is dropped at the consumption site — the comment in
`c_api_shared.cpp` states it is "plumbed end-to-end for per-tensor direction
decisions in runtime_maker but is currently **unconsumed on both runtimes**".

### Git Commit ID

7c2f35fec10acf879401f008a813f0102870596e

### Host Platform

Linux (aarch64)

### Reproduction

The waste is observable directly in the host runtime's INFO logs — every tensor
is logged once on upload (H2D) and once on copy-back (D2H), regardless of
direction:

\`\`\`bash
# Run any example that has input-only tensors alongside output tensors.
python tests/st/a5/tensormap_and_ringbuffer/<example>/test_*.py -p a5 -d 1

# In the host log:
#   bind_callable_to_runtime_impl -> "Tensor i: <N> bytes at 0x..."   (H2D upload, printed for EVERY tensor)
#   validate_runtime_impl        -> "Tensor i: <N> bytes copied to host" (D2H copy-back, printed for EVERY tensor)
#
# => pure-INPUT tensors are copied back, and pure-OUTPUT tensors are copied up.
\`\`\`

### Expected Performance

Copies should be gated on `ArgDirection`:

- `IN`    -> H2D copy-in only; **no** copy-back.
- `OUT`   -> device buffer only (skip the H2D copy-in of garbage); D2H copy-back only.
- `INOUT` -> both directions (today's behavior).
- `child_memory` -> neither direction.

For a typical kernel with mostly read-only inputs (weights, KV-cache) plus a
small output, this removes the dominant share of both the H2D and D2H traffic.

### Actual Performance

All non-`child_memory` tensors are copied **both** directions unconditionally:

- **H2D (start)** — \`bind_callable_to_runtime_impl\` loops over every tensor and
  does \`device_malloc\` + \`copy_to_device\`, branching only on \`is_child_memory()\`,
  never on direction. Pure outputs are uploaded too.
- **D2H (end)** — \`validate_runtime_impl\` loops over every recorded
  \`tensor_pairs_\` entry and does \`copy_from_device\`, gated only on null
  host/dev pointers, never on direction. Pure inputs are copied back too.

### Profiling Data (Optional)

Related closed issue #796 ("validate_runtime_impl is ~2x the chip-side cost per
run") measured ~50ms of copy-back overhead and explicitly hypothesized angle #1:
"Are all tensor pairs that validate_runtime_impl iterates actually outputs? If
the loop is also copying back inputs/weights/KV-cache entries ... that is the
bug." This issue is the root-cause counterpart: the direction info needed to
avoid those copies is available but unconsumed.

### Additional Context

Code locations (mirrored on both runtimes):

- a5:   \`src/a5/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp\`
  - \`bind_callable_to_runtime_impl\` (H2D loop) — signature param is \`const ArgDirection * /*signature*/\` (unused)
  - \`validate_runtime_impl\` (D2H loop)
- a2a3: \`src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp\` (same structure)
- Plumbing: \`src/common/platform/onboard/host/c_api_shared.cpp\` passes \`bind_result.signature\` into \`bind_callable_to_runtime_impl\`.

Suggested fix: consume the already-plumbed \`signature\`/\`sig_count\` in
\`bind_callable_to_runtime_impl\` to skip H2D for \`OUT\`, and tag each
\`tensor_pairs_\` entry with its direction so \`validate_runtime_impl\` skips D2H for
\`IN\`. Note the existing \`graph_output_ptr\` first-output-tensor heuristic in
\`validate_runtime_impl\` should be revisited together, since it currently assumes
the first iterated pair is an output.

Related: #796

---

## #1049 [Feature] swimlane_converter: render SPMD deps at block granularity, not a per-instance crossbar

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1049
- Created: 2026-06-15T02:31:07Z
- Updated: 2026-06-30T11:54:18Z
- Closed: 2026-06-30T11:54:18Z
- Labels: enhancement

### Body

### Summary

The runtime resolves SPMD inter-block dependencies at **per-SPMD-block (scope) granularity**, but `swimlane_converter` expands each block-level edge into a dense **per-instance crossbar** of flow arrows. Represent the dependency at block granularity (or clearly annotate it) so the trace doesn't imply per-instance dependency resolution.

### Motivation / Use Case

- For a whole kernel (DSv4 `decode_sparse_attn`), `deps.json` captures the dependency graph as **9 task nodes / 23 tensor-mediated edges** (`source: tensormap`, region `overlap: covered/other`) — i.e. one node per SPMD block.
- The same run's `merged_swimlane_*.json` contains **613,820 flow events** (`cat: flow, name: dependency`) — every block-level edge is blown up into a per-instance crossbar (e.g. 128 producer instances × 64 consumer instances).
- Empirically the runtime does a **per-scope barrier**: dependent stages run sequentially with only a small dispatch gap and do not overlap at the instance level, while a dependency-free input-only pre-pass correctly floats ahead and overlaps. So the per-instance arrows do not correspond to real runtime edges.
- This misleads performance analysis — a reader looking at the swimlane concludes the runtime resolves a full per-instance dependency between consecutive SPMD stages, and reasons about dependency-resolution cost / overlap potential incorrectly. It also bloats the merged trace from ~2 MB to ~110 MB.

### Proposed API / Behavior

Any subset:

1. Collapse the per-instance flow arrows to **one representative edge per (producer-block, consumer-block)** pair, annotated with the fan degree (e.g. `128→64`).
2. Add a **block-level dependency view / toggle** alongside the per-instance one.
3. At minimum, **document** (tool help + output) that the flow arrows are a conservative visualization expansion of block-level `tensormap` edges, not runtime per-instance edges.

Reducing the arrow count would also shrink the merged trace dramatically.

### Additional Context

- Repro: run a kernel with `--enable-l2-swimlane --enable-dep-gen` (e.g. pypto-lib `models/deepseek/v4/decode_sparse_attn.py -p a2a3`), then compare `deps.json` (9 nodes / 23 edges) against `merged_swimlane_*.json` (613,820 flow events) in the same `dfx_outputs/`.
- runtime (simpler) commit: `48980572`.
- Related: simpler#1001 (text-based dep_gen rendering) — adjacent tooling, but a different concern (output format of the dep_gen graph).

---

## #1050 [Bug] Swimlane: the two vector subblocks of a fused 1c2v show very unequal durations

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1050
- Created: 2026-06-15T06:30:08Z
- Updated: 2026-06-15T07:09:30Z
- Closed: 2026-06-15T07:09:30Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

All / Unknown

### Description

**Main question: in a fused 1c2v stage, the two vector subblocks (2v) report very unequal durations in the merged swimlane — one is up to ~3x the other — which looks wrong for a symmetric 1c2v.**

Investigated on `models/deepseek/v4/decode_sparse_attn.py` (pypto-lib) and reproduced on a minimal standalone mix kernel. Measured per-stage means (each stage is one matmul → vector epilogue → store, i.e. a fused cube→vector region):

| stage | AIC | AIV subblock0 (even core) | AIV subblock1 (odd core) |
|---|---|---|---|
| proj_a | 47.3 | 48.1 | 47.0 |
| proj_b | 48.4 | **129.5** | **45.0** |
| attn_out_scale (minimal repro) | 44.2 | **71.4** | **43.2** |

proj_b and the minimal repro show the two vector subblocks badly unequal; proj_a happens to look balanced.

### Root cause found (for reference)

The inequality is real, not a measurement glitch — but the swimlane representation is misleading. The emitted ptoas shows the cube→vector handoff is `tpush_to_aiv {split = 0}`, and the AIV kernel is an `if subblock_idx == 0 / else`:

- **subblock 0** does all the real work and holds the only `tstore`.
- **subblock 1** is a phantom: its tiles are `valid_row=0 valid_col=0`, it does no compute and no `tstore`, only the `tpop_from_aic` handshake.

So every one of these stages is effectively **1c1v** — only one vector core works. The key relationship: **subblock 1's duration ≈ the AIC duration** in all three stages (47≈47, 45≈48, 43≈44), because the phantom subblock just waits on the cube's pushes and exits when the cube stops feeding. subblock 0's duration = `max(cube feed time, its own vec+store time)`.

This explains why proj_a looks balanced and proj_b does not:
- **proj_a is cube-bound** (vec work ≤ cube time) → subblock0 ≈ subblock1 ≈ AIC → looks balanced (the idle 2nd core is harmless here).
- **proj_b / attn_out_scale are vector-bound** (subblock0 vec+store >> cube) → subblock0 >> subblock1(=AIC floor) → looks unequal.

Confirmation that it's the split=0 degeneration: adding `optimizations=[pl.split(pl.SplitMode.UP_DOWN)]` to the minimal repro flips the handoff to `split = 1`, removes the `subblock_idx` branch entirely, and both subblocks then process half the rows **with a real `tstore`** — durations become balanced (44.7 vs 44.3, vs 71.4/43.2 before).

### The swimlane problem

The phantom subblock 1 is drawn with a **substantial duration (≈ the AIC feed time)**, not near-zero. From the timeline alone you cannot tell that subblock 1 is **idle-waiting on `tpop`** rather than computing — it just looks like "the two vector cores took unequal time." This (a) makes a 1c1v-degenerate stage read as a merely-unbalanced 1c2v, and (b) hides that the second vector core is doing no useful work. The same ambiguity inflates the AIC bars too: identical-workload cube tasks (fixed-size matmul) span ~3µs→95µs because the bar is wall-clock occupancy including dispatch + producer→consumer GM waits, not compute.

Request: in the swimlane, make idle/sync-only time (waiting on `tpop`/`tpush`, dispatch, GM-dependency stalls) visually distinct from compute time, so a phantom subblock and a stalled cube are not shown as if they were busy.

### Steps to Reproduce

1. Run a fused 1c2v kernel with the swimlane enabled, e.g. `python models/deepseek/v4/decode_sparse_attn.py -d <dev> --enable-l2-swimlane` (pypto-lib).
2. Open `dfx_outputs/merged_swimlane_*.json`, aggregate `proj_b_aiv` (and `proj_a_aiv`) task durations by core parity (subblock 0 vs 1), and compare with `ptoas/proj_b.pto` (`tpush_to_aiv {split = 0}`, phantom else-branch).
3. Compare AIC mean vs subblock-1 mean per stage to see subblock1 ≈ AIC.

### Expected Behavior

Idle / sync-only vector subblocks (and stalled cube tasks) should be distinguishable from genuinely-busy ones, so unequal 2v durations are not misread as both cores doing comparable work.

### Actual Behavior

The phantom vector subblock is drawn with ≈AIC duration; the two vector subblocks of a 1c2v look "unequal" with no indication that one is idle-waiting and does no store.

### Git Commit ID

f1062ff0ef272c1ab619c6e8acb4fa0a53476fe3

### Driver Version

26.0.rc1

### Host Platform

Linux (aarch64)

### Additional Context

Related: #1049 (swimlane dependency visualization). Screenshot and swimlane JSON to be attached by the reporter.

---

## #1052 swimlane_converter: multi-value counter events (ph:C) break Perfetto import ('Args error in counter event')

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1052
- Created: 2026-06-15T07:23:22Z
- Updated: 2026-06-17T03:25:24Z
- Closed: 2026-06-17T03:25:24Z

### Body

## Summary

`tools/swimlane_converter.py` emits the scheduler queue-depth tracks as Perfetto **counter events (`"ph": "C"`) with multi-value `args`** (`{"AIC", "AIV", "MIX"}`). The legacy Chrome trace viewer tolerates this "multi-series counter" shape, but Perfetto's `trace_processor` JSON importer (ui.perfetto.dev) rejects it, so the whole `merged_swimlane_*.json` fails to load with:

```
Parse json data error: Args error in counter event name:local_ready_buf_T0
```

Because the import aborts, **none** of the swimlane (lanes / X / flow events) renders — a single unsupported counter shape takes down the entire trace.

## Affected code

`tools/swimlane_converter.py` (queue-depth counter emission), e.g.:

```python
local_track_name = f"local_ready_buf_T{thread_idx}"
events.append({
    "args": {"AIC": local_at_end[0], "AIV": local_at_end[1], "MIX": local_at_end[2]},
    "cat": "queue", "name": local_track_name, "ph": "C", "pid": 3, "tid": tid, "ts": end_us,
})
...
events.append({
    "args": {"AIC": shared_at_end[0], "AIV": shared_at_end[1], "MIX": shared_at_end[2]},
    "cat": "queue", "name": "shared_ready_queue", "ph": "C", "pid": 3, "tid": 3999, "ts": end_us,
})
```

Both `local_ready_buf_T{0,1,2}` and `shared_ready_queue` are emitted this way.

## Reproduce

1. Run any kernel with `--enable-l2-swimlane`, e.g.
   `python models/deepseek/v4/decode_sparse_attn.py -p a2a3 -d <id> --enable-l2-swimlane`
2. Drag the produced `merged_swimlane_*.json` into <https://ui.perfetto.dev/>.
3. Import fails with `Args error in counter event name:local_ready_buf_T0`.

The trace is otherwise well-formed: args keys are consistent across all instances and all values are numeric — it is purely the *multi-value-in-one-counter-event* shape that Perfetto refuses.

## Root cause

Perfetto's JSON counter importer expects each `ph:"C"` event to carry a **single** numeric series value. When an event's `args` holds multiple numeric keys, Perfetto raises `Args error in counter event`. (The multi-key form was only ever a Chrome-trace convenience.)

## Suggested fix

Split each multi-value counter into one single-value counter series per dimension, keeping them on the same `tid` so Perfetto still groups them under the thread. For example emit three events with names `local_ready_buf_T{idx}/AIC`, `.../AIV`, `.../MIX` (or `..._aic` etc.), each `{"args": {"value": <n>}}`. This renders as 3 stacked step-counters and loads cleanly. Same treatment for `shared_ready_queue`.

## Workaround (today)

Post-process the merged JSON: either drop all `ph:"C"` events, or rewrite each multi-value counter into single-value series. The lanes/flows are unaffected — only the queue-depth counters are involved.

## Environment

- simpler / simpler_setup `0.1.0` (converter shipped in `simpler_setup/tools/swimlane_converter.py`)
- Platform: a2a3 (Ascend 910), real device
- Perfetto: ui.perfetto.dev (current trace_processor JSON importer)

Related: #995 (DFX capability tracking).


---

## #1065 Speculative early-dispatch (pre-stage + DMB doorbell) — feat/early-dispatch

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1065
- Created: 2026-06-16T08:32:47Z
- Updated: 2026-06-25T09:01:09Z
- Closed: 2026-06-25T09:01:09Z

### Body

## 1. Feature: Speculative early-dispatch (pre-stage + DMB doorbell)

Cut the producer→consumer hand-off latency on the AICPU scheduler from the
normal dispatch cost (~5–8 µs: pop ready queue, build payload, flush MAIN)
down to ~1–2 µs (DMB doorbell floor) by **pre-staging** a consumer's blocks
onto cores *while its producers are still running*, then releasing them with
a single high-32 DMB doorbell the instant the last producer completes.

**Mechanism (event-driven, `dispatch_fanin`):**
- A producer is opted-in by calling `set_allow_early_resolve()` on its `Arg`
  before submit.
- When a flagged producer **dispatches**, `propagate_dispatch_fanin` walks its
  fanout and bumps each consumer's `dispatch_fanin` counter.
- A consumer becomes an early-dispatch **candidate** when
  `dispatch_fanin == fanin_actual_count`, i.e. **every** producer is either
  flagged-and-dispatched, or was already complete when the consumer was wired
  (buffer-creator/alloc edges are auto-satisfied via an `early_finished` seed).
- Candidates are pushed to an inline MPMC `spec_queue`; idle scheduler threads
  drain it, claim a block range, and pre-stage blocks onto free cores (gated:
  the AICore spins on `read_dmb_high32() == task_id`).
- On the last producer's completion, `try_speculative_release` rings the gated
  cores' doorbells inline — the consumer starts immediately, skipping the
  ready-queue round-trip.
- **Auto-chain:** a released candidate inherits the flag (depth-capped) and
  propagates to *its* consumers, so flagging the head of a chain can cascade.

**Candidate rule (the important constraint):** a consumer pre-stages only when
its *entire* producer set is flagged-or-pre-completed (the "all-satisfied"
rule). One unflagged compute producer blocks it.

**Measured (qwen3-14b decode layer, a2a3):** every flagged critical-path
hand-off (rope→fa→online→out_proj→residual) tightened to ~1–2 µs (from
~5–8 µs). Note: **total layer time is unchanged** (~1040 vs ~1060 µs, within
noise) — that layer is compute-bound (fa_fused ~322 µs + MoE matmuls dominate),
so the µs-scale scheduling savings are invisible end-to-end. The feature pays
off on critical paths built from **many short tasks** where scheduling latency
is a meaningful fraction, not on compute-bound layers.

## 2. Code branch

- Branch: **`feat/early-dispatch`** on `hw-native-sys/simpler`
- Tip: `0f7831ed` — defer `dispatch_fanin` propagation off the doorbell/publish
  hot paths (so a flagged producer's fanout walk never delays its own SPMD
  blocks' publish, nor a sibling consumer's doorbell)
- `f7fa9087` — event-driven candidate detection (`dispatch_fanin` + the
  `early_finished` wiring seed; replaces the old O(running×fanout) PULL scan)
- `44003587` — parallel cross-thread staging via the re-push `spec_queue`

Scope: a2a3 `tensormap_and_ringbuffer` runtime/scheduler
(`pto_scheduler.h`, `scheduler_dispatch.cpp`, `pto_runtime2_types.h`). Spec
ST coverage: `tests/st/a2a3/tensormap_and_ringbuffer/spec_{mix,spmd_producer,spmd_consumer}`.

## 3. How to enable it (JIT + flag)

In the orchestration C++ (the `build_output/_jit_*/orchestration/*.cpp` a JIT
build emits), call `set_allow_early_resolve()` on the producer task's `Arg`
before its `rt_submit_*`:

```cpp
Arg params_t9;
params_t9.add_output(...);
params_t9.set_allow_early_resolve();   // opt this producer into early-dispatch
rt_submit_aiv_task(9, params_t9);
```

To make a specific consumer `C` pre-stage, **flag every one of C's compute
producers** (creator/alloc edges are auto-satisfied). Use dep-gen to find C's
producer set:

```bash
python debug/run.py --dep-gen --no-rebuild-from-pto --device-id $DEV
# inspect dfx_outputs/deps.json: edges with succ==C, source==tensormap/explicit
```

Then re-run the JIT build_output to pick up the flags (cpp is recompiled to
`.so`; no ptoas needed):

```bash
python debug/run.py --no-rebuild-from-pto --device-id $DEV
# add --swimlane to capture an L2 swimlane and verify the tight hand-off
```

Notes:
- **sync_start** SPMD tasks cannot be block-by-block pre-staged (skipped).
- A flagged producer's *consumers* pre-stage; the flagged task itself
  pre-stages only if *its own* producers are all flagged too.
- Explicit ordering deps can be added with `ArgWithDeps<>::add_dep(tid)`
  (`pto_arg_with_deps.h`) — they show as `source=explicit` in deps.json.

This is currently driven by hand-placed flags in the JIT orchestration cpp;
codegen-side emission of `set_allow_early_resolve()` is future work.

---

## Worked example: qwen3-14b decode layer (a2a3)

A concrete, tuned flag set for the qwen3-14b decode layer, driven by hand in
the JIT orchestration cpp. This is **workload-specific tuning**, recorded as a
reference for how to apply the feature, not a claim of end-to-end speedup (see
the caveat at the end).

**Flagged (22 tasks) — the attention front-end + output tail (the critical
path):**

```
x_gamma, rms_recip, q_seed, q_proj, k_seed, k_proj, v_proj, fa_work,
qk_gamma, qk_recip, rope_qkv, fa_fused, online, out_seed, out_proj,
residual_rms_cast (+ _0/_1/_2/_3), down_cast_residual, out_consolidate
```

**Deliberately NOT flagged — the MoE FFN compute:**

```
down_seed, gate_seed, up_seed, post_rms_reduce,
gate_proj, up_proj, silu, down_proj
```

Rationale: flagging a producer only helps its *consumers* pre-stage. The big
MoE matmuls (gate/up/down_proj, 85 blocks each) are compute-bound — pre-staging
them buys nothing and they can't reach the all-satisfied rule anyway (their
seeds are unflagged), so we leave the whole MoE compute chain on the normal
dispatch path.

**Which tasks actually pre-stage under this set** (computed statically from
`deps.json` — every non-creator producer must be flagged):

- ✅ pre-stageable: the entire attention front-end + output tail (rope → fa →
  online → out_proj → residual → out_consolidate all hand off in ~1–2 µs), plus
  the seeds (they're near-roots with only creator deps).
- ❌ not pre-stageable: `gate_proj, up_proj, silu, down_proj, down_cast` — the
  MoE compute chain, blocked by the unflagged MoE seeds cascading downstream.

Note the producer/consumer asymmetry: `down_cast` is flagged but cannot itself
pre-stage (its producer `down_proj` is unflagged); flagging it only lets its
consumer `out_consolidate` pre-stage.

**Explicit-dep example (`ArgWithDeps::add_dep`):** to order `v_seed` after
`x_gamma` (instead of letting it race the other seeds):

```cpp
TaskOutputTensors task_0_outs = rt_submit_aiv_task(0, params_t0);  // x_gamma
PTO2TaskId x_gamma_tid = task_0_outs.task_id();
...
ArgWithDeps<> params_t6;                 // v_seed
params_t6.add_inout(v_proj_inline179);
params_t6.add_dep(x_gamma_tid);          // explicit ordering dep
rt_submit_aiv_task(6, params_t6);        // ArgWithDeps overload auto-finalizes
```

This shows up as a `source=explicit` edge in `deps.json`.

**Caveat — no end-to-end speedup on this layer.** Across all flag counts tried
(4 → 31), the total layer time stayed ~1030–1060 µs, within the ±80 µs
run-to-run jitter. qwen decode is **compute-bound** (fa_fused ~322 µs + MoE
matmuls dominate), so the µs-scale scheduling savings on each hand-off are
invisible end-to-end. The 22-flag set above is the *most economical* config
(fewest flags for the same tight hand-offs), not a faster one. Early-dispatch
will move the needle end-to-end only on critical paths built from many short
tasks where scheduling latency is a meaningful fraction of wall time.


---

## #1067 [Bug] sdma_async_completion_demo (onboard a2a3) fails: aclnnShmemSdmaStarsQueryGetWorkspaceSize failed

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1067
- Created: 2026-06-16T10:53:03Z
- Updated: 2026-06-23T08:51:11Z
- Closed: 2026-06-23T08:51:11Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

The onboard a2a3 example `examples/a2a3/tensormap_and_ringbuffer/sdma_async_completion_demo` fails in CI. The SDMA `TGET_ASYNC` deferred-completion path does not deliver the peer rank's data into `out`, so the golden check fails.

The device-side log shows the STARS completion query into CANN failing:

```
[SDMA] Created 40 STARS streams OK
[SDMA] aclnnShmemSdmaStarsQueryGetWorkspaceSize failed
```

When `aclnnShmemSdmaStarsQueryGetWorkspaceSize` (CANN-layer query for the SDMA STARS completion workspace) fails, the producer's `TGET_ASYNC` of the peer window never completes correctly, `out` keeps its initial zeros, and the deferred-release dependency that gates the consumer (`result = out + 1`) is therefore exercised against wrong data.

### Steps to Reproduce

1. On an onboard a2a3 host with ≥2 NPU devices, run the scene-test CI command (wrap in `task-submit` per repo convention):

   ```
   python -m pytest examples/a2a3/tensormap_and_ringbuffer/sdma_async_completion_demo/test_sdma_async_completion_demo.py \
       --platform a2a3 --device <two-device-range> -v
   ```

2. Observe the assertion failure and the device-side `[SDMA] aclnnShmemSdmaStarsQueryGetWorkspaceSize failed` log.

Observed in CI: https://github.com/hw-native-sys/simpler/actions/runs/27607156897/job/81637881341

### Expected Behavior

Each rank's `out` equals the peer rank's input window (`max_out <= 1e-3`) and `result == out + 1` (`max_result <= 1e-3`); the test passes (`run(...) == 0`).

### Actual Behavior

```
[sdma_async_completion_demo] rank 0: max_out=1.250e+02 max_result=1.250e+02
[sdma_async_completion_demo] rank 1: max_out=2.500e+01 max_result=2.500e+01
[SDMA] Created 40 STARS streams OK
[SDMA] aclnnShmemSdmaStarsQueryGetWorkspaceSize failed
...
>       assert run(st_platform, [int(d) for d in st_device_ids]) == 0
E       AssertionError: assert 1 == 0
examples/a2a3/tensormap_and_ringbuffer/sdma_async_completion_demo/test_sdma_async_completion_demo.py:196: AssertionError
```

`max_out` matches the magnitude of the (un-copied) peer input, i.e. `out` was never written by the SDMA completion path.

### Git Commit ID

19b2c0be5aa6aa1827f0e26648ea34a9513df9ba

### Host Platform

Linux (aarch64)

### Additional Context

The test has been temporarily disabled from CI via `@pytest.mark.skip` on `test_sdma_async_completion_demo` (it only matches the onboard a2a3 run) while this is investigated. The skip should be removed once the SDMA STARS completion path is fixed.

---

## #1070 [Bug] spmd_paged_attention_highperf b1_h32_kv8_s128_bs128_fp16 regressed: sim scheduler stall (-100) + onboard golden mismatch

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1070
- Created: 2026-06-16T11:11:12Z
- Updated: 2026-06-22T06:32:01Z
- Closed: 2026-06-22T06:32:01Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware) **and** a2a3sim (Ascend 910B/C simulation) — fails on both.

### Runtime Variant

tensormap_and_ringbuffer

### Description

`tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/test_spmd_paged_attention_highperf.py::TestSpmdPagedAttentionHighPerf::test_run` fails on the only non-manual case, `b1_h32_kv8_s128_bs128_fp16` (batch=1, num_heads=32, kv_heads=8, head_dim=128, kv_seq=128, block_size=128, fp16).

This is a **regression on `main`**: the `st-sim-a2a3` and `st-onboard-a2a3` jobs both passed at commit `17fa04aa` (2026-06-11, run 27324277512) and fail at the current HEAD `19b2c0be`. The failure reproduces deterministically on simulation, so it is not hardware flakiness.

The failure presents differently on the two backends:

- **a2a3sim**: scheduler stall — the workload never completes and the runtime times out.
- **a2a3 (onboard)**: numerical golden mismatch on `out`, and the resulting hang/fault poisons the device (cascading 507018 into the next test in the same worker).

### Steps to Reproduce

```
# simulation (deterministic)
pytest tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/test_spmd_paged_attention_highperf.py \
    --platform a2a3sim --device 0-15 -v

# onboard
python -m pytest tests/st/a2a3/tensormap_and_ringbuffer/spmd_paged_attention_highperf/test_spmd_paged_attention_highperf.py \
    --platform a2a3 --device <range> -v
```

Observed in CI run 27612538258:
- sim (ubuntu): https://github.com/hw-native-sys/simpler/actions/runs/27612538258/job/81640333256
- onboard: https://github.com/hw-native-sys/simpler/actions/runs/27612538258/job/81640333245

### Expected Behavior

`test_run` passes for `b1_h32_kv8_s128_bs128_fp16` on both a2a3sim and a2a3, as it did at `17fa04aa`.

### Actual Behavior

a2a3sim:

```
E       RuntimeError: run_prepared failed with code -100
[ERROR] handle_timeout_exit: [scheduler_cold_path.cpp:378] [STALL thread=1 idle_iterations=324] TIMEOUT_EXIT after_idle_iterations=324
[ERROR] aicpu_execute: PTO2 runtime failed with rc=-100
[ERROR] validate_runtime_impl: PTO2 runtime failed: orch_error_code=0 sched_error_code=100 runtime_status=-100
```

a2a3 (onboard):

```
E       AssertionError: Golden mismatch on 'out': max_diff=0.39404296875, rtol=0.005, atol=0.02
... (an earlier run showed max_diff=3.859375)
[ERROR] sync_run_streams: aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
[ERROR] recover_device_or_mark_unusable: Device unrecoverable after AICore error 507018 ... force-reset the card
```

### Git Commit ID

19b2c0be5aa6aa1827f0e26648ea34a9513df9ba

### Host Platform

Linux (aarch64)

### Additional Context

- Regression window: passing at `17fa04aa` (2026-06-11) → failing at `19b2c0be`. Commits landed in between include #1042 (per-task ring sizing), #1048, #1039, #1051 (direction-aware host<->device tensor staging), #1056 (CORE_MAX_TENSOR_ARGS 32 / scalars 16). Not yet bisected — listed only to bound the search.
- **Temporarily disabled from CI** by marking the `b1_h32_kv8_s128_bs128_fp16` case `"manual": True` (CI runs `--manual exclude`, so it is skipped on both sim and onboard while still runnable via `--manual only`). The fix PR must remove that `"manual": True` and confirm the case passes on a2a3sim and a2a3.
- Related: #1022 ([Bug] SPMD Paged Attention Highperf Fails For >= 8192 sequences) — different scenario (long sequences); this report is a small-case regression.

---

## #1073 [Bug] sync_start drain ack-barrier has no completed_ escape — spmd_sync_start_stress hangs (507018) under --rounds

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1073
- Created: 2026-06-17T01:46:09Z
- Updated: 2026-06-17T03:02:09Z
- Closed: 2026-06-17T03:02:09Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

The `tensormap_and_ringbuffer` sync_start **drain protocol** (`SchedulerContext::handle_drain_mode` in `runtime/scheduler/scheduler_completion.cpp`) has a liveness bug: its three spin-waits — the sentinel wait, the **ack barrier**, and the non-elected wait — require all `active_sched_threads_` scheduler threads to keep participating, but none of them checks `completed_`.

A scheduler thread leaves the dispatch loop the instant `completed_` latches (`scheduler_dispatch.cpp:714` / `handle_orchestrator_exit`). If a late-joining thread enters the drain ack-barrier in the narrow window where its peers are exiting on `completed_`, it waits forever for acks that can never arrive.

The in-runtime 2 s scheduler watchdog cannot catch it: that watchdog lives in the dispatch loop's idle path, not inside the barrier spin. So the hang escalates to the 3 s STARS op-exec timeout (`PLATFORM_OP_EXECUTE_TIMEOUT_US`), the AICPU watchdog kills the `aicpu-sd` process (`HandleTaskTimeout`), and it surfaces on the host as **507018**, then device-unrecoverable **507014** and a forced card reset.

Same defect exists in the **a5** copy (`src/a5/.../scheduler_completion.cpp`), which is identical apart from the `Runtime*` parameter.

### Steps to Reproduce

```bash
# Single round usually PASSES:
task-submit --device auto --run \
  "python tests/st/a2a3/tensormap_and_ringbuffer/spmd_sync_start_stress/test_spmd_sync_start_stress.py \
     -p a2a3 -d \$TASK_DEVICE --log-level v0"

# Multiple rounds FAIL probabilistically (more rounds = more independent attempts):
task-submit --device auto --run \
  "python tests/st/a2a3/tensormap_and_ringbuffer/spmd_sync_start_stress/test_spmd_sync_start_stress.py \
     -p a2a3 -d \$TASK_DEVICE --log-level v0 --rounds 10"
```

`spmd_sync_start_stress` is the only test that hits it: it is the sole case that simultaneously maximizes all four required factors — many drain cycles (24 sync tasks), normal tasks concurrently occupying cores (forces the drain *retry* state to linger), cross-shape MIX+AIV contention on the single drain slot, and a long multi-round tail that produces scheduler-thread skew. `--rounds N` multiplies the per-run hit probability. Each round is independent (`deinit()` resets `drain_state_` between rounds); the failure is a probabilistic timing race, not cumulative state corruption.

### Expected Behavior

All rounds complete and the test passes regardless of `--rounds`. A scheduler thread parked in the sync_start drain must abandon the drain once the run has latched `completed_`, exactly as `handle_core_transition` already does in its spin.

### Actual Behavior

One scheduler thread hangs in the drain ack-barrier ~3 s, then:

```
[ERROR] sync_run_streams: aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
[ERROR] recover_device_or_mark_unusable: Device unrecoverable after AICore error 507018:
        aclrtSynchronizeDeviceWithTimeout failed: 507014. Marking DeviceRunner unusable;
        ... finalize() will force-reset the card
```

Device-side log (the real cause):

```
[ERROR] HandleTaskTimeout ... thread index[5], op name[simpler_aicpu_exec],
        stream_id=46, task_id=2, timeOut:150000000, tickFreq:50000000   (= 3.0 s)
```

The stuck thread's last progress log is `scheduler_dispatch.cpp:614` "PTO2 dispatch starting"; the peer threads logged "PTO2 completed tasks 54/54" and shut down cleanly just before.

### Git Commit ID

19b2c0be5aa6aa1827f0e26648ea34a9513df9ba

### Host Platform

Linux (aarch64)

### Additional Context

**Root cause location**: `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_completion.cpp::handle_drain_mode` (and the a5 twin). The three spin-waits lack the `if (is_completed()) return;` escape that `handle_core_transition` (`scheduler_cold_path.cpp:94-98`) already uses.

**Prior art**: PR #989 saw this same 507018 on this same test and shipped a sync_start-exclusion timing change, but explicitly noted *"the exact race window was not pinpointed"* (see `docs/investigations/2026-06-cross-task-batched-publish.md`). That only shifted timing to pass 10/10; the latent deadlock remained and `--rounds` re-exposes it.

**Related** (different root cause, shared surface error): #1036 also surfaces 507018 but from VEC alignment, not the drain protocol.

---

## #1075 [Code Health] Rename dump-tensor public surface to dump-args across CLI, artifacts, tests, CI, and docs

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1075
- Created: 2026-06-17T02:40:52Z
- Updated: 2026-06-18T07:40:18Z
- Closed: 2026-06-18T07:40:18Z

### Body

### Category

Naming / Consistency

### Component

Other (please specify in description)

### Description

The per-task args dump feature still exposes the legacy `dump tensor` public naming on several user-facing surfaces.

This is not a mixed-naming problem; it is a rename problem. The feature semantics are per-task argument dump, so the public surface should be renamed comprehensively to `dump args` to match the actual behavior and terminology.

### Location

- `conftest.py`
- `simpler_setup/scene_test.py`
- `simpler_setup/tools/README.md`
- `docs/dfx/tensor-dump.md`
- `docs/testing.md`
- `.github/workflows/ci.yml`
- `tests/st/a2a3/tensormap_and_ringbuffer/dfx/tensor_dump/test_tensor_dump.py`

### Proposed Fix

Rename the public surface from `dump tensor` to `dump args` across CLI flags, output directory and manifest names, tooling, tests, CI, and docs so the external naming matches the feature behavior.

### Priority

Low (no impact today, good to fix eventually)

---

## #1077 [Code Health] CI: onboard a2a3 host_runtime built against unpinned pto-isa diverges from test-time --pto-isa-commit

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1077
- Created: 2026-06-17T08:00:25Z
- Updated: 2026-06-17T09:28:24Z
- Closed: 2026-06-17T09:28:24Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Build System

### Description

CI 在同一次 onboard a2a3 run 里会用**两个不同的 pto-isa 版本**：

- **Build 期**（`pip install` → CMake `build_runtimes` target → `build_runtimes.py`）：对 a2a3 调用 `ensure_pto_isa_root(clone_protocol=...)` **不传 commit**，所以 clone 的是 pto-isa **HEAD**（或 self-hosted runner 上一轮残留的 clone）。`host_runtime.so` 在这一步把 `comm_hccl.cpp` 里 `#include "pto/npu/comm/async/sdma/sdma_workspace_manager.hpp"` 编进去，scene test 直接加载 `build/lib/` 的预编译产物、不会重编。
- **Run 期**（scene test）：用 `--pto-isa-commit ${{ env.PTO_ISA_COMMIT }}` pin 到固定 commit，conftest 把 `build/pto-isa` checkout 到该 commit，**只影响 kernel 编译**。

结果：`host_runtime.so`（内嵌 pto-isa SDMA 头）与测试期 kernel 用了两个不同的 pto-isa 修订版。调用失败符号的 `SdmaWorkspaceManager` 整体住在 `host_runtime.so` 里，真正跑的是 build 期那版 pto-isa，而非 pin 的版本。

**迫近风险**：pto-isa HEAD 已经把 `sdma_workspace_manager.hpp` 从 `pto/npu/comm/async/sdma/` 移到 `pto/comm/async/sdma/`（pto-isa commit `8e0400f2`）。一旦 build 期 fresh clone 到不含旧路径的 HEAD，a2a3 host 会因 `#include "pto/npu/comm/..."` 找不到头文件而**直接编译失败**。

这是在排查 #1067（`aclnnShmemSdmaStarsQueryGetWorkspaceSize failed`）时发现的**独立** build-hygiene 问题。已确认它**不是** #1067 的根因（#1067 是设备侧 CANN op 运行期失败；build 期 pin 版到 HEAD 之间对该 header 的改动是行为等价的 refactor），但属于应当单独修复的 CI 一致性缺陷。

附带：`src/a2a3/platform/onboard/host/comm_hccl.cpp` 的 `ensure_sdma_workspace` 注释声称 workspace init 失败时 demo 会 "self-skip"，但对应 demo test 并无 self-skip 逻辑——独立小问题，可在 #1067 一并处理，此处仅记录。

Git Commit ID: c4b0aac2c8b17d2748793337d47df2f2a1552127

Related: #1067

### Location

- `simpler_setup/build_runtimes.py` — a2a3 块 `ensure_pto_isa_root(...)` 调用未传 `commit`
- `CMakeLists.txt` — `build_runtimes` custom target 未向脚本透传 pinned commit
- `.github/workflows/ci.yml` — onboard job 的 `pip install` 未 pin，仅 scene test 步骤用 `--pto-isa-commit ${{ env.PTO_ISA_COMMIT }}`
- `src/a2a3/platform/onboard/host/comm_hccl.cpp` — `#include "pto/npu/comm/async/sdma/sdma_workspace_manager.hpp"`（依赖已被 pto-isa HEAD 移走的路径）

### Proposed Fix

让 build 期与 run 期共用唯一的 pinned commit（ci.yml 的 `env.PTO_ISA_COMMIT` 作为单一源头，改一处两端同步）：

1. `build_runtimes.py` 新增 `--pto-isa-commit`，透传给 `ensure_pto_isa_root(commit=...)`。
2. `CMakeLists.txt` 新增 `SIMPLER_PTO_ISA_COMMIT` cache 变量（仿 `SIMPLER_PTO_CLONE_PROTOCOL`），非空时把 `--pto-isa-commit <sha>` 传给 build_runtimes target。
3. `ci.yml` onboard job 的 `pip install` 加 `--config-settings=cmake.define.SIMPLER_PTO_ISA_COMMIT="${PTO_ISA_COMMIT}"`；`requires_hardware` 的 pytest 也加 `--pto-isa-commit`，避免 conftest 在无 pin 时把 `build/pto-isa` reset 回 HEAD。

### Priority

High (significant risk, fix soon)

---

## #1082 [Code Health] AICPU orch .so is double-uploaded (orch_so_dedup_ duplicates the ChipCallable buffer) and chip_callable_buffers_ leaks until finalize

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1082
- Created: 2026-06-18T01:34:12Z
- Updated: 2026-07-15T14:54:25Z
- Closed: 2026-07-15T14:54:25Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Host Runtime

### Description

Two related device-memory hygiene problems in the onboard host runner, surfaced while investigating #1019 (which turned out to be unrelated — an op-timeout window, fixed by #1035).

**1. The AICPU orchestration `.so` is uploaded to the device twice.**
- `upload_chip_callable_buffer()` uploads the **whole** `ChipCallable` (header + `storage_`) into `chip_callable_buffers_`. `storage_` *starts with* the orchestration `.so` — `ChipCallable::binary_data()` **is** the orch `.so` (the host itself reads it that way: `runtime_maker.cpp` does `orch_so_binary = callable->binary_data()`).
- `register_callable()` then uploads **just the orch `.so` bytes again** into a separate pool `orch_so_dedup_`, and points the AICPU at it via `runtime.set_dev_orch_so(addr, size)`.

So the same orch bytes occupy device GM twice. The orch already lives at a known offset inside the chip buffer: `chip_dev + offsetof(ChipCallable, storage_)`, length `binary_size()`. `orch_so_dedup_` exists only because the AICPU reads `dev_orch_so` (the standalone copy) and `dlopen`s it, instead of pointing into the chip buffer.

**2. `chip_callable_buffers_` is never freed on unregister — only at `finalize()`.**
- `unregister_callable()` decrements + frees `orch_so_dedup_` (it has a refcount), but does **not** touch `chip_callable_buffers_`.
- `ChipCallableBuffer` has no `refcount` field (unlike `OrchSoBuffer`), and the comment says "never freed until finalize".
- Result: in a long-lived worker (e.g. the L2 `st_worker` pool reuses one `ChipWorker` per (runtime, device) for a whole xdist session), every distinct chip-callable buffer accumulates on-device until the runner finalizes, even after its callable is unregistered. The header comment at the `chip_callable_buffers_` declaration already *claims* "refcounted by hash", but that was specified and never implemented.

Neither is a crash today (the #1019 repro showed max-live=1 for a single callable), but both are real growth/duplication that scale with callable churn.

### Location

- `src/common/platform/onboard/host/device_runner_base.cpp`
  - `upload_chip_callable_buffer()` ~`385`–`431` (uploads whole ChipCallable incl. orch)
  - `register_callable()` ~`476`–`535` (separate orch `.so` upload → `orch_so_dedup_`)
  - `prepare_orch_so()` ~`437`–`470` (`set_dev_orch_so`)
  - `unregister_callable()` `571`–`594` (frees `orch_so_dedup_`, **not** `chip_callable_buffers_`)
  - finalize-only free of `chip_callable_buffers_` ~`680`–`689`
- `src/common/platform/onboard/host/device_runner_base.h`
  - `struct ChipCallableBuffer` `625`–`628` (no `refcount`), map `629`
  - `struct OrchSoBuffer` `654`–`657` (has `refcount`), map `660`
- `src/common/task_interface/callable.h:117`–`118` — `ChipCallable::binary_data()/binary_size()` = orch `.so`
- `src/{a5,a2a3}/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp` ~`133`–`134` — `orch_so = callable->binary_data()`
- `src/{a5,a2a3}/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp` ~`269`–`318` — AICPU reads `dev_orch_so` → writes temp file → `dlopen`

### Proposed Fix

Unify into a single refcounted device buffer:
1. `prepare_orch_so` (device-orch path): set `dev_orch_so = chip_dev + offsetof(ChipCallable, storage_)`, size `= binary_size()` — point the AICPU at the orch bytes already inside the chip buffer.
2. Delete `register_callable`'s separate orch upload + the `orch_so_dedup_` map/refcount.
3. Add `refcount` to `ChipCallableBuffer` and free-on-unregister in `unregister_callable()` (mirror the existing `orch_so_dedup_` pattern), so the unified buffer (orch + kernels) is released when its last callable unregisters.
4. Start with a failing repro test: register N distinct callables → unregister → assert the chip pool is freed (today it isn't).

**Must verify / preserve (the make-or-break check):**
- **Byte-identity**: `upload_chip_callable_buffer` runs `patch_chip_callable_scratch_for_device` (patches *child* `resolved_addr_`). Confirm that patching does **not** touch the orch region `storage_[0 .. binary_size)`, so the in-buffer orch is byte-identical to what `dlopen` needs.
- **hbg path**: `host_build_graph` doesn't H2D the orch (host `dlopen` via `state.host_dlopen_handle`). This change is for the device-orch (`tensormap_and_ringbuffer`) path only; the hbg branch must stay.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1084 [Feature] Annotate SPMD tasks in deps_viewer HTML (and text) output

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1084
- Created: 2026-06-18T06:59:06Z
- Updated: 2026-06-25T03:16:14Z
- Closed: 2026-06-25T03:16:14Z
- Labels: enhancement

### Body

### Summary

The deps.json viewer (`simpler_setup/tools/deps_viewer.py`) should visually
annotate **SPMD-type tasks** in its generated HTML dependency graph. A task
that runs across multiple logical blocks (SPMD dimension / `block_num > 1`)
is currently indistinguishable from a single-block task — nodes are colored
only by `core_type` (AIC blue / AIV orange / mix diamond / alloc). Add an
SPMD marker (e.g. a badge, border style, or block-count suffix in the node
label) so SPMD tasks stand out in the graph, and a matching legend entry.

If the text output can carry the same annotation, that is also wanted — e.g.
add an `spmd=<block_num>` field to the `TASK INDEX` / per-task detail blocks
in `emit_text`, alongside the existing `kind=` and `func_id=` fields.

### Motivation / Use Case

When inspecting a task graph it matters a lot whether a node is a single
block or fans out across many SPMD blocks (different dispatch cost,
scheduling behavior, and per-block dependency semantics). Today that
information is invisible in both the HTML and text views, so a reader cannot
tell SPMD tasks apart from ordinary ones without cross-referencing other
artifacts. Surfacing it directly in the viewer makes the dependency graph
self-describing for debugging and perf triage.

### Proposed API / Behavior

- **HTML**: mark SPMD task nodes distinctly (badge / thicker border / `×N`
  suffix on the identity header) and add an SPMD entry to the legend.
- **Text**: include `spmd=<block_num>` (or `spmd=no`) in the `TASK INDEX`
  line and per-task `=== TASK ... ===` header in `emit_text`.

Note: the SPMD block count does **not** appear to be captured today.
`DepGenRecord` (`src/{arch}/platform/include/common/dep_gen.h`) carries
`task_id`, `flags`, `kernel_id[3]`, tensor blobs, and explicit deps, but no
`block_num` / SPMD dimension field — so this likely also needs the capture
path (`submit_task` → `DepGenRecord` → `deps.json` tasks[]) to record the
SPMD block count before the viewer can annotate it. Implementation should
decide whether to thread `block_num` through dep_gen, or derive SPMD-ness
from the colocated `l2_swimlane_records.json` perf sidecar (where SPMD tasks
already emit one record per block / `block_num > num_cores`).

### Additional Context

- Viewer: `simpler_setup/tools/deps_viewer.py` (`emit_html` / `emit_dot` for
  HTML, `emit_text` for text).
- deps.json producer: `src/{arch}/runtime/tensormap_and_ringbuffer/host/dep_gen_replay.cpp`,
  `DepGenRecord` in `src/{arch}/platform/include/common/dep_gen.h`.
- Related: #1049 (swimlane_converter rendering SPMD deps at block
  granularity) — different artifact (merged_swimlane), but same underlying
  "make SPMD visible" goal.

---

## #1085 [Code Health] a5 profiling collectors leave device-buffer member pointers dangling after a failed initialize()

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1085
- Created: 2026-06-18T08:08:14Z
- Updated: 2026-06-29T03:32:59Z
- Closed: 2026-06-29T03:32:59Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Host Runtime

### Description

The a5 host-side profiling collectors assign their device-buffer **member pointers** mid-`initialize()`, before the success commit, while the `InitRollbackGuard` is still armed. If `initialize()` fails at any return point after that assignment, the guard frees all framework-tracked device buffers, leaving the member pointing at freed memory.

Surfaced by this review comment (on `l2_swimlane_collector.cpp:254`):
> If initialize fails after rotation_table_dev is allocated and assigned to aicore_ring_addr_table_dev_ (line 254), aicore_ring_addr_table_dev_ will be left pointing to the freed memory (since the rollback guard will free it). This can lead to undefined behavior if get_aicore_ring_addr_table_device_ptr() is called or if finalize is subsequently invoked.

**The dangling itself is confirmed real** (full chain verified on `main`):
- `alloc_paired_buffer` registers `rotation_table_dev` via `BufferPoolManager::register_mapping` (adds it to `dev_to_host_`).
- There are real fail-return points after line 254 and before `guard.commit()` (the `init_phase_pools` alloc failures).
- On those, the un-committed `InitRollbackGuard` destructor calls `release_all_owned`, which iterates `dev_to_host_` and frees every dev_ptr — including `rotation_table_dev`. The member is then dangling.

**It does NOT cause UB in the current call flow** (hence low severity) — both UB triggers the comment names are currently unreachable:
- `finalize()` early-returns on `shm_host_ == nullptr`, and `shm_host_` is set only at the very end of `initialize()` (after all fail-return points), so a failed init never reaches the `release_one_buffer(<member>)` path → no double-free.
- `get_..._device_ptr()` is only called by `device_runner` on init **success**.

So it is a latent footgun: a member left pointing to freed memory after a failed init. A future refactor (relocating the accessor, or changing the `shm_host_`-gated `finalize` early-return) could turn it into UB / double-free.

Not isolated to one collector — the same mid-init-assign pattern is shared across the a5 collectors, so it should be addressed uniformly. a2a3 is unaffected: its collectors do not use `InitRollbackGuard`, so there is no rollback-free → no dangling member.

Found during code review; not a runtime failure.

### Location

Both on `main`:
- `src/a5/platform/shared/host/l2_swimlane_collector.cpp:254` — `aicore_ring_addr_table_dev_` assigned mid-`initialize` (`shm_host_` set ~line 352 via `set_memory_context`, `guard.commit()` ~line 363). Introduced by #1058.
- `src/a5/platform/shared/host/pmu_collector.cpp:104` — `aicore_ring_addrs_dev_` assigned mid-`init`, fail-returns after, `finalize` guarded by the same `shm_host_ == nullptr` early-return.

### Proposed Fix

Either:
1. Defer the device-buffer member assignments to the post-`guard.commit()` region (next to `perf_shared_mem_dev_ = perf_dev_ptr` / `shm_dev_ = ...`), so a failed init leaves them at their default `nullptr`; or
2. Have `InitRollbackGuard` reset the registered member pointers to `nullptr` on rollback.

Apply uniformly across the a5 collectors that share this mid-init assignment pattern (l2_swimlane, pmu, and any sibling).

### Priority

Low (no impact today, good to fix eventually)

---

Related (other profiling/collector resource-lifecycle code-health items, different root cause): #1082, #977

---

## #1087 [Bug] a2a3 onboard test fails: get_aicore_reg_info halMemCtl rc=13 (EACCES) exhausts all retries on devid=11

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1087
- Created: 2026-06-18T09:35:14Z
- Updated: 2026-06-22T11:25:30Z
- Closed: 2026-06-22T11:24:42Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

All / Unknown

### Description

On a CI runner, an a2a3 onboard communication test failed not in the
communication path itself but during AICore register base address retrieval.
`get_aicore_reg_info` in [host_regs.cpp](src/a2a3/platform/onboard/host/host_regs.cpp)
calls the HAL `halMemCtl` to map the register window, and it returned
`rc=13 (EACCES)` on `devid=11`. There is an existing EACCES retry loop
(3 retries × 50 ms backoff), but all retries were exhausted and the call
ultimately failed with `rc=13`, aborting the test.

The existing retry comment ([host_regs.cpp:108-113](src/a2a3/platform/onboard/host/host_regs.cpp#L108-L113))
already documents this exact failure mode — concurrent `chip_process`
bring-up across paired dies losing a narrow driver-side serialization
window, consistently landing on `dev=11` (last die of the last chip in the
8–11 range). This report is that the current 3×50 ms budget is **insufficient**
on CI: the contention window outlasts ~150 ms of backoff, so the test still
fails intermittently.

### Steps to Reproduce

```markdown
1. Run the a2a3 onboard communication test on a CI runner that brings up
   paired dies concurrently in the 8–11 device range.
2. Observe `get_aicore_reg_info` issuing `halMemCtl` on devid=11 while a
   sibling die is mid-bring-up.
3. The call returns rc=13 (EACCES) and all 3 EACCES retries (50 ms each)
   are exhausted before the prior holder releases the serialization window.
```

CI run where this was observed:
https://github.com/hw-native-sys/simpler/actions/runs/27749047067/job/82097345787?pr=1086

### Expected Behavior

Register base retrieval should tolerate the transient driver-side EACCES
contention during concurrent paired-die bring-up — either by a larger /
exponential backoff budget, or another serialization strategy — so the
onboard communication test does not fail on a transient `halMemCtl` EACCES.

### Actual Behavior

```
[2026-06-18 17:28:36.780394][T0xffff8ed3abe0][WARN] get_aicore_reg_info: [host_regs.cpp:125] halMemCtl rc=13 (EACCES) on devid=11 attempt 1/3, retrying after 50 ms
[2026-06-18 17:28:36.830617][T0xffff8ed3abe0][WARN] get_aicore_reg_info: [host_regs.cpp:125] halMemCtl rc=13 (EACCES) on devid=11 attempt 2/3, retrying after 50 ms
[2026-06-18 17:28:36.880779][T0xffff8ed3abe0][WARN] get_aicore_reg_info: [host_regs.cpp:125] halMemCtl rc=13 (EACCES) on devid=11 attempt 3/3, retrying after 50 ms
[2026-06-18 17:28:36.930978][T0xffff8ed3abe0][ERROR] get_aicore_reg_info: [host_regs.cpp:133] halMemCtl failed with rc=13
```

All three retries land within a ~150 ms window (every 50 ms), all return
EACCES, and the function returns `rc=13` — failing register setup and the test.

### Git Commit ID

1e4364926131f1f1e8a80aa3ba3e1264654a3907

### Host Platform

Linux (aarch64)

### Additional Context

- The EACCES retry path is in `get_aicore_reg_info`
  ([host_regs.cpp:114-135](src/a2a3/platform/onboard/host/host_regs.cpp#L114-L135)).
- The failure is environmental/transient (driver serialization window under
  concurrent bring-up), not a logic bug in the communication test itself —
  but the current retry budget is too small to absorb it on CI.
- Possible mitigations to evaluate: larger retry count, exponential backoff,
  or jittered backoff so paired-die attempts don't keep colliding on the same
  50 ms cadence.

---

## #1098 read_blob forms an under-aligned Tensor* (alignas(64)) from the 8-byte-aligned TaskArgs blob

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1098
- Created: 2026-06-22T03:13:47Z
- Updated: 2026-06-22T06:50:08Z
- Closed: 2026-06-22T06:50:08Z
- Labels: code health

### Body

## Context

Follow-up from PR #1093 review (CodeRabbit, `src/common/task_interface/task_args.h:280`).

After unifying `TaskArgs` on the 128 B `alignas(64)` `Tensor`, `read_blob` does:

```cpp
reinterpret_cast<const Tensor *>(src + TASK_ARGS_BLOB_HEADER_SIZE)
```

The args-blob `tensors[]` region starts at an **8-byte** boundary (header is 8 B,
`MAILBOX_OFF_ARGS` is only guaranteed 8-aligned), but `Tensor` is declared
`alignas(64)`. Forming/derefing a pointer to an object with stricter alignment
than its storage is **undefined behavior** per the C++ standard, even when no
access faults.

Before #1093 the blob stored the 40 B `ContinuousTensor` (natural alignment 8),
so `src+8` satisfied its alignment — the UB is newly introduced by the
over-aligned `Tensor`.

## Why it's currently safe (not urgent)

- Every `Tensor` member has alignment <= 8, and the blob is 8-aligned, so each
  field access is naturally aligned.
- All consumers read via trivially-copyable copy / `memcpy`
  (`view_to_chip_storage`, `worker_manager` blob memcpy, `Tensor t = view.tensors[i]`),
  which the compiler lowers to alignment-tolerant loads on aarch64.
- `task_args.h` already documents this in a NOTE.

So there is no observed miscompile; this is a standards-conformance / future-proofing
item (a later edit doing in-place SIMD/atomics on `view.tensors[i]`, or a compiler
exploiting the `alignas(64)` assumption, would break).

## Options

1. **Force the blob `tensors[]` region to 64-byte alignment** — pad the header to
   64 and make `MAILBOX_OFF_TASK_ARGS_BLOB` 64-aligned. No consumer changes;
   changes the local blob layout and makes `read_blob` depend on a 64-aligned `src`.
2. **Byte-address the view** — `TaskArgsView::tensors` becomes `const uint8_t*`
   plus a `Tensor tensor_at(i)` that `memcpy`s into an aligned local. Removes the
   `reinterpret_cast<Tensor*>` entirely; touches the view definition and ~4 consumers.

Either is larger than PR #1093's "behavior-unchanged" scope, hence this follow-up.

---

## #1102 [Bug] SceneTestCase L2 run-path: intermittent single-lane NaN in fused decode (execute_compiled is clean on identical artifacts)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1102
- Created: 2026-06-22T06:38:07Z
- Updated: 2026-06-25T06:11:19Z
- Closed: 2026-06-25T06:11:19Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

Under the **SceneTestCase L2 run path** (`simpler_setup/scene_test.py::_run_and_validate_l2` → `worker.run(handle, chip_args, cfg)`), the fused Qwen3-14B decode example intermittently produces a **NaN in ~1 of the 16 output-row lanes** (one full batch row `out[b, :]` all NaN). It is **non-deterministic**: most runs hit 0–1 lanes, occasionally more. The finite lanes are always numerically correct (`max_abs_diff ≈ 0.016`, well within tolerance), and the INOUT `k_cache`/`v_cache` always match.

**This is not a defect in the example (kernels/golden/CALLABLE) — it is specific to the SceneTestCase L2 run path.** The decisive contrast:

> pypto's `execute_compiled` (`pypto/runtime/device_runner.py::execute_on_device`) runs the **identical** compiled orchestration + incore kernels, the **same** runtime, the **same** `KernelCompiler` + `elf_parser.extract_text_section`, the **same** `make_tensor_arg` arg-building, and the **same** `Worker` class — and is **deterministically clean (10/10)** at the lib's strict `ratio_allclose(3e-3, 2% outliers)`.

So the same compiled artifacts + same `Worker` produce correct, deterministic output under `execute_on_device` but an intermittent single-lane NaN under SceneTestCase's L2 path.

**Isolation — ruled out (reproduces with each of these held/varied):**
- CALLABLE incore signatures (verified to match the codegen `kernel_config.py` exactly)
- `block_dim` = 0 (auto) and 24
- `dep_gen` on and off
- runtime version: reproduces on #1042, #1078, and #1069
- codegen source: smoke (`compile_for_test`) vs device-run (`run_jit`) codegen
- single-layer vs 2-layer (`decode_fwd_layers`), single-block vs multi-block seq
- `IN` vs `INOUT` cache arg directions

The non-determinism + "one entire lane = NaN" symptom is consistent with a **race**: one lane's attention / `online_softmax` accumulator (or other per-lane scratch) is read before it is fully written, or reads uninitialized device scratch → `0/0` or garbage → NaN, with the losing lane varying per run.

**Remaining suspect:** the difference between SceneTestCase's L2 path (session-scoped cached `Worker` + cached registered handle → `worker.run`) and `execute_on_device` (fresh `Worker` + `init()` + `register` + `run` + `close()` per call). Both use the same `Worker`, compile, and args; the difference is a run/dispatch-time detail (suspected scratch-init or dispatch/scheduler timing). Pinning the exact mechanism needs runtime instrumentation (e.g. catching which task/lane reads an uninitialized accumulator, or diffing the dispatch ordering between the two paths).

### Steps to Reproduce

```markdown
1. Build the runtime: `pip install --no-build-isolation -e .` in a venv.
2. Use the fused decode example `examples/a2a3/tensormap_and_ringbuffer/qwen3_14b_decode`
   from PR #1088 (a faithful harvested 2-layer Qwen3-14B decode; the case is
   currently `xfail(strict=False)` for exactly this issue).
3. Run it several times on a2a3 hardware:
   `task-submit --device auto --device-num 1 --run \
     "python -m pytest examples/a2a3/tensormap_and_ringbuffer/qwen3_14b_decode \
      --platform a2a3 --device $TASK_DEVICE -s -rxX"`
4. Across runs, observe intermittent XFAIL (one output lane NaN) vs XPASS (clean) —
   e.g. measured 4/5 XPASS, 1/5 XFAIL at seq_len=3500. Add a `_compare_outputs`
   diagnostic to print `dev_nan_rows` / finite max_diff to see the NaN lane.
5. Contrast: run the same artifacts via pypto `execute_compiled`
   (e.g. lib `decode_layer.py` on device) — deterministically clean.
```

### Expected Behavior

The SceneTestCase L2 run produces the same deterministic, correct output as `execute_compiled` on the identical compiled artifacts (no NaN lanes; all 16 lanes match the golden every run).

### Actual Behavior

```
[DIAG] out dev_nan_rows=[0] finite_max_diff=0.01562   # ~1/5 runs: one lane NaN  -> XFAIL
[DIAG] out dev_nan_rows=[]  finite_max_diff=0.01562   # ~4/5 runs: clean         -> XPASS
```

One batch row of `out` is entirely NaN on a fraction of runs; the lane index varies run-to-run; finite lanes are always correct.

### Git Commit ID

b7d04b45e560bf038c4c7b5aa3f4c8a90e004542 (main, #1069; also reproduces on #1042 and #1078). Repro example on PR #1088 branch.

### CANN Version

(as on the shared CI/dev a2a3 runners; `version.cfg` empty on this box)

### Host Platform

Linux (aarch64)

### Additional Context

The example is marked `xfail(strict=False)` so CI stays green whether a run XPASSes or XFAILs; it serves as a faithful minimal repro. Root-causing likely requires instrumenting the L2 dispatch / scratch-init path in `src/a2a3/runtime/tensormap_and_ringbuffer/`. Related loader limitation (separate, already worked around in the example): #900.

---

## #1103 [Performance] Remaining dispatch-path optimizations from poursoul/a2a3-sched-opt

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1103
- Created: 2026-06-22T07:12:04Z
- Updated: 2026-07-14T07:48:06Z
- Closed: 2026-07-14T07:48:06Z
- Labels: performance

### Body

## Context

PR #989 landed the **batched publish** optimization (one `wmb()` per claim) from `poursoul/simpler:a2a3-sched-opt`. That commit originally bundled **six** dispatch-path optimizations; only one shipped in #989 (plus the cross-task gating + cross-thread stagger fix added during merge). The other **five remain unmerged** on `poursoul/a2a3-sched-opt`:

| # | Item | Status |
|---|---|---|
| 1 | Batched publish (one wmb per claim) | ✅ shipped in #989 (commit `98849e81`) |
| 2 | SPMD arg sharing (AICore burst-copy from template) | ❌ not shipped |
| 3 | `PTO2DispatchPayload` re-layout (control block first, args[] at tail) | ❌ not shipped |
| 4 | One-time context-pointer init (handshake-time) | ❌ not shipped |
| 5 | AICPU prefetch (`__builtin_prefetch` payload + slab) | ❌ not shipped |
| 6 | `fast_sys_cnt` (inline `mrs cntvct_el0`) | ❌ not shipped |

Original branch: `poursoul/simpler:a2a3-sched-opt`, commit `40944786`.

This issue tracks the remaining five so they don't get lost. Each item below has its gain source, scope, and the rebase constraint from upstream changes since the original branch base (`fecf7c97`).

---

## #2 SPMD arg sharing

**What**: AICPU writes the task's tensor pointers + scalars once into a per-task `dispatch_args_template` (in GM) at submit time. Each `build_payload` then only writes `task_args` (GM pointer) + `arg_count` into the per-core dispatch payload. AICore burst-copies `args[0..arg_count)` from the shared template into its per-core `args[]` before invoking the kernel.

**Gain source**:
- AICPU `build_payload` inner loops (`for tensor_count` + `for scalar_count`) eliminated.
- For SPMD with `block_num=B` and `N+M=K` total args: AICPU stores drop from `B × K × 8B` to `K × 8B` (one-time) + `B × 2 words` (per-dispatch).
- Eliminates per-block RFO misses on the args[] cache lines (each block previously dirtied them).

**Cost**: AICore pays one extra GM burst-load per dispatch to fetch the shared template into local args[].

**Estimated gain**: Hundreds of ns to ~µs per SPMD task with many args. Zero gain on `block_num=1` tasks.

**Most relevant workload**: decode_layer-style — many tensor pointers per kernel (KV-cache slots, projections) over many SPMD blocks.

**Upstream rebase risk**: HIGH.
- `#1056` raised `CORE_MAX_TENSOR_ARGS` 16 → 32 and lowered scalars 32 → 16. Args buffer layout sized differently.
- `#1093` unified TaskArgs on strided Tensor, dropped `ContinuousTensor`. The `PTO2TaskPayload` type poursoul added `dispatch_args_template` to has been refactored.
- Requires reconciling with the new payload type system and verifying the template lifetime fits the new task submit flow.

**Couples with**: #3, #4 (shared layout dependency)

---

## #3 `PTO2DispatchPayload` re-layout

**What**: Move the per-dispatch-written control fields (`function_bin_addr`, `task_args`, `arg_count`, `local_context`, `global_context`) to the **leading** cache lines of the struct. Move `args[]` (256B array) to the **tail** with `alignas(64)`. Struct total size stays 576B (hardware ABI constraint).

**Gain source**:
- AICPU per-dispatch writes hit only the first 1-2 cache lines (control block); previously spread across 2-3 lines.
- AICore's first dcci-then-read on the dispatch path lands on `function_bin_addr` (offset 0) immediately, can issue kernel jump earlier.
- Fewer dirty cache lines per dispatch → less NoC writeback bandwidth for AICore coherence.

**Cost**: Just layout — no extra ops.

**Estimated gain**: 1-2 fewer cache line dirties per dispatch (~ns direct savings); shaves ~10-100 ns off AICore's wake-to-start critical path depending on NoC latency.

**Upstream rebase risk**: HIGH.
- `#1056` resized args/scalar caps inside `pto2_dispatch_payload.h`. Layout has already been touched.
- `#1079` (speculative early-dispatch) reads the payload from a different code path; layout assumptions need to stay consistent.

**Couples with**: #2 (needs the new `task_args` / `arg_count` fields).

---

## #4 One-time context-pointer init

**What**: At handshake init, write `args[PAYLOAD_LOCAL_CONTEXT_INDEX]` and `args[PAYLOAD_GLOBAL_CONTEXT_INDEX]` once per `(core_id, buf_idx)` pair. Remove these two stores from `build_payload`.

**Gain source**:
- These slots hold pointers to `local_context` / `global_context` fields **inside the same dispatch_payload buffer** — the values are fixed across all dispatches for a given (core, buffer).
- Per-dispatch AICPU saves 2 stores (~2 ns direct).
- The args[] cache line containing these indexes stays clean across dispatches → AICore's dcci doesn't pull stale state.

**Estimated gain**: ~2 ns + one cache line kept clean per dispatch. Trivial alone, meaningful as part of the layout cleanup.

**Upstream rebase risk**: MEDIUM. Depends on #3's layout decisions and the new args[] sizing from `#1056`.

**Couples with**: #3 (requires stable args[] layout across dispatches).

---

## #5 AICPU prefetch

**What**: At the top of `prepare_subtask_to_core` (before any store into the payload or slab), issue three software prefetches:

```cpp
__builtin_prefetch(&payload, 1, 3);
__builtin_prefetch(reinterpret_cast<const char*>(&payload) + 64, 1, 3);
__builtin_prefetch(deferred_slab, 1, 3);
```

`(1, 3)` = prefetch-for-write, highest temporal locality.

**Gain source**:
- 72 cores × dual-buffer = 144 payload + 144 slab buffers ≈ 36+KB, exceeds typical AICPU L1.
- Cross-core scheduler rotation means each per-core buffer is cold-cache when its turn comes round again.
- Without prefetch: first store hits **Read-For-Ownership miss → ~100 ns blocking** while line is fetched and ownership acquired.
- With prefetch: async RFO issued ahead of the actual writes; by the time `build_payload` stores fire, line is in L1 with exclusive ownership.

**Estimated gain**: ~80-100 ns per dispatch when buffer is cold (common in steady-state cross-core rotation). Marginal cost (~3 ns) when buffer happens to be hot.

**Upstream rebase risk**: LOW. 3-line standalone addition; no struct or layout dependencies.

**Independent**: can be its own PR.

---

## #6 `fast_sys_cnt`

**What**: Replace `get_sys_cnt_aicpu()` (out-of-line function in `device_time.cpp`) with a `static inline __attribute__((always_inline))` wrapper in the same TU as the dispatch hot path:

```cpp
namespace {
static inline __attribute__((always_inline)) uint64_t fast_sys_cnt() {
    uint64_t t;
    asm volatile("mrs %0, cntvct_el0" : "=r"(t));
    return t;
}
}
```

The actual register read is identical (`cntvct_el0`, the chip-wide system timer at 50 MHz — same register both AICPU and AICore-side `get_sys_cnt()` resolve to). The win is purely function-call elimination.

**Why not `pmccntr_el0` (per-core CPU cycle counter, ~30× higher resolution)**: per the original commit's note, EL0 access on the a2a3 AICPU traps-and-emulates (→ 507018 op timeout); enable attempts get masked by the platform. Plus per-core PMU counters aren't synchronized across cores — wouldn't be usable for cross-core / cross-tier dispatch ↔ AICore-start measurement anyway.

**Gain source**:
- Each profiling timestamp sample drops from `bl get_sys_cnt_aicpu` + frame + `mrs` + `ret` (~5 ns) to just `mrs` (~0 ns call-overhead).
- AICPU instruction cache footprint on the dispatch hot path slightly smaller.

**Estimated gain**: ~5 ns × (samples per dispatch) × (dispatches). Only with `--enable-l2-swimlane >= 2`; zero in release / no-profiling builds.

**Upstream rebase risk**: LOW. Standalone, 6 lines, drops next to existing `get_sys_cnt_aicpu` call sites.

**Independent**: can be its own PR.

---

## Suggested ordering

| Priority | Item(s) | Why |
|---|---|---|
| 1 | **#6 `fast_sys_cnt`** | Smallest scope, zero risk, drops next to existing call sites. Standalone PR, ~6 lines. |
| 2 | **#5 AICPU prefetch** | Standalone, 3 lines, but needs micro-benchmark on a real workload (decode-style) to confirm cache-cold assumption holds today (after `#1079` speculative-early-dispatch changed the prepare path). |
| 3 | **#2 + #3 + #4 bundle** | Largest gain on the table (per-block AICPU args store elimination scales linearly with `block_num`), but requires non-trivial rebase work against `#1056` (args sizing), `#1093` (TaskArgs type unification), `#1079` (speculative early-dispatch). Consider redesigning rather than mechanically cherry-picking — the original `dispatch_args_template` design may conflict with the new speculative path's payload assumptions. |

## Measurement plan

Each item should be benched on:
1. **`spmd_serial_chain_mix`** (PR #988) — clean SPMD with controlled kernel duration, validates `block_num`-scaled paths
2. **A real decode workload** — qwen3 decode_layer (per the PR #989 measurement table) to capture cross-task batch interaction and cache effects
3. **`spmd_sync_start_stress` × 10** — regression gate (this is the test that caught the cross-task batching bug in PR #989)

Level-2 L2 swimlane is the primary observability channel for per-dispatch timing impacts. `tools/benchmark_rounds.sh` covers the wall-time view.

## References

- PR #989: where #1 shipped (commit `98849e81`).
- PR #988: `spmd_serial_chain_mix` example useful for measuring SPMD-fanout-bound paths.
- Branch with all six bundled: `poursoul/simpler:a2a3-sched-opt`, commit `40944786`.
- `docs/investigations/2026-06-aicore-cold-start-warmup.md`: related cold-start finding (NoC routing is the dominant cause of first-task head OH, not I-cache; affects any prefetch evaluation under #5).
- `docs/investigations/2026-06-cross-task-batched-publish.md`: the cross-task hoist that was attempted, gated on sync_start in the merged version of #989.
- Upstream changes interacting with these: `#1056` (args caps), `#1079` (speculative early-dispatch), `#1093` (TaskArgs unification).


---

## #1105 [Bug] Group eligible endpoint reuse can leave scheduler requeueing forever

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1105
- Created: 2026-06-22T07:54:05Z
- Updated: 2026-06-22T07:54:05Z
- Labels: bug

### Body

### Platform

All / Unknown

### Runtime Variant

All / Unknown

### Description

Current `simpler` main can leave a group task requeued forever when the final
eligible endpoint sets require reusing the same endpoint for multiple
automatically selected group members.

This is based on `origin/main` at:

```text
26b7b1507476024d6c97dbf97e52545853d44bd6
```

The problematic shape is:

```cpp
eligible_endpoint_ids = {{0}, {0}};
```

For a group of size 2, if endpoint 0 exists and both members have no explicit
worker affinity, this submit shape can pass validation. Scheduler dispatch then
cannot assign the second member because automatic selection excludes endpoints
already selected for earlier members in the same group.

### Current Main Code Example

In `src/common/hierarchical/orchestrator.cpp`, current main only checks that
each eligible endpoint set is non-empty. If a member has no explicit affinity,
validation skips the rest of the checks:

```cpp
for (size_t i = 0; i < args_count; ++i) {
    const auto &eligible =
        eligible_endpoint_ids.empty() ? std::vector<int32_t>{} : eligible_endpoint_ids[i];
    if (!eligible_endpoint_ids.empty() && eligible.empty()) {
        throw std::invalid_argument(
            "Orchestrator: final eligible endpoint set is empty for member " + std::to_string(i)
        );
    }
    int8_t affinity = affinities.empty() ? int8_t(-1) : affinities[i];
    if (affinity < 0) continue;

    ...
}
```

So `eligible_endpoint_ids = {{0}, {0}}` is not rejected when both group members
are unconstrained by explicit affinity.

In `src/common/hierarchical/types.h`, current main stores and exposes
per-member eligible endpoint sets:

```cpp
const std::vector<int32_t> &eligible_endpoints_for(int32_t i) const {
    static const std::vector<int32_t> empty;
    if (eligible_endpoint_ids.empty()) return empty;
    if (i < 0 || static_cast<size_t>(i) >= eligible_endpoint_ids.size()) return empty;
    return eligible_endpoint_ids[static_cast<size_t>(i)];
}
```

In `src/common/hierarchical/scheduler.cpp`, current main uses all-or-nothing
group dispatch. It first selects workers for all group members, and only
dispatches after every member has a selected worker:

```cpp
std::vector<WorkerThread *> workers(static_cast<size_t>(N), nullptr);
bool ok = true;

// Pass 2: fill unconstrained slots from idle pool
if (ok) {
    for (int i = 0; i < N; i++) {
        if (workers[static_cast<size_t>(i)] != nullptr) continue;
        auto *wt =
            cfg_.manager->pick_idle_excluding_eligible(
                s.worker_type, workers, s.eligible_endpoints_for(i));
        if (!wt) {
            ok = false;
            break;
        }
        workers[static_cast<size_t>(i)] = wt;
    }
}

if (!ok) {
    q->push(slot);
    break;
}

s.state.store(TaskState::RUNNING, std::memory_order_release);
```

The exclusion happens inside
`src/common/hierarchical/worker_manager.cpp::pick_idle_excluding_eligible()`:

```cpp
bool excluded = false;
for (auto *ex : exclude) {
    if (ex == wt.get()) {
        excluded = true;
        break;
    }
}
if (!excluded) return wt.get();
```

For `eligible_endpoint_ids = {{0}, {0}}`, dispatch behaves like this:

1. member 0 tentatively selects endpoint 0 and stores it in `workers[0]`;
2. member 1 is also restricted to endpoint 0;
3. `pick_idle_excluding_eligible()` sees endpoint 0, but it is already in the
   exclude list;
4. no endpoint is returned for member 1;
5. `ok = false`;
6. the whole group slot is pushed back to the ready queue;
7. no member is dispatched, so the same state can repeat forever.


### Steps to Reproduce

```markdown
1. Register one NEXT_LEVEL endpoint with endpoint id 0.
2. Submit a NEXT_LEVEL group task with two members and no explicit worker
   affinity.
3. Set both members' final eligible endpoint set to endpoint 0:

   
   orch.submit_next_level_group(callable, {args0, args1}, cfg, {}, {{0}, {0}});
   

4. Run the scheduler/drain path.
```

### Expected Behavior

The scheduler should not requeue forever. It should choose and document one
contract:

- allow endpoint reuse by dispatching both group members to endpoint 0, where
  the `WorkerThread` queue runs them sequentially, or
- reject this shape at submit time with a clear `invalid_argument` if group
  members are required to occupy distinct endpoints.


### Actual Behavior

The submit can succeed, but scheduler dispatch cannot complete worker
selection. The whole group slot is pushed back to the ready queue and retried.
Since no member is dispatched, the slot can remain undrained.


### Git Commit ID

26b7b1507476024d6c97dbf97e52545853d44bd6

### CANN Version

N/A - scheduler logic issue, not hardware-specific

### Driver Version

N/A - scheduler logic issue, not hardware-specific

### Host Platform

Linux (aarch64)

### Additional Context

This was found while reviewing PR #1011's remote L3 worker-id cleanup. PR #1011 should only reject unknown eligible endpoint/worker ids at submit time. It should not force a distinct-endpoint contract for `{{0}, {0}}`, because endpoint reuse may be a valid scheduler behavior. The broader scheduler contract issue should be tracked separately here.

---

## #1106 Track PTO-ISA build/run revision compatibility validation

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1106
- Created: 2026-06-22T08:22:39Z
- Updated: 2026-06-24T00:53:25Z
- Closed: 2026-06-24T00:53:25Z

### Body

## Background

PR #1096 adds PTO-ISA build/run revision compatibility validation for simpler.

The current implementation records the actual PTO-ISA git HEAD used when `pip install` builds the a2a3 onboard runtime, then validates that revision when a2a3 onboard runtime binaries are looked up at test/runtime startup.

## Current scope

- Build metadata is written to `build/lib/pto_isa_build.json` after runtime builds complete.
- The recorded build revision is the actual PTO-ISA checkout HEAD, read with `git rev-parse HEAD`.
- Runtime validation is scoped to a2a3 onboard runtime lookup only.
- a5, a2a3sim, and a5sim are intentionally outside this check because the current metadata represents the a2a3 onboard host runtime PTO-ISA dependency.
- Runtime non-git `PTO_ISA_ROOT` falls back to explicit/default pin when possible; `latest`/`HEAD` without a concrete checkout remains an error.
- Build-time non-git `PTO_ISA_ROOT` remains unsupported because metadata would be unverifiable.

## Follow-up items to track

- Decide whether future support is needed for headers-only / packaged PTO-ISA directories.
- If needed, design an explicit resolved-version source, such as `PTO_ISA_ROOT/.pto_isa_commit` or a build-time resolved commit override.
- If additional platforms start embedding PTO-ISA headers into prebuilt runtime binaries, extend metadata from one global a2a3-onboard record to per-platform or per-runtime records.
- Keep docs aligned with the actual build/run resolution order for `PTO_ISA_ROOT`, `--pto-isa-commit`, `SIMPLER_PTO_ISA_COMMIT`, and `DEFAULT_PTO_ISA_COMMIT`.

Related PR: #1096

---

## #1110 [Code Health] L2 device-poison skips leave tests uncovered — add a dispatcher-level fresh-process retry pass

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1110
- Created: 2026-06-23T06:48:15Z
- Updated: 2026-06-24T02:09:47Z
- Closed: 2026-06-24T02:09:47Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Tests

### Description

When an AICore op-timeout poisons a gw xdist worker's L2 device context, the
triggering case FAILs and every subsequent same-runtime L2 case on that worker
process is marked `_l2_poisoned` and `pytest.skip`ped (see
`docs/investigations/2026-06-a5-aicore-op-timeout-cascade.md`). The skip
correctly stops the misleading 507899 cascade, but it means **those cases get
no coverage at all** in that run — they are neither verified on the poisoned
card nor anywhere else.

The intended recovery is the in-place `aclrtResetDeviceForce` path in
`DeviceRunner::finalize()`, which heals the card so the next `Worker.init()`
succeeds and the would-be-skipped cases actually run. That path is
hardware-verified on **a5** but the a2a3 mirror is **CI-verified only** (no a2a3
silicon on the dev box). When force-reset does not recover the card (a2a3, or a
rare a5 force-reset failure), the fixture falls back to the skip — and those
cases silently lose coverage.

This issue tracks **option B**: a dispatcher-level retry pass that re-runs the
poison-skipped cases in a fresh subprocess (= a clean card, which the
investigation confirms always recovers the poison), independent of whether the
in-process force-reset worked. Option A (making force-reset itself reliable on
a2a3) is the better end-state but is an empirical hardware fix gated on a2a3
silicon; B is a deterministic, hardware-semantics-independent safety net that
restores coverage today.

**Critical correctness constraint (design note):** the retry pass must collect
cases by a marker the poison guard *actively registers*, NOT by
`outcome == "skipped"`. Several legitimate skips would otherwise be wrongly
retried:

- `@pytest.mark.skip` / `skipif` (author-intentional)
- platform-required skips (`conftest.py:554/573/1104`)
- `st_worker requires SceneTestCase` (`conftest.py:1149`)
- `No cases matched ...` (`simpler_setup/scene_test.py:1418`)

(Platform-mismatch cases are *deselected*, not skipped — `conftest.py:515` — so
they never appear as skipped, but the others above do.)

Proposed mechanism: at the two poison-skip points, register
`(nodeid, runtime)` into a structured sink (per-worker JSONL file, or xdist
`workeroutput`); the dispatcher reads exactly that sink after the L2 xdist
subprocess exits and re-runs only those nodeids in a fresh subprocess. Optionally
also retry the single triggering FAIL on a clean card (bounded `<= N` attempts),
matching the investigation's "bounded retry" follow-up.

### Location

- `conftest.py:1130` — `_l2_poisoned()` sink
- `conftest.py:1160` — `st_worker` poison-skip guard (already-poisoned runtime)
- `conftest.py:1205` — `st_worker` poison-skip after rebuild `Worker.init()` fails
- `conftest.py:878-927` — L2 phase dispatch (`_dispatch_test_phases`), where the retry pass would hook in after the xdist subprocess returns
- Legit-skip sources to exclude: `conftest.py:515` (deselect), `conftest.py:554`, `conftest.py:573`, `conftest.py:1104`, `conftest.py:1149`, `simpler_setup/scene_test.py:1418`

### Proposed Fix

1. At the poison-skip points (`conftest.py:1160`, `1205`), register the deferred
   `(nodeid, runtime)` into a structured sink that survives the xdist worker
   subprocess boundary (per-worker JSONL with `O_APPEND`, or xdist
   `workeroutput` collected at `pytest_testnodedown`).
2. In the dispatcher's L2 phase, after the per-runtime xdist subprocess returns,
   read the sink and, if non-empty, spawn a fresh subprocess
   (`pytest --runtime <rt> --level 2 --case <nodeids...> --device <free>`) — a
   new process gets a clean card, so the poison is gone.
3. Collect strictly from the registered sink; never from `outcome == "skipped"`,
   so legitimate skips are untouched.
4. (Optional) Fold in a bounded retry of the single triggering FAIL on the clean
   card to turn the last red green, per the investigation's "When to reconsider".

Relates to and complements the force-reset recovery in
`src/{a5,a2a3}/platform/onboard/host/device_runner.cpp` (option A).

Related: #1111 (option A — make the in-place card recovery reliable/observable)

### Priority

Medium (minor risk, should fix in next few releases)


---

## #1111 [Code Health] In-place card recovery (force_reset_device) silently fails / is a2a3-unverified — make it observable and self-checked

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1111
- Created: 2026-06-23T06:59:07Z
- Updated: 2026-06-24T02:55:56Z
- Closed: 2026-06-24T02:55:56Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Platform (a2a3 / a2a3sim)

### Description

The in-place card-recovery path
(`DeviceRunner::force_reset_device()` → `aclrtResetDeviceForce`, called from
`DeviceRunner::finalize()` on the `device_unusable_` poison path) is the intended
fix for the AICore op-timeout cascade: it heals the poisoned card in the same
process so the next `Worker.init()` succeeds and the L2 cases that would
otherwise be skipped actually run (see
`docs/investigations/2026-06-a5-aicore-op-timeout-cascade.md`).

This recovery is **hardware-verified on a5 only**. The a2a3 mirror is
**CI-verified only** — the dev box has no a2a3 silicon, and the investigation
explicitly flags that "the CANN force-reset semantics may differ from a5"
(see its "When to reconsider" section). In practice we still see L2 cases fall
back to the poison-`skip` path, which means force-reset is **not reliably
recovering the card** (at least on a2a3, possibly on rare a5 force-reset
failures too).

Worse, when force-reset fails the failure is **invisible to the runtime**, so
the system cannot tell "recovered" from "still poisoned":

1. **The reset rc is swallowed.** `force_reset_device()` only `LOG_ERROR`s a
   non-zero `aclrtResetDeviceForce` rc and returns void — no caller can act on
   it (`device_runner.cpp:568-573`).
2. **`device_unusable_` is cleared unconditionally** at the end of `finalize()`
   regardless of whether the reset succeeded (`device_runner.cpp:649`), so a
   reused/next runner starts with a clean flag even if the card is still
   poisoned.
3. **No post-reset self-check.** Whether the card is actually clean is only
   discovered later, in Python, when the next `Worker.init()` fails — at which
   point the only remaining option is the fixture's poison-`skip` fallback.

Net effect: when the in-place reset silently fails, the would-be-skipped tests
lose coverage in that run, and we have no signal at the C++ layer that recovery
failed.

### Location

- `src/a2a3/platform/onboard/host/device_runner.cpp:553-574` — `force_reset_device()` (rc swallowed)
- `src/a2a3/platform/onboard/host/device_runner.cpp:642-649` — `finalize()` poison path + unconditional `device_unusable_ = false`
- `src/a5/platform/onboard/host/device_runner.cpp` — same chain, hardware-verified (the working reference)
- `conftest.py:1196-1209` — Python side that falls back to `_l2_poisoned` + `pytest.skip` when the rebuilt `Worker.init()` still fails

### Proposed Fix

1. **Make the reset result observable.** `force_reset_device()` returns its rc;
   `finalize()` only clears `device_unusable_` when the reset actually
   succeeded, so a still-poisoned card stays flagged.
2. **Post-reset self-check.** After `aclrtResetDeviceForce`, probe the card in
   the same `finalize()` (e.g. `aclrtSetDevice` + a trivial stream/alloc) to
   confirm it is clean before declaring recovery. If the probe still fails,
   escalate (second force-reset attempt, or keep the card marked unusable so the
   layer above knows recovery did not happen).
3. **Bounded drain + retry around op-timeout.** Add a bounded
   `aclrtSynchronizeDeviceWithTimeout` before the force-reset and allow `<= N`
   reset attempts — the op-timeout sticky-error sometimes needs a drain first.
4. **a2a3 hardware verification.** Add logging so `st-onboard-a2a3` shows the
   `cleared the poisoned card` WARN vs the ERROR plus the subsequent
   `Worker.init()` rc; a2a3 can only be validated through that CI job (no a2a3
   silicon locally).

### Related

Related: #1110 (option B — dispatcher-level retry pass that restores coverage as
a backstop when this in-place recovery fails). A and B are complementary, not a
dependency: B is the hardware-independent coverage floor; A (this issue) reduces
how often B has to fire and recovers the card in place.

### Priority

Medium (minor risk, should fix in next few releases)


---

## #1112 [Feature] Make scheduler/op-execute/stream-sync timeouts env-var configurable (no rebuild)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1112
- Created: 2026-06-23T07:22:28Z
- Updated: 2026-06-26T09:28:38Z
- Closed: 2026-06-26T09:28:38Z
- Labels: enhancement

### Body

### Summary

Allow three runtime timeouts to be overridden via environment variables, falling back to the current compile-time defaults when the env var is unset. This lets upper-layer repos (pypto, pypto-serving, etc.) tune timeouts **without re-running `pip install`** / rebuilding the runtime binaries.

In scope:

| Setting | Location | Default | Side |
| ------- | -------- | ------- | ---- |
| `PLATFORM_OP_EXECUTE_TIMEOUT_US` | `src/a2a3/platform/include/common/platform_config.h:67` | 3000000 us (3s) | Host |
| `PLATFORM_STREAM_SYNC_TIMEOUT_MS` | `src/a2a3/platform/include/common/platform_config.h:76` | 4000 ms (4s) | Host |
| `PLATFORM_SCHEDULER_TIMEOUT_MS` | `src/common/platform/{onboard,sim}/aicpu/spin_hint.h` | 2000 ms onboard / 5000 ms sim | Device (AICPU) |

Out of scope for this issue (tracked separately if needed): deadlock spin-limits (`PTO2_ALLOC_SPIN_LIMIT`, `PTO2_DEP_POOL_SPIN_LIMIT`) and `PTO2_TENSOR_DATA_TIMEOUT_CYCLES`.

### Motivation / Use Case

These timeouts are currently `constexpr` / `#define` baked into the compiled host `.so` and AICPU/device binaries. Today the only way an upper-layer repo can change them is to edit the C++ and rebuild via `pip install`, which is impractical for downstream consumers that pin a prebuilt wheel.

Different workloads legitimately need different budgets — e.g. long-running decode kernels or congested shared-device runs may need a larger scheduler/stream-sync timeout, while CI may want them tighter. Making them env-tunable removes the rebuild round-trip and keeps the defaults unchanged for everyone who sets nothing.

### Proposed API / Behavior

Env var unset → keep the existing compile-time default (no behavior change). Env var set + valid → use the override. Invalid → log a warning and fall back to the default. This mirrors the existing host-reads-env pattern in `apply_env_ring_values()` (`src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp:128`).

```bash
export PTO2_OP_EXECUTE_TIMEOUT_US=5000000
export PTO2_STREAM_SYNC_TIMEOUT_MS=6000
export PTO2_SCHEDULER_TIMEOUT_MS=4000
```

Two implementation tiers by where the value is read at runtime:

- **Host-side** (`PLATFORM_OP_EXECUTE_TIMEOUT_US`, `PLATFORM_STREAM_SYNC_TIMEOUT_MS`): read `std::getenv` directly where the ACL calls are made (`device_runner_base.cpp` / `device_runner.cpp`). Cheap.
- **Device-side** (`PLATFORM_SCHEDULER_TIMEOUT_MS`): AICPU code cannot `getenv`. Host reads the env var and passes it down through the runtime config struct that is already DMA'd to the device (same path as ring config in `runtime_maker.cpp`); the scheduler reads the field instead of the `constexpr`.

**Ordering constraint:** the wall-clock timeouts are coupled — `scheduler (2s) < op-execute (3s) < stream-sync (4s)` (documented in `platform_config.h`). Scheduler must fire first so the AICPU can flush diagnostics before STARS reaps the op, and host stream-sync must outlast op-execute so the error surfaces rather than the host timing out first. When overrides are applied, validate this ordering on the host side and warn/reject combinations that break it.

### Alternatives Considered

- **Edit C++ + rebuild per workload** — current state; the exact rebuild round-trip this issue removes for downstream repos.
- **Expose via the Python `runtime_env` API instead of env vars** — viable for the device-side scheduler timeout (the struct path is the same), but env vars are lower-friction for upper-layer repos that don't construct the runtime directly and just want to set a knob in their launch environment.

### Additional Context

- Per `.claude/rules/env-macro-gating.md`, each new behavior-gating env var needs explicit sign-off; this issue is the place to record that decision and the agreed names.
- Apply to both `a2a3` and `a5` for parity (`platform_config.h` and `spin_hint.h` exist in both).

---

## #1116 [Code Health] Rename misleading flag pto2_init_done_ to pto2_init_claimed_

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1116
- Created: 2026-06-23T08:01:11Z
- Updated: 2026-06-23T09:01:26Z
- Closed: 2026-06-23T09:01:26Z
- Labels: code health

### Body

### Category

Naming / Consistency

### Component

AICPU Scheduler

### Description

The `tensormap_and_ringbuffer` scheduler coordinates multi-threaded one-time
init with two atomic flags:

```cpp
std::atomic<bool> pto2_init_done_{false};
std::atomic<bool> pto2_init_complete_{false};
```

The first thread to arrive claims the init via `pto2_init_done_.exchange(true)`,
performs the one-time setup, then sets `pto2_init_complete_ = true`. The other
threads spin-wait on `pto2_init_complete_`.

The name `pto2_init_done_` is misleading: its real meaning is "init has been
**claimed / started**", not "init is done". `done` and `complete` are
near-synonyms but here denote opposite phases (start vs. finish), which is
exactly where a reader gets tripped up — seeing `pto2_init_done_ == true` reads
as "init finished" when init may have only just begun.

This is a naming concern only; the logic is correct and behavior must not change.

### Location

- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_context.h:183` — member declaration
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_dispatch.cpp:784` — `exchange(true)` claim site
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp:975` — reset to false

### Proposed Fix

Rename `pto2_init_done_` to a name that reflects its claim/start role, e.g.
`pto2_init_claimed_`, pairing cleanly with `pto2_init_complete_`
(claimed → complete). Replace all three usages synchronously, then verify:

- `rg 'pto2_init_done_'` returns no results
- rebuild the runtime (`pip install --no-build-isolation -e .`) and run the
  runtime's tests to confirm behavior is unchanged

### Priority

Low (no impact today, good to fix eventually)

---

## #1120 [Code Health] Consolidate profiling init into SchedulerContext::init() and remove the one-time-init cross-thread barrier

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1120
- Created: 2026-06-23T11:20:13Z
- Updated: 2026-06-24T09:17:01Z
- Closed: 2026-06-24T09:17:01Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

AICPU Scheduler

### Description

**Applies to both `a2a3` and `a5`** — the `tensormap_and_ringbuffer` runtime has the identical structure in both arches (only the flag names differ; this branch is unifying them).

The scheduler's "one-time init" runs inside the dispatch loop (`resolve_and_dispatch`), gated by an `init_claimed_` CAS among scheduler threads, and the orchestrator thread blocks on `wait_*init_complete()` before running orchestration. This couples three things that don't need to be coupled and adds a cross-thread handshake on the orchestrator's critical path.

The block only does `dump_args_init` and `pmu_aicpu_init` (both `#if PTO2_PROFILING`, no-ops when those features are off). When both are disabled (the default), the orchestrator's wait is a barrier with **zero payload**. Local instrumentation around the a2a3 wait measured ~40ms on onboard — but that figure was taken with **V0 device logging enabled** (`g_log_info_v=0`): the ~5 `LOG_INFO_V0` lines in the window then actually emit through CANN `dlog`, and the orchestrator floods the same device slog channel with tens of V0 lines just before, so each in-window `dlog_info` blocks on a backpressured channel. With V0 logging at its default (suppressed), the barrier itself costs single-digit microseconds. So the latency motivation is largely a DFX artifact; the consolidation below is justified on **code-health / consistency** grounds, not a production latency win.

The redundancy is visible against the existing `l2_swimlane` pattern, which **already** does the right thing in both arches: its buffer/state init lives in `SchedulerContext::init()` (single-threaded cold path), and only `l2_swimlane_aicpu_set_orch_thread_idx()` stays on the orchestrator thread. a5's one-time-init comment even acknowledges this ("l2_swimlane ... already ran eagerly in SchedulerContext::init() ... Only dump_tensor / pmu init remain dispatch-time"), so a5 is half-migrated. `dump_args` / `pmu` / `dep_gen` do not yet follow the convention, leaving two inconsistent init styles for the same kind of profiling subsystem.

Two facts make the consolidation safe (verified in both arches):
- `pmu_aicpu_init` starting the AICPU-side counters early is harmless: AICore samples PMU per-task via `pmu_aicore_begin()` / `pmu_aicore_end()` deltas (a2a3 `aicore_executor.cpp:211-220`, a5 `aicore_executor.cpp:161-168`), so AICPU counter-start time does not affect per-task measurement. The real PMU constraint is task non-overlap (single-issue dispatch), unrelated to where init runs.
- `pmu_aicpu_init` needs `physical_core_ids_` / `cores_total_num_`, both set by `handshake_all_cores()` inside `init()`, so placing it after handshake in `init()` satisfies its dependencies.

### Location

**a2a3** (flags: `pto2_init_claimed_` / `pto2_init_complete_` / `wait_pto2_init_complete()`):
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_dispatch.cpp:783-807` (one-time init block + flags)
- `src/a2a3/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp:535` (orchestrator wait)
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_context.h:183-184` (flag members)
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp` (`SchedulerContext::init()`; existing `l2_swimlane_aicpu_init` at 873/887 shows the target pattern)

**a5** (flags: `init_claimed_` / `init_complete_` / `wait_init_complete()`):
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_dispatch.cpp:506-525` (one-time init block + flags)
- `src/a5/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp:545` (orchestrator wait)
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_context.h:183-184` (flag members) + `:106` / `scheduler_cold_path.cpp:1012` (`wait_init_complete`)
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp:879/897` (`l2_swimlane_aicpu_init` already in `init()` — target pattern)

**Shared collectors** (per arch under `src/{arch}/platform/shared/aicpu/`): `pmu_collector_aicpu.cpp` (`pmu_aicpu_init`), `tensor_dump_aicpu.cpp` (`dump_args_init`), `dep_gen_collector_aicpu.cpp` (`dep_gen_aicpu_init`).

### Proposed Fix

Apply the same change to **both a2a3 and a5**. Consolidate all profiling-subsystem buffer/state init into `SchedulerContext::init()` (after `handshake_all_cores` / `assign_cores_to_threads`, under `#if PTO2_PROFILING`), matching the existing `l2_swimlane` convention:

- Move `dump_args_init(...)` and `pmu_aicpu_init(physical_core_ids_, cores_total_num_)` from the dispatch-loop one-time-init block into `init()`.
- Move `dep_gen_aicpu_init()` (buffer pop only) into `init()`; keep `dep_gen_aicpu_set_orch_thread_idx()` on the orchestrator thread (must record the orchestrator's idx for ready-queue routing — same split `l2_swimlane` already uses).
- Keep the three `*_set_orch_thread_idx` setters on the orchestrator thread (swimlane / dep_gen / scope_stats) as the consistent convention.
- Delete the one-time-init block, the `init_claimed_` / `init_complete_` (a2a3: `pto2_*`) members, `wait_*init_complete()`, and the orchestrator's wait.

Net effect: removes a cross-thread handshake from the orchestrator critical path, deletes two atomics + a wait function per arch, and unifies profiling init under one convention. Since `init()` is single-threaded, the "do it once" guarantee is structural — no CAS needed.

Notes:
- The ~40ms is a V0-logging/slog-backpressure artifact, not a production-path cost — do not advertise a 40ms latency win. The real fix for that symptom is separate (don't run V0-level debug logging in production, or demote the in-window trace lines).
- Keep a2a3 and a5 in lockstep so the runtimes don't drift further.

Related: #1103, #849

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1126 [Code Health] Unify runtime_env ring sizing into a single int-or-list field (drop the *s plural variants)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1126
- Created: 2026-06-24T02:08:03Z
- Updated: 2026-06-24T08:22:15Z
- Closed: 2026-06-24T08:22:15Z
- Labels: code health

### Body

## Category

Naming / Consistency

## Component

Orchestration (CallConfig / runtime_env API surface)

## Description

`CallConfig.runtime_env` currently exposes ring sizing through **two near-identical names** per resource that differ only by a trailing `s`:

| scalar (broadcast) | per-ring array |
| ------------------ | -------------- |
| `ring_task_window` | `ring_task_windows` |
| `ring_heap`        | `ring_heaps` |
| `ring_dep_pool`    | `ring_dep_pools` |

This was added in #1099 so a scalar broadcasts to all four scope-depth rings while the array selectively overrides individual rings, with the scalar acting as a fallback tier for `0` entries in the array (precedence: per-ring field > scalar field > per-ring env > scalar env > default).

The one-letter difference is an ergonomics footgun: `ring_task_window` vs `ring_task_windows` is easy to mistype, and the mistype is silently accepted (it just selects the other tier) rather than erroring. The layered "broadcast baseline + override a few rings in one config" capability that justifies keeping both is not worth the confusing twin names for this project's usage.

## Proposed Fix

Collapse each pair into a **single field that accepts either an `int` (broadcast) or a 4-element list (per-ring)**:

```python
cfg.runtime_env.ring_task_window = 128             # scalar -> broadcast to all rings
cfg.runtime_env.ring_task_window = [128, 0, 0, 0]  # per-ring; 0 falls through to env/default
```

- Broadcast happens in the Python binding (`int` -> `[v, v, v, v]`); the wire format carries only the three 4-element arrays (12 x uint64, down from 15). The getter always returns a 4-list.
- A `0` entry falls through to `PTO2_RING_*` env -> compile-time default. The separate scalar-CallConfig fallback tier is intentionally dropped (accepted trade-off): a `0` in a list can no longer fall back to a sibling scalar, only to env/default.
- The internal C-API (`run_prepared`) and wire layout are internal-only (no external consumers; everything rebuilds together via `pip install`), so this is a clean break with no back-compat shim.

### Surface (mirror a2a3 <-> a5)

- Core struct + validate + wire asserts: `src/common/task_interface/call_config.h`
- Python binding (int|list property, repr): `python/bindings/task_interface.cpp`
- Pack/unpack wire format: `python/simpler/worker.py`
- Scene-test dict parse: `simpler_setup/scene_test.py`
- Internal C-API: `src/common/worker/pto_runtime_c_api.h`, `chip_worker.cpp`, onboard+sim `c_api_shared.cpp`, both `host_build_graph/host/runtime_maker.cpp`
- Resolution: both `tensormap_and_ringbuffer/host/runtime_maker.cpp`
- Docs: both `tensormap_and_ringbuffer/docs/MULTI_RING.md`
- Tests: `tests/ut/cpp/types/test_call_config.cpp`, both `tests/ut/cpp/{a2a3,a5}/test_shared_memory.cpp`, `tests/ut/py/test_chip_worker.py`
- Examples: `examples/workers/l2/per_task_runtime_env`, `examples/workers/l3/per_task_runtime_env` (added in #1122), and the two `paged_attention*` scene tests

## Location

- `src/common/task_interface/call_config.h` (RuntimeEnv struct, lines ~61-120)
- `python/bindings/task_interface.cpp` (RuntimeEnv bindings, ~614-690)
- Full list above.

## Priority

Low (no impact today, good to fix eventually) — pure API ergonomics; the feature shipped recently (#1099) so changing the spelling before wide adoption is cheap.

---

## #1133 [Code Health] trb PTO2TaskAllocator back-pressure/deadlock logs are misleading (heap cursor printed as occupancy, no ring index)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1133
- Created: 2026-06-24T08:20:53Z
- Updated: 2026-06-27T01:13:20Z
- Closed: 2026-06-27T01:13:06Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Ring Buffer

### Description

> **Update (2026-06-25, after #1132 merged).** #1132 rewrote the trb allocator
> deadlock detector (fixed-spin → two-tier: structural head-of-line proof +
> ~500 ms wall-clock backstop) and mirrored it to a5. That reworked the
> *detection mechanism* but left the *log-readability* defects below untouched.
> This issue is trimmed to what still holds; the original spin-limit-env ask is
> now moot (the spin limit was deleted). See the per-point status table.

The `PTO2TaskAllocator` diagnostic logs in the `tensormap_and_ringbuffer`
runtime are the primary signal a developer reads when an allocation
back-pressures or deadlocks. Found while debugging a `spmd_paged_attention`
"Heap Exhausted" deadlock on a2a3.

**1. The `BLOCKED` warning prints the heap write-cursor as if it were occupancy. (STILL OPEN)**

The warning formats `heap_top_` as `heap=%d/%d`, which reads like *used /
capacity*. But `heap_top_` is the ring **write cursor position**, not bytes
used. In a real report it printed:

```
[TaskAllocator] BLOCKED: tasks=13428/1048576, heap=141966336/4294967296, on=heap, spins=20000
```

That `heap=141966336/4294967296` looks like ~3% full. The ring was actually
**99.98% full**: `heap_used_bytes() = (top + size - tail) % size =
(141966336 + 4294967296 - 142671872) % 4294967296 = 4294261760`, with
`available = 705536` and `requested = 1278976`. The cursor is a small number
only because the ring already wrapped. A developer reading this line concludes
the heap is nearly empty when it is exhausted.

`report_deadlock()` now prints `heap_available()` correctly (good), but the
hot-path `BLOCKED` `LOG_WARN` at `pto_ring_buffer.h:200-201` is unchanged and
still misleads.

*Fix:* print `heap_used_bytes()` and/or `heap_available()` in the `BLOCKED`
warning. If `heap_top_` is kept, label it explicitly as a cursor.

**2. Neither the `BLOCKED` warning nor `report_deadlock()` identifies which ring exhausted. (STILL OPEN)**

There are `PTO2_MAX_RING_DEPTH = 4` independent rings (one
HeapRing/TaskRing/DepPool per scope depth). When the deadlock fires you cannot
tell which ring/scope-depth ran out — every per-ring heap looks identical in
the log. The caller already has `ring_id` in scope
(`pto_orchestrator.cpp:362`, `orch->rings[ring_id].task_allocator`) but does
not thread it into the allocator's log sites. #1132 did not add this.

*Fix:* thread `ring_id` into `PTO2TaskAllocator` (store it in `init()`) and
include it in both the `BLOCKED` warning and `report_deadlock()`.

**3. The "Solution" text — mostly resolved by #1132, residual text gap. (PARTIAL)**

#1132 split the detector into a structural, immediate head-of-line proof
(`scope_gated=true` → "Provable head-of-line deadlock") and a wall-clock
backstop, and `report_deadlock()`'s Solution now branches three ways
(scope-gated / heap / task-window) with mode-aware advice (e.g. "heap*2 may
not be enough" for the scope-gated case). That largely addresses the original
"single remedy can't tell true-deadlock from under-provisioned apart"
complaint.

Residual: the non-scope-gated wall-clock-backstop path still leads with a bare
"Increase heap" and gives no "go debug the stuck consumer" hint, and there is
no explicit *raise-once-and-re-run* disambiguation step ("if it now completes
it was under-provisioned; if it deadlocks again at a higher active-task count
the head task is genuinely stuck"). Low priority polish.

**4. Spin-limit env override — NO LONGER APPLICABLE.**

The original issue asked for a `PTO2_ALLOC_SPIN_LIMIT` env override because it
was a hard-coded `#define` and heap growth was the only runtime-tunable lever.
#1132 **deleted `PTO2_ALLOC_SPIN_LIMIT` entirely**, replacing the no-progress
detector with a wall-clock `PTO2_ALLOC_DEADLOCK_TIMEOUT_CYCLES`
(`PLATFORM_PROF_SYS_CNT_FREQ / 2`, fixed 500 ms). This is a fixed safety
margin sitting below the AICPU scheduler (2 s) and STARS op-exec (3 s)
timeouts — not a per-workload tuning knob — so the original env-override ask is
moot and is dropped.

**5. a5 parity — DONE by #1132.** The a5 copy is now symmetric with a2a3, so
points 1 and 2 above apply equally to
`src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.h`.

**6. `<pow2>` heap-size hint regressed by #1132. (NEW, STILL OPEN)**

#959/#1099 corrected the stale `<power-of-2 bytes>` hint to `<bytes>` because
`PTO2_RING_HEAP` is parsed with `require_power_of_2 = false`
(`runtime_maker.cpp:189`) — there is no power-of-2 constraint on the heap
size. #1132's new `report_deadlock()` Solution text **reintroduced** it:
`env PTO2_RING_HEAP=<pow2>` (`pto_ring_buffer.h:457`, and the a5 copy).

*Fix:* change `<pow2>` back to `<bytes>` in both arch copies.

### Per-point status after #1132

| # | Point | Status |
| - | ----- | ------ |
| 1 | `BLOCKED` warning prints `heap_top_` cursor as `heap=%d/%d` occupancy | **Open** |
| 2 | No `ring_id` in `BLOCKED` / `report_deadlock()` | **Open** |
| 3 | Single-remedy Solution can't distinguish true-deadlock vs under-provisioned | **Mostly fixed** by #1132; residual text polish |
| 4 | Add `PTO2_ALLOC_SPIN_LIMIT` env override | **Moot** — spin limit deleted by #1132 |
| 5 | Mirror to a5 | **Done** by #1132 |
| 6 | `<pow2>` heap hint | **Open (new regression from #1132)** |

Related: #959, #995, #1099, #1132, #1135

### Location

- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.h:200-201` — `BLOCKED` warning prints `heap_top_` as `heap=%d/%d` (point 1)
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.h:406-471` — `report_deadlock()`: no ring index (point 2); residual Solution text (point 3); `<pow2>` hint at :457 (point 6)
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp:362` — caller has `ring_id` available to thread through (point 2)
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.h` — same defects in the a5 copy (points 1, 2, 6)

### Proposed Fix

1. In the `BLOCKED` `LOG_WARN`, replace the raw `heap_top_` with
   `heap_used_bytes()` / `heap_available()` (or relabel it as a cursor and add
   a used/available pair).
2. Thread `ring_id` from `orch->rings[ring_id]` into `PTO2TaskAllocator`
   (store it in `init()`) and include it in both the `BLOCKED` warning and
   `report_deadlock()`.
3. (Low priority) In the non-scope-gated backstop path, add a
   raise-once-and-re-run disambiguation hint plus a "debug the stuck consumer"
   pointer.
4. Fix the `<pow2>` → `<bytes>` regression in the heap Solution text.
5. Apply 1, 2, 4 to the a5 copy.

### Priority

Low–Medium (diagnostics quality; detection itself is now handled by #1132)


---

## #1139 Onboard a2a3 host_runtime.so not rebuilt after a pto-isa update (stale ccache/cmake cache) → SDMA query fails, allocate_domain ImportByKey 507899

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1139
- Created: 2026-06-24T12:08:29Z
- Updated: 2026-07-01T03:15:52Z
- Closed: 2026-07-01T03:15:52Z

### Body

## Summary

After updating **pto-isa** (without changing the `simpler`/runtime repo HEAD), reinstalling the
runtime (`pip install .../pypto/runtime`) silently produces a **broken onboard a2a3
`libhost_runtime.so`** that is compiled against the *old* pto-isa headers. The build's
cache-invalidation logic does not account for pto-isa changes, and the global **ccache** then serves
the stale object on the reinstall, so neither a normal reinstall nor `rm -rf build/` fixes it.

This is a build-system correctness bug: a pto-isa update is not reflected in a rebuilt
`host_runtime.so` unless the user knows to clear ccache.

## Symptom (real failure observed)

`allocate_domain` (dynamic comm domain over HCCL) fails during IPC setup:

```
[SDMA] Created 40 STARS streams OK
[SDMA] aclrtSynchronizeStream (aicpu) failed
[comm rank 0] alloc_domain: ImportByKey(peer_dr=1 pid=...) -> 507899
[comm rank 1] alloc_domain: ImportByKey(peer_dr=0 pid=...) -> 507899
destroy_comm_stream: aclrtSynchronizeStream during stream teardown failed: 507018
RuntimeError: alloc_domain(allocation_id=0) failed on 2/2 chips ... comm_alloc_domain_windows failed with code -1
```

The `ImportByKey -> 507899` is a **secondary** failure. The primary cause is the SDMA workspace
query failing (`aclrtSynchronizeStream (aicpu) failed`).

## Root cause

`allocate_domain` → `ensure_sdma_workspace()` → `pto::comm::sdma::SdmaWorkspaceManager`
(`pto-isa: include/pto/npu/comm/async/sdma/sdma_workspace_manager.hpp`, header-only).

pto-isa commit `e19897e7` ("modify async comm isa for 48 channel") changed `kSdmaMaxChan` 40 → 48.
`Init()` calls `CreateStarsStreams(detail::kSdmaMaxChan)`, so the stream count is baked into
`host_runtime.so` at compile time (it is logged as `Created N STARS streams`).

A `host_runtime.so` built **against the pre-update (40-channel) object** creates 40 STARS streams,
and its AICPU workspace-query path then fails at `aclrtSynchronizeStream`, cascading into the
`ImportByKey -> 507899` above.

We confirmed this by diffing a passing vs failing install: only
`a2a3/onboard/*/libhost_runtime.so` differed; `nm -D` showed the SDMA symbols differ; the
`40 vs 48 STARS streams` log line pinned it to the compile-time `kSdmaMaxChan`.

## Why current safeguards miss it

1. **cmake cache invalidation keys on the runtime repo HEAD only.**
   `simpler_setup/runtime_builder.py`:
   - `get_binaries()`: `current_commit = _get_git_head(PROJECT_ROOT)` (the *runtime* repo)
   - `_compile_target()`: `_invalidate_cache_if_stale(cache_dir/target, current_commit)`
   The helper's own comment notes *"git does not update file mtimes on checkout, so cmake's
   incremental build can't detect stale objects."* That reasoning is correct — but it is only
   applied to the **runtime** repo's HEAD. A pto-isa-only change (runtime HEAD unchanged) does not
   invalidate the cache, and pto-isa's headers come in via `-I$PTO_ISA_ROOT/include` whose mtimes
   are likewise not bumped by a git checkout. So cmake/incremental thinks the object is up to date.

2. **ccache also serves the stale object.** The toolchain compiles via the ccache wrapper
   (`/usr/lib64/ccache/g++`) into a global `CCACHE_DIR`. Even after `rm -rf .../runtime/build`, a
   reinstall gets ccache hits and links the stale `comm_hccl.o`. (Observed with ccache 3.7.12,
   `compiler_check = mtime`, default `sloppiness`.)

Net effect: a pto-isa update is invisible to the runtime rebuild.

## Reproduction

1. Build/install the runtime once with pto-isa at the **old** (40-channel) commit.
2. Update pto-isa to a commit that changes `kSdmaMaxChan` (e.g. include `e19897e7`).
3. `pip install --force-reinstall --no-deps --no-cache-dir .../pypto/runtime` (runtime HEAD unchanged).
4. Run any kernel that uses `orch.allocate_domain` (e.g. an EP-2 MoE) → fails with the symptom above.
   `[SDMA] Created 40 STARS streams` confirms the stale build.

## Workaround (verified)

Force a real recompile against the updated pto-isa:

```bash
ccache -C                       # or: export CCACHE_DISABLE=1 for the build
rm -rf .../pypto/runtime/build
PTO_ISA_ROOT=/path/to/pto-isa \
  pip install --force-reinstall --no-deps --no-cache-dir .../pypto/runtime
```

After this the binary creates `48 STARS streams` and `allocate_domain` succeeds.

## Suggested fix

Make the onboard-a2a3 host build's cache invalidation aware of the **pto-isa** commit, not just the
runtime repo HEAD. Options:

- Fold the resolved pto-isa HEAD (already recorded in `pto_isa_build.json` →
  `write_pto_isa_build_metadata`) into the `.git_commit` stamp that
  `_invalidate_cache_if_stale` compares, so a pto-isa change clears the per-target cmake cache.
- Additionally guard ccache: since git checkouts don't bump header mtimes and `compiler_check`
  defaults to `mtime`, consider setting `CCACHE_COMPILERCHECK=content` (or
  `CCACHE_SLOPPINESS`-free content hashing) for the runtime build, or mixing the pto-isa commit into
  the ccache key via `CCACHE_EXTRAFILES` / a `-D` define so a pto-isa bump forces a miss.

## Environment

- simpler/runtime HEAD: `fcc33bcb`
- pto-isa HEAD: `b9122ec5` (contains `e19897e7` "48 channel")
- ccache 3.7.12, `compiler_check = mtime`, default `sloppiness`
- platform: a2a3 onboard, CANN 9.0.0


---

## #1146 [Code Health] Two profiling enable() gates leak onto orch/scheduler hot path (not covered by PTO2_PROFILING)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1146
- Created: 2026-06-25T02:38:44Z
- Updated: 2026-06-27T01:00:40Z
- Closed: 2026-06-27T01:00:40Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

AICPU Scheduler

### Description

The orchestrator/scheduler hot path contains `if (xxx_enable())` profiling gates. Each gate resolves to an O(1) global-bool read (`return g_enable_pmu;` etc.), but the gate functions are `extern "C"` / `weak` symbols defined in a **separate translation unit** from the scheduler loop, so the compiler **cannot inline them and cannot hoist them out of the loop** — every call is a real `bl`/`ret` on the hot path. This is already acknowledged in-tree (a2a3 `scheduler_dispatch.cpp` ~L810: *"is_pmu_enabled() is extern "C" and the compiler cannot hoist it across the dispatch loop on its own"*).

The existing `PTO2_PROFILING` compile macro (`src/common/task_interface/profiling_config.h`, default `1`) already wraps **most** of these gates — `is_dump_args_enabled()`, `is_scope_stats_enabled()`, etc. are inside `#if PTO2_PROFILING` and compile out when `PTO2_PROFILING=0`. Two residual sites are **not** gated and remain as non-inlinable calls even when profiling is compiled out:

1. **`is_pmu_enabled()`** — called **once per scheduler main-loop iteration** (the tightest spin loop in the system). Note this one is **load-bearing**: `pmu_active` is passed into `dispatch_ready_tasks(...)` and forces single-issue dispatch, so the fix must hard-set `pmu_active = false` under `#if !PTO2_PROFILING`, not just delete the call (when profiling is compiled out, PMU is definitionally off).
2. **`is_dep_gen_enabled()`** — called **once per task submission** in `submit_task_common`.

**Magnitude is unmeasured.** No profile was taken; the original report ("much slower") is a mechanism-true but quantitatively unverified claim. The cost is one non-inlinable function call per scheduler iteration / per task submission. The in-tree function-scope caching of `is_pmu_enabled()` is the strongest existing evidence the team already treats the call cost as real and worth avoiding.

Full analysis: `docs/investigations/2026-06-orch-profiling-enable-gates-hot-path.md`.

### Location

- `src/a5/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_dispatch.cpp:813` — `is_pmu_enabled()`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_dispatch.cpp:812` — `is_pmu_enabled()`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp:610` — `is_dep_gen_enabled()`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp` — `is_dep_gen_enabled()` in `submit_task_common`

### Proposed Fix

Gate the two residual sites under the **existing** `PTO2_PROFILING` macro — do **not** add a new `PTO_PROFILING` macro (it would duplicate `PTO2_PROFILING`). For the load-bearing PMU site:

```cpp
#if PTO2_PROFILING
    const bool pmu_active = is_pmu_enabled();
#else
    constexpr bool pmu_active = false;
#endif
```

and the analogous wrap around `is_dep_gen_enabled()` in `submit_task_common`. Recommend taking an AICPU scheduler profile first to confirm the cost is a non-trivial slice before/after, since the magnitude is currently unverified.

### Priority

Low (no impact today, good to fix eventually)

---

Related: #1103

---

## #1149 [Code Health] qwen3_14b_decode example SKIPPED: fa_fused_aiv [[block_local]] sub-block-id static emits a .rela.text reloc the strict loader rejects

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1149
- Created: 2026-06-25T03:36:25Z
- Updated: 2026-06-25T07:44:34Z
- Closed: 2026-06-25T07:44:34Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Build System (the `simpler_setup/elf_parser.py` `.text`-only loader is the proximate gate; the underlying cause spans **AICPU Scheduler / AICore** — the runtime does not program the FFTS sub-block register — and **pto-isa** — the no-arg `get_subblockid()` contract).

### Description

`examples/a2a3/tensormap_and_ringbuffer/qwen3_14b_decode` (added in `68960f4f`, a verbatim harvested 2-layer Qwen3-14B decode) is checked in but **`@pytest.mark.skip`** — it never reaches PASS, it reports SKIPPED. Un-skipping does not fail at runtime; it fails earlier, at **compile/load time**, with a `ValueError` from the loader. This issue tracks removing that blocker so the example can run.

**Root-cause chain (verified end-to-end in-tree + by recompiling the kernel):**

1. **The runtime does not program the FFTS sub-block register.** `tensormap_and_ringbuffer` launches one persistent AICore control-loop kernel and drives dispatch itself via the AICPU scheduler + ring buffer — it does *not* go through CANN FFTS+ sub-task dispatch. So the native no-arg CCE `get_subblockid()` returns **0 for both AIV0 and AIV1** of every MIX 1C2V cluster (documented at `intrinsic.h:50-66`; same failure mode as #900). Two lanes collide on the same FIFO half → attention poisoned to NaN. simpler instead carries the correct lane id out-of-band in `GlobalContext.sub_block_id` (scheduler writes 0/1 per core), read via `get_sub_block_id(args)`.

2. **The codegen bridges the correct id into the no-arg ISA contract with a `[[block_local]]` static.** `get_sub_block_id(args)` needs `args`, which only exists at the `kernel_entry(__gm__ int64_t *args)` ABI boundary. But the value is consumed deep inside pto-isa tile-pipe templates (`TPUSH/TPOP/TAlloc<…TILE_UP_DOWN>` compute `subAIVOffset = get_subblockid() * …`), whose fixed signatures cannot receive `args`. So the codegen caches the value once in `kernel_entry` into a per-core `[[block_local]] static int32_t pypto_runtime_subblock_id` and `#define`s `get_subblockid()` to read it. `[[block_local]]` (per-core storage) is required because AICore forbids ordinary mutable globals and the two lanes need *different* values (0 vs 1) from the *same* binary.

3. **The `[[block_local]]` static emits a `.rela.text` relocation; the strict loader rejects ANY such entry.** `elf_parser.py` (`_extract_text_elf64`) rejects any `.rela.text*` section — the guard against unapplied **branch** relocations (BL/B with imm26=0 → CANN 507018 / silently-wrong output) from #900 / #830 / #831. It cannot distinguish the benign **non-branch data** reloc here from a dangerous branch reloc, so it rejects it too. The build path hits this in `scene_test.py` (`compile_incore` → `extract_text_section`), before any device run.

**Empirical confirmation (recompiled `fa_fused_aiv.cpp` with the repo's own `ccec` toolchain):**

- The compiled `.o` carries **exactly 1** `.rela.text` entry: type `0x123` (a CCE-specific **data/address** reloc, which stock `readelf` prints as `unrecognized: 123`) against symbol `_ZL25pypto_runtime_subblock_id` (the mangled `[[block_local]]` static). There are **zero** `R_AARCH64_CALL26`/`JUMP26` branch relocations anywhere — confirming it is exactly the "benign non-branch" kind.
- Compiling **all 35 incores** through the loader: **34 PASS, only `fa_fused_aiv` is REJECTED** (including the AIC half `fa_fused_aic` — it loads fine). So this is the **sole** static blocker, not a symptom of a broader load problem.
- `pytest …/qwen3_14b_decode -rs` → `1 skipped` with the `[[block_local]]` reason.

Per the README, the math itself is correct on a loader that accepts the benign reloc (`max_abs_diff ≈ 0.03`, both layers' KV-cache match) — i.e. only the load gate, not numerics, blocks the example.

### Location

- Skipped test: `examples/a2a3/tensormap_and_ringbuffer/qwen3_14b_decode/test_qwen3_14b_decode.py:57` (`@pytest.mark.skip`)
- Offending static + macro: `examples/a2a3/tensormap_and_ringbuffer/qwen3_14b_decode/kernels/aiv/fa_fused_aiv.cpp:33-34`; cached at `:683` (`pypto_runtime_subblock_id = get_sub_block_id(args)`); consumed at `:504` and inside `TPUSH/TPOP<…TILE_UP_DOWN>` (e.g. `:175,:267,:306,:401`)
- Loader rejection: `simpler_setup/elf_parser.py:155-159` (rejects any `.rela.text*`) → `_raise_unresolved_text_error` `:168-203`
- Build-time gate: `simpler_setup/scene_test.py:949-953` (`compile_incore` → `extract_text_section`)
- Sub-block-id source (the correct path): `src/a2a3/runtime/tensormap_and_ringbuffer/common/intrinsic.h:170` (`get_sub_block_id(args)`), `:50-66` (documents native `get_subblockid()` returns 0/0); scheduler writes 0/1 per core at `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_cold_path.cpp:940-943`
- pto-isa internal no-arg use: `pto-isa include/pto/npu/a2a3/TPush.hpp:204` (`subAIVOffset = get_subblockid() * …`)
- Example commit: `68960f4f` ("Add qwen3_14b_decode 2-layer (decode_fwd_layers N=2) SceneTestCase")

### Proposed Fix

Remove the `[[block_local]]` dependency so the verbatim codegen loads under the strict loader (kept strict on purpose — **do not** relax the #900/#830/#831 branch-reloc guard). Either:

1. **pto-isa (preferred, pure-software, low risk):** give `TPUSH/TPOP`'s sub-AIV-offset helpers an explicit `sub_block_id` parameter, so the kernel passes `get_sub_block_id(args)` straight in. No no-arg call site remains → no `[[block_local]]`, no relocation. Cleanest because it touches no hardware registers.
2. **runtime (harder):** program the AICore FFTS sub-block register at MIX dispatch so native `get_subblockid()` returns 0/1. Bumps into the hardware-register-write constraints in `.claude/rules/ascend.md` (AICore can't write its own SPR; AICPU cross-core writes need on-`a3` validation) and the fact that simpler deliberately does not use FFTS+ sub-task dispatch — needs verification that the written field is actually reflected by `get_subblockid()`.

Either fix lets the test drop `@pytest.mark.skip` and run (math already verified correct on a permissive loader).

### Priority

Medium (no impact on shipping users today — it only blocks example/regression coverage; should be resolved so the verbatim decode example is exercised in CI)

---

Related: #900 (CLOSED — canonical deep-dive on the strict-loader / unapplied-`.text`-reloc gap, for `spmd_paged_attention_highperf`; same loader root cause, different kernel), #1102 (OPEN — a *separate* intermittent single-lane NaN **race** in the SceneTestCase L2 run path, observed when the example still loaded; it explicitly calls this loader limitation "separate". The current verbatim example does not load at all, so #1102's premise — example loads and xfails — is superseded by this skip until the `[[block_local]]` blocker is removed).

---

## #1150 [Bug] resolve_ring_config: unaligned uint64_t load from pack(1) RuntimeEnv (UBSan-fatal, flaky nightly)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1150
- Created: 2026-06-25T04:00:29Z
- Updated: 2026-06-25T07:11:05Z
- Closed: 2026-06-25T07:11:05Z
- Labels: bug

### Body

> **Status — fix up + validated.** The nightly Sanitizers ASAN leg actually had
> **two independent aborts**, fixed across two PRs that must both merge for the
> job to go green:
> - **This bug** (unaligned `uint64_t` load) — fix in **#1151** (product code).
> - A separate `__cxa_throw` interceptor abort (sanitizer harness, not a code
>   bug) — fix in **#1148** (libstdc++ preload) + log capture so the report was
>   visible in the first place.
>
> Validated together in a combined sanitizer run: all 4 legs green, `3 passed`.

---

**Platform:** All (a2a3 / a5, sim + onboard) · **Runtime:** tensormap_and_ringbuffer

## Description

`resolve_ring_config` in `runtime_maker.cpp` reads the per-ring override arrays (`ring_task_window` / `ring_heap` / `ring_dep_pool`) as aligned `uint64_t` loads, but those pointers point into a `#pragma pack(1)` wire struct, so the loads are unaligned — **undefined behavior**, and fatal under UBSan.

### Root cause

`RuntimeEnv` is declared under `#pragma pack(push, 1)` in `src/common/task_interface/call_config.h` (for a stable IPC wire layout, enforced by the `static_assert`s on `sizeof`). In `CallConfig`, `runtime_env` follows **7× `int32_t` = 28 bytes**, so `runtime_env.ring_task_window[0]` sits at byte offset **28 — 4-byte aligned, not 8**. `chip_worker.cpp:327` passes `config.runtime_env.ring_task_window` (and siblings) **unconditionally** to `run_prepared` → `bind_callable_to_runtime_impl` → `resolve_ring_config`, which then does `ring_task_window[r]` — an unaligned 8-byte load.

Because `CallConfig` is `pack(1)` (alignment 1), the instance lands at an arbitrary address each run, so whether `base+28` is 8-aligned varies run to run — which is why the nightly **Sanitizers** ASAN job fails **intermittently** rather than every time.

### Observed (nightly Sanitizers, `asan, a2a3sim`)

```
runtime_maker.cpp:197:62: runtime error: load of misaligned address 0x...6b4
  for type 'const uint64_t', which requires 8 byte alignment
    #0 resolve_ring_config            runtime_maker.cpp:197
    #1 bind_callable_to_runtime_impl  runtime_maker.cpp:344
    #2 run_prepared                   c_api_shared.cpp:363
```

(Originally invisible — the report was only recoverable after PR #1148 made the sanitizer job capture reports through the abort.)

### Deterministic repro

A standalone program placing a `CallConfig` at an 8-aligned address and reading `runtime_env.ring_task_window[1]` directly reproduces the exact error under `g++-15 -fsanitize=alignment`; reading the same bytes via `memcpy` does not.

## Locations

- `src/a2a3/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp:197` (and `:344` caller)
- `src/a5/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp` (identical mirror)
- Layout origin: `src/common/task_interface/call_config.h` (`RuntimeEnv` under `pack(1)`, offset 28 in `CallConfig`)
- Call site: `src/common/worker/chip_worker.cpp:327`

## Fix

Read the packed arrays with `memcpy` instead of dereferencing them as `uint64_t` (keeps the wire layout intact). PR incoming.

## Severity

Medium — real UB on every run (manifests when the instance lands misaligned); UBSan-fatal in CI. On strict-alignment paths it could fault rather than silently work.



---

## #1159 [Code Health] simt_basic scatter kernel: drop the __CPU_SIM fork — use one templated MSCATTER across sim and onboard

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1159
- Created: 2026-06-25T11:49:36Z
- Updated: 2026-07-06T09:26:57Z
- Closed: 2026-07-06T09:26:57Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Tests

### Description

`kernel_simt_scatter.cpp` (the SIMT element-scatter ST kernel) currently
forks the scatter call on `__CPU_SIM`:

```cpp
#ifdef __CPU_SIM
    MSCATTER(outGlobal, srcTile, idxTile);                                   // non-templated
#else
    MSCATTER<Coalesce::Elem, ScatterAtomicOp::None, ScatterOOB::Skip>(...);  // templated
#endif
```

The fork existed because pto-isa previously gated the **templated** `MSCATTER`
overloads behind `PTO_NPU_ARCH_A5` only — they were not visible to the CPU
simulator, so the sim path had to fall back to the non-templated form (whose
CPU-sim default happens to be `Coalesce::Elem`, matching our element-scatter
golden), while onboard selected `Coalesce::Elem` explicitly. See
[pto-isa#164](https://github.com/hw-native-sys/pto-isa/issues/164).

The pinned pto-isa (bumped to `016396b5` in #1156, the
[pto-isa#166](https://github.com/hw-native-sys/pto-isa/pull/166) mechanism)
now opens the templated overloads to `__CPU_SIM` as well as
`PTO_NPU_ARCH_A5`:

```cpp
// build/pto-isa/include/pto/common/pto_instr.hpp:2049
#if defined(PTO_NPU_ARCH_A5) || defined(__CPU_SIM)
template <Coalesce Mode, ScatterAtomicOp Atomic, ScatterOOB Oob, ...>
PTO_INST RecordEvent MSCATTER(...) { ... MSCATTER_IMPL<Mode, Atomic, Oob>(...); }
#endif
```

So the same explicit templated call now compiles and runs identically on both
backends, and the `#ifdef __CPU_SIM` fork can be removed.

**Important caveat — the non-templated form is still NOT portable.** Only the
*templated* overload was unified. The non-templated `MSCATTER(dst, src, idx)`
still dispatches to each backend's own default `MSCATTER_IMPL`:

- CPU sim default → `Coalesce::Elem` (`pto/cpu/MScatter.hpp:139`)
- a5 onboard default → `Coalesce::Row` (`pto/npu/a5/MScatter.hpp:456`)

i.e. the original #164 divergence persists for the non-templated surface. The
single portable instruction must therefore be the explicit
`MSCATTER<Coalesce::Elem, ScatterAtomicOp::None, ScatterOOB::Skip>`.

### Location

- `tests/st/a5/tensormap_and_ringbuffer/simt_basic/kernels/aiv/kernel_simt_scatter.cpp:85-89`

### Proposed Fix

Drop the `#ifdef __CPU_SIM` branch and call the explicit templated form
unconditionally on both sim and onboard:

```cpp
MSCATTER<Coalesce::Elem, ScatterAtomicOp::None, ScatterOOB::Skip>(outGlobal, srcTile, idxTile);
```

Verified on `--platform a5sim` (1 passed). The onboard call site is
unchanged by this cleanup (it already used this exact instruction), so a5
behavior is unaffected; an a5 onboard rerun is still warranted to close the
loop (not available on the current a2a3 dev box).

### Priority

Low (no impact today, good to fix eventually)

---

## #1161 [Performance] L2 swimlane profiling drops under 30GB/s AICPU producer

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1161
- Created: 2026-06-25T17:07:50Z
- Updated: 2026-07-02T12:25:29Z
- Closed: 2026-07-02T12:25:29Z

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Summary

L2 swimlane profiling can drop records when device-side AICPU profiling data is produced faster than the host can drain, recycle, and return buffers.

The issue is about the device-to-host profiling buffer lifecycle: AICPU writes records into profiling buffers, publishes full buffers to the ready queue, and depends on host-side management threads to drain those buffers and refill the free queue. Under bursty profiling traffic, the host path may not return buffers quickly enough, causing device-side drops.

This should be investigated independently from any specific model or library example. A synthetic AICPU producer is useful here because it can generate normal L2 swimlane profiling records at a controlled rate and let the host consume them through the regular profiling path.

Related: #997

### Git Commit ID

5a6ad1f2cab80b9eea3e4350a2c93a80d53b6403

### CANN Version

Not captured.

### Driver Version

Not captured.

### Host Platform

Linux (aarch64)

### Reproduction

Use a temporary synthetic L2 swimlane producer to isolate the profiling path from real model execution:

1. Short-circuit the normal AICore path so the kernel does not run real compute work.
2. In the AICPU entry path, start one AICPU thread that writes normal `L2SwimlaneAicpuTaskRecord` buffers for a short fixed duration.
3. Publish those buffers through the existing L2 swimlane ready-queue/free-queue mechanism.
4. Let the normal host L2 swimlane management and collector path drain the data.
5. Check whether the host keeps up or whether device-side profiling drops are reported.

The Python test used to launch the kernel should only act as a harness; the reproduction should not depend on pageattention, qwen, or any other specific workload behavior.

### Expected Performance

For a controlled device-side producer below the intended hardware bandwidth envelope, the host profiling path should be able to drain and recycle buffers without scattered profiling record loss, or should expose clear backpressure/overflow behavior that is easy to reason about.

### Actual Performance

Under bursty device-side profiling production, L2 swimlane can still report device-side dropped profiling records. This indicates that host-side drain/refill/collector progress can lag behind the AICPU producer and fail to return free buffers in time.

### Profiling Data (Optional)

N/A. This issue intentionally tracks the problem statement and reproduction direction only; detailed benchmark numbers should live in the relevant PR or investigation notes.

### Additional Context

The main question is whether the limiting factor is host-side profiling control-path throughput, buffer lifecycle design, or a lower-level device-to-host bandwidth limit. The synthetic AICPU producer should help separate this from workload-specific behavior.


---

## #1164 [Feature] Add PTO2_SERIAL_ORCH_SCHED toggle to serialize orch→sche execution + benchmark integration

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1164
- Created: 2026-06-26T01:56:50Z
- Updated: 2026-06-29T06:04:33Z
- Closed: 2026-06-29T06:04:33Z
- Labels: enhancement

### Body

### Summary

Add an opt-in switch (proposed `PTO2_SERIAL_ORCH_SCHED` env var / `Runtime::serial_orch_sched` field) that controls the ordering between the AICPU **orchestration (orch)** thread and the **scheduler (sche)** threads.

Today orch and sche run **pipelined / overlapped**: the orchestrator sets `runtime_init_ready_` right after initializing the SM header — *before the task graph is fully built* (`src/{arch}/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp`, a5 ~L532) — and scheduler threads, which only wait on that flag (a5 ~L686), immediately enter `resolve_and_dispatch` and start dispatching while the orchestrator is still building the graph.

The new toggle makes scheduler threads instead wait until the orchestrator has **fully finished building the task graph** (`orchestrator_done_`, `scheduler_context.h` ~L144) before dispatching — i.e. strictly **serial orch → sche**. Default remains the current parallel/overlapped behavior (toggle off ⇒ zero behavior change).

> **Not a duplicate of `PTO2_ORCH_TO_SCHED`.** That existing flag (`host/runtime_maker.cpp` ~L435) makes orch threads *transition into schedulers* after orchestration finishes; it does not change when schedulers begin dispatching. This proposal is orthogonal: it changes the scheduler **start gate**, not the orch thread's post-completion role.

### Motivation / Use Case

We want to measure and reason about the performance impact of orch/sche overlap. Running the two phases serially gives:

- A clean baseline to quantify how much wall-clock the current pipelined overlap actually saves (or costs) per workload.
- A debugging/isolation mode where dispatch behavior is decoupled from in-flight graph construction, making orch-only vs sche-only costs separable.

The benchmark harness already reports Orch and Sched timings separately, so the data surface to evaluate this already exists — we just need the switch and a second benchmark pass.

### Proposed API / Behavior

- New behavior gate, mirroring the existing `orch_to_sched` plumbing end to end:
  - Host: read `PTO2_SERIAL_ORCH_SCHED` env in `host/runtime_maker.cpp` → set a new `Runtime::serial_orch_sched` field (default `false`).
  - Device: `aicpu_executor` reads the field; when set, scheduler threads wait on `orchestrator_done_` instead of the early `runtime_init_ready_` gate before calling `resolve_and_dispatch`.
- Applied to **both** `a2a3` and `a5` arches (runtime structs are parallel).
- Default off — existing workloads see no behavior or perf change.

> Per the repo's [env-macro-gating rule](.claude/rules/env-macro-gating.md), this adds a new behavior gate. It is requested here explicitly; implementation will land it default-off so current behavior is unchanged.

**Benchmark integration**

- Add a flag to `tools/benchmark_rounds.sh` (e.g. `--serial-orch-sched`) that injects `PTO2_SERIAL_ORCH_SCHED=1` into the benchmarked process.
- For each case in `TMR_EXAMPLE_ORDER`, run an **additional** pass in serial mode and report it alongside the default parallel mode, reusing the existing Host/Device/Total/Sched/Orch table and Delta/Change% comparison.

### Alternatives Considered

- **Reuse `PTO2_ORCH_TO_SCHED`** — rejected: it controls a different axis (orch→scheduler role transition after completion), not the scheduler start gate.
- **Always serialize** — rejected: would regress the overlap optimization for production workloads; the serial mode is for measurement/debugging, hence opt-in and default-off.

### Acceptance Criteria

- Default (toggle off): all existing cases unchanged in behavior and performance.
- Toggle on: device log orch/sched timestamps confirm sche starts only after orch completes.
- `benchmark_rounds.sh` emits parallel-vs-serial numbers for every case.
- Works on both `a2a3` and `a5`, sim + onboard.

### Additional Context

- Current commit: `abc62d86065163ea1640e1b3df36ea4ec12418f5`
- Key code: `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/aicpu/aicpu_executor.cpp`, `.../runtime/scheduler/scheduler_context.h`, `.../host/runtime_maker.cpp`, `.../runtime/runtime.h`; benchmark in `tools/benchmark_rounds.sh` + `.claude/skills/benchmark/SKILL.md`.
- Related: #984, #1146, #1103 (orchestrator/scheduler perf & profiling — different scope).

---

## #1165 [Feature] Raise compiled timeout defaults to production-friendly values; CI restores tight values via #1127 env overrides

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1165
- Created: 2026-06-26T02:26:59Z
- Updated: 2026-06-27T09:54:27Z
- Closed: 2026-06-27T09:54:27Z
- Labels: enhancement

### Body

### Summary

Once #1127 (env-overridable `PTO2_SCHEDULER_TIMEOUT_MS` / `PTO2_OP_EXECUTE_TIMEOUT_US` / `PTO2_STREAM_SYNC_TIMEOUT_MS`) merges, **raise the three compiled timeout defaults to larger, production-friendly values**, and have **CI restore today's tight fast-fail values via those env overrides**.

Net effect: the default (no-env) behavior becomes lenient for real serving workloads, while CI keeps detecting hangs quickly by dialing the timeouts back down through environment variables — no separate build.

Proposed new compiled defaults (a2a3 **and** a5):

| Constant | Where | Today | New default |
| --- | --- | --- | --- |
| `PLATFORM_ONBOARD_SCHEDULER_TIMEOUT_MS` (onboard scheduler no-progress) | `platform_config.h` (consumed via `onboard/aicpu/spin_hint.h`) | 2 s | **10 s** |
| `PLATFORM_OP_EXECUTE_TIMEOUT_US` (STARS op-execute) | `platform_config.h` | 3 s | **45 s** (`45000000`) |
| `PLATFORM_STREAM_SYNC_TIMEOUT_MS` (host stream-sync) | `platform_config.h` | 4 s | **50 s** (`50000`) |
| `PLATFORM_SCHEDULER_TIMEOUT_MS` (sim scheduler) | `sim/aicpu/spin_hint.h` | 5 s | **10 s** (parity) |

These satisfy the ordering rules #1127 enforces (`validate_runtime_timeout_order`): `scheduler < op-execute < stream-sync` **and** `stream-sync > scheduler + 1.5 s`. Check: `10 s < 45 s < 50 s` ✓ and `50 s > 10 + 1.5 = 11.5 s` ✓.

### Motivation / Use Case

The current 2 s / 3 s / 4 s chain was sized for short single-example tests. Real serving graphs (pypto-serving Qwen3-14B decode, 8192-token / DSv4 sparse attention, etc.) legitimately run far longer than a few seconds, and routinely trip false timeouts — `507018` AICore op-execute kills and AICPU scheduler no-progress aborts that are not actual hangs (cf. #1022 / #1070 long-sequence regressions).

The scheduler timeout is a **no-progress watchdog**, not a cumulative budget: `last_progress_ts` is reset to "now" on any task progress (`scheduler_dispatch.cpp`), so a 10 s budget only fires after a full 10 s window with **zero** progress. Bumping it to 10 s tolerates long single ops while still catching a true wedge in ~10 s.

Raising the **compiled defaults** (rather than expecting every serving deployment to export env vars) makes the out-of-the-box runtime robust for production. CI is the one place we *want* tight timeouts (fail fast on a genuine hang, don't waste device time), and #1127 gives us exactly the lever to keep CI tight without a separate build.

### Proposed API / Behavior

1. Change the four constants above to the new defaults (a2a3 + a5).
2. In `.github/workflows/ci.yml`, restore today's behavior with job-level `env:` blocks using the #1127 env overrides:
   - **Onboard jobs** (`st-onboard-a2a3`, `st-onboard-a5`, `ut-a2a3`, `ut-a5`):
     ```yaml
     env:
       PTO2_SCHEDULER_TIMEOUT_MS: "2000"
       PTO2_OP_EXECUTE_TIMEOUT_US: "3000000"
       PTO2_STREAM_SYNC_TIMEOUT_MS: "4000"
     ```
   - **Sim jobs** (`st-sim-a2a3`, `st-sim-a5`): only the scheduler applies (no STARS / stream-sync in sim):
     ```yaml
     env:
       PTO2_SCHEDULER_TIMEOUT_MS: "5000"
     ```
3. Verify the ordering validator accepts the CI env values against the new defaults (onboard `2000 < 3000000 < 4000` ✓; sim `5000` scheduler vs new op/stream defaults ✓).
4. **Documentation (must land in the same commit as the default change — `.claude/rules/doc-consistency.md` rule 4).** See the dedicated section below.

### Documentation requirement

After #1165 raises the defaults, **local / default runs become lenient (50 s stream-sync) — a genuine hang takes up to ~50 s to surface locally.** Users must be able to discover this and know they can dial it back down with the same three env vars CI uses. #1127 only adds a mechanism note buried in `docs/dfx/args-dump.md` §8 (a DFX debug FAQ, keyed to the old 2/3/4 s values) — not discoverable for a normal local run, and stale once defaults change.

Required doc work in this issue:

- **Update `docs/dfx/args-dump.md` §8** — the escalation-chain line `SCHEDULER_TIMEOUT_MS (2 s) < OP_EXECUTE (3 s) < STREAM_SYNC (4 s)` and the surrounding prose must reflect the new `10 s / 45 s / 50 s` (and sim scheduler 10 s). Otherwise the table lies.
- **Add a discoverable, user-facing note** (not only the debug FAQ) that: (a) local/default runs now use large timeouts so hangs surface slowly; (b) the three `PTO2_*_TIMEOUT_*` env vars dial them down (or up) without a rebuild; (c) CI sets them back to `2000 / 3000000 / 4000` (sim `5000`) as the reference "tight" config. Suggested home: a short `docs/troubleshooting/` entry ("my local run hangs ~50 s before erroring") and/or a tuning note linked from `docs/getting-started.md`, cross-linked to `docs/dfx/args-dump.md` §8 as the authority on the ordering rules.
- Grep-audit other docs that hardcode the old values: `docs/investigations/2026-06-pa-unroll-207001-optimeout-window.md` and `docs/investigations/2026-06-cross-task-batched-publish.md` reference `PLATFORM_OP_EXECUTE_TIMEOUT_US` 3 s / `PLATFORM_STREAM_SYNC_TIMEOUT_MS` 4 s — confirm whether they describe a historical measurement (leave as-is, dated) or a current contract (update).

### Alternatives Considered

- **Keep defaults tight, require serving to export env vars.** Rejected: every deployment then has to remember the knob; the out-of-the-box runtime stays footgun-prone for exactly the large-graph case that needs it most.
- **Raise defaults, leave CI on the big values.** Rejected: CI would take up to ~50 s to surface a real hang and burn shared device time — the whole point of keeping CI tight.

### Additional Context

- **Blocked on #1127** (the env-override mechanism) merging first — this issue only changes the default values, wires the CI overrides on top of it, and documents the new lenient local default.
- Related: #1112 (original request for env-overridable timeouts; #1127 implements it).
- Scope: a2a3 + a5, `tensormap_and_ringbuffer`. Per `.claude/rules/env-macro-gating.md`, no new gates are introduced here — this reuses the env vars already signed off in #1112/#1127.

---

## #1170 st-sim-a5 broken on main: test_l3_l2_orch_comm omits mandatory arg_index (#1015 × #1123 merge skew)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1170
- Created: 2026-06-26T07:05:39Z
- Updated: 2026-06-26T08:44:57Z
- Closed: 2026-06-26T08:44:57Z

### Body

## Summary

`st-sim-a5` fails on **every** PR that merges against current `main`, because a newly-added test calls `CoreCallable.build` without the now-mandatory `arg_index`.

```
FAILED tests/st/a5/tensormap_and_ringbuffer/l3_l2_orch_comm/test_l3_l2_orch_comm.py::test_closed_loop_payload_signal_path_while_l2_task_is_in_flight
  - ValueError: CoreCallable.build: arg_index is required and must be parallel to signature (equal length)
```

Reproduces on pristine `main` HEAD (`815822cc`) — independent of any PR.

## Root cause (merge skew)

- **#1123** (`b972b288`, "Fix: attribute dumped tensors per-subtask via mandatory arg_index") made `arg_index` **mandatory** on `CoreCallable.build` / `make_callable` and removed the contiguous fallback. It migrated ~250 call sites.
- **#1015** (`815822cc`, current `main` HEAD, "Add: L3-L2 orchestration communication design") added `test_l3_l2_orch_comm.py` whose `CoreCallable.build(signature=[D.IN, D.OUT], binary=aiv)` (line 70) **omits `arg_index`**.

#1015 was developed in parallel and merged after #1123's sweep, so this one new call site never got migrated. `python/bindings/task_interface.cpp:395` then raises at build time.

## Evidence

- Failing run: https://github.com/hw-native-sys/simpler/actions/runs/28221961100/job/83605080790
- Binding that raises: `python/bindings/task_interface.cpp:395`
- Offending call: `tests/st/a5/tensormap_and_ringbuffer/l3_l2_orch_comm/test_l3_l2_orch_comm.py:70`

## Fix

Declare the explicit slot mapping (parallel to signature), as every other migrated incore does:

```python
CoreCallable.build(signature=[D.IN, D.OUT], arg_index=[0, 1], binary=aiv)
```

A fix PR is open: see linked PR below.

---

## #1174 [Code Health] Local pto-isa clone defaults to origin/HEAD, ignoring pto_isa.pin; define commit-resolution precedence

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1174
- Created: 2026-06-27T01:56:25Z
- Updated: 2026-06-30T11:50:32Z
- Closed: 2026-06-30T11:50:32Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Build System

### Description

`pto_isa.pin` (repo root, a bare 40-char SHA) is the intended single source of truth for the PTO-ISA revision, but it is consumed **only by CI**. A repo-wide grep for readers of `pto_isa.pin` across `*.py`, `*.cmake`, `CMakeLists.txt`, `*.toml` returns exactly one hit: `.github/actions/read-pto-isa/action.yml`. No Python or CMake build code reads it.

As a result, a plain local `pip install .` + `pytest` **diverges from CI**: it clones the pto-isa default branch and, on the test path, runs `git fetch origin` + `git reset --hard origin/HEAD` on every invocation — i.e. it tracks **latest**, not the pinned commit. A previously-pinned local `build/pto-isa` clone is even reset back to latest on the next `pytest` run.

This is the local-build counterpart of #1077 (which fixed the CI-side build-vs-test divergence) and is adjacent to #1106 (build/run revision compatibility validation). #1077 explicitly left local builds out of scope.

Concretely, with no env var / CLI override:
- Build: `CMakeLists.txt` defaults `SIMPLER_PTO_ISA_COMMIT` to empty, so `--pto-isa-commit` is never passed to `build_runtimes.py` → `ensure_pto_isa_root(commit=None)` → `_clone()` skips `git checkout`.
- Test: `conftest.py` defaults `--pto-isa-commit` to `None` with `update_if_exists=True` → `_update_to_latest()` → `git reset --hard origin/HEAD`.

The desired behavior: the **default** (no override anywhere) should resolve to the commit in `pto_isa.pin`, so local build+test matches CI out of the box. Explicit overrides must still win.

### Requested precedence (highest wins)

1. `PTO_ISA_ROOT` (points to a user-managed checkout) — used as-is; the user owns the revision. *(unchanged from today)*
2. Explicit CLI `--pto-isa-commit <sha>` / API arg.
3. `SIMPLER_PTO_ISA_COMMIT` environment variable.
4. **NEW default:** the commit recorded in `pto_isa.pin`.
5. Explicit opt-out to latest: `--pto-isa-commit latest|head|none` (or the env equivalent) keeps the current `origin/HEAD` behavior — only when explicitly asked.

Open sub-questions for the implementer:
- Relative ordering of #2 vs #3 (CLI vs env) — proposed CLI > env; confirm.
- When `pto_isa.pin` is absent (e.g. a downstream checkout without the file), fall back to latest with a warning, rather than hard-failing.
- Whether `PTO_ISA_ROOT` should warn when its HEAD doesn't match `pto_isa.pin` (validation already exists via `validate_runtime_pto_isa_compatible`, but only against build metadata).

### Location

- \`pto_isa.pin\` (repo root) — the pin, currently CI-only
- \`.github/actions/read-pto-isa/action.yml\` — sole reader today
- \`simpler_setup/pto_isa.py:43\` — \`resolve_pto_isa_commit()\` returns \`None\` when nothing is requested (the place to add the pin fallback)
- \`simpler_setup/pto_isa.py:318\` — \`_update_to_latest()\` (\`git reset --hard origin/HEAD\`)
- \`simpler_setup/pto_isa.py:331\` — \`ensure_pto_isa_root()\` resolution entry point
- \`CMakeLists.txt:44\` — \`SIMPLER_PTO_ISA_COMMIT\` defaults to empty
- \`conftest.py:201\` — \`--pto-isa-commit\` defaults to \`None\`

### Proposed Fix

Make `resolve_pto_isa_commit()` (or a small helper it calls) read `pto_isa.pin` as the default when no explicit commit is requested, returning that SHA instead of `None`. Add a single `read_pto_isa_pin()` helper anchored to `PROJECT_ROOT` so both the build path (`CMakeLists.txt` / `build_runtimes.py`) and the test path (`conftest.py`) share one source of truth. Preserve the explicit `latest`/`head`/`none` opt-out for tracking HEAD. This centralizes the precedence in one function rather than scattering defaults across CMake, conftest, and the env-action.

### Priority

Medium (minor risk, should fix in next few releases)

---

Related: #1077, #1106

---

## #1180 [Feature] Sub-classify AICPU scheduler no-progress timeout (code 100) and propagate device error type to host

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1180
- Created: 2026-06-27T09:00:59Z
- Updated: 2026-06-30T01:40:08Z
- Closed: 2026-06-30T01:40:08Z
- Labels: enhancement

### Body

### Summary

Today every device-side failure that surfaces as the AICPU scheduler
no-progress timeout is latched as a single generic code
`PTO2_ERROR_SCHEDULER_TIMEOUT` (= 100), via the `global_stuck` latch in
`scheduler_dispatch.cpp:914`
(`!self_owns && total_tasks_>0 && completed_tasks_ < total_tasks_ && no_thread_owns_running_task()`).
This one code collapses several **distinct** device error conditions that the
host cannot tell apart. The diagnostic data needed to distinguish them is
**already computed** by `log_stall_diagnostics`
(`scheduler_cold_path.cpp:235`) — but it only goes to the device log, never
to host.

Proposal: at `handle_timeout_exit` (`scheduler_cold_path.cpp:371`), classify
the stall into a small set of sub-reasons using state the scheduler already
has, and propagate that sub-reason to host as a `detail` field alongside the
existing code 100 (top-level code unchanged ⇒ backward compatible). The host
already reads `orch_error_code` / `sched_error_code` once in
`validate_runtime_impl` (`host/runtime_maker.cpp:611`) and prints a single
`LOG_ERROR` line; extend that line with the sub-reason + a few locator fields.

The goal is **letting the host distinguish device error TYPES** — not shipping
all device logs to host. Only one small int (+ a handful of locator values)
crosses the boundary; the full snapshot stays in the device log / plog.

### Motivation / Use Case

`PTO2_ERROR_SCHEDULER_TIMEOUT` (and, when the host op-execute / stream-sync
watchdog wins the race first, the generic CANN `507018`) is the catch-all that
hides genuinely different root causes with different owners:

- an **AICore that silently hung** (no hardware trap raised) — owner: AICore / kernel
- a **fanin-only-satisfied task that never dispatches** — owner: dispatch loop / sync-start
- a **dependency deadlock** (everything blocked on fanin that never arrives) — owner: dep graph wiring
- **scheduler starvation** because the orchestrator never delivered the rest — owner: orchestrator
- an **internal accounting/corruption inconsistency** — owner: runtime bookkeeping

Right now triaging which of these fired requires hand-reading
`~/ascend/log/debug/.../device-*.log`. Surfacing the category on the host
turns a multi-minute log dive into a glance at the failure line, and gives CI
a machine-readable device-error class.

This is explicitly scoped to **AICPU-software-detectable** stalls. AICore
*hardware traps* (UB-misalignment `0x800`, illegal address, etc.) are caught
by the CCECPU fault path and already reported through CANN/plog — they never
enter our `orch_error_code` / `sched_error_code` software channel and are out
of scope here (CANN owns them). The case this issue covers is the AICore
*silent hang* (no trap), which only our no-progress watchdog ever observes.

### Proposed API / Behavior

Classify by priority `RUNNING > READY > WAIT > empty`, reducing the multi-state
snapshot to one dominant label. All inputs already exist at timeout
(`cnt_running / cnt_ready / cnt_waiting`, `completed_tasks_ / total_tasks_`,
header `orchestrator_done`):

```
if cnt_running > 0:                                   -> S1  RUNNING-stalled
elif cnt_ready  > 0:                                  -> S3  ready-but-all-idle
elif cnt_waiting> 0:                                  -> S4  dependency-deadlock
else:  # three buckets all zero
    if !orchestrator_done:                            -> S5  orchestrator-starvation
    else:                                             -> unknown (accounting/corruption)
```

| sub-class | meaning | likely owner |
| --------- | ------- | ------------ |
| **S1** RUNNING-stalled | a task is on a core but never completes | AICore stuck / over-long kernel |
| **S3** ready-but-all-idle | all cores idle, a fanin-satisfied task exists, nothing dispatched | dispatch loop / sync-start gate (`scheduler_dispatch.cpp:304`) |
| **S4** dependency-deadlock | only WAIT tasks remain, fanin never resolves | dep graph wiring / cycle |
| **S5** orchestrator-starvation | all submitted tasks done, orch not done, scheduler idle | orchestrator upstream stall |
| **unknown** | premise/bookkeeping invariant violated | runtime-internal bug (dump full snapshot) |

Notes / boundary conditions found while scoping this:

- **S2 (lost-completion-handshake) was dropped as unobservable.** `is_*_core_idle`
  reads `core_states_`, the same AICPU bookkeeping that is flipped together with
  `running_slot_state` (`scheduler_dispatch.cpp:158` set / `scheduler_completion.cpp:235`
  clear). So "core idle but slot still RUNNING" cannot occur — a lost completion
  shows up as S1, not a separate class.
- **S3, after narrowing, needs no shape-eligibility check.** It is reached only
  when `cnt_running==0`, which (by the same coupling) implies *all* cores idle,
  so there is never a "no matching free cluster" excuse. The residual ambiguity
  is only attribution (dispatch loop vs `requires_sync_start` hold), not a false
  positive.
- **The `unknown` bucket condition** (`three buckets all zero ∧ orchestrator_done ∧ completed_tasks_ < total_tasks_`)
  decomposes into ~3 families / ~7 concrete mechanisms: (A) declared total >
  actually-submitted (`total_tasks_` overcount at `scheduler_cold_path.cpp:956`,
  or a lost submission), (B) counter undercount on a *decoupled* path
  (async/SDMA `scheduler_dispatch.cpp:691`; `inline_completed` fold
  `scheduler_cold_path.cpp:1062`; counter reset race
  `scheduler_cold_path.cpp:960/1009`), (C) corrupted premise (ring-index or
  torn `task_state` read making the scan falsely report "all done"). Core/DUMMY
  undercounts are *excluded* — their count is coupled to state-transition, so
  they manifest as S1, not unknown.

Encoding: keep top-level `sched_error_code = 100`; add a `sched_error_detail`
(or reuse spare header space) carrying the sub-class enum. Also carry a few
locator fields (`completed/total`, `orchestrator_done`, the three raw counts,
and for S1 the stuck `task_id`/`core`) so the host failure line is
self-diagnosing even for `unknown`. Full snapshot remains device-log / plog
only.

### Alternatives Considered

- **Brand-new top-level error codes per condition.** Rejected: breaks the clean
  "scheduler errors are 100+" contract and the host `runtime_status_from_error_codes`
  mapping, and is not backward-compatible. A sub-reason `detail` field keeps
  code 100 stable.
- **Ship the full stall diagnostic to host.** Rejected: violates the "device log
  stays on device, only a code crosses" boundary and bloats the host path. Only
  the category + a few locators need to cross.
- **Do nothing / keep reading the device log.** That is the status quo; it costs
  a per-incident log dive and gives CI no structured device-error class.

### Additional Context

- Single host-visible channel: `PTO2SharedMemoryHeader.{orch_error_code, sched_error_code}`
  (`runtime/pto_shared_memory.h:137-147`); codes defined in
  `common/pto_runtime_status.h`.
- a2a3 and a5 are identical in this path; the fix should land in both.
- Interacts with the host-side watchdog race: if op-execute / stream-sync
  timeout fires before the AICPU no-progress watchdog, code 100 (and any
  sub-detail) is never latched and the host only sees generic `507018`. Raising
  the device-side timeout so the AICPU detector wins is tracked separately
  (see #1165). This issue is about *what* gets reported once the AICPU detector
  does win.
- Related: #959 (surfaces `sched_error_code=100` for a dep_pool deadlock; would
  benefit from this sub-classification but does not request it).
- File refs above are a5; identical lines exist under `src/a2a3/...`.

---

## #1188 [Code Health] scope_tasks_cap hard-wired to compile-time window — undersized when ring_task_window is enlarged

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1188
- Created: 2026-06-29T06:25:51Z
- Updated: 2026-06-29T08:50:43Z
- Closed: 2026-06-29T08:50:43Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Orchestration

### Description

`scope_tasks` is a single buffer that tracks **every task in the open scope
across all rings**; its capacity is meant to equal the total in-flight slot
budget. But `PTO2OrchestratorState::reserve_layout` sets it from the
**compile-time** macro, ignoring the per-ring `task_window_sizes[]` it already
receives (and uses to size the rings, tensor map, and fanin buffers):

```cpp
layout.scope_tasks_cap = PTO2_SCOPE_TASKS_CAP;  // = PTO2_TASK_WINDOW_SIZE * PTO2_MAX_RING_DEPTH = 16384 * 4 = 65536
```

`ring_task_window` is a runtime override validated only as "power of 2 in
`[4, INT32_MAX]`" (`call_config.h:89`) — there is **no clamp to the compile-time
default**, so it can be set well above 16384. The two failure directions:

- **Enlarged window (the dangerous one).** Set `ring_task_window = 32768`: the
  rings now hold `4 * 32768 = 131072` in-flight tasks, but `scope_tasks_cap`
  stays **65536**. A scope that submits more than 65536 tasks — which the
  enlarged rings now permit — overflows `scope_tasks` and latches
  `SCOPE_TASKS_OVERFLOW (10)` **prematurely**, even though the rings have room.
  The enlarged window silently fails to deliver its configured capacity, and the
  user gets a confusing scope-tasks-overflow instead. (Not memory corruption —
  `scope_tasks_push` checks the bound — but a false/early failure.)
- **Shrunk window.** Set `ring_task_window = 4`: rings hold `4 * 4 = 16`, but
  `scope_tasks` is still reserved for 65536 entries — harmless over-allocation of
  device arena.

The invariant that *should* hold — `scope_tasks_cap == sum(task_window_sizes)` —
is broken in both directions; only the compile-time default happens to match.

Found while extending the issue #1180 negative-test coverage.

### Location

- `src/a5/runtime/tensormap_and_ringbuffer/runtime/shared/pto_runtime2_init.cpp:232`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/shared/pto_runtime2_init.cpp` (same line)
- macro: `runtime/pto_runtime2_types.h` (`PTO2_SCOPE_TASKS_CAP`)
- runtime override validated (no upper clamp) at `src/common/task_interface/call_config.h:89`

### Proposed Fix

Derive the cap from the runtime windows the function already has, so it tracks
the real budget in both directions:

```cpp
int32_t cap = 0;
for (int r = 0; r < PTO2_MAX_RING_DEPTH; r++) cap += task_window_sizes[r];
layout.scope_tasks_cap = cap;
```

With the default window this is still 65536; an enlarged window grows the cap to
match the rings (no premature overflow), and a shrunk window shrinks it (no
over-allocation). Apply to both arches; add an ST that enlarges `ring_task_window`
and submits past the old 65536 cap to lock in the enlarged-window path.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1189 [Code Health] PTO2_TENSOR_DATA_TIMEOUT_CYCLES is raw cycles, not frequency-scaled (20x arch skew)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1189
- Created: 2026-06-29T06:26:59Z
- Updated: 2026-06-29T08:50:16Z
- Closed: 2026-06-29T08:50:16Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Orchestration

### Description

`PTO2_TENSOR_DATA_TIMEOUT_CYCLES` (the deadline used by the orchestrator's
tensor-data wait, e.g. `get_tensor_data` waiting for a producer) is hard-coded
to **15e9 raw counter cycles**, identically in both arches:

```cpp
// runtime/pto_runtime2_types.h (a2a3 and a5)
constexpr uint64_t PTO2_TENSOR_DATA_TIMEOUT_CYCLES = 15 * 1000 * 1000 * 1000ULL;
```

This is the **only deadline in the runtime expressed as a raw cycle literal**.
Every other timeout/deadline is either a time unit or frequency-derived:

| constant | how it is expressed |
| -------- | ------------------- |
| `SCHEDULER_TIMEOUT_CYCLES` | `SCHEDULER_TIMEOUT_MS * (PLATFORM_PROF_SYS_CNT_FREQ / 1000)` — ms, FREQ-scaled |
| `PTO2_ALLOC_DEADLOCK_TIMEOUT_CYCLES` | `PLATFORM_PROF_SYS_CNT_FREQ / 2` — i.e. 500 ms, FREQ-derived |
| `PLATFORM_OP_EXECUTE_TIMEOUT_US` / `PLATFORM_STREAM_SYNC_TIMEOUT_MS` / `PLATFORM_*_TIMEOUT_SECONDS` | time units |
| **`PTO2_TENSOR_DATA_TIMEOUT_CYCLES`** | **15e9 raw cycles — ignores frequency** |

Because the AICPU system counter (`get_sys_cnt_aicpu`, CNTVCT_EL0) runs at very
different rates per arch — `PLATFORM_PROF_SYS_CNT_FREQ` is **1 GHz on a5** but
**50 MHz on a2a3** — the same raw constant means very different wall-clock:

| arch | counter freq | 15e9 cycles |
| ---- | ------------ | ----------- |
| a5   | 1 GHz        | **15 s**    |
| a2a3 | 50 MHz       | **~300 s (5 min)** |

A 20x skew for the same logical deadline. On a2a3 a stuck producer holds for 5
minutes before `TENSOR_WAIT_TIMEOUT` fires, which is almost certainly not the
intent.

Found while extending the issue #1180 negative-test coverage; this skew is also
why an e2e test for `TENSOR_WAIT_TIMEOUT` (code 8) is currently a5-only.

### Location

- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2_types.h:105`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2_types.h:102`
- consumed at `runtime/pto_runtime2.cpp:120,148` (`wait_one_producer` / `wait_one_consumers`)
- existing patterns to follow: `runtime/scheduler/scheduler_types.h:72-74` (SCHEDULER_TIMEOUT_*),
  `runtime/pto_ring_buffer.h:61` (PTO2_ALLOC_DEADLOCK_TIMEOUT_CYCLES); freq in
  `src/{a2a3,a5}/platform/include/common/platform_config.h` (`PLATFORM_PROF_SYS_CNT_FREQ`)

### Proposed Fix

Express the deadline in **time** and derive the cycle count from the platform
counter frequency, exactly like the other deadlines already do — do **not** keep
it as raw cycles (and do not paper over it with a per-arch cycle literal). E.g.:

```cpp
constexpr uint64_t PTO2_TENSOR_DATA_TIMEOUT_MS = 15000;  // 15 s, intent in time
constexpr uint64_t PTO2_TENSOR_DATA_TIMEOUT_CYCLES =
    PTO2_TENSOR_DATA_TIMEOUT_MS * (PLATFORM_PROF_SYS_CNT_FREQ / 1000);
```

This mirrors `SCHEDULER_TIMEOUT_CYCLES` / `PTO2_ALLOC_DEADLOCK_TIMEOUT_CYCLES`,
removes the lone raw-cycle outlier, and makes both arches reap at the same
wall-clock. Apply to both arches; then the code-8 e2e test can drop its a5-only
restriction (15 s on both).

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1197 [Code Health] Teardown ordering: release RTS resources before aclFinalize (load_aicpu_op_ stopgap is ad-hoc)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1197
- Created: 2026-06-29T11:59:11Z
- Updated: 2026-06-30T01:40:08Z
- Closed: 2026-06-30T01:40:08Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Platform (a2a3 / a2a3sim)

### Description

The onboard `DeviceRunner` teardown has a structural **ordering hazard**: an RTS
interface gets called *after* the RTS/ACL context is torn down.

- `aclFinalize` (which tears down the RTS/ACL context) runs inside the **derived**
  `DeviceRunner::finalize()` (a2a3/a5 `device_runner.cpp`); the error path's
  `force_reset_device()` also does `aclrtResetDeviceForce` + `aclFinalize`.
- But RTS-holding objects like `load_aicpu_op_` (`host::LoadAicpuOp`) are
  **base-class members** of `DeviceRunnerBase`. By C++ destruction rules, a base
  member's destructor runs **after** the derived `finalize()` completes — i.e.
  **after** `aclFinalize`.
- `~LoadAicpuOp()` calls `rtsBinaryUnload(binary_handle_)` on an already-torn-down
  RTS handle. **a5's driver segfaults** at process exit; a2a3's driver tolerates
  the call (the UB happened to no-op), which is why it stayed hidden.
- Only manifests on the path that calls `aclFinalize` — the error / force-reset
  path that the device-error negative STs exercise. The common rt-path only does
  `rtDeviceReset` (no `aclFinalize`), so the late unload is benign there.

**Current state (stopgap shipped with #1180):** `finalize_common()` now calls
`load_aicpu_op_.Finalize()` explicitly (before `aclFinalize`, while RTS is live),
which unloads and nulls `binary_handle_`, so the later `~LoadAicpuOp` `Finalize()`
no-ops. This is a **point-fix for one member** and does not fix the underlying
invariant: explicit-Finalize + idempotent-destructor is awkward, and any other
base-class member whose destructor touches an RTS/ACL/`rt*` API after `finalize()`
would hit the same crash.

### Location

- `src/common/platform/onboard/host/device_runner_base.cpp` — `finalize_common()`, the `load_aicpu_op_.Finalize()` stopgap
- `src/common/platform/onboard/host/device_runner_base.h` — `load_aicpu_op_` is a base member (`~line 766`)
- `src/common/aicpu_loader/host/load_aicpu_op.cpp:~226,241` — `~LoadAicpuOp` -> `Finalize` -> `rtsBinaryUnload`
- `src/a2a3/platform/onboard/host/device_runner.cpp` — `finalize()` (`finalize_common` then `aclrtResetDevice`/`aclFinalize`), `force_reset_device()` (`aclrtResetDeviceForce` + `aclFinalize`); same under `src/a5/`

### Proposed Fix

Establish and enforce the invariant: **device reset / `aclFinalize` is the LAST
teardown step; every RTS-using resource is released before it; no destructor calls
an RTS interface after the RTS context is destroyed.** Options to evaluate:

- (a) Re-structure so `aclFinalize` / device-context teardown runs *after* all
  RTS-using members are destroyed (own/order the device teardown last), or
- (b) Remove RTS calls from destructors entirely — destructors do pure C++ cleanup
  only, all RTS release is explicit in `finalize_common()`. This also removes the
  stopgap's double-`Finalize()` awkwardness.

Either way, audit all `DeviceRunnerBase` members (streams, `LoadAicpuOp`,
`mem_alloc_`, the arenas, `aicore_bin_handle_`, ...) for RTS-touching destructors.
Once the invariant holds, the `load_aicpu_op_` stopgap can be simplified/removed.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1202 [Code Health] fully_distributed_within_core: alloc 单owner选举修复 heap 回收下溢；遗留精确依赖与 TensorMap overlap 待完善

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1202
- Created: 2026-06-30T03:02:22Z
- Updated: 2026-06-30T03:02:22Z
- Labels: code health

### Body

关联 PR：#1142（`fully_distributed_within_core` runtime）。

## 背景

在 a2a3sim 上对 `fully_distributed_within_core` 做大规模验证（paged_attention_unroll，batch≥16，`--use-example-exec-time` busy-wait 回放路径）时，`dist_alloc_tensors` 会随机 SIGABRT。本 issue 记录已修复的根因与重构，并提出两点仍需完善的遗留问题。

## 已修复：alloc 缺少 single-owner 选举导致 heap 回收水位线无符号下溢

### 现象
- a2a3sim、batch≥16、busy-wait 回放（`--use-example-exec-time`）下随机崩溃；OFF（真跑 kernel）与 tmr 同用例均不复现。
- 表象是下游 `get_ref` 的 `always_assert(index < output_count_)` 失败 → terminate → SIGABRT。

### 根因
heap reclaim back-pressure 用了**无符号减法** `heap_next - vend[F-H]` 判断 live window 是否超过 ring。`dist_alloc_tensors` 此前由**每个 core 无条件重放**（不像 `dist_submit_impl` 有 `is_winner` 选举），因此当某个 core 的重放进度落后全局完成前沿 `F` 超过 `H` 个 task 时，会出现 `heap_next < vend[F-H]`，无符号减法回绕到约 `2^64` → 误判 "heap ring too small" → `set_fatal()`，随后 alloc 返回空 `TaskOutputTensors{}`，下游 `get_ref` 即断言失败崩溃。

只有 busy-wait 回放路径在 batch≥16 触发：真跑 kernel 时各 core 的完成前沿足够接近，没有 core 会落后超过 `H`。

### 修复（已在 PR #1142 重构）
给 `dist_alloc_tensors` 引入与 `dist_submit_impl` 相同的 single-owner 选举：
- materialize 输出 + producer-map 登记仍**每核执行**（保持确定性重放一致）；
- 之后用一条新的 `alloc_cursor` 做 claim 选出唯一 owner；
- **只有该 owner 执行 reclaim back-pressure 并发布完成标志**。

owner 必然处于/领先于完成前沿（它认领的 task 尚未完成，故 `F < N`），因此 window 减法不再可能下溢，无需额外的算术保护。把 materialize 提前到（现在仅 owner 执行的）back-pressure 之前，也使真正的 fatal 返回已物化的 result，而非此前会触发断言的空 result。

---

## 遗留待解决（可能已在设计文档中作为 feature/limitation 提出）

### 1. 依赖跨度用常数 H 近似，需要精确依赖 + 配套的内存复用管理

当前用依赖跨度上界 `H`（`kHDefault=64`，`PTO_DIST_H` 覆盖）来界定"某 producer 的最后消费者 id ≤ producer id + H"，并据此推导 reclaim 水位线 `R = F - H`（见 `docs/fully_distributed_within_core.md` §依赖跨度/回收）。但实际 task 的依赖跨度可以很大且差异显著，常数 H 只是保守近似：
- H 取小 → 可能在真实消费者读取前就回收了 producer 的堆区（运行期 fatal "heap span exceeded"）；
- H 取大 → live window 占用过多 ring、削弱回收效率。

需要**精确的 per-task 依赖区间**（而非全局常数），以及与之配套的**内存复用/回收管理机制**，让回收水位线按真实依赖推进。

### 2. TensorMap.lookup 的 overlap 判断过于简单，且只返回单个前驱（无法支持 partial update 的多前驱）

`dist_engine.cpp` 的 `MapEntry::lookup`：
- overlap 判断仅为简单区间相交 `lo < e.hi && e.lo < hi`；
- 每个 tensor 只返回 **MAX（最新）的一个** overlapping producer（`return best`）。

但在 **partial update** 场景下，一个 INPUT/INOUT 区域可能由**多个**前驱分别写入其不同子区间，正确的 fan-in 应解析出**全部**相关 producer，而非只取最新一个，否则依赖图不完整、可能在前驱未完成时就执行消费者。

建议**参照 `tensormap_and_ringbuffer`（tmr）的 overlap 逻辑**完善：采用 tmr 的区域重叠判定方式，并让 lookup 支持返回多个 partial 前驱。

相关代码：
- `src/a2a3/runtime/fully_distributed_within_core/runtime/dist_engine.cpp`（`MapEntry::lookup`、`dist_alloc_tensors`、reclaim back-pressure）
- 参考：`src/a2a3/runtime/tensormap_and_ringbuffer/runtime/`（overlap / 多前驱解析）

---

## #1205 [Code Health] CI resource failures only surface as task-submit exit=1

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1205
- Created: 2026-06-30T07:27:20Z
- Updated: 2026-07-02T01:04:38Z
- Closed: 2026-07-02T01:04:38Z

### Body

### Category

Robustness (potential edge-case failure)

### Component

Tests

### Description

`st-onboard-a5` can fail with only a top-level `task-submit` / process exit message, while the visible pytest summaries near the end are passing. This makes it hard to identify which Resource-phase child pytest job actually failed.

Example run/job:

- Run: https://github.com/hw-native-sys/simpler/actions/runs/28419102475
- Job: https://github.com/hw-native-sys/simpler/actions/runs/28419102475/job/84214065249
- Failing job: `st-onboard-a5`
- Failing step: `Run pytest scene tests (a5)`
- Runner: `a5ci8p`, machine `179-147-21-11`

Observed tail:

```text
--- L2 host_build_graph: PASS ...
--- L2 tensormap_and_ringbuffer: PASS ...
...
[npu-lock] 已释放设备 4 5 的锁
=== 任务失败 (exit=1) ===
Process completed with exit code 1.
```

This does **not** look like a CI-machine failure: the self-hosted runner started successfully, checkout/setup/build succeeded, device locks were acquired and released cleanly, and the job was not cancelled or timed out. The failure appears to come from inside the `task-submit`-wrapped pytest command.

The relevant workflow command is:

```bash
PYTEST="python -m pytest examples tests/st --platform a5 --device ${DEVICE_RANGE} -v --clone-protocol ssh --require-pto-isa"
task-submit --timeout 1800 --max-time 1800 --device "$DEVICE_LIST" --run "$PYTEST --pto-session-timeout 1200 --pto-isa-commit ..."
```

The root pytest dispatcher runs a Resource phase for L3 / standalone resource-marked tests and collects child pytest results via `parallel_scheduler.run_jobs(...)`. If a child returns non-zero, the parent marks the session failed, but the actionable failure detail is only printed inside the per-child GitHub group. When the Actions log is collapsed/truncated, the top-level failure has no clear child label or useful tail.

In the referenced run, the visible Resource phase began with standalone worker tests and 2-device allreduce variants. The log shows allreduce `onephase` and `ring` passing before the middle of the Resource-phase output is truncated in the fetched job log, so the exact failing child is not obvious from the final Actions view.

This issue is about CI observability and failure surfacing. It does not assert that the underlying test failure is a CI-machine problem. The referenced PR also changed prepared-callable behavior so that `TASK_READY` now requires prior `_CTRL_PREPARE`; that may be related to the actual child failure, but the immediate issue is that the failed child is not visible from the top-level CI result.

### Location

- `.github/workflows/ci.yml` — `st-onboard-a5`, `Run pytest scene tests (a5)` wraps pytest in `task-submit`
- `conftest.py` — `_dispatch_test_phases(...)` Resource phase uses `parallel_scheduler.run_jobs(...)`
- `conftest.py` — `_emit_group(...)` prints child output inside collapsible GitHub groups
- `conftest.py` — final `session.testsfailed = 1 if (resource_failed or l2_failed) else 0` marks the parent failed without an uncollapsed Resource failure summary
- `simpler_setup/parallel_scheduler.py` — `JobResult` already carries `label`, `returncode`, `device_ids`, `output`, and `duration_s`; enough information exists to summarize failed children

### Proposed Fix

Improve Resource phase failure reporting in `conftest.py`:

1. Keep collecting `JobResult`s from `parallel_scheduler.run_jobs(...)` as today.
2. After the Resource phase completes, if any result has `returncode != 0`, print an uncollapsed summary outside any GitHub group.
3. Emit a GitHub Actions annotation for each failed child, for example:

```text
::error title=Resource phase failed::<label> rc=<returncode> devices=<devices>
```

4. Include the last 50-100 lines of the failed child output outside the collapsed group, or at minimum print the failing child labels and tell the reader which group to expand.

A minimal shape could be:

```text
*** Resource phase failed: 1 child job(s) ***
- standalone test_xxx (rt=..., dev=...): rc=1 devices=[...]
  tail:
  ...
```

This would make hardware Resource failures actionable from the job tail without requiring manual log archaeology.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1209 [Bug] runtime_fatal_codes a5 ST: CANN driver exit-time SIGSEGV (libascend_trace/HDC/URMA race) after test passes

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1209
- Created: 2026-06-30T08:29:48Z
- Updated: 2026-06-30T08:32:32Z
- Labels: bug

### Body

### Platform

a5 (Ascend 950 hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

The `runtime_fatal_codes` ST suite (`test_device_error_class_reaches_host_log`,
the onboard a5 negative-path cases) intermittently fails CI with the subprocess
exiting on **SIGSEGV (`rc=-11`)** even though pytest itself reports `1 passed`.

The crash is **not** in simpler code and **not** in the test logic. It is a
**process-exit-time use-after-free inside the closed-source CANN / Ascend driver
stack** (`libascend_trace` → `libascend_hal` → `liburma` → `libummu`). The test
assertions complete successfully *first* (`1 passed`); the segfault happens
afterward, during interpreter teardown, in a CANN background thread racing the
main thread's `exit()`.

This issue is a **record / tracking entry**: the triggering parametrized case
has already been removed from mainline (the suite was thinned). It is filed to
preserve the full root-cause analysis, the native backtrace, and the
reproduction conditions for (a) reporting upstream to the CANN/driver team and
(b) anyone who re-introduces these negative-path cases later.

### Steps to Reproduce

```markdown
The crash is a probabilistic process-exit race; reproduction rate scales with
**concurrency**, not with the number of cases run.

Faithful CI repro (reproduces ~3 of 5 rounds on an a5 box):

1. Hold 2 a5 devices via task-submit (CI runs the a5 onboard st suite on 2
   devices — `--device 4-5` on this runner — with scheduler
   `max_parallel = device_count = 2`, so two case subprocesses run AND exit
   concurrently; the specific device numbers do not matter, only that two
   processes are concurrent):

   task-submit --device auto --device-num 2 \
     --run "for r in 1 2 3 4 5; do \
              python -m pytest tests/st/runtime_fatal_codes \
                --platform a5 --device \$TASK_DEVICE -q; \
            done"

2. Watch for `FAIL rc=-11` / a subprocess killed by signal 11. pytest still
   prints `1 passed` for the case body; only the process *exit* segfaults.

Negative control (does NOT reproduce — confirms concurrency is the amplifier):
running the cases one-by-one, single device, serially gave 0 SIGSEGV in 30
consecutive process exits on the same (idle) box.

Capturing the native stack (core is owned by root via taskqueue.service):

  coredumpctl dump <pid> --output=/tmp/c.core
  gdb -q <python> /tmp/c.core --batch -ex 'thread apply all bt'
```

### Expected Behavior

The fatal-code negative-path cases assert that the device error class reaches
the host log, then the worker tears down cleanly and the process exits 0.
Process teardown after a successful assertion should not segfault.

### Actual Behavior

pytest reports the case passed, then the **process** dies with SIGSEGV during
exit. The scheduler records `rc=-11` and marks the case FAIL purely on the
non-zero exit code.

Native backtrace from the core dump (crash thread is a CANN background thread,
**not** the main thread; simpler appears in zero frames):

```
Thread 1 (CANN teardown thread):
#0  std::_Hashtable<unsigned int, ...>::find()   from libummu.so   ★ SIGSEGV
#1  hashmap_get                                  from libummu.so
#5  udma_u_unregister_seg                         from liburma-udma.so
#6  urma_unregister_seg                           from liburma.so
#7  hdc_unregister_own_urma_seg                   from libascend_hal.so   (driver)
#9  hdc_delete_ub_context                         from libascend_hal.so
#11 hdc_ub_session_close                          from libascend_hal.so
#13 halHdcSessionCloseEx                          from libascend_hal.so
#14 drvHdcSessionClose                            from libascend_hal.so
#16 AdxDestroyCommHandle                          from libascend_trace.so (CANN)
#17 ...                                           from libascend_trace.so (thread entry)

Thread 8 (main thread, concurrently):
#5  exit()                                        from libc
#1  ??                                            from libummu.so
#0  close()                                        from libc
```

Mechanism: `libascend_trace.so` is the CANN **device-log relay channel** (it
reads `ASCEND_LOG_DEVICE_FLUSH_TIMEOUT` / `ASCEND_TRACE_RECORD_NUM`; it is NOT a
profiling/ADX feature and is NOT enabled by simpler — the driver brings it up
whenever the device emits logs). At process exit, its background thread runs
`AdxDestroyCommHandle → halHdcSessionClose → urma_unregister_seg`, walking the
`libummu` global hashtable, **while the main thread is already in `exit()`**
running C++/atexit teardown. The two race to tear down the same HDC/URMA
resources; the background thread dereferences a hashtable the main thread has
freed → use-after-free → SIGSEGV.

Why only the fatal-code suite: these cases deliberately drive the device into a
FATAL state (e.g. device log shows `aicpu_orchestration_entry "FATAL(code=9):
st injected fatal"`, `PTO2 runtime failed with rc=-9`), so the device-log relay
channel is *busy right up to exit* — the teardown race window is at its widest.
Normal cases emit little/no device log and almost never hit it.

Why CI fails often but a local single run usually passes: **measured** — the
single-process exit hit rate on an idle box is <3% (0/30); with CI's 2-device
concurrency (two subprocesses running and exiting at once, higher load, wider
scheduling jitter) it jumps to ~60% (3/5 rounds). Concurrency widens the
`exit()`-vs-background-thread race window; the specific device numbers and
device independence are irrelevant because the race is **intra-process**.

### Git Commit ID

6d938bf85e68239fbb0f5802e093f2d515336822

### CANN Version

CANN 9.1.T500

### Driver Version

25.6.rc1.b108 (ascendhal_version 7.35.23)

### Host Platform

Linux (aarch64)

### Additional Context

**Root cause ownership.** Every crash frame is in closed-source CANN/driver
libraries; the defect is a missing synchronization between `libascend_trace`'s
exit-time background thread and process teardown. It cannot be *fixed* at the
application layer (we cannot lock the driver's internal hashtable or control its
thread lifecycle) — only mitigated. A true fix must come from the CANN/driver
team (make `AdxDestroyCommHandle` exit-safe / mutually exclusive with atexit, or
join the relay thread before teardown).

**Mitigation options (for if these cases are re-introduced):**
1. Report upstream to CANN with this backtrace + repro (the only real fix).
2. Have the fatal-code suite's process skip native teardown via `os._exit()`
   after assertions complete (a local conftest `pytest_sessionfinish`) — removes
   one leg of the race. Onboard work holds an exclusive task-submit device lock,
   so skipping the graceful device reset is acceptable here. (New exit behavior —
   needs sign-off per `.claude/rules/env-macro-gating.md`.)
3. CI-level: treat "pytest passed but process exited `-11`" as a known
   driver-flaky outcome (attach the core stack) rather than a hard FAIL.
4. Lowering concurrency (serial / single device) reduces but does not eliminate
   the hit rate — not recommended as the final fix.

**Status.** The triggering case was removed from mainline when the
`runtime_fatal_codes` suite was thinned (latest local commit touching it:
`5d4785e4`). This issue exists for the record and for upstream reporting.

Related: #1197 (teardown-ordering segfault where RTS-using destructors run after
`aclFinalize` on a5) — a different teardown bug in our own `DeviceRunner` member
ordering; this issue is the closed-source CANN device-log-relay thread race, not
fixable in simpler.


---

## #1220 [Code Health] Per-device runtime config (scheduler timeout) rides the per-run arena layout instead of a per-device channel

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1220
- Created: 2026-06-30T12:58:55Z
- Updated: 2026-07-01T02:31:16Z
- Closed: 2026-07-01T02:31:16Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Host Runtime (with AICPU Scheduler on the read side)

### Description

`PTO2_SCHEDULER_TIMEOUT_MS` is a **per-device, run-invariant** value (the AICPU scheduler no-progress watchdog). It is semantically per-device config, but it is currently carried as a field of the **per-run** runtime arena layout (`PTO2RuntimeArenaLayout::scheduler_timeout_ms`) and re-transmitted on every run as part of the full arena image H2D.

This is a structural mismatch with two concrete downsides:

1. **The layout becomes a dumping ground.** `PTO2RuntimeArenaLayout` describes the *per-run* arena (ring sizes, tensor_map, scope caps — things that genuinely change per run). A per-device watchdog timeout has nothing to do with ring/tensor layout. Every future per-device knob that "just rides the layout" compounds this.

2. **Read path is per-run for a value that never changes per run.** The host re-reads the env (`resolve_scheduler_timeout_ms()`) every run and re-writes it into the freshly-rebuilt arena image; the device re-reads it from `rt_->prebuilt_layout` on every boot.

Ring sizes (`PTO2_RING_*`) legitimately belong in the layout (they are per-run). The mismatch is only for run-invariant per-device config like the scheduler timeout.

**There is now a purpose-built channel for exactly this: `InitArgs`.** A recent refactor introduced `InitArgs` (`src/a5/platform/include/common/kernel_args.h:130`), documented verbatim as *"per-device one-shot invariants ... uploaded once at worker init via the `simpler_aicpu_init` entry, before any register_callable/exec launch ... so they no longer ride on the per-run KernelArgs: latched once into the resident AICPU SO globals and surviving every subsequent per-task launch."* It currently carries `device_id`, `log_level`, `log_info_v`. The scheduler timeout is the same category of value and belongs here.

- Host send: `ensure_aicpu_init_launched()` (`src/common/platform/onboard/host/device_runner_base.cpp:364`) fills `InitArgs` (`:374`) and launches `KernelNames::InitName` exactly once per runner, guarded by `aicpu_init_launched_` (`:380`, `aicpu_num=1`).
- Device latch precedent: `InitArgs.log_info_v` is latched into the resident AICPU global `g_log_info_v` (`src/common/platform/onboard/aicpu/device_log.cpp:36`), "latched once per device ... not re-pushed per run."

This supersedes an earlier note in this issue that claimed there was no transmit-once channel — that reasoning only considered the per-run launch tier. `InitArgs` is a genuine transmit-once-per-device path.

### Location

Current placement to remove:
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/pto_runtime2.h:117` — `scheduler_timeout_ms` field in `PTO2RuntimeArenaLayout`
- `src/a5/runtime/tensormap_and_ringbuffer/host/runtime_maker.cpp:248` — per-run `resolve_scheduler_timeout_ms()` (env read), written into layout at `:499`
- `src/a5/runtime/tensormap_and_ringbuffer/runtime/scheduler/scheduler_dispatch.cpp:606` — device read of `rt_->prebuilt_layout.scheduler_timeout_ms`

Target channel to reuse:
- `InitArgs` struct: `src/a5/platform/include/common/kernel_args.h:130`
- Host one-shot launch: `src/common/platform/onboard/host/device_runner_base.cpp:364` (`ensure_aicpu_init_launched`)
- Device latch precedent: `src/common/platform/onboard/aicpu/device_log.cpp:36` (`g_log_info_v`)

a2a3 mirrors under `src/a2a3/...`; sim variants under `src/*/platform/sim/...`.

### Proposed Fix

**Recommended: carry `scheduler_timeout_ms` in `InitArgs`** (the per-device one-shot channel that already exists for `device_id` / log config):

1. Add `uint32_t scheduler_timeout_ms;` to `InitArgs` (`kernel_args.h`).
2. Host: in `ensure_aicpu_init_launched()` stamp `init_args.scheduler_timeout_ms` from the env value resolved **once at init** (`resolve_onboard_timeout_config()` already reads the scheduler env at attach for ordering validation and currently discards it — keep it). The per-run `getenv` in `runtime_maker` is then deleted.
3. Device: `simpler_aicpu_init` latches it into a resident AICPU SO global (next to the `device_id` / `g_log_info_v` latches).
4. Scheduler: `scheduler_dispatch.cpp` reads that global instead of `rt_->prebuilt_layout.scheduler_timeout_ms`.
5. Remove `scheduler_timeout_ms` from `PTO2RuntimeArenaLayout` and the per-run `resolve_scheduler_timeout_ms()`.
6. Apply symmetrically across the four quadrants (onboard/sim x a5/a2a3).

This is a true transmit-once-per-device path: the value leaves the per-run arena and the per-run `KernelArgs` entirely, is uploaded once at init, latched into AICPU SO globals, and consumed read-only by every subsequent run — exactly how `device_id` / log config already work. No new device buffer, no per-run pointer, no per-run `getenv`. `InitArgs` being strictly per-device (vs per-callable) means there is not even a re-stamp concern.

No new env gate is introduced — `PTO2_SCHEDULER_TIMEOUT_MS` already exists; only its landing/transport changes. Existing per-case tests that set different values (`tests/st/runtime_fatal_codes`, `tests/st/aicore_op_timeout`) are per-process and set the env before init, so an init-time read does not break them.

Alternatives considered (inferior, kept for the record): an inline scalar in the per-run `KernelArgs` (fixes categorization but stays per-run); a separate persistent device buffer modeled on `device_wall_dev_ptr_` (data once, but the pointer still free-rides `KernelArgs` per run — only worthwhile for a large/growing config blob); or the per-callable `RegisterCallableArgs` register tier (transmit-once but per-callable, so less clean than the strictly per-device `InitArgs`).

### Priority

Low (no impact today, good to fix eventually)

---

## #1221 [Code Health] Worker.close() L2 branch leaks _ChipWorker nanobind instance at interpreter shutdown

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1221
- Created: 2026-06-30T13:00:10Z
- Updated: 2026-07-01T03:14:07Z
- Closed: 2026-07-01T03:14:07Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Host Runtime

### Description

`Worker.close()` is contracted to release every resource the Worker holds. The
L2 branch violates this: it calls `self._chip_worker.finalize()` but never drops
the Python reference (`self._chip_worker = None`). The `_ChipWorker` nanobind
instance therefore stays alive on the closed `Worker` object.

This is inconsistent with the two sibling teardown paths, both of which *do*
drop the handle:

- the L>=3 branch sets `self._worker = None` right after `self._worker.close()`;
- the error/abort path already does `self._chip_worker = None` after `finalize()`.

**Observed symptom (CI, intermittent):** nanobind prints a reference-leak dump at
interpreter shutdown, e.g.

```
nanobind: leaked 1 instances!
 - leaked instance 0x... of type "_task_interface._ChipWorker"
nanobind: leaked 15 types!
nanobind: leaked 165 functions!
nanobind: this is likely caused by a reference counting issue in the binding code.
```

(The full types/functions list is dumped because nanobind cannot cleanly unload
the module while any one of its instances is still live.)

**Why it is intermittent / "sometimes":** when a pytest case *fails or errors*,
pytest retains that case's traceback for reporting, and the traceback strongly
references the failing frame's locals — including the `worker` object, which in
turn pins `_ChipWorker`. Those references survive until interpreter exit, where
nanobind's leak check runs and reports them. Passing runs release the locals
normally, so no dump appears. `tests/st/aicore_op_timeout/test_aicore_op_timeout.py`
is a frequent trigger because it asserts on a timing-sensitive 507xxx code and an
`elapsed < 10` bound that can fail on a busy/shared box.

This is a benign teardown-ordering artifact (not a runtime C++ leak), but it is
noisy in CI logs and masks any future *real* nanobind refcount regression.

### Location

- \`python/simpler/worker.py\` — \`Worker.close()\`, L2 branch (\`if self.level == 2:\`), the \`self._chip_worker.finalize()\` line.

For reference, the consistent siblings:
- \`python/simpler/worker.py\` — L>=3 branch: \`self._worker = None\` after \`self._worker.close()\`.
- \`python/simpler/worker.py\` — error/abort path: \`self._chip_worker = None\` after \`finalize()\`.

### Proposed Fix

Drop the handle in the L2 branch immediately after finalizing, mirroring the
other two paths:

```python
if self.level == 2:
    if self._chip_worker:
        self._chip_worker.finalize()
        self._chip_worker = None
```

This releases the `_ChipWorker` instance as soon as the Worker is closed, so it
no longer outlives the module even when a failing test's traceback pins the
`Worker` object. One line; aligns `close()` with the L>=3 branch and the error
path.

### Priority

Low (no impact today, good to fix eventually)

### Environment

- Git commit: `11d03d9b81e1d29162eb30b7b39386842328559d`
- Host platform: Linux (aarch64)

Related: #1082, #980, #1018, #824 (Worker lifecycle / cleanup — distinct root causes).

---

## #1226 [Feature] Use pinned HTTPS-only PTO-ISA checkout under build/pto-isa

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1226
- Created: 2026-07-01T01:56:51Z
- Updated: 2026-07-02T03:04:34Z
- Closed: 2026-07-02T03:04:34Z
- Labels: enhancement

### Body

### Summary

Simplify PTO-ISA dependency resolution to one deterministic managed/manual checkout path:

- Clone PTO-ISA over HTTPS only.
- Use `<repo>/build/pto-isa` as the only checkout location.
- Always build/run against the commit recorded in `pto_isa.pin`.
- If users need a different PTO-ISA commit, they must update `pto_isa.pin`.
- If automatic clone fails, users may manually clone PTO-ISA into `build/pto-isa`; simpler should still checkout/reset that repository to the pinned commit before building or compiling kernels.
- Remove the old build-time vs run-time PTO-ISA mismatch enforcement path, because build and run should no longer choose independent ISA revisions.
- Keep a small build metadata JSON as runtime-binary provenance: it records what the current build artifacts were actually built with and can help detect stale prebuilt binaries after `pto_isa.pin` changes.

This removes protocol selection, arbitrary checkout location selection, ad hoc CLI/env commit selection, and compatibility enforcement that only existed to guard those independent choices. The remaining metadata JSON is not configuration and must not become a second source of truth.

### Motivation / Use Case

The current PTO-ISA setup has too many independent knobs:

- SSH vs HTTPS clone protocol.
- `PTO_ISA_ROOT` as an arbitrary user-managed path.
- `--clone-protocol` across pytest, scene-test, and build-runtimes.
- `SIMPLER_PTO_CLONE_PROTOCOL` at CMake/install time.
- `--pto-isa-commit` / `SIMPLER_PTO_ISA_COMMIT` as a separate runtime/install commit selector.
- Runtime lookup validation comparing the runtime build PTO-ISA commit against the run-time PTO-ISA commit.

That makes install-time runtime builds and run-time kernel compilation easy to drift apart. The repo already has `pto_isa.pin`; make it the single source of truth. Developers who want another ISA revision should change the pin file, so the selected revision is visible in the repo diff and applies consistently to install/build and run/kernel compile flows.

Once both phases use the same pinned checkout, the old mismatch detector becomes redundant complexity: there should be no separate run-time commit source to compare against. We still want artifact provenance, because `build/lib` binaries can be stale after a pin change. A JSON manifest can answer: which ISA commit were these runtime binaries actually built with?

HTTPS-only auto-clone also avoids first-run SSH key failures such as `Permission denied (publickey)` on fresh developer machines, GitHub-hosted CI runners, and containers.

### Proposed API / Behavior

- Managed checkout path is always `<repo>/build/pto-isa`.
- Auto-clone command uses only:
  `https://github.com/hw-native-sys/pto-isa.git`
- Resolution flow:
  1. Read the required PTO-ISA commit from `pto_isa.pin`.
  2. If `build/pto-isa` is missing, clone it over HTTPS.
  3. If auto-clone fails, error message should tell the user they can manually run:
     `git clone https://github.com/hw-native-sys/pto-isa.git build/pto-isa`
  4. Once `build/pto-isa` exists, fetch if needed and checkout/reset to the commit in `pto_isa.pin`.
  5. Verify the checkout HEAD equals the pinned commit; if it cannot be resolved, fail before building or compiling kernels.
  6. Build runtime binaries and compile kernels using that checkout.

- Remove or deprecate protocol/path/commit selection surfaces that conflict with the pin-file model:
  - pytest/scene-test `--clone-protocol`
  - build-runtimes `--clone-protocol`
  - CMake `SIMPLER_PTO_CLONE_PROTOCOL`
  - Python `ensure_pto_isa_root(clone_protocol=...)`
  - `PTO_ISA_ROOT` as an arbitrary checkout override
  - pytest/scene-test/build `--pto-isa-commit` overrides
  - `SIMPLER_PTO_ISA_COMMIT`
  - internal `SIMPLER_RUN_PTO_ISA_COMMIT` / `SIMPLER_RUN_PTO_ISA_ROOT` tracking, if only used for the old mismatch check

- Keep build provenance metadata:
  - write a JSON file in the runtime build output, e.g. `build/lib/pto_isa_build.json`
  - JSON is output-only; it must not be read as an ISA selection input
  - record at least:
    - `schema_version`
    - `required_commit_from_pin`
    - `actual_checkout_commit`
    - optionally `pin_file`, `checkout_path`, and build timestamp/source metadata if useful
  - build should fail if `required_commit_from_pin` and `actual_checkout_commit` differ
  - runtime lookup may optionally compare `required_commit_from_pin` in the JSON with the current `pto_isa.pin` to report stale runtime binaries and ask for reinstall/rebuild
  - this optional stale-artifact check is not the old build-vs-run ISA mismatch check; it only verifies that prebuilt binaries correspond to the current source pin

- Remove the old a2a3 onboard runtime PTO-ISA mismatch enforcement:
  - remove `validate_runtime_pto_isa_compatible()` as a comparison against an independently selected run-time commit
  - remove tests/docs that describe build-time vs run-time PTO-ISA drift as a supported condition
  - replace any remaining safety checks with two simpler invariants:
    1. all PTO-ISA consumers resolve through `pto_isa.pin` and `build/pto-isa`
    2. prebuilt runtime metadata, if present, describes artifacts built for the current pin

### CI Impact

CI should be updated to stop passing protocol and commit override flags once the pin file is the single source of truth:

- Remove `--clone-protocol https` and `--clone-protocol ssh` from workflows.
- Remove CMake `SIMPLER_PTO_CLONE_PROTOCOL` usage.
- Replace `--pto-isa-commit $PTO_ISA_COMMIT` / `SIMPLER_PTO_ISA_COMMIT=...` plumbing with reading `pto_isa.pin` inside the code path, unless a specific CI job is intentionally testing pin changes.
- Keep or update expectations around the metadata JSON as an informational record of the pinned commit used for the runtime build.
- Self-hosted runners that cannot auto-clone can pre-populate `build/pto-isa`; simpler should still enforce checkout to `pto_isa.pin` before use.

### Alternatives Considered

Keep `PTO_ISA_ROOT`, `--pto-isa-commit`, or the mismatch detector as escape hatches. That keeps flexibility but also keeps the core mismatch risk: runtime binaries can be built with one ISA revision while kernels compile against another. A single `pto_isa.pin` source of truth is more reproducible. A build metadata JSON is still useful, but only as artifact provenance and stale-build diagnostics.

### Additional Context

This affects the managed checkout used by runtime builds and kernel compilation. Manual recovery from clone failure remains possible by cloning PTO-ISA into the standard `build/pto-isa` location, but the selected revision is still controlled by `pto_isa.pin`.

---

## #1232 [Code Health] Reset AICPU profiling collectors' cached static state on disabled/base=0 launch (persistent .so hazard), symmetrically across a2a3 + a5

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1232
- Created: 2026-07-01T03:45:16Z
- Updated: 2026-07-01T06:27:30Z
- Closed: 2026-07-01T06:27:30Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Platform (a2a3 / a2a3sim)

### Description

The AICPU profiling collectors (L2Swimlane, PMU, DepGen, TensorDump, ScopeStats) keep file-local **static** state that persists across launches, because the AICPU `.so` is loaded once and reused. This state includes:

- cached header pointers (`s_*_header`),
- pool arrays (`s_*_pools[]`),
- "current buffer" pointers (`s_current_*_buffers[]` / `current_buf_ptr`),
- orch thread index (`s_orch_thread_idx`),
- base / level globals (`g_*_base`, `g_*_level`).

**Hazard — enabled → disabled launch sequence:** when a subsequent launch turns profiling *off*, it calls `set_platform_*_base(0)` and/or `set_*_enabled(false)` but does **not** run `*_aicpu_init` (init only runs when profiling is enabled). The statics therefore retain the *previous* launch's pointers, which may point at memory that has since been freed/reallocated. Any record/complete path that becomes reachable in that state can dereference a stale pointer (potential use-after-free).

This is a **pre-existing / latent** hazard, not introduced by any single change. The a2a3 `l2_swimlane_aicpu_init` comment already references the same class of bug and its prior fix (`#936`). There is **no proven live crash path today** — record sites are gated (`s_phase_initialized`, `is_*_enabled`) — so this is filed as defense-in-depth / robustness rather than an active bug.

**Why now / symmetry:** PR #1162 introduced a per-collector `reset_*_cached_state()` helper (nulls all cached statics) and wired it into the disabled/base=0 setters — but **only for a5** (L2/PMU/DepGen) and **common** (`tensor_dump`; `scope_stats` partial). The **a2a3** arch-specific L2/PMU/DepGen collectors, and `scope_stats`' `set_*_enabled(false)` path, were left uncovered. Per review, PR #1162 is dropping this hardening from its scope entirely (it is unrelated to that PR's buffer-drop-reduction goal) so it can land focused; this issue tracks doing the hardening **properly and symmetrically across both arches and all five collectors** as a standalone change.

**Acceptance:** each collector defines a `reset_*_cached_state()` that nulls header + pools + current-buffer pointers + orch idx + level globals, and it is invoked from **both** `set_platform_*_base(0)` **and** `set_*_enabled(false)`, on **both** a2a3 and a5 (and once in `common` for tensor_dump / scope_stats). Add a small onboard/sim check that an enabled→disabled→(record attempted) sequence does not touch stale state.

Reference mainline commit where the hazard exists: `c080089d` (merge-base of #1162).

### Location

- `src/a2a3/platform/shared/aicpu/l2_swimlane_collector_aicpu.cpp` — `set_platform_l2_swimlane_base` / `set_l2_swimlane_enabled` (no reset)
- `src/a2a3/platform/shared/aicpu/pmu_collector_aicpu.cpp` — `set_platform_pmu_base` / `set_pmu_enabled` (no reset)
- `src/a2a3/platform/shared/aicpu/dep_gen_collector_aicpu.cpp` — `set_platform_dep_gen_base` / `set_dep_gen_enabled` (no reset)
- `src/common/platform/shared/aicpu/scope_stats_collector_aicpu.cpp` — `set_scope_stats_enabled(false)` does not reset header/state
- (reference implementation to mirror) `src/a5/platform/shared/aicpu/{l2_swimlane_collector_aicpu,pmu_collector_aicpu,dep_gen_collector_aicpu}.cpp` — `reset_*_cached_state()` + call sites
- (reference) `src/common/platform/shared/aicpu/tensor_dump_aicpu.cpp` — `reset_dump_runtime_state()`

### Proposed Fix

Mirror the a5 pattern onto a2a3 (and complete scope_stats): add `reset_l2_swimlane_cached_state()` / `reset_pmu_cached_state()` / `reset_dep_gen_cached_state()` to the a2a3 collectors and call them from both the `base == 0` and `!enable` branches of the respective setters; route `set_scope_stats_enabled(false)` through the same reset. Keep the reset helper as the single source of truth (also usable from `*_finalize`, as a5 dep_gen does). Do this as one focused PR so a2a3 and a5 stay in lockstep (the framework was unified in #944 and is meant to be reviewed against both arches).

### Priority

Medium (minor risk, should fix in next few releases)

Related: #1161, #1162

---

## #1237 [Code Health] L2Swimlane collector: shard per-collector accumulation state to drop hot-path locks/atomics (measure first)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1237
- Created: 2026-07-01T07:58:10Z
- Updated: 2026-07-08T09:01:55Z
- Closed: 2026-07-08T09:01:55Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Host Runtime

### Description

PR #1162 makes the L2Swimlane collector run N-wide (`kCollectorThreadCount = PLATFORM_MAX_AICPU_THREADS`), so `on_buffer_collected` and its `copy_*_buffer` helpers now execute on multiple collector threads concurrently. To stay race-free, the shared accumulation state was synchronized two ways:

- scalar tallies/flags made `std::atomic` (the running `total_*_collected_` counters and `has_phase_data_`);
- the per-core / per-thread record vectors guarded by per-index `std::mutex` arrays (perf / aicore records keyed by core; sched / orch phase records keyed by AICPU thread).

**Proposed optimization — shard by writer, reduce at the end.** Instead of collectors contending on shared state, give each collector its own slice:

- counters/flags → per-collector arrays (`[collector]`), each collector does a plain (non-atomic) write to its own slot;
- record vectors → per-collector-by-instance (`[collector][core]` / `[collector][thread]`), each collector appends only to its own slice with no lock.

Then reduce once at `reconcile_counters` / export time — this runs after `stop()` has joined every collector, so there is a natural "all writes done" barrier. This removes every lock and atomic from the collector hot path.

**Ordering is safe:** the export path already sorts records by timestamp, so the "collector-0's records, then collector-1's, ..." concatenation order after the merge does not matter.

**Caveats to handle when implementing:**
- **False sharing:** pad each per-collector counter slot to its own cache line (`alignas(64)` or equivalent). Adjacent `uint64_t` slots share a line and would ping-pong across cores — that can be *slower* than the single atomic it replaces.
- Extra memory: N copies of the outer vector structures (small — the inner vectors start empty).
- One-time O(total records) merge at the end (single-threaded, unavoidable work).

**Measure before doing this.** The mutex is taken once per *buffer*, not per record, and is typically uncontended (only when two collectors touch the same core simultaneously). The dominant cost in `copy_*_buffer` is the per-record `push_back` and, on the non-SVM (a5) path, the `copy_buffer_from_device` rtMemcpy that already happened upstream. So the expected speedup may be small and could be eaten by false sharing. Gate this on a profile (`/profile` or the dfx timing tools) that shows the lock/atomic is actually hot. Prior L2Swimlane micro-opt context: `docs/investigations/2026-06-l2-swimlane-defer-wmb.md`; if this is tried and shows no signal, record that in `docs/investigations/` per the working-discipline rule.

**Do this after #1162 merges** — that PR is being trimmed and its line layout is still moving.

### Location

(Symbols only — no line numbers, since #1162 is still being edited.)

- `src/a2a3/platform/include/host/l2_swimlane_collector.h` and `src/a5/platform/include/host/l2_swimlane_collector.h` — members `total_perf_collected_`, `total_sched_phase_collected_`, `total_orch_phase_collected_`, `has_phase_data_`, `perf_record_mutexes_`, `aicore_record_mutexes_`, `sched_phase_record_mutexes_`, `orch_phase_record_mutexes_`, and the `collected_*_records_` vectors.
- `src/a2a3/platform/shared/host/l2_swimlane_collector.cpp` and `src/a5/platform/shared/host/l2_swimlane_collector.cpp` — `copy_perf_buffer`, `copy_sched_phase_buffer`, `copy_orch_phase_buffer`, `copy_aicore_buffer` (writers) and `reconcile_counters` (the reduce site).

### Proposed Fix

Replace the shared atomics + per-index mutexes with per-collector-sharded state (`[collector]` for scalars, `[collector][instance]` for record vectors), written lock-free on the hot path and merged once at reconcile/export after all collector threads join. Cache-line-pad the per-collector scalar slots. Land only with a before/after profile demonstrating a real collector-side speedup.

### Priority

Low (no impact today, good to fix eventually)

Related: #1161, #1162

---

## #1247 [Code Health] Extract the AICPU-side profiling operation layer (enqueue/pop/switch/flush/record) into a templated device engine + per-subsystem trait — symmetric to host ProfilerAlgorithms

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1247
- Created: 2026-07-02T02:45:03Z
- Updated: 2026-07-08T02:46:49Z
- Closed: 2026-07-08T02:46:49Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Platform (a2a3 / a2a3sim)

### Description

The **host** side of the profiling framework is unified: `ProfilerBase` (poll/drain/collect loops) + `BufferPoolManager` (pools/queues) + `ProfilerAlgorithms<Module>` (the generic algorithm), one implementation for all five subsystems, each supplying a small `Module` trait. The **AICPU (device)** side has no such layer — each of L2Swimlane / PMU / DepGen / TensorDump / ScopeStats reimplements the same device-side logic in its own `*_aicpu.cpp` (per arch for the three arch-specific ones), 400–1000 lines each.

This issue is the **device-side analog of the host unification**: hoist the shared AICPU operation layer into one templated engine + per-subsystem trait. (An earlier framing scoped this to just the two low-level wait helpers; the real duplication is the whole operation layer above them.)

**The operation layer is structurally identical across all five, and each copy has drifted.** Every collector has an `enqueue_*_ready_buffer` (ready-queue push) and a `switch_*_buffer` (buffer rotation), and the switch skeleton is the same everywhere:

```
switch():
  1. null guards (state / current buffer)
  2. check free_queue for space (head==tail → drop: count dropped, reset, return)
  3. enqueue current full buffer to the ready queue
  4. pop a fresh buffer from free_queue (head+1, buffer_ptrs[head % SLOT_COUNT])
  5. install as current, reset count, wmb
```

The underlying queue layouts are already identical — the ready header exposes `queue_heads[]` / `queue_tails[]` / `queues[][]` and the free-queue exposes `head` / `tail` / `buffer_ptrs[]`, differing only in type name (`PmuDataHeader` / `DepGenDataHeader` / …). Because there is no shared engine, the copies have drifted: the backpressure poll-mask, trailing `wmb()`, top-of-loop `rmb()`, and null-slot handling all differed per copy until #1162 aligned them one file at a time — and **TensorDump's `switch_dump_meta_buffer` still uses an inline `DUMP_SPIN_WAIT_LIMIT` spin instead of the `wait_for_free_queue_entry` helper the others adopted**, a live example of the drift. Every future device-side change has to be made 5+ times and kept in sync by hand.

### Proposed structure

| Layer | Contents |
| :-- | :-- |
| **Device collector engine** (templated on a `Module` trait) | `enqueue_ready(buffer_ptr, seq)` (ready-queue push), `pop_free()` (free-queue pop-and-install), **`switch_buffer()`** (the enqueue-full + pop-fresh + install skeleton above), **`flush()`** (flush the partial current buffer at teardown), `record(...)` (append + switch-if-full hot path), and the init/finalize skeleton (set header/pool pointers, reset state) |
| **Per-subsystem trait** | header / free-queue / buffer types; buffer-kind count; `*_READYQUEUE_SIZE` / `*_SLOT_COUNT` / backpressure-cycle constants; the record-field-store hook; the drop-accounting hook; the instance shape (single-instance vs per-thread) |

Each `*_aicpu.cpp` then collapses to a trait plus a few subsystem-specific hooks, instead of a full re-implementation of enqueue/pop/switch/flush/commit. This also erases the current per-copy drift (the TensorDump spin, the divergent logging, the differing drop-accounting) by construction.

### Caveats

- **L2Swimlane is the outlier.** It has 4 buffer kinds, per-core task pools + per-thread phase pools + AICore rotation, plus `flush_phase_pool` / `switch_phase_buffer_kind`. The single-instance subsystems (DepGen, ScopeStats) and simple per-thread ones (PMU, TensorDump) collapse cleanly into the engine; L2's multi-pool structure has to compose several engine instances or keep some subsystem-specific code on top. Don't force it into the base if it distorts the common case.
- **Device memory-ordering code.** Every `rmb()` / `wmb()` must be preserved exactly; sim does not exercise weak-memory reordering, so this must be **onboard-validated on both arches**.

### Location

(Symbols only — files are a moving target.)

- Per-arch: `src/{a2a3,a5}/platform/shared/aicpu/{l2_swimlane_collector,pmu_collector,dep_gen_collector}_aicpu.cpp` — `enqueue_*_ready_buffer`, `switch_*_buffer` / `switch_records_buffer` / `switch_phase_buffer_kind`, `flush_phase_pool`, `try_pop_*`.
- Common: `src/common/platform/shared/aicpu/{tensor_dump_aicpu,scope_stats_collector_aicpu}.cpp` — `enqueue_*`, `switch_dump_meta_buffer` (note the inline `DUMP_SPIN_WAIT_LIMIT`), `switch_buffer`.
- Candidate home for the shared engine header: alongside `src/common/platform/include/aicpu/`.
- Host precedent to mirror: `src/common/platform/include/host/profiler_base.h` (`ProfilerAlgorithms<Module>` + the `Module` trait contract).

### Proposed Fix

Introduce one templated device-side collector engine (single source of truth) implementing enqueue/pop/switch/flush/record/init-finalize over a `Module` trait, included by all five AICPU collectors in place of the per-subsystem copies — the device analog of `ProfilerAlgorithms<Module>`. Mechanical, onboard-validated, preserving every barrier. Land after #1162 (which aligned the helper shapes and is the natural precursor).

### Priority

Low (no impact today, good to fix eventually)

Related:
- #1253 — the **arch axis** (a2a3↔a5) dedup: L2/DepGen AICPU are byte-identical and can be plain-moved to common. **This issue is the collector axis** (across subsystems). They overlap: sequence #1253's quick move first, or note that this engine extraction largely **subsumes** #1253 (once collectors become trait + hooks, the byte-identical per-arch files disappear anyway).
- #1237 — collector-output sharding on the host side (shares the static-ownership linchpin).
- #1251 — all-SPSC buffer-pool redesign (host-side pipeline); this issue is the device-side operation layer that pushes/pops those same queues.
- #1162 — aligned the wait-helper shapes; the precursor.

---

## #1248 [Code Health] Incorrect "get_sys_cnt_aicpu() is an MMIO read" comment in ring-buffer / orchestrator deadlock backstops

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1248
- Created: 2026-07-02T02:56:52Z
- Updated: 2026-07-03T03:06:39Z
- Closed: 2026-07-03T03:06:39Z
- Labels: code health

### Body

### Category

Naming / Consistency

### Component

Ring Buffer

### Description

The task-allocator / ring-buffer / orchestrator deadlock backstops sample the wall-clock only once per 1024 spins, and the comment justifying that says:

> `get_sys_cnt_aicpu()` **is an MMIO read**, so sample it only once per 1024 spins.

That justification is **factually wrong**. `get_sys_cnt_aicpu()` onboard is a single `mrs cntvct_el0` (see `src/common/platform/onboard/aicpu/device_time.cpp`) — an ARM generic-timer **system-register read**, not an MMIO / `Device-nGnRE` access. It is cheap and is used freely on hot paths elsewhere (dispatch/resolve/pop timestamps).

The 1024-spin sampling itself is fine for these ~500 ms deadlock backstops, but for a *different* reason than stated: over that window the loop runs millions of iterations, and the gate keeps the reclaim-retry / deadlock-check loop tight (it also gates an atomic error-flag load and, in one case, a head-slot walk) — not because reading the clock is expensive. The comment should be corrected so it doesn't propagate the false "MMIO read" premise (this same premise was copied into the profiling collectors' backpressure waits and had to be removed there in #1162).

This is **pre-existing** runtime code, unrelated to the profiling subsystem and unrelated to #1162 — comment-only, zero behavior change.

### Location

(Symbols only — line numbers drift.) The `"is an MMIO read"` comment appears 6 times:

- `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.cpp` — `PTO2FaninPool::ensure_space` deadlock backstop
- `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/runtime/pto_ring_buffer.h` — DepList/ring reclaim deadlock check
- `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp` — TensorMap entry-pool deadlock backstop

### Proposed Fix

Reword the six comments to drop the "MMIO read" claim and state the real reason for the 1024-spin gate (keep the hot reclaim/deadlock-check loop tight; `get_sys_cnt_aicpu()` is a cheap `mrs cntvct_el0`, and the gated block also does an atomic flag load / head-slot walk). Comment-only; keep the sampling logic unchanged.

### Priority

Low (no impact today, good to fix eventually)

---

## #1249 [Code Health] Harden a5 DFX scene tests: PMU artifact validation gaps + missing st-sim-a5 smoke coverage

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1249
- Created: 2026-07-02T03:24:36Z
- Updated: 2026-07-08T07:35:37Z
- Closed: 2026-07-08T07:35:37Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

Tests

### Description

During review of the commit that mirrors the a2a3 DFX scene tests to a5, four
follow-up hardening points surfaced. None block the mirror (it is a faithful
copy), but each weakens the coverage the DFX tests are supposed to provide.

**A. PMU artifact validation is too lenient** (issues 1–3 below live in
`test_pmu.py::_validate_pmu_artifact`; the a2a3 and a5 files are byte-identical
apart from arch strings, so all three exist in **both** and should be fixed in
both to avoid divergence):

1. **Silent skip on capture failure.** `if not matches: return` — when PMU
   capture fails so badly that no output directory is produced, the glob
   matches nothing and the method returns without any assertion, so the test
   *passes* on a real capture regression instead of failing.

2. **Stale-directory risk.** `matches[-1]` picks the most-recent directory by
   mtime but never confirms it belongs to the current test invocation. A
   directory left over from a prior run/session with the same case label
   satisfies the glob and gets validated in place of (or in addition to) the
   current run's real output — masking a current-run capture regression.

3. **Header ordering not verified.** The docstring claims the smoke asserts the
   header "starts with the documented prefix" (leading, ordered), but the loop
   only checks `col in header_cols` (membership). A header with the same columns
   in a different order passes incorrectly. Either tighten the check to a
   leading ordered-prefix comparison, or correct the docstring to match the
   membership-only intent.

**B. CI coverage gap — `st-sim-a5` runs no DFX per-feature smoke steps.**
`.github/workflows/ci.yml`'s `st-sim-a5` job runs only the default
`pytest examples tests/st --platform a5sim ...` with no `--enable-*` flags.
The a5 DFX cases are no-ops without their flag, so they are **collected but not
validated** in sim CI. By contrast `st-sim-a2a3` mounts four dedicated steps
(`dep_gen`, `l2_swimlane`, `PMU`, `args_dump`). Note the onboard job already
mirrors all four a5 smokes — the gap is **only on the sim side**.

### Location

```markdown
- `tests/st/a5/tensormap_and_ringbuffer/dfx/pmu/test_pmu.py:94-96` (silent skip + stale dir)
- `tests/st/a5/tensormap_and_ringbuffer/dfx/pmu/test_pmu.py:16` (docstring) vs `:102-103` (impl) — header order
- `tests/st/a2a3/tensormap_and_ringbuffer/dfx/pmu/test_pmu.py` — same three, fix in lockstep with a5
- `.github/workflows/ci.yml` — `st-sim-a5` job (~L250-307) missing DFX smoke steps present in `st-sim-a2a3` (~L226-247)
```

### Proposed Fix

1. Replace the `if not matches: return` early-out with an assertion that at
   least one matching output directory exists.
2. Bind the validated directory to the current invocation (e.g. capture a
   pre-run timestamp/marker and require `mtime`/name newer than it, or record
   the exact output path the run created rather than globbing by label).
3. Either assert `header_cols[:len(prefix)] == list(prefix)` for a true ordered
   prefix, or relax the docstring to state membership-only.
4. Add the four DFX smoke steps to `st-sim-a5`, mirroring the `st-sim-a2a3`
   set with `--platform a5sim`, `--clone-protocol https`, and
   `tests/st/a5/...` paths (graphviz for dep_gen is already installed in the
   a5 sim job).

Fix items 1–3 in a single commit touching both a2a3 and a5 so they stay in
sync.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1251 [Code Health] Redesign profiling buffer-pool as an all-SPSC lock-free per-lane pipeline (replenish-driven alloc/recycle)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1251
- Created: 2026-07-02T06:16:53Z
- Updated: 2026-07-10T10:01:21Z
- Closed: 2026-07-10T10:01:21Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Platform (a2a3 / a2a3sim)

### Description

The profiling host path currently uses several mutexes — `ready_shards` (mutex+cv), `done_shards` (mutex), the striped `free_queue` writer lock, `recycled` (per-shard×kind mutex), the `dev_to_host_` mapping mutex, and the collectors' per-core/thread record-vector mutexes. Most of these guard access that is genuinely multi-writer / multi-consumer **in the current design**, so they are not simply removable as-is (see #1237 for the collector-output side).

But with a strict **per-lane** partition (1 AICPU thread ↔ 1 drain ↔ 1 collector ↔ 1 recycled pool, + 1 replenish thread — already the shape the PR uses, sized by `PLATFORM_MAX_AICPU_THREADS`), the whole buffer pipeline can be made **all-SPSC and lock-free**, which maximizes host read throughput on the hot path.

**Target pipeline (per lane q), every hop single-producer/single-consumer → lock-free (barriers only):**

```
freeQ[q] → AICPU q writes → readyQ[q] → drain q → ready_shard[q] → collector q
  → done_shard[q] → replenish → recycled[q] → drain q refills freeQ[q]
```

- readyQ[q]: AICPU q → drain q
- ready_shard[q]: drain q → collector q
- done_shard[q]: collector q → **replenish (sole consumer)**
- recycled[q]: **replenish (sole writer)** → drain q
- freeQ[q]: **drain q (sole writer)** → AICPU q

### Sub-changes required (each with its tradeoff)

1. **ready_shards → lock-free SPSC ring** + replace the cv-blocking wait with a lock-free-compatible blocking/timeout primitive (must keep the 100 ms tick + `execution_complete` exit semantics). This is the main non-trivial piece.
2. **done_shards → single consumer.** Remove `obtain_buffer`'s synchronous done-drain so replenish is the only done→recycled path (done[q] becomes collector[q]→replenish SPSC). Tradeoff: drain can no longer self-harvest done; it relies on replenish keeping recycled warm.
3. **recycled → per-lane SPSC.** Remove `pop_recycled_any` (cross-shard borrow) so recycled[q] has exactly one writer (replenish) and one reader (drain q). Cross-lane balancing moves into replenish instead (see below).
4. **free_queue → single writer** (drain[owner]). Depends on the invariant below.
5. **alloc off the hot path, on replenish, batched + proactive.** Move `alloc_and_register` out of the drain hot path to the replenish thread; allocate **one big block and register it once, then carve it into N buffers** (amortizes the expensive HAL registration vs N separate reg calls); drive it by a watermark so the drain path is pure-pop and never allocs. Single-thread allocator ⇒ no lock. Implementation consequence: `resolve_host_ptr` must handle sub-buffers of a block — register the block once and add N offset-computed `dev_to_host_` entries, or switch to range-based resolution.
6. **init: seed each shard's recycled evenly.** Today init pushes all surplus buffers with the default `shard=0`, so the whole surplus lands in `recycled[0]`; the current design only tolerates that because `pop_recycled_any` redistributes. Removing cross-shard borrow (#3) requires init to distribute the surplus across shards.

### Hard invariant this depends on

**Core/instance → AICPU-thread ownership must be static (no migration / work-stealing).** Verified in the current code: both runtimes call `assign_cores_to_threads()` once at init (cluster-aligned round-robin, `cluster ci → thread ci % N`), each thread only completes/flushes its own cores, and sched/orch pools enqueue via a fixed thread index — so each free_queue is refilled by exactly one drain thread. If future work introduces core migration/stealing, freeQ becomes multi-writer and this design breaks (it would need re-synchronization or a producer hand-off).

**Compatible** future extension: replenish cold→hot buffer balancing by routing `done[cold] → recycled[hot]` stays SPSC — replenish remains the sole writer of every recycled pool and sole consumer of every done shard, so it only changes the delivery target, not the number of readers/writers.

### Open question (confirm before relying on lock-free freeQ)

The PR kept a striped `free_queue` writer lock citing *"some runtime paths can reassign producer ownership across AICPU threads."* A repo-wide search found **no** reassign/steal/rebalance/migrate path in either runtime, and `orch_to_sched` is not present in the code — so the lock looks defensive/forward-looking. Confirm with the author what that comment actually refers to; if a real (even rare) migration path exists, freeQ cannot be made lock-free without handling the hand-off.

### Location

(Symbols only.) Host framework: `src/common/platform/include/host/buffer_pool_manager.h` (ready/done/recycled shards, `with_free_queue_writer`, `obtain_buffer`, `pop_recycled_any`, `alloc_and_register`, `resolve_host_ptr`), `src/common/platform/include/host/profiler_base.h` (`mgmt_drain_loop` / `mgmt_replenish_loop` / `poll_and_collect_loop`, `try_push_to_free_queue`). Device seeding: each collector's `initialize()` recycled seeding. Ownership invariant: `assign_cores_to_threads` / `find_core_owner_thread` in both runtimes.

### Proposed Fix

Rework the buffer pool into the all-SPSC per-lane pipeline above: lock-free SPSC ready/done/recycled queues + a lock-free wait primitive for ready, replenish as the sole done→recycled mover and sole (batched, proactive, block-carving) allocator, even init seeding, and the static-ownership invariant made explicit. Sizeable enough to warrant a short design note / RFC first. Device memory-ordering change → must be onboard-validated (sim does not exercise weak-memory reordering).

### Priority

Medium (minor risk, should fix in next few releases)

Related: #1162 (introduced the sharding this builds on), #1237 (collector-output sharding — shares the static-ownership linchpin and would be subsumed), #1247 (device-side plumbing unification), #997 (backpressure runs on top of these queues).

---

## #1252 [Code Health] Rename internal TensorDump implementation to ArgsDump

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1252
- Created: 2026-07-02T06:39:27Z
- Updated: 2026-07-13T09:30:29Z
- Closed: 2026-07-13T09:30:29Z
- Labels: code health

### Body

### Category

Naming / Consistency

### Component

Platform (a2a3 / a2a3sim)

### Description

The public dump surface has been renamed from tensor dump to args dump, but the internal C++ implementation still uses the old `TensorDump*` naming throughout the collector, platform headers, AICPU helpers, and CMake source paths.

This is naming drift left after the public-surface rename work:

- #1072 renamed the CLI/artifacts/viewer/tests/docs surface to args dump while keeping compatibility fields.
- #1143 finished more public-surface rename work, but explicitly left internal C++ names unchanged as out of scope.
- Current artifacts are already args dump (`args_dump/`, `args_dump.json`, `args.bin`), while internal code still says `TensorDumpCollector`, `TensorDumpRecord`, `TensorDumpRole`, `tensor_dump_collector.cpp`, `tensor_dump_aicpu.*`, etc.

The mismatch makes the code harder to navigate and keeps reintroducing ambiguity in docs, issue text, and DFX tooling work. The feature semantics are now per-task argument dump, including tensor and scalar args, so the internal names should match the public contract.

Related: #837, #995, #1247

### Location

Representative locations:

- `src/common/platform/shared/host/tensor_dump_collector.cpp`
- `src/common/platform/include/host/tensor_dump_collector.h`
- `src/common/platform/include/aicpu/tensor_dump_aicpu.h`
- `src/common/platform/shared/aicpu/tensor_dump_aicpu.cpp`
- `src/a2a3/platform/include/common/tensor_dump.h`
- `src/a5/platform/include/common/tensor_dump.h`
- `src/{a2a3,a5}/platform/{onboard,sim}/host/CMakeLists.txt`
- `src/{a2a3,a5}/platform/{onboard,sim}/host/device_runner.{h,cpp}`
- `src/{a2a3,a5}/runtime/**` includes of `aicpu/tensor_dump_aicpu.h`
- docs/comments that still refer to internal `TensorDump*` names where they describe args-dump behavior

### Proposed Fix

Do a mechanical internal rename from tensor dump to args dump across code, build files, tests, and docs/comments, while preserving on-disk public artifacts that are already correct:

- `TensorDumpCollector` -> `ArgsDumpCollector`
- `TensorDumpRecord` / `TensorDumpInfo` / `TensorDumpRole` / `TensorDumpStage` / `TensorDumpKind` -> corresponding `ArgsDump*` names
- `DumpTensorLevel` / `dump_tensor_level` -> `DumpArgsLevel` / `dump_args_level`
- `tensor_dump_collector.*` -> `args_dump_collector.*`
- `tensor_dump_aicpu.*` -> `args_dump_aicpu.*`
- `common/tensor_dump.h` -> `common/args_dump.h`
- constants/macros such as `TENSOR_DUMP_*` -> `ARGS_DUMP_*`
- function names such as `init_tensor_dump` where they initialize args dump rather than tensor-info dump APIs

Keep compatibility aliases only where needed for external or serialized contracts; otherwise prefer removing stale internal names outright.

Because this touches shared platform/runtime headers and onboard code, validate at least the args-dump smoke test after the rename and rebuild runtimes.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1253 [Code Health] Hoist L2Swimlane & DepGen collectors into common (like TensorDump/ScopeStats): move identical AICPU, migrate host to alloc_paired_buffer

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1253
- Created: 2026-07-02T06:44:59Z
- Updated: 2026-07-07T09:45:49Z
- Closed: 2026-07-07T09:45:49Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Platform (a2a3 / a2a3sim)

### Description

TensorDump and ScopeStats already live entirely in `src/common/` (aicpu + host + header) — one source compiled for both arches. L2Swimlane, PMU, and DepGen are still duplicated per-arch under `src/{a2a3,a5}/platform/shared/`. This issue covers **L2Swimlane and DepGen** (PMU is genuinely arch-divergent — separate effort, see below).

Measured on `main` (4d5fbe4c):

| file | a2a3 | a5 | diff lines |
| :-- | :-- | :-- | :-- |
| `aicpu/dep_gen_collector_aicpu.cpp` | 378 | 378 | **0 (byte-identical)** |
| `aicpu/l2_swimlane_collector_aicpu.cpp` | 941 | 941 | **0 (byte-identical)** |
| `host/dep_gen_collector.cpp` | 275 | 296 | 149 |
| `host/l2_swimlane_collector.cpp` | 1019 | 1060 | 187 |

**AICPU side — pure duplication.** Both files are byte-identical across arch: the device-side writer only touches its own device view of shared memory, so it is transport-agnostic; all arch differences (struct sizes, `PLATFORM_*` constants, register addresses) already resolve through arch-specific headers at build time. There is no reason for two copies.

**Host side — diverges only on transport, and the abstraction to remove that already exists.** The divergence is entirely SVM vs host-shadow: a2a3 inlines raw `alloc_cb` + `register_cb` (`halHostRegister`) + `register_mapping`, while a5 uses `alloc_paired_buffer` + `profiling_copy_to/from_device`. The bulk (record copy-out, reconcile, export) is the same logic. TensorDump/ScopeStats already hide this behind `ProfilerBase::alloc_paired_buffer` (which branches internally: halHostRegister / non-SVM malloc-shadow+copy / SVM identity-map) plus `profiling_copy_*_or_null()` (platform decides whether copy callbacks exist). a2a3 dep_gen host still calls `alloc_paired_buffer` **0** times; a5 calls it 3 times — the a2a3 side simply was never migrated to the abstraction.

### Location

(Symbols only.)

- AICPU (identical → move): `src/{a2a3,a5}/platform/shared/aicpu/{l2_swimlane_collector_aicpu,dep_gen_collector_aicpu}.cpp`
- Host (transport-diverged → migrate): `src/{a2a3,a5}/platform/shared/host/{l2_swimlane_collector,dep_gen_collector}.cpp`
- Reference implementations already in common: `src/common/platform/shared/{aicpu,host}/{tensor_dump_aicpu,tensor_dump_collector,scope_stats_collector_aicpu,scope_stats_collector}.*`
- Abstraction to adopt: `src/common/platform/include/host/profiler_base.h` (`alloc_paired_buffer`), `src/common/platform/include/host/profiling_copy.h` (`profiling_copy_*_or_null`), `src/common/platform/include/host/buffer_pool_manager.h`.

### Proposed Fix

Two independent, incrementally-landable steps, mirroring how TensorDump/ScopeStats are already structured:

1. **AICPU: move to common (plain relocation).** Move the two byte-identical `*_aicpu.cpp` to `src/common/platform/shared/aicpu/`, delete the per-arch copies, and wire the build to compile the common source per-arch via include paths (same mechanism `tensor_dump_aicpu.cpp` already uses). Mechanical; verify the arch-specific headers still resolve.
2. **Host: migrate to the transport abstraction, then collapse.** Refactor the a2a3 host to use `alloc_paired_buffer` + `profiling_copy_*_or_null()` instead of inline `alloc_cb`/`register_cb`/`register_mapping`, so both arches take one code path; then merge the two host `.cpp` into one common file (leaving only the platform-resolved copy-callback wiring, exactly as TensorDump does).

PMU is out of scope here: its AICPU side genuinely diverges (a5 AICore PMU staging-ring, 10 vs 8 counters, dual CTRL registers) and its host adds counter-count differences — that needs a common-skeleton + arch-hooks approach, not a plain move. Track PMU with the device-side unification effort.

Device memory-ordering / transport change → must be onboard-validated on both arches (sim does not exercise the SVM-vs-shadow transport difference).

### Priority

Low (no impact today, good to fix eventually)

Related: #1247 (device-side plumbing unification — the collector axis; this issue is the arch axis), #1251 (all-SPSC buffer-pool redesign). Reference precedent: TensorDump & ScopeStats are already fully common.

---

## #1260 [Bug] cpput test_scheduler hangs the PR ut(ubuntu/macos) job into the 15-min cap (flaky, multi-PR)

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1260
- Created: 2026-07-03T01:36:08Z
- Updated: 2026-07-03T03:35:13Z
- Closed: 2026-07-03T03:35:13Z
- Labels: bug

### Body

## Platform
GitHub Actions `ut (ubuntu-latest, 3.10)` and `ut (macos-latest, 3.10)` jobs (PR-only — these jobs do not run on `main`).

## Runtime Variant
N/A — pure C++ unit test (`tests/ut/cpp/hierarchical/test_scheduler.cpp`), not a runtime variant.

## Description
The `ut (ubuntu)` / `ut (macos)` CI jobs (which build and run the full `tests/ut/cpp/` GoogleTest tree as step "Build and run C++ unit tests") are intermittently hanging on `test_scheduler` (CTest test #5). Tests 1–4 (`test_tensormap`, `test_ring`, `test_scope`, `test_orchestrator`) pass in <1 s each, then `test_scheduler` starts and runs until the job's 15-minute cap cancels the whole job (`The job has exceeded the maximum execution time of 15m0s` / `The operation was canceled`).

This is hitting **multiple unrelated PRs**, not tied to any one change.

## Steps to Reproduce
Open a PR that triggers the `ut` job. The `test_scheduler` test hangs ~10+ min and the job is cancelled at the 15-min cap. Observed on:
- PR #1259 (dead-code cleanup in `worker_manager` — behavior-preserving rename + zero-caller deletions): run [28585117505](https://github.com/hw-native-sys/simpler/actions/runs/28585117505) and rerun [28631057805](https://github.com/hw-native-sys/simpler/actions/runs/28631057805) — both cancelled at `test_scheduler` (e.g. ubuntu started test #5 at 01:24:06, cancelled at 01:05:27 / 01:34:xx).
- PR on `l3-l2-orch-message-queue` (different feature, run [28584354306](https://github.com/hw-native-sys/simpler/actions/runs/28584354306)) — same symptom: `Start 5: test_scheduler` at 13:33:53, cancelled at 13:45:22.
- Also seen cancelling sibling `ut` jobs on `docs/...` and other PRs via the matrix `strategy` cancellation.

## Expected Behavior
`test_scheduler` completes in bounded time (like tests 1–4) and the `ut` job goes green.

## Actual Behavior
`test_scheduler` hangs indefinitely; the 15-min job cap cancels the job as `cancelled`. Locally the cpput tree can't be linked (a separate pre-existing gtest `_GLIBCXX_USE_CXX11_ABI` mismatch on this dev box), so I could not reproduce or root-cause locally — the hang is CI-only so far.

## Notes
- `main` does **not** run the `ut(ubuntu/macos)` job (it's PR-only), so this never surfaces post-merge — only blocks PRs.
- `test_scheduler` uses several spin-wait/`condition_variable::wait` patterns (`MockMailboxWorker::loop`, `wait_running`, `wait_consumed`); a deadlock or missing wakeup under CI runner timing is the likely shape, but unconfirmed.
- Flagging per the `/fix-pr` "unrelated and flaky still aren't ignore" rule. I am not asserting any particular PR caused it; the evidence (hang on a behavior-preserving cleanup PR + an unrelated feature PR) points to a pre-existing race in the test that surfaces under CI.

/cc any maintainer familiar with the hierarchical scheduler test.

---

## #1261 [Code Health] Warn when task fanin/fanout exceeds 16 during dependency construction

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1261
- Created: 2026-07-03T01:40:15Z
- Updated: 2026-07-09T12:17:12Z
- Closed: 2026-07-09T12:17:12Z
- Labels: code health

### Body

### Category

Robustness (potential edge-case failure)

### Component

AICPU Scheduler

### Description

When the orch submit path and scheduler thread 0 build task dependencies, the runtime constructs each task's fanin/fanout relationship. Very large fanin or fanout can make dependency wiring harder to reason about and may indicate an unexpectedly broad dependency shape.

Add a warning diagnostic when a task's fanin or fanout is greater than 16. The warning should identify the task and whether the high-water value is fanin or fanout, so workload authors can spot unusually dense dependency graphs early.

Because this is on the AICPU scheduler/orchestration path, the warning should avoid hot-path log flooding. Prefer logging only when the threshold is crossed for a task, or as a high-water diagnostic, rather than logging unconditionally in an inner loop.

Related: #959

### Location

- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/pto_orchestrator.cpp`
- `src/a2a3/runtime/tensormap_and_ringbuffer/runtime/scheduler/pto_scheduler.h`

### Proposed Fix

During dependency construction, track the computed fanin/fanout count for each task. If either count is greater than 16, emit a bounded warning log that includes at least:

- task id / slot id if available
- fanin count
- fanout count
- the dependency-construction phase where the value was observed

Keep the diagnostic bounded to avoid per-edge or per-iteration AICPU logging.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1281 [Code Health] Apply L2 host collector sharding optimization to non-L2 profiling collectors

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1281
- Created: 2026-07-07T03:29:11Z
- Updated: 2026-07-13T09:44:45Z
- Closed: 2026-07-13T09:44:45Z

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Other (please specify in description)

### Description

PR #1273 shards the L2 swimlane host-side collector accumulation path, but the profiling framework has several other collectors that were not part of that change: PMU, DepGen, TensorDump, and ScopeStats.

This issue tracks the follow-up work to audit those non-L2 profiling collectors and apply the same class of optimization where it is applicable. The target is parity with the L2 host pipeline improvements: static shard ownership or an equivalent per-collector ownership model, reduced shared collector-side serialization, and no unnecessary cross-shard lock contention on hot collection paths.

This is intentionally separate from the broader device-side/common-code cleanup work. #1247 covers extracting the AICPU-side profiling operation layer into a templated engine. #1253 covers arch-axis dedup/commonization for L2Swimlane and DepGen. This issue is specifically about whether the non-L2 host-side collector accumulation paths need the same performance-oriented sharding/update that L2 received.

### Location

- `src/{a2a3,a5}/platform/shared/host/pmu_collector.cpp`
- `src/{a2a3,a5}/platform/shared/host/dep_gen_collector.cpp`
- `src/common/platform/shared/host/tensor_dump_collector.cpp`
- `src/common/platform/shared/host/scope_stats_collector.cpp`
- Host trait/header surfaces, as needed:
  - `src/{a2a3,a5}/platform/include/host/{pmu,dep_gen}_collector.h`
  - `src/common/platform/include/host/{tensor_dump,scope_stats}_collector.h`
  - `src/common/platform/include/host/profiler_base.h`

### Proposed Fix

Audit PMU, DepGen, TensorDump, and ScopeStats collector pipelines against the L2 sharded collector design from PR #1273:

1. Identify whether each collector has a host-side accumulation bottleneck similar to L2.
2. For affected collectors, introduce static shard ownership or an equivalent per-tool design that avoids shared hot-path collector serialization.
3. Preserve each tool-specific record semantics, ordering requirements, buffer lifecycle, and memory-copy behavior.
4. Add targeted stress or synthetic validation where useful, so the change can be evaluated without relying on one specific model/example.
5. Validate on both a2a3 and a5 where the collector exists or shares common code.

This issue does not require making every profiling tool structurally identical. If a tool is already single-owner or not bottlenecked in the same way, document that conclusion and leave it unchanged.

Related: #1247, #1253, #1273.

### Priority

Medium (minor risk, should fix in next few releases)

---

## #1284 Managed PTO-ISA checkout can fail on dirty tracked files in macOS sim CI

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1284
- Created: 2026-07-07T07:20:15Z
- Updated: 2026-07-07T07:45:43Z
- Closed: 2026-07-07T07:45:43Z

### Body

## Background

macOS sim CI prepares a managed PTO-ISA checkout before running pytest with `--require-pto-isa`. The installed checkout lives under a path like:

```text
simpler_setup/_assets/build/pto-isa
```

That checkout is expected to match the commit pinned by `pto_isa.pin`.

## Problem

In PR #1262, the macOS sim jobs repeatedly failed before any pytest case started:

```text
Failed to checkout pto-isa commit 83d01313d9bfc247c4b7c8bcf969d1019f0d106f:
error: Your local changes to the following files would be overwritten by checkout:
  docs/figures/isa/TAddDeqRelu.svg
  docs/isa/TAddDeqRelu.md
  docs/isa/TAddDeqRelu_zh.md

Exit: PTO-ISA required but unavailable: PTO-ISA not available.
```

The failure happens while restoring the managed PTO-ISA checkout to the pinned commit, not while running the actual test cases.

## Impact

- `st-sim-a2a3 (macos-latest, 3.10)` fails.
- `st-sim-a5 (macos-latest, 3.10)` fails.
- Linux sim jobs can be cancelled as a follow-up effect.
- Unrelated PRs can be blocked by dirty state inside the managed dependency checkout.

## Proposed Fix

The managed PTO-ISA checkout is not a user workspace. Its purpose is to match `pto_isa.pin`, so local dirty state inside that dependency checkout should not block recovery.

Use a forced detached checkout when moving the managed checkout to the pinned commit:

```bash
git checkout --force --detach <pin>
```

Keep the existing `reset --hard`, `clean -fdx`, fetch fallback, and HEAD verification flow.

## Related PR

Fix PR: #1283


---

## #1299 [Bug] L2 swimlane dispatch flows can anchor on Sched lanes without matching dispatch phase

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1299
- Created: 2026-07-08T10:53:33Z
- Updated: 2026-07-08T10:53:33Z
- Labels: bug

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

tensormap_and_ringbuffer

### Description

In an L2 swimlane trace, some `dispatch` flow arrows are emitted from a scheduler lane timestamp even though the raw scheduler phase data has no corresponding visible `dispatch(...)` phase slice on that lane. In Perfetto this makes task launches appear to come directly from a nearby `complete(...)` or `wire(...)` scheduler bar.

Observed in:

- `outputs/TestSpmdSyncStartStress_Case1_20260708_025936/merged_swimlane.json`
- raw source: `outputs/TestSpmdSyncStartStress_Case1_20260708_025936/l2_swimlane_records.json`

For example, `SPMD_MIX_AIV0(t4)` / `SPMD_MIX_AIV0(t5)` have task-level dispatch timestamps in `aicpu_tasks`, but `aicpu_scheduler_phases[0]` has no matching `dispatch` phase around those Sched_0 launch points. The generated trace still emits `dispatch` flow starts on `pid=2, tid=Sched_0`, so the visual source is a bare scheduler timestamp rather than a real dispatch slice.

Related: #995

### Steps to Reproduce

1. Generate or open the L2 swimlane output for `TestSpmdSyncStartStress_Case1_20260708_025936`.
2. Preview `outputs/TestSpmdSyncStartStress_Case1_20260708_025936/merged_swimlane.json` in Perfetto UI.
3. Inspect `Sched_0` around the `SPMD_MIX_AIV0(t4)` / `SPMD_MIX_AIV0(t5)` launches.
4. Compare against `outputs/TestSpmdSyncStartStress_Case1_20260708_025936/l2_swimlane_records.json`:
   - `aicpu_tasks` contains per-task dispatch timestamps.
   - `aicpu_scheduler_phases[0]` has nearby `complete` / `release` records but no corresponding `dispatch` phase slice.

### Expected Behavior

The swimlane should not visually imply that `complete` or `wire` directly launches AICore tasks.

If a `dispatch -> task` flow is drawn, its source should be anchored to a real visible `dispatch(...)` scheduler phase when one exists. If the scheduler phase data lacks a matching dispatch slice, the trace should make that explicit, for example by adding a short synthetic task-level dispatch marker or by separating/renaming the task-level dispatch flow so it cannot be mistaken for a complete/wire-originated launch.

### Actual Behavior

`merged_swimlane.json` contains `dispatch` flow events from `Sched_0` task-level dispatch timestamps, but there is no corresponding visible `dispatch(...)` scheduler phase slice on `Sched_0` in the raw scheduler phase data.

As a result, Perfetto renders the flow from a bare point on the scheduler lane. Since the nearest visible scheduler bars are `complete(...)` / `wire(...)`, the graph can look like `complete` or `wire` directly connects to AICPU/AICore task slices.

### Git Commit ID

3aa7f26d5435497dc0c5d803bab7a34e69f14480

### CANN Version

Not captured. `/usr/local/Ascend/ascend-toolkit/latest/version.cfg` was not available in this environment.

### Driver Version

`npu-smi` version reported `26.0.rc1`.

### Host Platform

Linux (aarch64)

### Additional Context

This appears to be a mismatch between two raw data sources:

- `aicpu_tasks.dispatch_cycles` records a task-level dispatch timestamp.
- `aicpu_scheduler_phases` may not contain a matching `dispatch` phase bar on the same scheduler lane.

The converter currently uses the task-level timestamp plus `core_to_thread` to place `dispatch` flow starts on the scheduler lane. That is useful information, but without a corresponding scheduler phase marker it can be visually misleading.


---

## #1306 [Bug] Task dep-gen misses WAR edge: reader task not ordered before a later aliasing inout writer

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1306
- Created: 2026-07-09T11:25:00Z
- Updated: 2026-07-16T00:48:03Z
- Closed: 2026-07-16T00:48:03Z
- Labels: bug

### Body

## Background

In pypto-lib, a fused per-band MLP for `models/qwen3/14b/prefill_fwd.py` on `a2a3` produced wrong results (golden ~10% off) when two bands reused one loop-carried accumulator buffer. Reducing it isolated a **runtime task-dependency (WAR) bug**: the runtime does not order a later loop iteration's *writer* task after the current iteration's *reader* task when they alias the same buffer. Minimal reproducer below fails deterministically.

Reproduce with:

    python models/qwen3/14b/war_repro_draft.py -p a2a3 -d <device>

Reproduction environment:

| Component | Version |
|---|---|
| pypto-lib | `198ab5a` (branch: `main`) |
| pypto | `10d6b128` (branch: `main`) |
| simpler | `c94aa9f3` (pin) |
| pto-isa | `83d01313` |
| CANN | `9.0.0` |
| Driver | `26.0.rc1` |

Diagnosis: **simpler** — task dependency generation misses the write-after-read (WAR) anti-dependency between a pure-reader task and a later aliasing inout writer.

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

All / Unknown

### Description

The task-graph dependency generation does not emit a **WAR (write-after-read)** edge from a *reader* task to a subsequent *writer* task that aliases the same tensor across a loop.

Pattern (one `create_tensor` buffer `buf`, carried across a `pl.range` loop):

- iteration N: **writer** task takes `buf` `add_inout` (RMW) → **reader** task takes `buf` `add_input` (pure read)
- iteration N+1: **writer** task takes `buf` `add_inout` again

The runtime emits `writer(N) → reader(N)` (RAW) and `writer(N) → writer(N+1)` (WAW), but **not** `reader(N) → writer(N+1)` (WAR). Because the reader produces no new version of `buf`, the loop carries the writer's output forward, so iteration N+1's writer depends only on iteration N's writer — never on iteration N's reader. The runtime is then free to run writer(N+1) concurrently with reader(N), overwriting `buf` while reader(N) is still reading it → data race.

This is visible directly in the generated orchestration (single `buf`, `add_inout` in writer, `add_input` in reader):

```cpp
// Generated orchestration: war_repro.cpp  (buf = alloc_tensors(...), created ONCE)
for (int64_t b = 0; b < 2; b += 1) {
    PTO2_SCOPE() {
        // Spmd writer_spmd: writer
        L0TaskArgs params_t0;
        params_t0.add_inout(buf);          // writer RMW on buf
        params_t0.add_input(ext_src);
        params_t0.add_scalar(b);
        params_t0.launch_spec.set_block_num(24);
        rt_submit_aiv_task(0, params_t0);

        // Spmd reader_spmd: reader
        L0TaskArgs params_t1;
        params_t1.add_inout(ext_out);
        params_t1.add_input(buf);          // reader pure-read of buf
        params_t1.add_scalar(b);
        params_t1.launch_spec.set_block_num(24);
        rt_submit_aiv_task(1, params_t1);
    }
}
```

Expected: `writer(b=1)` (add_inout buf) waits for `reader(b=0)` (add_input buf) — a WAR edge. Actual: no such edge; `writer(b=1)` overwrites `buf` while `reader(b=0)` reads it.

### Steps to Reproduce

Minimal standalone frontend (no matmul; two loop iterations; writer `inout` + reader pure-read of one carried buffer):

```python
import pypto.language as pl

BANDS = 2
M = 128
N = 8704          # large enough that writer/reader overlap in time
CHUNK = 256
NCHUNKS = N // CHUNK
SPMD = 24


@pl.jit
def war_repro(
    src: pl.Tensor[[BANDS * M, N], pl.FP32],
    out: pl.Out[pl.Tensor[[BANDS * M, N], pl.FP32]],
):
    buf = pl.create_tensor([M, N], dtype=pl.FP32)
    for b in pl.range(BANDS):          # buf loop-carried across bands
        # writer: overwrite buf from src[b]  (inout)
        for wcore in pl.spmd(SPMD, name_hint="writer_spmd"):
            for cc in pl.range(wcore, NCHUNKS, SPMD):
                c0 = cc * CHUNK
                s = pl.slice(src, [M, CHUNK], [b * M, c0])
                buf = pl.assemble(buf, s, [0, c0])
        # reader: copy buf -> out[b]  (pure read)
        for rcore in pl.spmd(SPMD, name_hint="reader_spmd"):
            for cc in pl.range(rcore, NCHUNKS, SPMD):
                c0 = cc * CHUNK
                r = pl.slice(buf, [M, CHUNK], [0, c0])
                out = pl.assemble(out, r, [b * M, c0])
    return out
```

Harness init: `src[band0]=1.0`, `src[band1]=2.0`; golden `out = src`. Run:

    python models/qwen3/14b/war_repro_draft.py -p a2a3 -d <device>

Full repro file: `models/qwen3/14b/war_repro_draft.py` in pypto-lib.

### Expected Behavior

`out[band0] == src[band0] == 1.0` and `out[band1] == src[band1] == 2.0`, i.e. each band's reader sees its own writer's data (WAR ordering enforced).

### Actual Behavior

Golden FAILs deterministically:

```
'out' FAIL  shape=(256, 8704)
Mismatched elements: 392704/2228224  rtol=0.0 atol=0.0
[0] actual=2.0, expected=1.0
[1] actual=2.0, expected=1.0
...
```

`out[band0]` contains `2.0` (band1's writer data) in ~35% of its columns — band0's reader read `buf` after band1's writer overwrote it. Missing WAR edge → race.

### Git Commit ID

c94aa9f359a6c1825c9ba71ecf25576f1fa045b1

### CANN Version

9.0.0

### Driver Version

26.0.rc1

### Host Platform

Linux (aarch64)

### Additional Context

Real-kernel manifestation: in `models/qwen3/14b/prefill_fwd.py`, a fused per-band MLP shared the gate/up/silu accumulator buffers across the two MLP bands to force a band0→band1 software pipeline. gate is `inout`, silu is a pure `input` reader of the gate accumulator; band1's gate raced band0's silu exactly as above, corrupting ~10% of logits. Per-band-private buffers (no aliasing) are correct — this repro is the minimized aliasing case.

Related: `hw-native-sys/pypto-lib#481` — a sibling WAR-anti-dependency miss, but at the orchestration auto-dep layer (a gather `add_input` view + writeback `add_output` view of the same external inout tensor get no WAR edge). This issue is the runtime task-scheduler layer: the orch emits correct `add_inout`/`add_input` annotations (see war_repro.cpp above), but the runtime dep-gen does not derive the `reader → next-iteration writer` WAR edge from them.


---

## #1315 [Code Health] Require upgraded a5 environment supporting sdma

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1315
- Created: 2026-07-10T01:47:57Z
- Updated: 2026-07-13T11:30:25Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Host Runtime

### Description

PR #1179 landed the a5 SDMA workspace overlay (`ensure_sdma_workspace` → `aclnnShmemSdmaStarsQuery`) but gated it behind an opt-in macro because the available a5 CANN drops do not expose working SDMA primitives:

- CANN 9.1.T500: `aclnnShmemSdmaStarsQuery` creates STARS streams but `aclrtSynchronizeStream` fails with AICPU exception `0x715002a`, which poisons the AICPU context and turns every subsequent kernel launch into `507018`. This breaks **all** a5 communication cases, not just the SDMA demo.
- CANN 9.1.0 (`timestamp=20260625`): `HcclCommInitRootInfo` itself returns `HCCL_E_INTERNAL (4)` — base HCCL never comes up.

The overlay was verified working on a separate a5 box whose CANN does expose the primitive (`sdma_async_completion_demo` passes). So this is purely an environment gating issue, not a code defect.

Currently the overlay defaults OFF via `option(SIMPLER_ENABLE_PTO_SDMA_WORKSPACE ... OFF)` and the `SIMPLER_ENABLE_PTO_SDMA_WORKSPACE` env var. With it OFF: `ensure_sdma_workspace` is a no-op, `CommContext.workSpace` stays 0, the SDMA demo self-skips, and all other comm cases run normally.

### Location

```markdown
- `src/a5/platform/onboard/host/CMakeLists.txt` — `option(SIMPLER_ENABLE_PTO_SDMA_WORKSPACE ... OFF)` + conditional `PTO_ISA_ROOT` guard
- `simpler_setup/runtime_compiler.py` — `_init_a5` conditional `PTO_ISA_ROOT` ensure + `_sdma_workspace_enabled()`
- `simpler_setup/runtime_builder.py` — `_compile_target` env-var→CMake-define forwarding
- `examples/a5/tensormap_and_ringbuffer/sdma_async_completion_demo/test_sdma_async_completion_demo.py` — `pytest.skip` when env var unset
```

### Proposed Fix

Once the st-onboard-a5 CI CANN exposes a working `aclnnShmemSdmaStarsQuery` (verify with `nm -D $ASCEND_HOME_PATH/lib64/libascendcl.so | grep -ic SdmaStars`), re-enable the overlay. Two options:

**Option A — CI env var only (no code change):** set `SIMPLER_ENABLE_PTO_SDMA_WORKSPACE=ON` (plus `PTO_ISA_ROOT`) in the st-onboard-a5 job. The existing env-var→CMake define forwarding and test skip gate pick it up automatically.

**Option B — make SDMA the a5 default (revert the gating, 4 spots):**

1. `CMakeLists.txt`: `option(... OFF)` → `set(SIMPLER_ENABLE_PTO_SDMA_WORKSPACE ON)`; move `PTO_ISA_ROOT` check + pto-isa include back out of the `if`-guard.
2. `runtime_compiler.py _init_a5`: make `env_manager.ensure("PTO_ISA_ROOT")` unconditional again (mirror `_init_a2a3`).
3. `runtime_builder.py _compile_target`: the env-var→define forwarding can stay (harmless) or be removed.
4. `test_sdma_async_completion_demo.py`: remove the env-var `pytest.skip` gate.

Optionally also have `build_runtimes.py` auto-resolve `PTO_ISA_ROOT` for a5 the same way it does for a2a3 (lines 120–125), so callers do not need to set it manually.

Verification after re-enabling:
```bash
python -m pytest examples/a5/tensormap_and_ringbuffer/sdma_async_completion_demo/test_sdma_async_completion_demo.py -v --platform a5 --device <ids> -s
python -m pytest examples/workers/l3/allreduce_distributed/test_allreduce.py -v --platform a5 --device <ids> -k onephase
```
The SDMA demo must PASS (not skip) and the allreduce regression must stay green.

### Priority

Low (no impact today, good to fix eventually)

---

## #1317 [Code Health] tensor_dump mask pool should hash opaque task_id, not unpack runtime ring_id

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1317
- Created: 2026-07-10T02:55:10Z
- Updated: 2026-07-10T09:08:48Z
- Closed: 2026-07-10T09:08:48Z
- Labels: code health

### Body

### Category

Technical Debt (cleanup, refactor)

### Component

Platform (a2a3 / a2a3sim)

### Description

The dump-args mask pool in the platform layer (`tensor_dump_aicpu.cpp`) unpacks the runtime's `task_id` into `(ring_id, slot)` and gates on `PLATFORM_DUMP_MASK_POOL_MAX_RINGS`, making the **platform aware of runtime ring-depth**. This is unnecessary coupling.

The pool is a plain open-addressed hash table keyed by the full 64-bit `task_id` (each entry stores the complete `task_id` and probes on collision):

```cpp
static bool resolve_dump_args_task_slot(uint64_t task_id, uint32_t *idx_out) {
    uint32_t ring_id = static_cast<uint32_t>(task_id >> 32);
    if (ring_id >= TENSOR_DUMP_MASK_POOL_MAX_RINGS) return false;   // (a) bound check
    uint32_t slot = static_cast<uint32_t>(task_id) & TENSOR_DUMP_MASK_POOL_DEFAULT_SLOT_MASK;
    *idx_out = (ring_id * TENSOR_DUMP_MASK_POOL_MAX_SLOTS + slot) & (DUMP_TASK_MASK_TABLE_CAPACITY - 1);  // (b) hash
    return true;
}
```

`task_id.raw` (`(ring_id << 32) | local_id`) is **already a globally unique key**. For a hash table keyed by it, the platform can treat `task_id` as an opaque 64-bit integer:
- **(a)** the `ring_id >= MAX_RINGS` bound-check is not needed — any `task_id` can enter the table.
- **(b)** the `ring_id * MAX_SLOTS + slot` split is just one hash function; hashing the whole `task_id` (e.g. `task_id ^ (task_id >> 32)`) distributes at least as well.

**Why this matters:** because the platform assumes the ring layout, it must know "how many rings max", which is exactly what caused the recent coupling bug — `tensor_dump.h` keyed `TENSOR_DUMP_MASK_POOL_MAX_RINGS` to a runtime's `PTO2_MAX_RING_DEPTH`, so `host_build_graph` (single-ring) lowering its depth silently broke `tensormap_and_ringbuffer`'s `--dump-args` (rings 1/2/3 rejected by the bound check). PR #1185 stopped the bleeding by making the constants platform-level (`PLATFORM_DUMP_MASK_POOL_MAX_RINGS = 4 = max over runtimes`), but that preserved the unnecessary ring-depth awareness rather than removing it.

**Contrast — where ring_id awareness IS legitimate:** `scope_stats_collector_aicpu.cpp` uses `ring_id` to index physical per-ring heap regions (`s_heap_wraps[ring_id][side] * heap_cap[ring_id]`). There the ring is real device layout, so the platform must know it. tensor_dump's pool is a pure key lookup — no per-ring physical structure — so the ring split is superfluous.

### Location

`src/common/platform/shared/aicpu/tensor_dump_aicpu.cpp` — `resolve_dump_args_task_slot`, `set_dump_args_task_mask`, `get_dump_args_task_masks` (the three `ring_id` / `MAX_RINGS` sites).

Constants to remove: `PLATFORM_DUMP_MASK_POOL_MAX_RINGS` / `PLATFORM_DUMP_MASK_POOL_MAX_SLOTS` in `src/a2a3/platform/include/common/platform_config.h` and `src/a5/platform/include/common/platform_config.h`; and `TENSOR_DUMP_MASK_POOL_MAX_RINGS` / `TENSOR_DUMP_MASK_POOL_MAX_SLOTS` / `TENSOR_DUMP_MASK_POOL_DEFAULT_SLOT_MASK` in the two `tensor_dump.h`.

### Proposed Fix

Hash the opaque `task_id` directly for the mask-pool index and drop the ring-depth awareness entirely:

```cpp
static bool resolve_dump_args_task_slot(uint64_t task_id, uint32_t *idx_out) {
    uint64_t h = task_id ^ (task_id >> 32);              // or a stronger 64->32 mix
    *idx_out = static_cast<uint32_t>(h) & (DUMP_TASK_MASK_TABLE_CAPACITY - 1);
    return true;                                          // no ring bound-check
}
```

Then delete the `PLATFORM_DUMP_MASK_POOL_MAX_*` and `TENSOR_DUMP_MASK_POOL_MAX_*` constants. Net effect: the platform tensor-dump code becomes fully agnostic to any runtime's ring depth — a runtime changing `PTO2_MAX_RING_DEPTH` can never again affect dump-args. Verify `--dump-args` still selects the right tasks on both `tensormap_and_ringbuffer` (4-ring) and `host_build_graph` (1-ring), sim + onboard.

Related: #1252 (rename TensorDump implementation to ArgsDump) touches the same subsystem — worth coordinating so the rename and this decoupling land coherently.

---

## #1325 [Feature] Add lightweight selective task dispatch/finish timing slots

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1325
- Created: 2026-07-11T07:19:40Z
- Updated: 2026-07-11T07:19:40Z
- Labels: enhancement

### Body

### Summary

Add 16 fixed, per-run task-timing slots to the existing lightweight AICPU device-phase transport. Orchestration can attach an optional slot id (`0..15`) to selected L2 tasks, and the Scheduler records the task/window's AICPU `dispatch` and `finish` timestamps into that slot.

The host should reset the slots before each run, read them back once after stream synchronization, and expose each valid slot on the existing device-clock `[STRACE]` timeline. This path must work with L2 swimlane disabled and must not start L2 collector threads or write per-task AICore profiling records.

### Motivation / Use Case

L2 swimlane can capture every task's AICore start/end and AICPU dispatch/finish timestamps, but that is much heavier than many day-to-day measurements require. Enabling it allocates rotating record pools, runs host collector threads, stamps every task on AICPU/AICore, and performs AICore record write-back. The measured observer effect for back-to-back AICore tasks is about 0.8 us per switch, dominated by timestamp reads and record write-back.

A common question is much smaller: measure the interval from task A's first Scheduler dispatch to task B's final Scheduler-observed completion. The orchestrator knows which tasks bound that interval, but it cannot observe their asynchronous execution. The Scheduler already owns the exact dispatch and FIN-observation points, so selected fixed slots provide the needed answer without collecting a full timeline.

The repository already has the right transport: the device-phase buffer is host-allocated, reset with one H2D copy before a run, written by AICPU, and read with one D2H copy after the streams synchronize. Extending that fixed buffer by 16 small records is sufficient.

### Proposed API / Behavior

A suggested RT2 API is an optional field on `L0TaskArgs`, which avoids changing the `PTO2RuntimeOps::submit_task` function-pointer ABI:

```cpp
L0TaskArgs first_args;
first_args.set_task_timing_slot(0);
rt_submit_aiv_task(FIRST_KERNEL_ID, first_args);

L0TaskArgs last_args;
last_args.set_task_timing_slot(1);
rt_submit_aiv_task(LAST_KERNEL_ID, last_args);
```

`L0TaskArgsWithDeps` should forward the same setter. The legacy a5 `host_build_graph` orchestration API needs an equivalent way to set the slot on a submitted task.

Required behavior:

- Provide 16 slots. The default sentinel means "not recorded"; valid ids are `0..15`. Out-of-range ids fail through the existing invalid-argument path and never write out of bounds.
- Carry the id from Orch to Scheduler with the task metadata. In RT2, the 4-byte alignment gap after `PTO2TaskDescriptor::kernel_id[3]` can hold the id without growing the descriptor; protect that property with size/offset assertions.
- Extend the existing device-phase allocation with a dedicated per-Scheduler-thread `TaskTimingRecord[16]` tail rather than turning these records into named `AicpuPhase` enum values. This preserves the current once-per-run phase contract while reusing the same base pointer and H2D/D2H copies.
- For each slot, aggregate `min(dispatch_cycle)` and `max(finish_cycle)` across participating Scheduler threads. Reusing a slot for multiple tagged tasks intentionally produces the window from the earliest tagged dispatch to the latest tagged finish; using distinct slots preserves each task's own window and lets tooling compute `finish(B) - dispatch(A)`.
- `dispatch` means the earliest Scheduler publication of `DATA_MAIN_BASE`, after payload publication and immediately before the register write. Pending/speculative early dispatch therefore records the initial gated publication, not the later doorbell release or exact AICore kernel start.
- `finish` means the latest Scheduler observation of FIN across every required block/subtask, sampled after the COND load + `rmb()` and before fanin/fanout/deferred-completion processing. It matches the existing L2 swimlane `finish_time` definition; it is not the AICore kernel-end timestamp or completion of later deferred conditions.
- Emit every complete slot as a stable device-clock span such as `simpler_run.runner_run.device_wall.task_slot_0`, retaining start and end so cross-slot intervals are recoverable. Keep `Worker.run()` returning `None`; `[STRACE]` remains the timing source of truth.
- Reset all slots every run. Unset or incomplete slots are skipped, so a failed/short run cannot leak stale data from the previous run.
- Untagged tasks must not call `get_sys_cnt_aicpu()`, write timing records, or enable L2 collectors. Their only incremental hot-path work should be the cache-hot sentinel check. Do not add a new environment variable or compile-time behavior gate; explicit task tagging is the opt-in. The feature should remain available in `SIMPLER_DFX=0` builds.
- Support a2a3/a5, onboard/sim, and both `tensormap_and_ringbuffer` and `host_build_graph`. The a5 `host_build_graph` path uses its legacy `Runtime::Task` representation, so it needs a small compatibility implementation rather than assuming the RT2 descriptor path.

### Alternatives Considered

- **Use L2 swimlane level 2.** It already exposes dispatch/finish, but still records every task and retains the AICore timing/rotation path. That is the overhead this feature is intended to avoid.
- **Measure in Orch.** Orch only creates/submits the DAG; execution is asynchronous, so an Orch timestamp cannot represent task completion.
- **Store the records in the PTO2 shared-memory header.** This duplicates host/device transport logic and complicates a5 host-shadow handling. The existing fixed device-phase buffer already supplies reset, publication, conversion, and readback on both architectures.
- **Add 16 ordinary `AicpuPhase` entries.** Task slots can receive multiple block/subtask events per Scheduler thread, while `AicpuPhase` is explicitly a small set of phases that fires once per run/thread. A dedicated fixed tail keeps those contracts separate.

### Additional Context

Relevant implementation seams:

- Fixed device-phase contract and records: `src/common/platform/include/common/device_phase.h`
- AICPU phase-buffer accessors: `src/common/platform/include/aicpu/device_phase_aicpu.h`
- Onboard H2D reset / D2H reduce: `src/common/platform/onboard/host/device_runner_base.cpp`
- Host marker emission: `src/common/platform/{onboard,sim}/host/c_api_shared.cpp`
- Orch API and task metadata: `src/{arch}/runtime/*/{orchestration,runtime}/`
- RT2 dispatch/finish boundaries: `runtime/scheduler/scheduler_dispatch.cpp` and `scheduler_completion.cpp`
- Legacy a5 host-build-graph task path: `src/a5/runtime/host_build_graph/`
- Existing timing docs: `docs/dfx/device-phases.md`, `docs/dfx/l2-timing.md`, and `docs/dfx/l2-swimlane-profiling.md`

Acceptance coverage should include:

1. Unit coverage for Arg-to-descriptor propagation, slot bounds/sentinel, fixed-buffer layout, cross-thread min/max reduction, incomplete slots, and per-run reset.
2. End-to-end sim coverage with L2 swimlane off for a normal chain plus MIX/SPMD tasks, proving earliest-dispatch/latest-FIN aggregation and stable `task_slot_N` markers.
3. Parity coverage for a2a3/a5 and both runtime variants, including the legacy a5 host-build-graph path.
4. At least one onboard check of the real H2D/D2H path, following the repository's architecture precheck and `task-submit` rules.
5. Updated device-phase/L2-timing/runtime documentation, including early-dispatch, deferred-completion, duplicate-slot, dummy-task, and `SIMPLER_DFX=0` semantics.

Related: #995, #1299


---

## #1341 [Performance] AICPU scheduler: one thread hoards running+pending slots, starving sibling threads' idle AICores

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1341
- Created: 2026-07-12T11:06:23Z
- Updated: 2026-07-15T10:41:15Z
- Labels: performance

### Body

### Platform

a2a3 (Ascend 910B/C hardware)

### Runtime Variant

host_build_graph

### Summary

Under load imbalance, a single AICPU scheduler thread can drain the shared ready queue to fill **both** the `running` and `pending` slots of all its own cores (with separate single-core C/AIC and V/AIV tasks). Because cores are statically partitioned per scheduler thread and the ready queues are the only cross-thread work-sharing surface, this hoarding starves **sibling** scheduler threads: their idle cores' `running` slots find the queue already empty, so those AICores sit idle while the hoarding thread holds a backlog parked in `pending` slots that cannot execute until its own `running` tasks FIN.

The `pending` slot is a latency-hiding prefetch — it only runs after the core's current `running` task finishes. Parking a task there is strictly worse than running it *now* on an idle sibling core. There is a guard (`has_idle_in_other_threads`) meant to suppress the pending pre-load when a peer is idle, but it is an advisory, racy, instantaneous snapshot and leaks in practice.

**Root cause (three structural gaps):**

1. **Racy instantaneous gate.** `has_idle_in_other_threads` reads peer `core_states_` with no synchronization (self-described as a "hint"). If a peer's cores are momentarily all-busy at check time, the gate passes and the thread pre-loads pending; a moment later the peer FINs and finds the queue drained.
2. **Physically-idle peer reads as "running" until reaped.** `core_states_` only flips when the *owning* thread runs its completion poll. A core hardware has already finished, but whose owner is mid-poll on a long task, still reads "busy" to the gate — widening the race into a steady-state effect under imbalance.
3. **No global IDLE barrier across threads.** Every thread runs its own completion->dispatch loop independently (`resolve_and_dispatch`). A thread that finishes its completion scan first races ahead into the PENDING pre-load stage while slower siblings haven't reached their IDLE fill yet, emptying the queue before they can claim.

Note: the early-dispatch path (Phase 4b) is gated off whenever any ready queue is non-empty, so under queue pressure only this PENDING pre-load is active — precisely when hoarding hurts.

### Git Commit ID

0608635c700ef5275a8800f25687073b2039065d

### Driver Version

26.0.rc1 (npu-smi 26.0.rc1)

### Host Platform

Linux (aarch64)

### Reproduction

Observed via code analysis + L2-swimlane trace inspection, not yet a scripted benchmark (quantifying the throughput delta is the first follow-up — see Additional Context). To reproduce the conditions:

```bash
# Run a workload that emits many independent single-core C (AIC) and V (AIV)
# tasks across >1 AICPU scheduler threads on a2a3 host_build_graph, with a
# SIMPLER_DFX build so the scheduler swimlane is captured. Inspect the trace
# for a window where one scheduler thread's cluster holds running+pending on
# every core while another thread's AICores show idle gaps and the ready
# queue is drained.
python tests/st/a2a3/host_build_graph/<example>/test_<example>.py \
    -p a2a3 -d <dev> --rounds 10
```

### Expected Performance

Ready single-core C/V tasks are distributed so that any idle AICore — on any scheduler thread — pulls a task into its `running` slot and executes immediately. `pending` pre-load only consumes queue tasks when there is genuine surplus beyond all threads' idle running capacity, maximizing concurrent AICore occupancy.

### Actual Performance

One scheduler thread pre-loads both slots of its cores (running + pending), draining the shared queue. Sibling threads' idle AICores cannot claim work and sit idle, so aggregate AICore occupancy drops and wall-clock time increases under load imbalance. The backlog is parked in pending slots that only run serially after each core's current task FINs, instead of running in parallel on the idle siblings now.

### Profiling Data (Optional)

Key code locations:
- Two-phase IDLE->PENDING staging order + cross-thread gate: `src/a2a3/runtime/host_build_graph/runtime/scheduler/scheduler_dispatch.cpp:497-556` (`run_staging_order`)
- Advisory racy idle gate: `scheduler_dispatch.cpp:78-94` (`has_idle_in_other_threads`)
- PENDING pop sized to the thread's own cores, drains shared queue: `scheduler_dispatch.cpp:307-324` (`dispatch_shape`), `get_pending_core_offset_states` `scheduler_types.h:431-451`
- Static per-thread cluster partition: `scheduler_cold_path.cpp:717-733`
- Dual-slot per core: `scheduler_types.h:106-132` (`CoreExecState`)

The a2a3 `tensormap_and_ringbuffer` scheduler shares this two-phase + gate design and is expected to exhibit the same behavior. The a5 `tensormap_and_ringbuffer` scheduler is an older variant without the pending-prefetch split and should not.

### Additional Context

**Priority: High** — reported as a significant throughput concern on real workloads (AICore idle under load imbalance).

Candidate fixes (smallest-change first):
1. Cap the PENDING stage to pre-load at most *k* pending slots per pass, or gate it on a **global** free-running-core count rather than the per-shape racy peer-idle snapshot, so one thread cannot consume the whole queue into pending slots ahead of idle siblings.
2. Make PENDING pre-load conditional on global ready-queue depth exceeding total idle-running capacity (only prefetch on genuine surplus) — directly encodes "an idle core anywhere beats a pending slot here."
3. Reduce staleness of the idle check by eagerly publishing an idle hint on completion before full reaping.

---

## #1344 [Feature] Rebalance DFX recycled buffers across hot and cold collector shards

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1344
- Created: 2026-07-13T06:29:13Z
- Updated: 2026-07-14T06:25:58Z
- Closed: 2026-07-14T06:25:58Z

### Body

### Summary

Add cross-shard load balancing for the DFX profiling framework's recycled
buffer pools. A hot collector/drain shard should be able to consume spare
buffers associated with cold shards before the replenish thread dynamically
allocates another registered buffer batch.

The current buffer lifecycle preserves shard affinity:

```text
ready[q] -> collector[q] -> done[q] -> replenish -> recycled[q]
```

This keeps the ready, done, and recycled hand-offs SPSC, but it also makes
buffer ownership sticky. Under uneven AICPU-thread traffic, a hot shard can
fall below its recycled watermark and trigger allocation while cold shards
still hold unused buffers of the same kind and size.

### Motivation / Use Case

DFX traffic can be strongly imbalanced across AICPU threads or collector
shards. Per-shard watermarks treat a local shortage as a global shortage, so
the single replenish thread may allocate and register new buffers even though
the framework already owns enough compatible buffers in other shards.

The intended outcome is to:

- reduce dynamic buffer allocation/registration under hot/cold shard load;
- retain a safe per-shard reserve so a temporarily cold shard can resume;
- keep the drain hot path allocation-free;
- preserve current buffer ownership, teardown, and SPSC correctness.

### Proposed API / Behavior

No public API change is required. Implement and measure the work in two
independently useful stages.

#### Stage 1: route newly returned buffers to deficit shards

When the replenish thread drains `done_shards_`, do not always return a
collected buffer to its originating `recycled[q]` lane. For compatible buffers
with the same `(kind, buffer_size)`:

1. Track each shard's recycled target, current inventory, and pending inbound
   buffers.
2. Route newly completed buffers to shards with an outstanding deficit,
   preferably using fair/round-robin selection.
3. Return to the origin shard when no compatible shard needs the buffer.
4. Run dynamic watermark allocation only after redistributing the newly
   completed buffers.

This stage preserves the existing SPSC ownership: the replenish thread remains
the only producer for every recycled lane, and each drain shard remains its
lane's only consumer. It gradually corrects imbalance but cannot reclaim
buffers already parked in a permanently cold lane.

#### Stage 2: cooperatively donate existing cold-shard inventory

If Stage 1 does not remove enough allocations, add active redistribution of
buffers already held by cold recycled lanes without making replenish a second
consumer of those SPSC rings:

1. Replenish computes receiver deficits and donor surplus using separate low
   and high watermarks, a donor reserve, and bounded transfer batches.
2. Replenish publishes a donation request for a cold shard.
3. The donor shard's drain thread, which remains the sole consumer of its
   recycled lane, pops only the requested surplus and publishes it to a
   drain-to-replenish SPSC donation queue.
4. Replenish consumes donated buffers and pushes them into the current deficit
   shard's recycled lane.
5. Dynamic allocation remains a bounded-latency fallback when no compatible
   surplus exists or a critical refill deficit persists.

Donation requests must also be serviced during an otherwise idle drain scan;
a cold shard may have no ready-buffer traffic. Teardown must cancel requests
and release or re-home every buffer in donation queues or in-flight state.

#### Balancing and correctness constraints

- Match by `(kind, buffer_size)` and verify that no buffer metadata requires
  permanent thread ownership. L2 Swimlane buffer kinds must not be mixed.
- Use low/high watermark hysteresis and a donor reserve to avoid oscillation or
  draining a shard that is about to become active.
- Account for pending transfers before declaring a deficit and allocating.
- Never lose or duplicate ownership when a donation or destination queue is
  full; reroute or retain the buffer in a framework-owned fallback state.
- Keep balanced workloads on the existing local fast path with no material
  contention regression.

#### Validation

- Add a synthetic hot/cold shard stress shape and count allocation/registration
  calls after startup.
- Compare baseline, Stage 1, and (if needed) Stage 2 allocation counts.
- Verify no increase in dropped records, no cross-kind reuse, no leaks or
  double-free at stop/finalize, and no regression in balanced traffic.
- Land Stage 1 independently and use its measurement to decide whether Stage 2
  is justified.

### Alternatives Considered

- **Have replenish directly pop a cold `recycled[q]` lane.** This creates a
  second consumer alongside the owning drain thread and violates the current
  SPSC contract.
- **Replace all local recycled lanes with one global MPMC pool.** This makes
  sharing direct but adds CAS/contended synchronization to every drain-side
  buffer acquisition and loses locality.
- **Increase every shard's fixed buffer count.** This masks imbalance by
  over-provisioning memory and registration work instead of using already idle
  capacity.

### Additional Context

Relevant implementation and documentation:

- `src/common/platform/include/host/profiler_base.h`
- `src/common/platform/include/host/buffer_pool_manager.h`
- `docs/profiling-framework.md`

Related: #1281, #997, #995.


---

## #1347 [Feature] Predicated dispatch — scheduler evaluates a per-task predicate at the dispatch point

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1347
- Created: 2026-07-13T08:55:12Z
- Updated: 2026-07-14T08:14:43Z
- Closed: 2026-07-14T08:14:43Z
- Labels: enhancement

### Body

## Summary

Add a per-task **dispatch predicate**: a comparison (`operand OP target`) attached
at submit via `args.set_predicate(...)` and evaluated **by the scheduler at the
dispatch point**, not by the orchestrator at submit. When the predicate fails, the
statically-materialized task is retired inline (via the existing dep-only path) with
no AICore dispatch; when it passes, the task dispatches normally (all SPMD blocks).
The predicate's operand is a GM tensor element whose value is produced by a prior
task — the scheduler reads it only once the predicated task is ready, so
orchestration never stalls waiting for that value.

## Motivation / Use Case

This is driven by a concrete requirement in the **lib repo** (pypto-lib):
[**pypto-lib PR #738**](https://github.com/hw-native-sys/pypto-lib/pull/738) —
the DeepSeek-V4 MoE decode optimization.

MoE is sparsely activated: with the DSv4 FLASH preset (`n_routed_experts=256`,
`num_experts_per_tok=6`, decode batch `MOE_TOKENS=8`) and an EP2 layout, a large
fraction of per-expert compute tasks receive **zero tiles** (empty experts). In the
L2 swimlane onboard run, ~47% of the `exp_w2_mm_spmd`-class tasks are empty
(`n_tiles == 0`) yet are still dispatched — pure overhead.

The natural fix is "don't dispatch an expert whose row count is 0". But #738 moved
the tile loop **and** the `pl.read(recv_expert_count)` **into the incore kernel**
(commit 639e777): the kernel now takes the `recv_expert_count` tensor plus a
`local_i` index and does a bare GM read (`int32_t v = recv_expert_count[local_i]`)
instead of receiving an `n_tiles` scalar. **Consequently the orchestrator no longer
has the tile-count value** — it only has the tensor address.

So "skip empty experts" cannot be a value known at submit time. Two options remain:

1. Have the orchestrator read the value itself (`get_tensor_data`) — but that call
   contains a `wait_for_tensor_ready()` and **stalls orchestration** until the
   producer of `recv_expert_count` finishes. This serializes the very pipeline we
   want to keep flowing.
2. Pass the *address + comparison* down and let the **scheduler** read it at the
   dispatch point. Because a task only becomes ready once its dependencies (incl.
   the producer of the predicate operand) have completed, the value is already
   current at that point — so the read is free of any wait, and it overlaps with
   other scheduling work (**pipeline preserved**).

This feature implements option 2. It is deliberately **generalized** — not
special-cased to MoE or to `n_tiles == 0`: any task can carry any
`operand OP target` predicate over a produced tensor element.

## Proposed API / Behavior

Orchestration-side, level-by-level construction mirroring `get_tensor_data`:

```cpp
L0TaskPredicate pred;
pred.operand.tensor  = &recv_expert_count;   // source tensor (GM)
pred.operand.ndims   = 1;                     // dims, as in get_tensor_data
pred.operand.indices[0] = local_i;            // element to read
pred.op     = PredicateOp::GT;                // NONE/EQ/NE/GT/LT/GE/LE
pred.target = 0;                              // compare against
args.set_predicate(pred);                     // no predicate => always dispatch
```

Runtime behavior:

- Submit resolves the operand into a `DispatchPredicate {addr, target, elem_size, op}`
  on the task payload (an absolute GM address + comparison) and sets an
  `active_mask` fast-path bit (`HAS_PREDICATE`).
- The scheduler, at each ready-routing point, checks the bit; if set, it evaluates
  `predicate.pass()` (reads `elem_size` bytes at `addr`, sign-extends, compares).
  PASS => dispatch normally; FAIL => route to the dep-only DUMMY queue and retire
  inline (dependents still unlock).
- Tasks without a predicate never dereference the payload for this — the bit gates it.

## Alternatives Considered

- **Static nullify at submit** (orchestrator decides skip/keep before submit):
  impossible here — post-#738 the orchestrator no longer holds the tile count; the
  value lives only in GM behind a producer dependency.
- **Orchestrator reads the value via `get_tensor_data`**: correct but pays
  `wait_for_tensor_ready()`, stalling orchestration on the operand's producer —
  defeats the pipeline the optimization is meant to preserve.
- **A frontend-only skip in pypto**: the frontend cannot skip a dispatch whose
  condition is only knowable on-device at dispatch time; it needs a runtime
  primitive to express "dispatch iff predicate". This issue is that primitive.

## Additional Context

- Payload layout: `DispatchPredicate` sits at a **fixed offset before the tensor
  array** (cache line 9), so it never shifts when `MAX_TENSOR_ARGS` / `MAX_SCALAR_ARGS`
  change; AICore never reads that cache line (hot/cold split).
- Contract: the predicate tensor's producer **must** be a dependency of the
  predicated task, so the value is current once the task is ready.
- To be implemented in **both** the a2a3 and a5 runtimes.
- Follow-up (separate, lib repo): pypto frontend
  `pl.spmd(predicate=(recv_expert_count[local_i] > 0))` → codegen `set_predicate(...)`.

---

## #1350 [Code Health] Host log prints bare error codes — show what the code means, not just the number

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1350
- Created: 2026-07-13T11:13:42Z
- Updated: 2026-07-13T11:15:25Z
- Labels: code health

### Body

## Problem

When a runtime/driver call fails, the host log prints only the raw integer error code and no indication of what that code *means*. Users (and CI triage) are left with a bare number like `507018` and have to go find someone who knows the CANN code tables.

Representative log lines today:

```
[ERROR] aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018
[ERROR] rtSetDevice(0) failed: 507899
[ERROR] PTO2 runtime failed: orch_error_code=3 sched_error_code=0 runtime_status=2
RuntimeError: run failed with code 507018
```

Nothing on that screen tells you that `507018` is `ACL_ERROR_RT_AICPU_EXCEPTION`, or that `orch_error_code=3` is a specific `PTO2_ERROR_*` condition. The knowledge exists in the repo, but only as prose that never reaches the log:

- `conftest.py:1066-1087` — a comment block documenting `207001 / 507000 / 507018 / 507046 / 507899`, followed by a numbers-only `_DEVICE_POISON_CODES` set.
- `.claude/rules/running-onboard.md` — a human triage table for `507018 / 507014 / 507899`.
- Scattered explanatory comments in `src/{a2a3,a5}/platform/onboard/host/device_runner.{h,cpp}` and `src/common/platform/onboard/host/device_runner_base.h`.

There is currently **no** code→string helper for these codes anywhere: no `ErrorCodeToString`, no `switch (rc)` over ACL/RT codes, and CANN's own `aclGetRecentErrMsg` / `aclrtGetLastError` / `HcclGetErrorString` are never called (zero hits repo-wide).

The one existing precedent for what this should look like is `stall_detail_name()` in `src/{a2a3,a5}/runtime/tensormap_and_ringbuffer/common/pto_runtime_status.h:67`, used at `runtime_maker.cpp:948` to print `sub_class=S1:running-stalled (detail=1)` instead of a bare `1`. That is exactly the shape we want everywhere else.

## Proposal

Print the meaning alongside the code, never the code alone. Target format:

```
[ERROR] aclrtSynchronizeStreamWithTimeout (AICPU) failed: 507018 (ACL_ERROR_RT_AICPU_EXCEPTION: AICPU raised an exception; check the device log for the faulting task)
[ERROR] PTO2 runtime failed: orch_error_code=3 (PTO2_ERROR_...) sched_error_code=0 (OK) runtime_status=2
```

Concretely:

1. Add a host-side `error_code_to_string(rc)` helper (symbol name + short description) covering at minimum the codes we already know about and hit in CI: `207001`, `507000`, `507014`, `507018`, `507046`, `507899`. Unknown codes should degrade gracefully to something like `507123 (unknown ACL/RT code)` rather than dropping the annotation.
2. Add the same for the `PTO2_ERROR_*` family — the codes are `#define`s at `pto_runtime_status.h:24-41` (`SCOPE_DEADLOCK=1` … `TENSORMAP_OVERFLOW=11`, `SCHEDULER_TIMEOUT=100` … `ASYNC_REGISTRATION_FAILED=103`) with no name table, right next to a file that already has `stall_detail_name`.
3. Where CANN can tell us more than a static table can, call `aclGetRecentErrMsg()` on the failure path and append it — that gets the driver's own context for free.
4. Route the annotation through the failure sites that users actually see, not just the `LOG_ERROR` lines:
   - `src/common/platform/onboard/host/device_runner_base.cpp` — the stream-sync / rtMemcpy / rtSetDevice / kernel-launch cluster (`:380`, `:424`, `:475`, `:666`, `:1130`, `:1276`, `:1290`, …)
   - `src/{a2a3,a5}/platform/onboard/host/device_runner.cpp`, `memory_allocator.cpp`, `host_regs.cpp`, `comm_hccl.cpp`
   - `src/common/worker/chip_worker.cpp:250,339,…` — the `"... failed with code N"` exception text, which is the final user-visible surface

## Notes / constraints

- `conftest.py` parses the code back out of the exception string with `_DEVICE_ERROR_CODE_RE = re.compile(r"(?:run_prepared|prepare_callable|simpler_init) failed with code (-?\d+)")` to decide whether a worker is poisoned. Any change to the `chip_worker.cpp` message text must keep that regex matching — append the description **after** the digits, don't reformat what precedes them.
- Once a name table exists, `_DEVICE_POISON_CODES` and the `.claude/rules/running-onboard.md` triage table should point at it as the single source of truth instead of restating the codes.

---


---

## #1351 [Code Health] Extend PTO-ISA build/run version guard to a5 onboard SDMA overlay (missed after #1179)

- State: open
- URL: https://github.com/hw-native-sys/simpler/issues/1351
- Created: 2026-07-13T11:19:29Z
- Updated: 2026-07-13T11:30:27Z
- Labels: code health

### Body

### Category

Missing Validation

### Component

Build System

### Description

The PTO-ISA build/runtime version guard added in #1096 (record the pto-isa
commit runtimes were built with, and reject stale binaries at load) and #1194
(fold the pto-isa commit into the cmake cache stamp + ccache key so a pin bump
forces a real recompile) was **deliberately scoped to a2a3 onboard**, because
a2a3 onboard was the only variant that baked pto-isa headers into
`host_runtime.so` at the time.

**#1179 changed that assumption.** It made a5 onboard `host_runtime.so` embed
pto-isa headers (and link `libnnopbase`) whenever
`SIMPLER_ENABLE_PTO_SDMA_WORKSPACE=ON` — i.e. a5 now has exactly the
compile-time pto-isa dependency the guard exists to protect. But #1179 only
wired the *enable* path (CMake option, `PTO_ISA_ROOT` requirement, header
include, nnopbase link); it did **not** extend any of the version-guard
machinery to a5. Every guard still keys on `arch == "a2a3" and variant ==
"onboard"`, so an a5 build with the overlay enabled embeds pto-isa headers with
**none** of the pin/staleness protections. When someone flips the overlay ON
(the re-enable path tracked in #1315), a pto-isa pin bump will silently serve a
stale a5 `host_runtime.so` built against the old headers — the exact
507018 / 507899-class failure #1194 was written to prevent, now un-guarded on
a5.

A second, subtler point: the a2a3 guard's coarse `arch/variant` scoping is only
correct because a2a3 **forces** `SIMPLER_ENABLE_PTO_SDMA_WORKSPACE` ON
unconditionally (`_requires_pto_isa_metadata_validation` docstring says as
much). On a5 the overlay is **opt-in** (default OFF), so an a5 guard must key on
the env var / CMake option, not on `arch == "a5"` — otherwise a default (OFF)
a5 build that embeds no pto-isa headers would be forced to clone pto-isa and
record metadata for nothing. So this is not a one-line `or arch == "a5"` fix.

Concretely, the gaps are:

1. **No managed-pin resolution for a5.** `build_runtimes.py` resolves the
   pinned managed checkout (`ensure_pto_isa_root()`) and exports `PTO_ISA_ROOT`
   only under `if "a2a3" in platforms:`. `runtime_compiler._init_a5` merely
   `env_manager.ensure("PTO_ISA_ROOT")` — it checks the var is *set*, never that
   it points at the pinned commit. So an opted-in a5 build consumes whatever
   pto-isa tree the user happens to export, unpinned — the very "unpinned ISA"
   scenario the mechanism was built to forbid.

2. **No build metadata recorded for a5.** `pto_isa_runtime_keys` is appended
   only for `arch == "a2a3" and variant == "onboard"`, and
   `pto_isa_root_for_metadata` is set only when `"a2a3" in platforms`, so
   `write_pto_isa_build_metadata` never records a5 artifacts. No metadata → no
   staleness detection possible for a5 binaries.

3. **No runtime staleness validation for a5.**
   `_requires_pto_isa_metadata_validation()` returns a2a3-onboard-only, so
   `validate_runtime_pto_isa_current_pin` is never called for a5 onboard
   binaries at load.

4. **Cmake cache stamp does not fold pto-isa commit for a5.**
   `_resolve_build_pto_isa_commit` returns `""` for a5 (same gate), so
   `_build_cache_stamp` leaves the a5 cache keyed on runtime HEAD only — a
   pto-isa bump with unchanged runtime HEAD reuses a stale cache.

5. **No `SIMPLER_PTO_ISA_BUILD_COMMIT` ccache-key perturbation in the a5
   CMakeLists.** The a2a3 host CMakeLists bakes the resolved pto-isa commit into
   a compile define so `git checkout` of headers (mtime unchanged) still busts
   the ccache key under `compiler_check=mtime`. The a5 host CMakeLists has no
   such block, and `runtime_builder` never passes the define for a5 anyway.

### Location

Guard machinery (all a2a3-scoped, needs an env-var-gated a5 path):

- `simpler_setup/build_runtimes.py:120` — `if "a2a3" in platforms:` resolves
  `ensure_pto_isa_root()` / sets `PTO_ISA_ROOT` + `pto_isa_root_for_metadata`
- `simpler_setup/build_runtimes.py:159-162` — `pto_isa_runtime_keys` appended
  only for a2a3 onboard
- `simpler_setup/build_runtimes.py:191-194` — `write_pto_isa_build_metadata`
  only when the a2a3 root was set
- `simpler_setup/runtime_builder.py:180-192` —
  `_requires_pto_isa_metadata_validation()` → `arch == "a2a3" and variant == "onboard"`
- `simpler_setup/runtime_builder.py:194-212` — `_resolve_build_pto_isa_commit()`
  returns `""` for non-a2a3
- `simpler_setup/runtime_builder.py:241-245` —
  `validate_runtime_pto_isa_current_pin` call gated on the same predicate
- `simpler_setup/runtime_compiler.py` `_init_a5` — `env_manager.ensure("PTO_ISA_ROOT")`
  only (presence check, no pin resolution)
- `src/a5/platform/onboard/host/CMakeLists.txt` — has the
  `SIMPLER_ENABLE_PTO_SDMA_WORKSPACE` gating (post-#1179) but **no**
  `SIMPLER_PTO_ISA_BUILD_COMMIT` block; contrast
  `src/a2a3/platform/onboard/host/CMakeLists.txt:118-134`

### Proposed Fix

Generalize the guard from "a2a3 onboard" to "onboard host embeds pto-isa
headers", keyed on the actual condition rather than the arch string:

- Introduce a single predicate — e.g. `_embeds_pto_isa_headers(arch, variant)`
  — that is True for a2a3 onboard (always) and for a5 onboard **only when
  `SIMPLER_ENABLE_PTO_SDMA_WORKSPACE` is truthy** (reuse the existing
  `runtime_compiler._sdma_workspace_enabled()` helper). Drive
  `_requires_pto_isa_metadata_validation`, `_resolve_build_pto_isa_commit`, the
  metadata-key collection, and `PTO_ISA_ROOT` resolution off this predicate.
- In `build_runtimes.py`, resolve `ensure_pto_isa_root()` and set
  `pto_isa_root_for_metadata` / append `pto_isa_runtime_keys` whenever any
  built platform embeds pto-isa headers (a2a3 onboard, or a5 onboard with the
  overlay ON) — so a5 uses the *pinned managed* checkout, not an arbitrary
  `PTO_ISA_ROOT`.
- Add the `SIMPLER_PTO_ISA_BUILD_COMMIT` cache-string + compile-define block to
  `src/a5/platform/onboard/host/CMakeLists.txt`, guarded by
  `SIMPLER_ENABLE_PTO_SDMA_WORKSPACE`, mirroring
  `src/a2a3/platform/onboard/host/CMakeLists.txt:118-134`.
- Extend the unit coverage in `tests/ut/py/test_runtime_builder.py` /
  `test_pto_isa.py` to the a5-overlay-on case (metadata written, mismatch
  rejected, cache invalidated, and the OFF case stays a no-op so default a5
  builds never touch pto-isa).

Relates to #1096, #1194, #1179; adjacent to the a5 SDMA re-enable checklist in
#1315.

### Priority

Medium (minor risk, should fix in next few releases)


---

## #1352 [Duplicate of #1351 — please delete] a5 pto-isa guard gate

- State: closed
- URL: https://github.com/hw-native-sys/simpler/issues/1352
- Created: 2026-07-13T11:28:19Z
- Updated: 2026-07-13T11:31:54Z
- Closed: 2026-07-13T11:30:23Z
- Labels: code health

### Body

**Void / duplicate. Track everything in #1351.** Created in error; already closed. Content fully folded into #1351, with the re-enable precondition recorded on #1315's checklist. Please have a maintainer **delete** this issue to clear the stray cross-reference events it left on #1315 and #1351.

---

