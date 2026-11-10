# nvitop for OpenChamber

OpenChamber에서 NVIDIA GPU와 GPU를 쓰는 프로세스를 확인하는 읽기 전용 확장입니다. 현재 연결된 **OpenChamber 서버**에서 nvitop Python API로 수집합니다. 예를 들어 Mac의 OpenChamber Desktop에서 Linux GPU 서버에 연결하면 Linux 서버의 GPU가 표시됩니다.

## 설치

**OpenChamber 2.0.1 이상(Web 또는 Desktop)**과 NVIDIA 드라이버가 설치된 **Linux OpenChamber 서버**가 필요합니다. 컨테이너에서 OpenChamber를 실행한다면 컨테이너에 GPU와 NVML이 노출되어야 합니다. 프로세스 이름과 사용자는 서버 프로세스가 해당 PID를 조회할 수 있을 때 표시됩니다. [OpenChamber 확장 설치 문서](https://docs.openchamber.dev/extensions/) · [nvitop 요구사항](https://pypi.org/project/nvitop/#requirements)

1. OpenChamber 서버를 실행하는 계정으로 GPU 서버에 접속합니다. NVIDIA 드라이버를 확인하고 전용 Python 가상환경을 만듭니다.

   ```bash
   nvidia-smi
   python3 -m venv "$HOME/.local/share/openchamber-nvitop/venv"
   "$HOME/.local/share/openchamber-nvitop/venv/bin/python3" -m pip install 'nvitop>=1.7.2,<2'
   ```

2. **Settings → Extensions → Add**에 서버에서 접근 가능한 확장 ZIP 또는 압축을 푼 폴더의 절대 경로를 입력합니다. Git 서버에 리포를 올린 뒤에는 HTTPS 리포 URL도 사용할 수 있습니다. 설치 패키지에 빌드된 패널이 들어 있으므로 GPU 서버에서 npm을 실행할 필요는 없습니다.
3. **Run a local service** 권한을 승인하고 오른쪽 레일의 **nvitop**을 엽니다. 넓은 화면은 **Extension pages → nvitop**, 요약은 **Work Status → NVIDIA GPUs**에서 볼 수 있습니다.

## 화면과 수집 범위

| 화면 | 표시 항목 |
| --- | --- |
| 오른쪽 레일 및 전체 화면 | GPU별 사용률, VRAM, 온도, 전력, 팬 속도, 최근 2분 GPU 사용률, MIG 파티션별 VRAM |
| GPU 프로세스 | PID, GPU 또는 MIG 위치, 프로세스명, 사용자, 그래픽/컴퓨트 유형, VRAM, SM 사용률, 실행 시간. VRAM 상위 256개 컨텍스트를 PID·이름·사용자·GPU로 검색 |
| Work Status | 사용률 기준 상위 3개 물리 GPU의 사용률과 VRAM 비율, 전체 GPU 컨텍스트 수 |

- 샘플은 화면을 보는 동안 약 2초마다 갱신합니다. 패널과 Work Status는 최근 샘플을 공유합니다. 레일이나 전체 화면에서 일시 정지할 수 있으며, 그래프 이력은 화면을 닫을 때 지워집니다.
- PID가 여러 GPU에 있으면 GPU마다 한 행이 표시됩니다. MIG 자식 장치를 열거할 수 있을 때는 자식에서 프로세스를 조회해 부모와의 중복 집계를 피합니다. 물리 GPU와 MIG의 VRAM은 각각 표시합니다.
- nvitop이 제공하지 않는 값은 `—`로 표시합니다. SM 값은 nvitop 보고값이며, 기기·드라이버에 따라 세부 이용률을 제공하지 않거나 nvitop이 0을 반환할 수 있습니다. 샘플 오류가 발생하면 마지막 데이터를 흐리게 표시하고 샘플 시각과 오류를 보여줍니다. [nvitop Device API](https://nvitop.readthedocs.io/en/latest/api/device.html) · [nvitop GpuProcess API](https://nvitop.readthedocs.io/en/latest/api/process.html)

## OpenChamber에서 활용한 기능

| 확장 API | 이 리포에서 쓰는 방식 |
| --- | --- |
| `panel`, `page`, `statusSection` | 같은 화면 번들로 레일, 전체 화면, Work Status 요약을 제공합니다. |
| `service`, `host.serviceRequest` | 샌드박스 iframe이 OpenChamber를 통해 로컬 서비스의 JSON을 요청합니다. 서비스는 `127.0.0.1`과 OpenChamber가 발급한 토큰을 사용하며 고정된 Python 수집기만 실행합니다. |
| `@openchamber/sdk/ui`, `host.setHeight` | 패널에 OpenChamber 테마를 적용하고 Work Status 섹션을 콘텐츠 높이에 맞춥니다. |

OpenChamber는 배지, 채팅 첨부, 명령 및 세션 제어도 지원합니다. 예를 들어 확장에 VRAM 경고 배지를 추가하거나 사용자가 선택한 GPU 스냅샷을 채팅에 첨부할 수 있습니다. 이 버전의 권한 범위는 로컬 수집 서비스입니다. 프로세스 종료와 명령줄 인자 수집 기능은 포함하지 않습니다. 장기간 지표를 저장하려면 nvitop 프로젝트의 Prometheus exporter를 별도로 사용할 수 있습니다. [OpenChamber SDK](https://docs.openchamber.dev/sdk/) · [Host API](https://docs.openchamber.dev/sdk/host/) · [nvitop exporter](https://github.com/XuehaiPan/nvitop/tree/main/nvitop-exporter)

## 유사 확장과의 차이

| 확장 | 데이터와 초점 |
| --- | --- |
| onvtop | `nvstats-service`를 Linux의 D-Bus 또는 원격 HTTP로 조회합니다. 공유 GPU 메모리와 vLLM·Ollama 등 로컬 추론 모델 카드가 특징입니다. |
| System Monitor | OpenChamber 서버의 CPU·RAM·GPU·디스크를 폭넓게 보여줍니다. 운영체제별 도구를 호출하며 Linux NVIDIA 지표에는 `nvidia-smi`를 사용합니다. |
| nvitop for OpenChamber | Linux NVIDIA 서버에서 nvitop/NVML의 물리 GPU, MIG, GPU 프로세스 지표를 읽습니다. 별도 원격 모니터링 데몬 없이 OpenChamber 서버 연결을 사용합니다. |

[onvtop](https://github.com/DAE51D/openchamber-onvtop) · [System Monitor](https://github.com/fuchs-alexander/openchamber-system-monitor) · [OpenChamber 확장 디렉터리](https://openchamber.dev/extensions/)

## 개발 및 확인

Node.js 22 이상, npm, Python 3이 필요합니다.

```bash
npm ci
npm run check
```

`panel/main.js`는 빌드된 브라우저 번들입니다. 패널을 수정한 뒤 `npm run build`로 갱신하고 함께 커밋합니다. GPU 서버에서 수집기만 확인하려면 리포 루트에서 다음 명령을 실행합니다.

```bash
"$HOME/.local/share/openchamber-nvitop/venv/bin/python3" -I service/collect.py
```

수집 서비스는 위 경로의 Python을 먼저 사용합니다. 가상환경이 없으면 서버의 PATH에서 `python3`를 찾으며, 이 경우 nvitop은 해당 Python의 시스템 환경에서 import할 수 있어야 합니다. `NVML_UNAVAILABLE`이 나오면 OpenChamber 서버와 같은 환경에서 `nvidia-smi`를 확인합니다.

번들에 포함된 OpenChamber SDK의 라이선스는 [OPENCHAMBER-SDK-LICENSE](OPENCHAMBER-SDK-LICENSE)에 있습니다.
