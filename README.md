# nvitop GPU Monitor for OpenChamber

A read-only NVIDIA GPU and process monitor for OpenChamber, powered by the nvitop Python API. It shows live GPU and MIG metrics, configurable bars and two-minute charts, and a searchable GPU process table. [nvitop](https://github.com/XuehaiPan/nvitop)

## Requirements

- OpenChamber 2.0.1 or later on Web or Desktop.
- A Linux machine running the OpenChamber server, with an NVIDIA GPU and a working driver. Run `nvidia-smi` on that machine to check.
- nvitop installed for the account that runs the OpenChamber server. If the server runs in a container, it also needs access to the GPU and NVML.

## Installation

1. On the OpenChamber server, use your existing nvitop install or pick one of these commands.

   ```sh
   pixi global install nvitop
   # or: uv tool install nvitop
   # or: pipx install nvitop
   ```

   The extension also discovers nvitop installed with pip or in a virtual environment when its launcher is on the server's `PATH`.

2. In **Settings → Extensions**, paste this repository URL and click **Add**.

   ```text
   https://github.com/0110tpwls/openchamber-nvitop-monitor
   ```

   For private access, use `git@github.com:0110tpwls/openchamber-nvitop-monitor.git` with a Git identity that can read the repo. You can also clone the repo and add its absolute path on the server. The panel ships prebuilt. [OpenChamber extension installation](https://docs.openchamber.dev/extensions/#install-one)

3. Approve **Run a local service**, then open **nvitop GPU Monitor** on the right rail. Use **Metrics** to choose which bars and charts to display and set the sampling interval from 1 to 60 seconds. The default is 2 seconds, and the interval also applies to the compact **Work Status** view.

If the panel cannot find nvitop, check the account running OpenChamber and make sure the directory containing the `nvitop` launcher is on the **server's** `PATH`. Restart the server after changing its environment.

## Development

Use Node.js 22 or later and Python 3. Run `npm ci` followed by `npm run check` to rebuild the panel and run the tests.

The bundled OpenChamber SDK is covered by the [SDK license](OPENCHAMBER-SDK-LICENSE).
