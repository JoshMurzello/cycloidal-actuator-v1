# Source and validation provenance

Prepared October 30, 2026, from the active STM32CubeIDE project and matching USB panel.
Firmware identity: protocol 3 / `usb-panel-3`.
`Core/Src/main.c` SHA-256: `74d0c914f870a3e311c3bdaee61d312f69dea20a5d37c4a98fa6e02a01c596a0`.

The active source exactly matches the saved workspace protocol-3 source. The
October 11 validation record reports a successful GCC 12.3 build, ST-LINK flash
verification and HELLO/STATUS identifying protocol 3. It also records successful
host firmware simulation and 17 browser transport tests. That historical record
does not identify every setting in the filmed load test or prove every frame's
flashed binary. The current feature set matches the filmed jog/load bench panel.

This package's fresh offline build and test outcomes are recorded separately in
the build report when run. No hardware was connected or commanded while staging.
Supply/current/microstep test settings are not invented. The scale calculation
does not establish maximum output torque or gearbox efficiency.

## Fresh offline verification — October 30, 2026

- GNU Tools for STM32 12.3 compiled and linked all 26 source units with zero warnings.
- Fresh BIN: 22,704 bytes, SHA-256 `e12ef78b02a2acf0feaec4a3dbb2751b9d3784890245aa8549796322889db51e`.
- The BIN exactly matches the saved protocol-3 image; the portable ELF omits machine-specific debug symbols.
- All 17 USB-panel transport tests passed. The actual-firmware host simulation passed.
- ELF, BIN and HEX are in `releases/usb-panel-3/`. Checksums and the concise report are included.
- No hardware was connected, flashed or moved during these checks.
