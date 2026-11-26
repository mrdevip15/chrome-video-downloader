"""List decrypt/key-related exported symbols with their virtual addresses.

Usage: python tools/wvd_symbols.py [path-to-libwvhidl.so] [pattern]
"""

from __future__ import annotations

import io
import re
import sys
from pathlib import Path

from elftools.elf.elffile import ELFFile

DEFAULT = Path(r"C:/Users/astrea/AppData/Local/hermes/cache/scratch/wvd-work/libwvhidl.so")
PATTERN = r"Decrypt|CryptoSession|Aes|AES|Cbc|Ctr|SetKey|LoadKey|Sign"


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    pattern = sys.argv[2] if len(sys.argv) > 2 else PATTERN
    blob = path.read_bytes()
    e = ELFFile(io.BytesIO(blob))
    ds = e.get_section_by_name(".dynsym")
    rows = []
    for s in ds.iter_symbols():
        name = s.name
        if not name or s["st_shndx"] == "SHN_UNDEF":
            continue
        if re.search(pattern, name):
            rows.append((s["st_value"], s["st_size"], name))
    rows.sort()
    for v, size, name in rows:
        print(f"0x{v:08x} {size:6d} {name[:150]}")
    print(f"--- {len(rows)} symbols from {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
