#!/usr/bin/env python3
"""Offline build of the supplied STM32 firmware. Never programs hardware."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
import shutil
import subprocess

PACKAGE = Path(__file__).resolve().parents[1]
PROJECT = PACKAGE / 'firmware/cubeide'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--toolchain-bin', type=Path,
                        help='Directory containing arm-none-eabi-gcc/objcopy/size')
    parser.add_argument('--output-dir', type=Path, default=PACKAGE / 'build')
    parser.add_argument('--jobs', type=int, default=4)
    args = parser.parse_args()
    tools = {}
    for suffix in ['gcc', 'objcopy', 'size']:
        name = 'arm-none-eabi-' + suffix
        found = str(args.toolchain_bin / name) if args.toolchain_bin else shutil.which(name)
        if not found or not Path(found).is_file():
            parser.error(f'{name} is unavailable; supply an installed toolchain with --toolchain-bin')
        tools[suffix] = str(Path(found).resolve())
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    sources = json.loads((PROJECT / 'build-sources.json').read_text())
    assert len(sources) == len(set(sources))
    assert all((PROJECT / s).is_file() for s in sources)
    relative = lambda p: os.path.relpath(p, PROJECT)
    architecture = ['-mcpu=cortex-m4', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard', '-mthumb']
    includes = ['Core/Inc', 'Drivers/STM32L4xx_HAL_Driver/Inc',
                'Drivers/STM32L4xx_HAL_Driver/Inc/Legacy',
                'Drivers/CMSIS/Device/ST/STM32L4xx/Include', 'Drivers/CMSIS/Include']
    common = architecture + ['-g0', '-DDEBUG', '--specs=nano.specs']
    records = []

    def run(command):
        result = subprocess.run(command, cwd=PROJECT, text=True, capture_output=True)
        record = {'command': [Path(command[0]).name, *command[1:]],
                  'returncode': result.returncode, 'stdout': result.stdout,
                  'stderr': result.stderr}
        if result.returncode:
            raise RuntimeError(json.dumps(record, indent=2))
        return record

    def compile_one(source):
        obj = output / 'objects' / Path(source).with_suffix('.o')
        obj.parent.mkdir(parents=True, exist_ok=True)
        if Path(source).suffix.lower() == '.s':
            options = common + ['-x', 'assembler-with-cpp']
        else:
            options = common + ['-std=gnu11', '-DUSE_HAL_DRIVER', '-DSTM32L476xx',
                                '-O0', '-ffunction-sections', '-fdata-sections', '-Wall']
            options += [flag for path in includes for flag in ['-I', path]]
        record = run([tools['gcc'], *options, '-c', source, '-o', relative(obj)])
        print('Compiled', source, flush=True)
        return obj, record

    version = run([tools['gcc'], '--version'])['stdout'].splitlines()[0]
    with ThreadPoolExecutor(max_workers=max(1, min(args.jobs, 8))) as executor:
        compiled = list(executor.map(compile_one, sources))
    objects = [obj for obj, _ in compiled]
    records += [record for _, record in compiled]
    elf = output / 'cycloidal-usb-panel-3.elf'
    binary = output / 'cycloidal-usb-panel-3.bin'
    ihex = output / 'cycloidal-usb-panel-3.hex'
    mapfile = output / 'cycloidal-usb-panel-3.map'
    records.append(run([tools['gcc'], *map(relative, objects), '-o', relative(elf),
                        *architecture, '-T', 'STM32L476RGTX_FLASH.ld',
                        '--specs=nosys.specs', '--specs=nano.specs', '-static',
                        '-Wl,--gc-sections', '-Wl,-Map=' + relative(mapfile),
                        '-Wl,--start-group', '-lc', '-lm', '-Wl,--end-group']))
    records.append(run([tools['objcopy'], '-O', 'binary', relative(elf), relative(binary)]))
    records.append(run([tools['objcopy'], '-O', 'ihex', relative(elf), relative(ihex)]))
    size = run([tools['size'], relative(elf)])
    records.append(size)
    print(size['stdout'], end='')
    hashes = {p.name: {'bytes': p.stat().st_size,
                      'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
              for p in [elf, binary, ihex]}
    report = {'built_at_utc': datetime.now(timezone.utc).isoformat(), 'status': 'PASS',
              'target': 'STM32L476RG / Cortex-M4F', 'protocol': 3,
              'firmware': 'usb-panel-3', 'compiler': version,
              'source_count': len(sources),
              'source_main_sha256': hashlib.sha256((PROJECT / 'Core/Src/main.c').read_bytes()).hexdigest(),
              'artifacts': hashes, 'size_output': size['stdout'],
              'warnings': [r['stderr'] for r in records if r['stderr']],
              'commands': records, 'network_access': False,
              'hardware_connected_or_programmed': False,
              'build_note': 'Uses the original Debug source list, O0 and DEBUG; omits debug paths/symbols with g0 for a portable artifact.'}
    (output / 'build-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print('OFFLINE_BUILD_PASS', flush=True)


if __name__ == '__main__':
    main()
