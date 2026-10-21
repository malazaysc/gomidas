// Pins the GOM-85 guard: a bundled preset path is accepted only if its real path (symlinks
// resolved) is a regular file inside instruments/, and the returned path is that real path.
// Build with -DGOMIDAS_BUILD_TESTS=ON, then: ./app_resources_test
#include "PathGuard.h"
#include <chrono>
#include <cstdio>
#include <fstream>
#include <string>

namespace fs = std::filesystem;
static int failures = 0;

static void check (bool got, bool want, const char* what)
{
    if (got != want) { std::printf ("FAIL: %s (got %d, want %d)\n", what, (int) got, (int) want); ++failures; }
}

int main()
{
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto root = fs::temp_directory_path() / ("gomidas_app_resources_test_" + std::to_string (stamp));
    std::error_code ec;
    fs::remove_all (root, ec);

    const auto instruments = root / "instruments";
    fs::create_directories (instruments / "guitar");
    std::ofstream (instruments / "guitar" / "guitar.sfz") << "<region>";
    std::ofstream (root / "outside.sfz") << "<region>";

    auto inside = [&] (const fs::path& p) { return gomidas::realPathInside (p, instruments).has_value(); };

    check (inside (instruments / "guitar" / "guitar.sfz"),                   true,  "a preset inside instruments/");
    check (inside (instruments / "guitar" / ".." / "guitar" / "guitar.sfz"), true,  "dot-dot that stays inside");
    check (inside (instruments / ".." / "outside.sfz"),                      false, "../ out of instruments/");
    check (inside (instruments / "guitar" / "missing.sfz"),                  false, "a file that doesn't exist");
    check (inside (instruments / "guitar"),                                  false, "a directory, not a file");
    check (inside (instruments),                                             false, "the instruments dir itself");

    const auto real = gomidas::realPathInside (instruments / "guitar" / ".." / "guitar" / "guitar.sfz", instruments);
    check (real.has_value() && *real == fs::canonical (instruments / "guitar" / "guitar.sfz"), true,
           "returns the canonical path");

   #ifndef _WIN32   // creating symlinks needs extra privileges on Windows
    fs::create_symlink (root / "outside.sfz", instruments / "guitar" / "escape.sfz");
    fs::create_directory_symlink (root, instruments / "uplink");
    check (inside (instruments / "guitar" / "escape.sfz"),  false, "a symlinked file pointing outside");
    check (inside (instruments / "uplink" / "outside.sfz"), false, "a symlinked directory pointing outside");
   #endif

    fs::remove_all (root, ec);

    if (failures == 0)
        std::printf ("PASS: app_resources_test\n");
    return failures == 0 ? 0 : 1;
}
