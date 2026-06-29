#!/usr/bin/env python3
"""Patch sfizz 1.2.3 so it builds with a modern toolchain on Apple Silicon.

Run from the sfizz source dir (this is FetchContent's PATCH_COMMAND cwd). Idempotent:
every fix is a no-op if already applied or if upstream changed the code. Never fails the
build on a missing/altered file — we'd rather let the compile surface a clear error.

Fixes:
  1. arm64 flags: SfizzConfig.cmake adds 32-bit-ARM-only flags (-mfpu=neon,
     -mfloat-abi=hard) whenever "(arm.*)" matches — which wrongly includes arm64, where
     clang rejects them. NEON is baseline on AArch64, so the flag is unneeded. We guard
     ONLY that branch. (We leave the identical regex in external/st_audiofile alone: it
     relies on arm64 matching to disable WavPack ASM, which also fails on Apple Silicon.)
  2. atomic_queue template keyword: `Base::template do_pop_any(...)` /
     `do_push_any(...)` are used WITHOUT a template argument list, which recent clang
     rejects as a hard error (-Wmissing-template-arg-list-after-template-kw). The
     `template` disambiguator is unnecessary here; remove it.
"""
import pathlib


def patch(path, replacements):
    p = pathlib.Path(path)
    if not p.exists():
        return
    text = p.read_text()
    out = text
    for old, new in replacements:
        if new in out:           # already applied
            continue
        out = out.replace(old, new)
    if out != text:
        p.write_text(out)
        print(f"patched {path}")


# 1. arm64 compile flags
patch("cmake/SfizzConfig.cmake", [(
    'elseif(PROJECT_SYSTEM_PROCESSOR MATCHES "(arm.*)")',
    'elseif(PROJECT_SYSTEM_PROCESSOR MATCHES "(arm.*)" '
    'AND NOT PROJECT_SYSTEM_PROCESSOR MATCHES "(arm64|aarch64)")',
)])

# 2. atomic_queue stray `template` keyword (modern-clang conformance)
patch("external/atomic_queue/include/atomic_queue/atomic_queue.h", [
    ("Base::template do_pop_any(",  "Base::do_pop_any("),
    ("Base::template do_push_any(", "Base::do_push_any("),
])
