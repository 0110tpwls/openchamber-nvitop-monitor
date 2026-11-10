"""Collect a bounded, read-only nvitop snapshot without command-line arguments."""
import json
import math
import socket
import time

MAX_PROCESSES = 256


def number(value):
    return value if type(value) in (int, float) and 0 <= value and math.isfinite(value) else None


def text(value):
    return value[:160] if isinstance(value, str) and value not in ("N/A", "") else None


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
            "used": number(device.memory_used()),
            "total": number(device.memory_total()),
        }
        if parent_id is None:
            power = number(device.power_usage())
            row.update(temperature=number(device.temperature()),
                       watts=power / 1000 if power is not None else None,
                       fan=number(device.fan_speed()))
    return row


def process_row(process, device_id):
    return {
        "deviceId": device_id,
        "pid": process.pid,
        "user": text(process.username()),
        "name": text(process.name()),
        "type": text(process.type),
        "used": number(process.gpu_memory()),
        "sm": number(process.gpu_sm_utilization()),
        "seconds": number(process.running_time_in_seconds()),
    }


def collect(device_class, process_class):
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
    with process_class.failsafe():
        processes = [process_row(process, device_id)
                     for process, device_id in candidates[:MAX_PROCESSES]]
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
        from nvitop import Device, GpuProcess, libnvml
    except ImportError:
        return {"error": "NVITOP_MISSING", "message": "Install nvitop in the extension's Python environment."}

    try:
        libnvml.nvmlInit()
        try:
            return collect(Device, GpuProcess)
        finally:
            libnvml.nvmlShutdown()
    except libnvml.NVMLError as error:
        return {"error": "NVML_UNAVAILABLE", "message": f"NVIDIA NVML: {error}"}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=True, allow_nan=False))
