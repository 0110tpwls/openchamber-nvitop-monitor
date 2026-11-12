import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock

from service.collect import collect, number, process_command, system_metrics


def device(index, uuid, processes=(), children=()):
    result = Mock(index=index)
    result.oneshot.side_effect = nullcontext
    result.uuid.return_value = uuid
    result.name.return_value = "NVIDIA Test"
    result.gpu_utilization.return_value = "N/A"
    result.memory_utilization.return_value = 27
    result.memory_used.return_value = 0
    result.memory_total.return_value = 80 * 2**30
    result.power_usage.return_value = 42_500
    result.power_limit.return_value = 300_000
    result.temperature.return_value = 39
    result.fan_speed.return_value = "N/A"
    result.processes.return_value = {process.pid: process for process in processes}
    result.mig_devices.return_value = children
    return result


def job(pid, memory):
    result = Mock(pid=pid, type="C")
    result.username.return_value = "N/A"
    result.name.return_value = "python"
    result.cmdline.return_value = ["/venv/bin/python", "--token=private"]
    result.gpu_memory.return_value = memory
    result.gpu_sm_utilization.return_value = 0
    result.gpu_memory_utilization.return_value = 31
    result.memory_percent.return_value = 0.3
    result.create_time.return_value = 1000
    result.running_time_in_seconds.return_value = 61
    result.host.oneshot.side_effect = nullcontext
    result.host.cpu_times.return_value = SimpleNamespace(user=10.2, system=0.8)
    return result


class CollectorTest(unittest.TestCase):
    def test_full_command_is_not_truncated_and_checks_process_identity(self):
        process = Mock()
        process.create_time.return_value = 123.5
        process.is_running.return_value = True
        command = "python train.py --data " + "x" * 1024
        process.command.return_value = command
        factory = Mock(return_value=process)
        self.assertEqual(process_command(7, 123.5, factory, OSError), {"command": command})

        process.command.reset_mock()
        self.assertEqual(process_command(7, 124, factory, OSError)["error"], "PROCESS_UNAVAILABLE")
        process.command.assert_not_called()
        process.create_time.side_effect = PermissionError()
        self.assertEqual(process_command(7, 123.5, factory, OSError)["error"], "PROCESS_UNAVAILABLE")

    def test_system_cpu_and_memory_match_nvitop_host_values(self):
        host = Mock(PsutilError=RuntimeError)
        host.cpu_percent.return_value = 0.0
        host.virtual_memory.return_value = SimpleNamespace(percent=30.1, used=300, total=1000)
        self.assertEqual(system_metrics(host), {
            "cpu": 0.0, "memoryPercent": 30.1, "memoryUsed": 300, "memoryTotal": 1000,
        })
        host.cpu_percent.assert_called_once_with(interval=0.1)

    def test_unavailable_system_cpu_keeps_memory(self):
        host = Mock(PsutilError=RuntimeError)
        host.cpu_percent.side_effect = PermissionError()
        host.virtual_memory.return_value = SimpleNamespace(percent=0, used=0, total=1000)
        self.assertEqual(system_metrics(host), {
            "cpu": None, "memoryPercent": 0, "memoryUsed": 0, "memoryTotal": 1000,
        })

    def test_mig_processes_use_partition_identity(self):
        same_pid = job(7, 1024)
        mig = device((0, 1), "MIG-test", [same_pid])
        gpu = device(0, "GPU-test", [same_pid], [mig])
        gpu2 = device(1, "GPU-test2", [job(2, 2048), same_pid])
        devices = Mock()
        devices.all.return_value = [gpu, gpu2]
        devices.driver_version.return_value = "123.45"
        processes = Mock()
        processes.failsafe.side_effect = nullcontext

        sample = collect(devices, processes, OSError)

        self.assertEqual(sample["driver"], "123.45")
        self.assertEqual(sample["processCount"], 3)
        self.assertEqual(sample["devices"][1]["parentId"], "GPU-test")
        self.assertEqual(sample["devices"][0]["watts"], 42.5)
        self.assertEqual(sample["devices"][0]["wattLimit"], 300)
        self.assertEqual(sample["devices"][0]["mbw"], 27)
        self.assertEqual(sample["devices"][0]["used"], 0)
        self.assertIsNone(sample["devices"][0]["util"])
        self.assertIsNone(sample["devices"][0]["fan"])
        self.assertEqual([row["deviceId"] for row in sample["processes"]],
                         ["GPU-test2", "GPU-test2", "MIG-test"])
        self.assertIsNone(sample["processes"][0]["user"])
        self.assertEqual(sample["processes"][0]["command"], "/venv/bin/python")
        self.assertEqual(sample["processes"][0]["cpuTime"], 11)
        self.assertEqual(sample["processes"][0]["startedAt"], 1000)
        self.assertEqual(sample["processes"][0]["hostMemory"], 0.3)
        self.assertEqual(sample["processes"][0]["mbw"], 31)
        self.assertNotIn("private", str(sample))
        same_pid.host.cpu_times.assert_called_once()
        gpu.processes.assert_not_called()

    def test_caps_rows_and_preserves_total(self):
        devices = Mock()
        devices.all.return_value = [device(0, "GPU-test", [job(i, i) for i in range(260)])]
        devices.driver_version.return_value = "123.45"
        processes = Mock()
        processes.failsafe.side_effect = nullcontext
        sample = collect(devices, processes, OSError)
        self.assertEqual(sample["processCount"], 260)
        self.assertEqual(len(sample["processes"]), 256)
        self.assertEqual(sample["processes"][0]["pid"], 259)

    def test_missing_host_fields_do_not_drop_gpu_process(self):
        process = job(7, 1024)
        process.cmdline.return_value = ["No Permissions"]
        process.host.cpu_times.side_effect = PermissionError()
        devices = Mock()
        devices.all.return_value = [device(0, "GPU-test", [process])]
        processes = Mock()
        processes.failsafe.side_effect = nullcontext

        row = collect(devices, processes, OSError)["processes"][0]
        self.assertEqual(row["command"], "python")
        self.assertIsNone(row["cpuTime"])
        self.assertEqual(row["used"], 1024)

    def test_unavailable_numbers_stay_distinct_from_zero(self):
        for invalid in ("N/A", None, True, -1, float("nan"), float("inf")):
            self.assertIsNone(number(invalid))
        self.assertEqual(number(0), 0)
