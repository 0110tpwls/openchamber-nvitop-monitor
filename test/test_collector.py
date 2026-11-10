import unittest
from contextlib import nullcontext
from unittest.mock import Mock

from service.collect import collect, number


def device(index, uuid, processes=(), children=()):
    result = Mock(index=index)
    result.oneshot.side_effect = nullcontext
    result.uuid.return_value = uuid
    result.name.return_value = "NVIDIA Test"
    result.gpu_utilization.return_value = "N/A"
    result.memory_used.return_value = 0
    result.memory_total.return_value = 80 * 2**30
    result.power_usage.return_value = 42_500
    result.temperature.return_value = 39
    result.fan_speed.return_value = "N/A"
    result.processes.return_value = {process.pid: process for process in processes}
    result.mig_devices.return_value = children
    return result


def job(pid, memory):
    result = Mock(pid=pid, type="C")
    result.username.return_value = "N/A"
    result.name.return_value = "python"
    result.gpu_memory.return_value = memory
    result.gpu_sm_utilization.return_value = 0
    result.running_time_in_seconds.return_value = 61
    return result


class CollectorTest(unittest.TestCase):
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

        sample = collect(devices, processes)

        self.assertEqual(sample["driver"], "123.45")
        self.assertEqual(sample["processCount"], 3)
        self.assertEqual(sample["devices"][1]["parentId"], "GPU-test")
        self.assertEqual(sample["devices"][0]["watts"], 42.5)
        self.assertEqual(sample["devices"][0]["used"], 0)
        self.assertIsNone(sample["devices"][0]["util"])
        self.assertIsNone(sample["devices"][0]["fan"])
        self.assertEqual([row["deviceId"] for row in sample["processes"]],
                         ["GPU-test2", "GPU-test2", "MIG-test"])
        self.assertIsNone(sample["processes"][0]["user"])
        self.assertNotIn("command", sample["processes"][0])
        gpu.processes.assert_not_called()

    def test_caps_rows_and_preserves_total(self):
        devices = Mock()
        devices.all.return_value = [device(0, "GPU-test", [job(i, i) for i in range(260)])]
        devices.driver_version.return_value = "123.45"
        processes = Mock()
        processes.failsafe.side_effect = nullcontext
        sample = collect(devices, processes)
        self.assertEqual(sample["processCount"], 260)
        self.assertEqual(len(sample["processes"]), 256)
        self.assertEqual(sample["processes"][0]["pid"], 259)

    def test_unavailable_numbers_stay_distinct_from_zero(self):
        for invalid in ("N/A", None, True, -1, float("nan"), float("inf")):
            self.assertIsNone(number(invalid))
        self.assertEqual(number(0), 0)
