"""Collect a bounded, read-only nvitop snapshot."""
import json
import math
import socket
import time

MAX_PROCESSES = 256


def number(value):
    return value if type(value) in (int, float) and 0 <= value and math.isfinite(value) else None


def text(value):
    return value[:160] if isinstance(value, str) and value not in ("N/A", "") else None


def system_metrics(host):
    result = {"cpu": None, "memoryPercent": None, "memoryUsed": None, "memoryTotal": None}
    try:
        # The collector starts fresh on every request. Measure over a real interval.
        result["cpu"] = number(host.cpu_percent(interval=0.1))
    except (OSError, host.PsutilError):
        pass
    try:
        memory = host.virtual_memory()
        result.update(memoryPercent=number(memory.percent), memoryUsed=number(memory.used),
                      memoryTotal=number(memory.total))
    except (OSError, host.PsutilError):
        pass
    return result


def device_row(device, parent_id=None):
    index = device.index
    label = f"GPU {index}" if parent_id is None else f"GPU {index[0]} / MIG {index[1]}"
    with device.oneshot():
        row = {
            "id": text(device.uuid()) or label,
            "label": label,
            "parentId": parent_id,
            "name": text(device.name()),
            "util": number(device.gpu_utilization()),
            "mbw": number(device.memory_utilization()),
            "used": number(device.memory_used()),
            "total": number(device.memory_total()),
        }
        if parent_id is None:
            power = number(device.power_usage())
            limit = number(device.power_limit())
            row.update(temperature=number(device.temperature()),
                       watts=power / 1000 if power is not None else None,
                       wattLimit=limit / 1000 if limit is not None else None,
                       fan=number(device.fan_speed()))
    return row


def host_row(process, process_error):
    with process.host.oneshot():
        name = text(process.name())
        argv = process.cmdline()
        command = text(argv[0]) if argv else None
        if command in ("No Such Process", "No Permissions", "Zombie Process"):
            command = None
        try:
            times = process.host.cpu_times()
            cpu_time = number(times.user + times.system)
        except process_error:
            cpu_time = None
        return {
            "user": text(process.username()),
            "name": name,
            "command": command or name,
            "hostMemory": number(process.memory_percent()),
            "seconds": number(process.running_time_in_seconds()),
            "startedAt": number(process.create_time()),
            "cpuTime": cpu_time,
        }


def process_row(process, device_id, host_fields):
    return {
        "deviceId": device_id,
        "pid": process.pid,
        **host_fields,
        "type": text(process.type),
        "used": number(process.gpu_memory()),
        "sm": number(process.gpu_sm_utilization()),
        "mbw": number(process.gpu_memory_utilization()),
    }


def collect(device_class, process_class, process_error):
    devices = []
    candidates = []
    for physical in device_class.all():
        parent = device_row(physical)
        devices.append(parent)
        children = physical.mig_devices()
        if children:
            for child in children:
                row = device_row(child, parent["id"])
                devices.append(row)
                candidates.extend((process, row["id"]) for process in child.processes().values())
        else:
            candidates.extend((process, parent["id"]) for process in physical.processes().values())

    candidates.sort(key=lambda pair: (
        -(number(pair[0].gpu_memory()) or 0), pair[0].pid, pair[1]
    ))
    processes = []
    host_fields = {}
    with process_class.failsafe():
        for process, device_id in candidates[:MAX_PROCESSES]:
            if process.pid not in host_fields:
                host_fields[process.pid] = host_row(process, process_error)
            processes.append(process_row(process, device_id, host_fields[process.pid]))
    return {
        "version": 1,
        "sampledAt": time.time_ns() // 1_000_000,
        "host": socket.gethostname(),
        "driver": text(device_class.driver_version()) if devices else None,
        "devices": devices,
        "processes": processes,
        "processCount": len(candidates),
    }


def main():
    try:
        from nvitop import Device, GpuProcess, host, libnvml
    except ImportError:
        return {"error": "NVITOP_MISSING", "message": "Install nvitop in the extension's Python environment."}

    try:
        libnvml.nvmlInit()
        try:
            sample = collect(Device, GpuProcess, host.PsutilError)
            sample["system"] = system_metrics(host)
            return sample
        finally:
            libnvml.nvmlShutdown()
    except libnvml.NVMLError as error:
        return {"error": "NVML_UNAVAILABLE", "message": f"NVIDIA NVML: {error}"}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=True, allow_nan=False))
