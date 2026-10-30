# Cycloidal actuator — STM32 USB controller v3

Firmware and local USB bench panel for the NUCLEO-L476RG + TB6600 setup used in
this actuator project. This package contains the active CubeIDE/HAL protocol-3
source, its generated support files, and the matching browser panel. The earlier
PlatformIO controller is intentionally absent because its wiring and commands differ.

## Start here

1. Read [wiring and hardware](docs/WIRING.md).
2. [Build and program the STM32](docs/BUILD-AND-FLASH.md).
3. [Launch the local USB panel](usb-panel/README.md).

The board identifies as `usb-panel-3`, protocol `3`. Motion is commanded position,
not encoder feedback or force control. The scale calculator produces contact
moments; it does not establish maximum actuator torque or gearbox efficiency.

## Package contents

- `firmware/cubeide/`: full STM32CubeIDE project, IOC, Core, HAL/CMSIS, startup and linker scripts.
- `usb-panel/`: static browser UI, local Python server, Mac launcher and transport tests.
- `tools/build_firmware.py`: optional offline GNU Arm build; no download or programming step.
- `tools/check_usb_panel.py`: optional operator-run HELLO/STATUS diagnostic; never starts motion.
  HELLO stops an active JOG/LOAD and keeps the driver commanded in HOLD (ENA low).
  It leaves an already RELEASED driver released; STATUS only requests telemetry.
- `tests/test_cubeide_usb_control.py`: host simulation using the actual firmware functions.
- `docs/PROTOCOL.md`, `docs/VALIDATION.md`, `LICENSES.md`: version, evidence and included notices.

This repository keeps the matching controller firmware, local USB panel and setup
notes together. Start with the wiring and build guides above, and read the existing
[license information](LICENSES.md) before reuse.
