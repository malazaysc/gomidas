#pragma once
// Plain-C++ path checks (no JUCE), so tests/app_resources_test.cpp can pin them (GOM-85).
#include <filesystem>
#include <optional>
#include <system_error>

namespace gomidas
{
// The real path (all symlinks resolved) of `file`, if it is a regular file inside `dir`'s real
// path; std::nullopt otherwise. A textual parent check can be escaped with "../" or a symlinked
// entry, and the path comes from the web view's JS. Returns the resolved path for callers that
// want it; loadTrackSfzPreset deliberately loads the original (sfizz resolves samples relative to
// the .sfz it opened).
inline std::optional<std::filesystem::path> realPathInside (const std::filesystem::path& file,
                                                            const std::filesystem::path& dir)
{
    std::error_code ec;
    const auto real = std::filesystem::canonical (file, ec);
    if (ec)
        return std::nullopt;
    const auto root = std::filesystem::canonical (dir, ec);
    if (ec)
        return std::nullopt;
    const auto rel = real.lexically_relative (root);
    if (rel.empty() || *rel.begin() == ".." || ! std::filesystem::is_regular_file (real, ec))
        return std::nullopt;
    return real;
}
}
